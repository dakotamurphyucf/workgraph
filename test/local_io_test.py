"""Independent real local input, output pipe and socket startup regressions."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import socket
import struct
import threading
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
FIXTURE = Path(sys.argv.pop(1)).resolve()


class LocalIoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-io-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = self.root / "s"

    def cli(self, *args):
        return subprocess.run([str(EXE), *map(str, args)], capture_output=True,
                              text=True, timeout=10)

    def error(self, result, kind, path=None):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        diagnostic = json.loads(result.stderr.splitlines()[-1])
        self.assertEqual(diagnostic["kind"], kind, result.stderr)
        if path is not None:
            self.assertIn(str(path), diagnostic["message"])
        self.assertNotIn("Raised at", result.stderr)

    def test_platform_and_error_contracts(self):
        result = subprocess.run([str(FIXTURE), str(self.root)], capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(int(result.stdout.strip()), (103, 107))

    def test_local_input_files(self):
        missing = self.root / "absent"
        self.error(self.cli("request", self.socket, "daemon.health", "--field-file",
                            "text", missing), "Invalid_argument", missing)
        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        oversized = self.root / "oversized"
        with oversized.open("wb") as stream:
            stream.truncate(4 * 1024 * 1024 + 1)
        link = self.root / "link"
        link.symlink_to(oversized)
        for path in (fifo, self.root, link, oversized, Path("/dev/null")):
            with self.subTest(path=path):
                self.error(self.cli("request", self.socket, "daemon.health", "--field-file",
                                    "text", path), "Invalid_argument", path)
        self.error(self.cli("request", self.socket, "daemon.health", "--params-file",
                            missing), "Invalid_argument", missing)
        self.error(self.cli("retry", self.socket, missing), "Invalid_argument", missing)
        self.error(self.cli("--context", missing, "request", "daemon.health"),
                   "Invalid_argument", missing)
        existing = self.root / "saved.json"
        existing.write_text("original")
        self.error(self.cli("request", self.socket, "daemon.health", "--save-request",
                            existing), "Invalid_argument", existing)
        self.assertEqual(existing.read_text(), "original")
        self.error(self.cli("request", self.socket, "daemon.health", "--save-request",
                            self.root / "missing-parent" / "request.json"),
                   "Invalid_argument", self.root / "missing-parent" / "request.json")
        self.error(self.cli("request", self.socket, "resource.upload", "--workspace-id", "w",
                            "--actor-id", "a", "--mutation-id", "m", "--resource-id", "r",
                            "--expected-revision", "0", "--title", "Upload", "--file", missing),
                   "Invalid_argument", missing)
        self.error(self.cli("request", self.socket, "resource.download", "--workspace-id", "w",
                            "--resource-id", "r", "--destination", existing),
                   "Invalid_argument", existing)

    def test_existing_execution_stage(self):
        stage = self.root / "stage"
        first = self.cli("evidence-run", "--stage", stage, "--cwd", self.root,
                         "--", shutil.which("true"))
        self.assertEqual(first.returncode, 0, first.stderr)
        original = (stage / "capture.json").read_bytes()
        self.error(self.cli("evidence-run", "--stage", stage, "--cwd", self.root,
                            "--", shutil.which("false")), "Invalid_argument", stage)
        self.assertEqual((stage / "capture.json").read_bytes(), original)

    def test_broken_stdout_is_quiet(self):
        read_end, write_end = os.pipe()
        os.close(read_end)
        try:
            process = subprocess.Popen([str(EXE), "schema"], stdout=write_end,
                                       stderr=subprocess.PIPE,
                                       env={**os.environ, "OCAMLRUNPARAM": "b"})
        finally:
            os.close(write_end)
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr.decode())
        self.assertEqual(stderr, b"")

    def test_transmitted_write_and_daemon_errors_keep_their_kind(self):
        def call_with_peer(reply):
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(self.socket))
            listener.listen(1)
            def peer():
                with listener, listener.accept()[0] as flow:
                    def exact(size):
                        data = b""
                        while len(data) < size:
                            part = flow.recv(size - len(data))
                            if not part:
                                raise EOFError("incomplete request")
                            data += part
                        return data
                    request = json.loads(exact(struct.unpack(">I", exact(4))[0]))
                    if reply:
                        response = {"jsonrpc": "2.0", "id": request["id"], "error": {
                            "code": -32000, "message": "fixture daemon disk failure",
                            "data": {"kind": "Storage_unavailable",
                                     "message": "fixture daemon disk failure"}}}
                        body = json.dumps(response).encode()
                        flow.sendall(struct.pack(">I", len(body)) + body)
            thread = threading.Thread(target=peer, daemon=True)
            thread.start()
            result = self.cli("request", self.socket, "ticket.create", "--workspace-id", "w",
                              "--actor-id", "a", "--mutation-id", "m", "--ticket-id", "t",
                              "--title", "Fixture", "--timeout", "1")
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.socket.unlink()
            return result
        self.error(call_with_peer(False), "Outcome_unknown")
        result = call_with_peer(True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"]["data"]["kind"],
                         "Storage_unavailable")

    def test_invalid_and_occupied_startup(self):
        for suffix in ("x" * 108, "é" * 60):
            registry = self.root / "registry"
            socket = self.root / suffix
            result = self.cli("serve", registry, socket)
            self.error(result, "Invalid_argument")
            self.assertNotIn("ready", result.stderr)
            self.assertFalse(registry.exists(), "invalid socket started registry worker")
        occupied = self.root / "occupied"
        occupied.write_text("keep")
        result = self.cli("serve", self.root / "reg-occupied", occupied)
        self.error(result, "Conflict")
        self.assertEqual(occupied.read_text(), "keep")
        self.assertNotIn(" ready ", result.stderr)
        failed = self.cli("serve", self.root / "reg-failed", self.root / "missing" / "s")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("bind", failed.stderr)
        self.assertNotIn('unlink', failed.stderr)
        self.assertNotIn(" ready ", failed.stderr)

    def test_native_boundary_live_protection_and_lifecycle(self):
        native = subprocess.run([str(FIXTURE), str(self.root)], capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(native.returncode, 0, native.stderr)
        maximum = int(native.stdout.strip())
        socket = self.root / ("s" * (maximum - len(os.fsencode(str(self.root))) - 1))
        self.assertEqual(len(os.fsencode(str(socket))), maximum)
        log = self.root / "daemon.log"
        with log.open("w") as stderr:
            daemon = subprocess.Popen([str(EXE), "serve", str(self.root / "registry"),
                                       str(socket)], stdout=subprocess.DEVNULL, stderr=stderr)
        def cleanup():
            if daemon.poll() is None:
                daemon.terminate()
                daemon.wait(timeout=10)
        self.addCleanup(cleanup)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if socket.exists() and self.cli("request", socket, "daemon.health").returncode == 0:
                break
            self.assertIsNone(daemon.poll(), log.read_text())
            time.sleep(0.02)
        else:
            self.fail("daemon never became ready: " + log.read_text())
        second = self.cli("serve", self.root / "other-registry", socket)
        self.error(second, "Conflict")
        same_registry = self.cli("serve", self.root / "registry", self.root / "other-socket")
        self.error(same_registry, "Conflict")
        self.assertEqual(self.cli("request", socket, "daemon.health").returncode, 0)
        shutdown = self.cli("request", socket, "daemon.shutdown")
        self.assertEqual(shutdown.returncode, 0, shutdown.stderr)
        daemon.wait(timeout=10)
        self.assertEqual(daemon.returncode, 0, log.read_text())
        self.assertFalse(socket.exists())
        text = log.read_text()
        for event in ("starting", "ready", "shutdown complete"):
            self.assertIn("workgraph daemon " + event, text)
        self.assertIn(str(self.root / "registry"), text)
        self.assertIn(str(socket), text)


if __name__ == "__main__":
    unittest.main()
