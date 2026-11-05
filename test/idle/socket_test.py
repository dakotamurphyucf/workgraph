"""Nondurable allocation bytes/feed invariants and exact committed retry identities."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
EXE = Path(sys.argv.pop(1)).resolve()
SDK = Path(sys.argv.pop(1)).resolve()


class Idle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wg-idle-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.address = self.root / "s"
        self.registry = self.root / "registry"
        self.workspace = self.root / "workspace"
        self.log = (self.root / "daemon.log").open("w+")
        self.daemon = None
        self.start()
        self.write("workspace.create", "create", name="Idle", root=str(self.workspace))
        self.write("run.register", "register", target_run_id="run", objective="Work", capabilities=["ocaml"])

    def start(self):
        self.daemon = subprocess.Popen([str(EXE), "serve", str(self.registry), str(self.address)],
                                       stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic() >= deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)

    @staticmethod
    def receive(connection, length):
        chunks = []
        while length:
            chunk = connection.recv(length)
            if not chunk:
                raise EOFError("incomplete response")
            chunks.append(chunk)
            length -= len(chunk)
        return b"".join(chunks)

    def rpc(self, method, drop_response=False, **params):
        if method not in ("daemon.shutdown", "export.get", "workspace.restore"):
            params = {"workspace_id": "idle", **params}
        request = {"workgraph_api": "0.6", "jsonrpc": "2.0", "id": "test", "method": method, "params": params}
        payload = json.dumps(request).encode()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            connection.connect(str(self.address))
            connection.sendall(struct.pack(">I", len(payload)) + payload)
            length = struct.unpack(">I", self.receive(connection, 4))[0]
            if drop_response:
                # Publication preceded this response header; discard the body so
                # the caller has no readable acknowledgement and must exact-retry.
                return None
            return json.loads(self.receive(connection, length))

    def result(self, method, **params):
        reply = self.rpc(method, **params)
        self.assertIn("result", reply, reply)
        return reply["result"]

    def write(self, method, mutation, **params):
        return self.result(method, actor_id="worker", mutation_id=mutation, **params)

    def allocate(self, mutation="idle", **params):
        return self.write("ticket.claim_next", mutation, run_id="run", target_run_id="run", attempt_id=mutation, **params)

    def snapshot(self):
        return {str(path.relative_to(self.workspace)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.workspace.rglob("*") if path.is_file()}

    def stop(self):
        self.result("daemon.shutdown")
        self.daemon.wait(timeout=10)

    def tearDown(self):
        if self.daemon and self.daemon.poll() is None:
            self.stop()
        self.log.close()
        self.temp.cleanup()

    def test_empty_identities_leave_head_receipts_feed_and_bytes_unchanged_then_select(self):
        before = self.snapshot()
        head = json.loads((self.workspace / "HEAD.json").read_text())["sequence"]
        with concurrent.futures.ThreadPoolExecutor() as executor:
            waiting = executor.submit(self.result, "changes.wait", source="planning", after=head, timeout_ms="5000")
            for index in range(40):
                empty = self.allocate("idle" if index % 2 else "empty-" + str(index))
                self.assertEqual("empty", empty["data"]["kind"])
                self.assertFalse(empty["meta"]["durable"])
                self.assertEqual(head, empty["meta"]["workspace_revision"])
                self.assertEqual(head, empty["data"]["explanation"]["captured_workspace_revision"])
            self.assertFalse(waiting.done(), "empty allocation woke changes.wait")
            self.assertEqual(before, self.snapshot(), "empty allocation changed durable bytes")
            feed = self.result("changes.read", source="planning", after=head)
            self.assertEqual([], feed["data"]["items"])
            # Exercise CLI publication validation as well as the raw API.
            cli = subprocess.run([str(EXE), "call", str(self.address), "ticket.claim_next", json.dumps({
                "workspace_id": "idle", "actor_id": "worker", "run_id": "run", "mutation_id": "cli-empty",
                "target_run_id": "run", "attempt_id": "cli-empty"})], capture_output=True, text=True, timeout=10)
            self.assertEqual(0, cli.returncode, cli.stderr)
            self.assertFalse(json.loads(cli.stdout)["result"]["meta"]["durable"])
            self.assertEqual(before, self.snapshot())
            self.write("ticket.create", "ticket", ticket_id="a", title="A")
            self.assertTrue(waiting.result(timeout=5)["data"]["items"])
        # The exact identity which previously observed empty now acquires work.
        chosen = self.allocate("idle")
        self.assertTrue(chosen["meta"]["durable"])
        self.assertEqual("a", chosen["data"]["claim"]["ticket_id"])
        self.assertEqual("idle", chosen["data"]["attempt"]["attempt_id"])
        selected_bytes = self.snapshot()
        self.assertEqual(chosen, self.allocate("idle"))
        self.assertEqual(selected_bytes, self.snapshot())
        self.write("ticket.finish", "finish", run_id="run", ticket_id="a", token="1", evidence="Checked")
        self.assertEqual(chosen, self.allocate("idle"))
        self.stop(); self.start()
        self.assertEqual(chosen, self.allocate("idle"))
        conflict = self.rpc("ticket.claim_next", actor_id="worker", run_id="run", mutation_id="idle",
                            target_run_id="run", attempt_id="different")
        self.assertEqual("Idempotency_conflict", conflict["error"]["data"]["kind"])
        adopted = self.rpc("ticket.claim_next", actor_id="worker", run_id="run", mutation_id="different",
                           target_run_id="run", attempt_id="idle")
        self.assertEqual("Conflict", adopted["error"]["data"]["kind"])

    def test_explicit_batch_empty_is_durable_and_its_receipt_stays_frozen(self):
        operations = [{"method": "ticket.claim_next", "params": {"target_run_id": "run", "attempt_id": "batch"}}]
        before = self.snapshot()
        batch = self.write("transaction.apply", "batch", run_id="run", operations=operations)
        self.assertTrue(batch["meta"]["durable"])
        self.assertEqual("empty", batch["data"]["results"][0]["data"]["kind"])
        self.assertNotEqual(before, self.snapshot())
        committed = self.snapshot()
        self.assertEqual(batch, self.write("transaction.apply", "batch", run_id="run", operations=operations))
        self.assertEqual(committed, self.snapshot())
        self.write("ticket.create", "ticket", ticket_id="a", title="A")
        self.assertEqual(batch, self.write("transaction.apply", "batch", run_id="run", operations=operations))
        self.assertEqual("selected", self.allocate("new")["data"]["kind"])
        self.stop(); self.start()
        self.assertEqual(batch, self.write("transaction.apply", "batch", run_id="run", operations=operations))

    def test_lost_selection_ack_exact_retry_survives_restart_and_export_restore(self):
        self.write("ticket.create", "ticket", ticket_id="a", title="A")
        self.rpc("ticket.claim_next", drop_response=True, actor_id="worker", run_id="run", mutation_id="lost",
                 target_run_id="run", attempt_id="lost")
        selected = self.allocate("lost")
        self.assertEqual("1", selected["data"]["claim"]["token"])
        self.assertEqual("lost", selected["data"]["attempt"]["attempt_id"])
        self.stop(); self.start()
        self.assertEqual(selected, self.allocate("lost"))
        destination = self.root / "export"
        export = self.write("workspace.export", "export", destination=str(destination))
        deadline = time.monotonic() + 10
        while True:
            job = self.result("export.get", job_id=export["data"]["job_id"])["data"]
            if job["status"] == "completed":
                break
            self.assertLess(time.monotonic(), deadline, job)
            time.sleep(.01)
        self.stop()
        self.registry = self.root / "restored-registry"
        self.start()
        restored = self.root / "restored-workspace"
        self.write("workspace.restore", "restore", directory=str(destination), root=str(restored))
        self.write("workspace.open", "open")
        self.assertEqual(selected, self.allocate("lost"))
        attempts = self.result("attempt.list")["data"]["items"]
        self.assertEqual(["lost"], [row["attempt_id"] for row in attempts])

    def test_typed_sdk_observation_and_durable_workflow(self):
        result = subprocess.run([str(SDK), str(self.address), str(self.root / "sdk")],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("typed workflow passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
