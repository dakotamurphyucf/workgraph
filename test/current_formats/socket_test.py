"""Independent profile fixtures and byte/metadata invariance of unsupported roots."""
import hashlib
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()


def snapshot(root):
    return {str(p.relative_to(root)): (p.stat().st_mode, p.stat().st_mtime_ns,
            hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None)
            for p in [root, *root.rglob("*")]}


def receive(sock):
    def exact(n):
        result = b""
        while len(result) < n:
            part = sock.recv(n-len(result))
            if not part:
                raise EOFError("closed before full frame")
            result += part
        return result
    return json.loads(exact(struct.unpack(">I", exact(4))[0]))


def send(sock, request):
    payload = json.dumps(request).encode()
    sock.sendall(struct.pack(">I", len(payload)) + payload)


class CurrentFormats(unittest.TestCase):
    def test_profile_storage_export_and_saved_retry_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="wg-format-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            daemon = None
            with (root / "log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic()+10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def raw(request):
                    with socket.socket(socket.AF_UNIX) as flow:
                        flow.settimeout(10)
                        flow.connect(str(address))
                        send(flow, request)
                        return receive(flow)

                def call(method, params):
                    return raw({"jsonrpc":"2.0", "workgraph_api":"0.4", "id":"test", "method":method, "params":params})

                def write(method, mutation, **params):
                    return call(method, {"actor_id":"test", "mutation_id":mutation, **params})

                def unsupported(response, representation):
                    self.assertEqual("Unsupported_version", response["error"]["data"]["kind"], response)
                    self.assertEqual(representation, response["error"]["data"]["details"]["representation"])

                try:
                    start()
                    before_registry = snapshot(root / "registry")
                    for request in [
                        {"jsonrpc":"2.0","id":"old","method":"initialize"},
                        {"jsonrpc":"2.0","workgraph_api":"0.2","id":"old","method":"workspace.create","params":{}},
                        {"workgraph_api":"future","id":"old","unrelated":True}]:
                        unsupported(raw(request), "application API")
                    self.assertEqual(before_registry, snapshot(root / "registry"))
                    current = call("initialize", {})["result"]["data"]
                    self.assertEqual("0.4", current["workgraph_api"])
                    self.assertEqual("3", current["registry_format_version"])
                    malformed = call("initialize", {"unknown":True})
                    self.assertEqual("Invalid_argument", malformed["error"]["data"]["kind"])
                    old = root / "old-workspace"
                    old.mkdir()
                    (old / "workspace.json").write_text('{"version":"1","obsolete":true}')
                    before = snapshot(old)
                    registry_before = snapshot(root / "registry")
                    unsupported(write("workspace.register", "register-old", root=str(old)), "workspace descriptor")
                    self.assertEqual(before, snapshot(old))
                    self.assertEqual(registry_before, snapshot(root / "registry"))
                    # Version detection precedes missing workspace-set inventory/fields.
                    export = root / "old-export"
                    export.mkdir()
                    (export / "manifest.json").write_text('{"version":"1","obsolete":true}')
                    before = snapshot(export)
                    unsupported(call("export.verify", {"directory":str(export)}), "workspace export")
                    unsupported(write("workspace.restore", "restore-old", directory=str(export), root=str(root / "restored")), "workspace export")
                    unsupported(write("daemon.restore_all", "restore-all-old", directory=str(export), roots={"w":str(root / "restored")}), "workspace-set export")
                    self.assertEqual(before, snapshot(export))
                    self.assertFalse((root / "restored").exists())
                    self.assertEqual(registry_before, snapshot(root / "registry"))
                    created = write("workspace.create", "create", workspace_id="w", name="Current", root=str(root / "workspace"))
                    self.assertIn("result", created, created)
                    self.assertEqual("3", json.loads((root / "workspace/workspace.json").read_text())["version"])
                    saved_current = root / "current-request.json"
                    command = [str(EXE), "ticket", "create", str(address),
                               "--workspace-id", "w", "--actor-id", "test",
                               "--ticket-id", "t", "--title", "Task",
                               "--save-request", str(saved_current)]
                    result = subprocess.run(command, capture_output=True, text=True, timeout=10)
                    self.assertEqual(0, result.returncode, result.stderr + result.stdout)
                    original_result = json.loads(result.stdout)
                    self.assertEqual("0.4", json.loads(saved_current.read_text())["workgraph_api"])
                    self.assertIn("result", write("ticket.create", "later", workspace_id="w", ticket_id="later", title="Later"))
                    self.assertIn("result", call("daemon.shutdown", {}))
                    daemon.wait(timeout=10)
                    start()
                    replay = subprocess.run([str(EXE), "retry", str(address), str(saved_current)],
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(0, replay.returncode, replay.stderr + replay.stdout)
                    self.assertEqual(original_result, json.loads(replay.stdout))
                    self.assertIn("result", write("workspace.close", "close", workspace_id="w"))
                    descriptor = root / "workspace/workspace.json"
                    contents = json.loads(descriptor.read_text())
                    contents["version"] = "1"
                    descriptor.write_text(json.dumps(contents))
                    before = snapshot(root / "workspace")
                    unsupported(write("workspace.open", "open-old", workspace_id="w"), "workspace descriptor")
                    self.assertEqual(before, snapshot(root / "workspace"))
                    # A saved legacy request rejects locally, unchanged, before connection.
                    saved = root / "old-request.json"
                    saved.write_text('{"jsonrpc":"2.0","id":"old","method":"ticket.create","params":{}}')
                    before_bytes = saved.read_bytes()
                    result = subprocess.run([str(EXE), "retry", str(root / "absent-socket"), str(saved)], capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(0, result.returncode)
                    self.assertEqual("Unsupported_version", json.loads(result.stderr)["kind"])
                    self.assertEqual(before_bytes, saved.read_bytes())
                finally:
                    if daemon is not None and daemon.poll() is None:
                        call("daemon.shutdown", {})
                        daemon.wait(timeout=10)

    def test_old_registry_startup_and_old_initialize_reply(self):
        with tempfile.TemporaryDirectory(prefix="wg-format-old-", dir="/tmp") as directory:
            root = Path(directory)
            registry = root / "registry"
            registry.mkdir()
            (registry / "registry.json").write_text('{"version":"1","obsolete":true}')
            before = snapshot(registry)
            result = subprocess.run([str(EXE), "serve", str(registry), str(root / "s")], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(0, result.returncode)
            problem = next(json.loads(line) for line in result.stderr.splitlines() if line.startswith('{"kind"') or line.startswith('{"details"'))
            self.assertEqual("Unsupported_version", problem["kind"])
            self.assertEqual("registry", problem["details"]["representation"])
            self.assertEqual(before, snapshot(registry))
            self.assertFalse((root / "s").exists())
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(root / "peer"))
                server.listen(1)
                observed = []
                def legacy():
                    flow, _ = server.accept()
                    with flow:
                        request = receive(flow)
                        observed.append(request)
                        send(flow, {"jsonrpc":"2.0","id":request["id"],"result":{"data":{"protocol_version":"1"},"meta":{}}})
                worker = threading.Thread(target=legacy, daemon=True)
                worker.start()
                result = subprocess.run([str(EXE), "call", str(root / "peer"), "initialize", "{}"], capture_output=True, text=True, timeout=10)
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive())
                self.assertEqual("0.4", observed[0]["workgraph_api"])
                self.assertNotEqual(0, result.returncode)
                self.assertEqual("Unsupported_version", json.loads(result.stderr)["kind"])


if __name__ == "__main__":
    unittest.main()
