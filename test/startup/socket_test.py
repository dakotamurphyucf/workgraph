"""Path ownership and real bootstrap readiness, including detached child lifetime."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
FIXTURE = Path(sys.argv.pop(1)).resolve()


class StartupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wg-startup-", dir="/tmp")
        self.root = Path(self.temporary.name)
        self.processes = []
        self.sockets = []
        self.logs = []

    def tearDown(self):
        # Daemons spawned by init are deliberately outside the CLI's process
        # lifetime. Stop them by protocol before removing their private roots.
        for address in self.sockets:
            self.cli("request", address, "daemon.shutdown", timeout=2)
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for log in self.logs:
            log.close()
        self.temporary.cleanup()

    def cli(self, *args, executable=EXE, timeout=10, env=None):
        return subprocess.run([str(executable), *map(str, args)], capture_output=True,
                              text=True, timeout=timeout, env=env)

    def serve(self, address, registry):
        log = tempfile.NamedTemporaryFile(mode="w+", prefix="serve-", dir=self.root,
                                          delete=False)
        self.logs.append(log)
        process = subprocess.Popen([str(EXE), "serve", str(registry), str(address)],
                                   stdout=log, stderr=log)
        self.processes.append(process)
        self.sockets.append(address)
        return process

    def ready(self, address, process=None, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process is not None and process.poll() is not None:
                self.fail("daemon exited before handshake: " + self.log_text())
            response = self.cli("request", address, "daemon.health", timeout=2)
            if response.returncode == 0:
                return json.loads(response.stdout)["result"]
            time.sleep(.02)
        self.fail("daemon never completed handshake: " + self.log_text())

    def log_text(self):
        chunks = []
        for log in self.logs:
            log.flush()
            chunks.append(Path(log.name).read_text())
        return "\n".join(chunks)

    def ok(self, *args, **kwargs):
        response = self.cli(*args, **kwargs)
        self.assertEqual(0, response.returncode, response.stderr + response.stdout)
        return json.loads(response.stdout)

    def init(self, address, registry, *, executable=EXE, env=None, timeout="3"):
        self.sockets.append(address)
        return self.cli("init", "--context", self.root / "context.json", "--socket", address,
                        "--workspace-id", "test", "--actor-id", "worker", "--name", "Test",
                        "--root", self.root / "workspace", "--start-daemon", "true",
                        "--registry", registry, "--daemon-log", self.root / "bootstrap.log",
                        "--timeout", timeout, executable=executable, env=env)

    def rejected_serve(self, address, registry):
        response = self.cli("serve", registry, address)
        self.assertNotEqual(0, response.returncode, response.stdout)
        self.assertEqual("", response.stdout)
        problem = json.loads(response.stderr.splitlines()[-1])
        self.assertEqual("Conflict", problem["kind"], response.stderr)
        self.assertFalse(registry.exists())
        return problem

    def test_crash_restart_recovers_only_recorded_socket_and_durable_state(self):
        address, registry = self.root / "s", self.root / "registry"
        first = self.serve(address, registry)
        self.ready(address, first)
        params = {"workspace_id": "test", "actor_id": "worker", "mutation_id": "create",
                  "name": "Test", "root": str(self.root / "workspace")}
        created = self.ok("call", address, "workspace.create", json.dumps(params))["result"]
        marker = next(self.root.glob(".workgraph-socket-*.lock"))
        record = json.loads(marker.read_text())
        self.assertEqual(str(address.resolve()), record["path"])
        self.assertEqual(str(address.stat().st_ino), record["inode"])
        first.kill()
        first.wait(timeout=5)
        self.assertTrue(address.is_socket())
        second = self.serve(address, registry)
        self.ready(address, second)
        self.assertEqual(created, self.ok("call", address, "workspace.create", json.dumps(params))["result"])
        self.ok("request", address, "daemon.shutdown")
        second.wait(timeout=5)
        self.assertFalse(address.exists())
        self.assertTrue(marker.is_file(), "permanent guard must never be unlinked")
        self.assertEqual("", marker.read_text(), "released identity must be invalidated")

    def test_different_registries_race_for_same_path_before_registry_creation(self):
        address = self.root / "s"
        registries = [self.root / "r1", self.root / "r2"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            processes = list(pool.map(lambda reg: self.serve(address, reg), registries))
        self.ready(address)
        deadline = time.monotonic() + 5
        while all(process.poll() is None for process in processes) and time.monotonic() < deadline:
            time.sleep(.02)
        winners = [i for i, process in enumerate(processes) if process.poll() is None]
        self.assertEqual(1, len(winners), self.log_text())
        loser = 1 - winners[0]
        self.assertFalse(registries[loser].exists(), self.log_text())
        self.assertIn("active Workgraph owner", self.log_text())

    def test_foreign_bound_listening_and_abandoned_sockets_are_never_unlinked(self):
        for kind in ["bound", "listening", "abandoned"]:
            address = self.root / kind
            with socket.socket(socket.AF_UNIX) as peer:
                peer.bind(str(address))
                if kind == "listening":
                    peer.listen(1)
                before = address.stat()
                if kind == "abandoned":
                    peer.close()
                self.rejected_serve(address, self.root / ("registry-" + kind))
                self.assertEqual((before.st_dev, before.st_ino),
                                 (address.stat().st_dev, address.stat().st_ino))

    def test_regular_symlink_guard_and_parent_alias_safety(self):
        regular = self.root / "regular"
        regular.write_text("untouched")
        self.rejected_serve(regular, self.root / "r-regular")
        link = self.root / "link"
        link.symlink_to(regular)
        self.rejected_serve(link, self.root / "r-link")
        self.assertTrue(link.is_symlink())
        self.assertEqual("untouched", regular.read_text())
        address, registry = self.root / "s", self.root / "registry"
        process = self.serve(address, registry)
        self.ready(address, process)
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.rejected_serve(alias / "s", self.root / "r-alias")
        marker = next(path for path in self.root.glob(".workgraph-socket-*.lock")
                      if path.read_text() and json.loads(path.read_text())["path"] == str(address.resolve()))
        self.ok("request", address, "daemon.shutdown")
        process.wait(timeout=5)
        marker.unlink()
        marker.symlink_to(regular)
        self.rejected_serve(address, self.root / "r-guard-link")
        self.assertEqual("untouched", regular.read_text())

    def test_replaced_inode_is_preserved_on_shutdown_and_restart(self):
        address, registry = self.root / "s", self.root / "registry"
        process = self.serve(address, registry)
        self.ready(address, process)
        address.unlink()
        with socket.socket(socket.AF_UNIX) as replacement:
            replacement.bind(str(address))
            inode = address.stat().st_ino
            self.rejected_serve(address, self.root / "r-live-replacement")
            process.terminate()
            process.wait(timeout=5)
            self.assertEqual(inode, address.stat().st_ino)
            self.rejected_serve(address, self.root / "r-stale-replacement")
            self.assertEqual(inode, address.stat().st_ino)

    def test_changed_recorded_socket_metadata_is_not_reclaimed(self):
        address, registry = self.root / "s", self.root / "registry"
        process = self.serve(address, registry)
        self.ready(address, process)
        process.kill()
        process.wait(timeout=5)
        marker = next(self.root.glob(".workgraph-socket-*.lock"))
        record = json.loads(marker.read_text())
        record["change_time"] = "unrecognized-generation"
        marker.write_text(json.dumps(record))
        inode = address.stat().st_ino
        self.rejected_serve(address, self.root / "r-changed-generation")
        self.assertEqual(inode, address.stat().st_ino)

    def test_bootstrap_reports_exact_child_failure_and_excludes_old_log(self):
        address, registry = self.root / "s", self.root / "registry"
        (self.root / "bootstrap.log").write_text('{"kind":"Conflict","message":"old failure"}\n')
        env = {**os.environ, "WORKGRAPH_STARTUP_FIXTURE_FAIL": "1"}
        response = self.init(address, registry, executable=FIXTURE, env=env)
        self.assertNotEqual(0, response.returncode)
        problem = json.loads(response.stderr.splitlines()[-1])
        self.assertEqual("Corrupt_store", problem["kind"], response.stderr)
        self.assertIn("fixture recovery failed", problem["message"])
        self.assertIn("17", problem["message"])
        self.assertIn("bootstrap.log", problem["message"])
        self.assertNotIn("old failure", problem["message"])
        self.assertFalse((self.root / "context.json").exists())

    def test_bootstrap_recovers_recognized_crash(self):
        address, registry = self.root / "s", self.root / "registry"
        process = self.serve(address, registry)
        self.ready(address, process)
        process.kill()
        process.wait(timeout=5)
        self.assertTrue(address.is_socket())
        response = self.init(address, registry)
        self.assertEqual(0, response.returncode, response.stderr)
        self.ready(address)
        self.assertTrue((self.root / "context.json").is_file())

    def test_bootstrap_reports_registry_owned_on_another_socket(self):
        address, registry = self.root / "first", self.root / "registry"
        process = self.serve(address, registry)
        self.ready(address, process)
        response = self.init(self.root / "second", registry)
        self.assertNotEqual(0, response.returncode)
        problem = json.loads(response.stderr.splitlines()[-1])
        self.assertEqual("Conflict", problem["kind"], response.stderr)
        self.assertIn("registry already served", problem["message"])
        self.assertIn("daemon startup failed", problem["message"])
        self.assertFalse((self.root / "context.json").exists())
        self.ready(address, process)

    def test_bootstrap_waits_for_handshake_and_daemon_survives_cli_exit(self):
        address, registry = self.root / "s", self.root / "registry"
        env = {**os.environ, "WORKGRAPH_STARTUP_FIXTURE_DELAY": ".35"}
        before = time.monotonic()
        response = self.init(address, registry, executable=FIXTURE, env=env)
        self.assertEqual(0, response.returncode, response.stderr)
        self.assertGreaterEqual(time.monotonic() - before, .3)
        time.sleep(.1)
        self.ready(address)
        listing = self.ok("request", address, "workspace.list")["result"]["data"]["workspaces"]
        self.assertEqual("test", listing[0]["workspace_id"])

    def test_bootstrap_timeout_does_not_claim_detached_child_stopped(self):
        address, registry = self.root / "s", self.root / "registry"
        env = {**os.environ, "WORKGRAPH_STARTUP_FIXTURE_DELAY": ".5"}
        before = time.monotonic()
        response = self.init(address, registry, executable=FIXTURE, env=env, timeout=".1")
        self.assertNotEqual(0, response.returncode)
        self.assertLess(time.monotonic() - before, 2)
        self.assertIn("startup deadline exceeded", response.stderr)
        self.assertIn("daemon may still start", response.stderr)
        self.assertFalse((self.root / "context.json").exists())
        # Explicitly verify the detached daemon later, then tearDown stops it.
        self.ready(address)

    def test_registry_failure_is_visible_in_bootstrap_diagnostics(self):
        address, registry = self.root / "s", self.root / "registry"
        registry.mkdir()
        (registry / "registry.json").write_text('{"format_version":"wrong"}')
        response = self.init(address, registry)
        self.assertNotEqual(0, response.returncode)
        problem = json.loads(response.stderr.splitlines()[-1])
        self.assertEqual("Unsupported_version", problem["kind"], response.stderr)
        self.assertIn("daemon startup failed", problem["message"])
        self.assertIn("bootstrap.log", problem["message"])
        self.assertFalse((self.root / "context.json").exists())

    def broken_handshake(self, payload, expected):
        address = self.root / "s"
        registry = self.root / "registry"
        with socket.socket(socket.AF_UNIX) as peer:
            peer.bind(str(address))
            peer.listen(4)
            errors = []

            def broken_peer():
                try:
                    for _ in range(2):
                        with peer.accept()[0] as connection:
                            connection.recv(65536)
                            connection.sendall(struct.pack(">I", len(payload)) + payload)
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(target=broken_peer, daemon=True)
            worker.start()
            before = address.stat().st_ino
            response = self.init(address, registry)
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertEqual([], errors)
            self.assertNotEqual(0, response.returncode)
            self.assertIn("last handshake", response.stderr)
            self.assertIn(expected, response.stderr)
            self.assertEqual(before, address.stat().st_ino)
            self.assertFalse(registry.exists())
            self.assertFalse((self.root / "context.json").exists())
        self.sockets.remove(address)

    def test_broken_peer_handshake_never_counts_as_readiness(self):
        self.broken_handshake(b'{"jsonrpc":"2.0","id":"wrong","result":{}}',
                              "request ID differs")

    def test_malformed_success_never_counts_as_readiness(self):
        self.broken_handshake(
            b'{"jsonrpc":"2.0","id":"cli-init","result":{"data":{},"meta":{}}}',
            "missing field")


if __name__ == "__main__":
    unittest.main()
