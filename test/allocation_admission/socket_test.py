"""Full daemon admission, serialized capacity and exact retry after restart."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
EXE = Path(sys.argv.pop(1)).resolve()


class Admission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wg-admit-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.address = self.root / "s"
        self.log = (self.root / "daemon.log").open("w+")
        self.daemon = None
        self.start()
        self.write("workspace.create", "workspace", name="Admission", root=str(self.root / "workspace"))
        self.write("run.register", "run", target_run_id="run", objective="work", capabilities=["ocaml"])
        self.write("run.register", "bad", target_run_id="bad", objective="work")
        self.write("allocation.pool_put", "pool", name="db", expected_revision="0", limit="1")
        for ticket in ["a", "b", "c"]:
            self.write("ticket.create", "create-" + ticket, ticket_id=ticket, title=ticket)
            self.write("allocation.ticket_policy_put", "policy-" + ticket, ticket_id=ticket,
                       expected_revision="0", required_capabilities=["ocaml"], pools=["db"])

    def start(self):
        self.daemon = subprocess.Popen([str(EXE), "serve", str(self.root / "registry"), str(self.address)],
                                       stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic() > deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)

    def stop(self):
        self.call("daemon.shutdown")
        self.daemon.wait(timeout=10)

    def tearDown(self):
        if self.daemon and self.daemon.poll() is None:
            self.stop()
        self.log.close()
        self.temp.cleanup()

    def call(self, method, **params):
        if method != "daemon.shutdown":
            params = {"workspace_id": "admission", **params}
        response = subprocess.run([str(EXE), "call", str(self.address), method, json.dumps(params)],
                                  capture_output=True, text=True, timeout=10)
        self.assertTrue(response.stdout, response.stderr)
        return json.loads(response.stdout)

    def write(self, method, mutation, **params):
        return self.call(method, actor_id="worker", mutation_id=mutation, **params)

    def granted(self, method, mutation, **params):
        result = self.write(method, mutation, **params)
        self.assertIn("result", result, result)
        return result["result"]

    def test_direct_shapes_and_replay_preserve_original_receipt(self):
        for i, (method, extra) in enumerate([
                ("ticket.claim", {}), ("ticket.claim", {"lease_duration_ms": "1000"}),
                ("ticket.start", {}), ("ticket.start", {"attempt_id": "attempt"})]):
            for suffix, run, expected in [("none", None, "run_required"),
                                          ("unknown", "unknown", "unregistered_run"),
                                          ("bad", "bad", "missing_capability")]:
                params = {"ticket_id": "a", **extra}
                if run is not None:
                    params["run_id"] = run
                reply = self.write(method, f"reject-{i}-{suffix}", **params)
                problem = reply["error"]["data"]
                self.assertEqual("Blocked", problem["kind"])
                self.assertEqual("allocation", problem["details"]["type"])
                self.assertIn(expected, [r["kind"] for r in problem["details"]["reasons"]])
        grant = self.granted("ticket.start", "grant", run_id="run", ticket_id="a")
        self.assertEqual(grant, self.granted("ticket.start", "grant", run_id="run", ticket_id="a"))
        rejected = self.write("ticket.claim", "full", run_id="run", ticket_id="b")
        reason = rejected["error"]["data"]["details"]["reasons"][0]
        self.assertEqual({"kind": "pool_full", "pool": "db", "unit": "allocated_tickets",
                          "used": "1", "limit": "1", "attempted": "2"}, reason)
        empty = self.granted("ticket.claim_next", "empty", run_id="run", target_run_id="run", attempt_id="empty")
        self.assertEqual("empty", empty["data"]["kind"])
        self.stop()
        self.start()
        self.assertEqual(grant, self.granted("ticket.start", "grant", run_id="run", ticket_id="a"))
        self.granted("ticket.release", "release", run_id="run", ticket_id="a", token=grant["data"]["token"])
        self.granted("ticket.claim", "new", run_id="run", ticket_id="b")
        self.assertEqual(grant, self.granted("ticket.start", "grant", run_id="run", ticket_id="a"))

    def test_concurrent_claims_share_serialized_pool_capacity(self):
        def claim(ticket):
            return self.write("ticket.claim", "race-" + ticket, run_id="run", ticket_id=ticket)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, ["a", "b"]))
        self.assertEqual(1, sum("result" in result for result in results), results)
        failure = next(result["error"]["data"] for result in results if "error" in result)
        self.assertEqual("pool_full", failure["details"]["reasons"][0]["kind"])


if __name__ == "__main__":
    unittest.main()
