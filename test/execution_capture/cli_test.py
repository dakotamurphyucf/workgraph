"""Execution stages survive failed/lost publication without executing twice."""
import base64
import importlib.util
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
ADAPTER = Path(__file__).resolve().parents[2] / "examples/history-adapter.py"
spec = importlib.util.spec_from_file_location("history_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def receive(sock, size):
    chunks = bytearray()
    while len(chunks) < size:
        data = sock.recv(size - len(chunks))
        if not data:
            raise EOFError("connection closed")
        chunks.extend(data)
    return bytes(chunks)


def frame(sock):
    header = receive(sock, 4)
    body = receive(sock, struct.unpack(">I", header)[0])
    return header + body, json.loads(body)


class DropFinishResponse:
    """Forward framed calls, consume finish acknowledgement, then lose its reply."""
    def __init__(self, path, upstream):
        self.upstream = str(upstream)
        self.receipt = None
        self.error = None
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        self.listener.listen()
        self.listener.settimeout(10)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while True:
                incoming, _ = self.listener.accept()
                with incoming, socket.socket(socket.AF_UNIX) as upstream:
                    incoming.settimeout(10)
                    upstream.settimeout(10)
                    upstream.connect(self.upstream)
                    encoded, request = frame(incoming)
                    upstream.sendall(encoded)
                    response, decoded = frame(upstream)
                    if request["method"] == "resource.finish_upload":
                        self.receipt = decoded["result"]
                        return
                    incoming.sendall(response)
        except Exception as error:
            self.error = error
        finally:
            self.listener.close()


class ExecutionCliTest(unittest.TestCase):
    def test_saved_publication_recovers_lost_response_without_execution(self):
        with tempfile.TemporaryDirectory(prefix="wg-exec-", dir="/tmp") as temporary:
            root = Path(temporary)
            stage = root / "stage"
            counter = root / "counter"
            address = root / "socket"

            def cli(*args, expected=0):
                result = subprocess.run([str(EXE), *map(str, args)], text=True,
                                        capture_output=True, timeout=20)
                self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
                return result

            script = ("from pathlib import Path; import os,sys; "
                      "p=Path(sys.argv[1]); p.write_text(p.read_text()+'x' if p.exists() else 'x'); "
                      "os.write(1,b'\\xff\\x00abcdefghijk'); os.write(2,b'error'); sys.exit(7)")
            run_args = ["evidence-run", "--stage", stage, "--cwd", root,
                        "--output-limit", "8", "--", sys.executable, "-c", script,
                        counter, "--context", "/never-load-this", "--socket", "/literal"]
            execution = json.loads(cli(*run_args, expected=2).stdout)
            self.assertEqual(execution["outcome"], {"kind": "exited", "code": "7"})
            self.assertEqual(execution["publication"], "not_attempted")
            self.assertTrue(execution["stdout"]["truncated"])
            self.assertEqual(counter.read_text(), "x")
            capture = json.loads((stage / "capture.json").read_text())
            self.assertEqual(base64.b64decode(capture["stdout"]["base64"]), b"\xff\x00abcdef")
            self.assertEqual(capture["command"]["argv"][-4:],
                             ["--context", "/never-load-this", "--socket", "/literal"])
            cli(*run_args, expected=1)
            self.assertEqual(counter.read_text(), "x")

            # Save exact identity before the first connection can possibly work.
            first = cli("evidence-publish", address, "--stage", stage,
                        "--workspace-id", "work", "--actor-id", "agent",
                        "--mutation-id", "capture-upload", "--resource-id", "capture",
                        "--expected-revision", "0", "--title", "Observed failure", expected=1)
            self.assertIn("saved_request:", first.stderr)
            request_bytes = (stage / "publication.json").read_bytes()
            saved = json.loads(request_bytes)
            self.assertEqual(saved["method"], "resource.upload")
            self.assertEqual(saved["params"]["mutation_id"], "capture-upload")

            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    process = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)],
                                               stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    return process

                try:
                    daemon = start()
                    client = adapter.Workgraph(address)
                    client.call("workspace.create", dict(workspace_id="work", actor_id="agent",
                                mutation_id="workspace", name="Work", root=str(root / "workspace")))
                    proxy_path = root / "proxy"
                    proxy = DropFinishResponse(proxy_path, address)
                    lost = cli("evidence-publish", proxy_path, "--stage", stage, expected=1)
                    self.assertIn("Outcome_unknown", lost.stderr)
                    proxy.thread.join(timeout=10)
                    self.assertFalse(proxy.thread.is_alive())
                    self.assertIsNone(proxy.error)
                    self.assertIs(proxy.receipt["meta"]["durable"], True)
                    self.assertEqual((stage / "publication.json").read_bytes(), request_bytes)
                    self.assertEqual(counter.read_text(), "x")
                    # A transport retry cannot mutate saved attribution/identities.
                    cli("evidence-publish", address, "--stage", stage, "--actor-id", "other", expected=1)
                    self.assertEqual((stage / "publication.json").read_bytes(), request_bytes)
                    published = json.loads(cli("evidence-publish", address, "--stage", stage).stdout)
                    self.assertEqual(published["jsonrpc"], "2.0")
                    self.assertEqual(published["id"], saved["id"])
                    self.assertEqual(published["result"], proxy.receipt)
                    resource = client.call("resource.get", dict(workspace_id="work", resource_id="capture"))
                    self.assertEqual(resource["data"]["resource_id"], "capture")
                    # Only the saved intent/receipt are needed after a committed upload.
                    (stage / "capture.json").unlink()
                    client.call("daemon.shutdown", {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    daemon = start()
                    again = json.loads(cli("evidence-publish", address, "--stage", stage).stdout)
                    self.assertEqual(again, published)
                    self.assertEqual(counter.read_text(), "x")
                    adapter.Workgraph(address).call("daemon.shutdown", {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            daemon.wait()


if __name__ == "__main__":
    unittest.main()
