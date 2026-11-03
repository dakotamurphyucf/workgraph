"""Cooperative actor admission across real durable restart and saved receipts."""
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


class ActorPolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wg-actor-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.address = self.root / "s"
        self.log = (self.root / "daemon.log").open("w+")
        self.daemon = None
        self.start()
        self.write("workspace.create", "workspace", name="Actors", root=str(self.root / "workspace"))
        self.write("run.register", "worker", target_run_id="run", objective="Work")
        self.write("run.register", "outsider", actor_id="outsider", target_run_id="outsider-run", objective="Other work")
        self.write("ticket.create", "ticket", ticket_id="a", title="A")
        self.policy(0, ["worker"])

    def start(self):
        self.daemon = subprocess.Popen([str(EXE), "serve", str(self.root / "registry"), str(self.address)], stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic() >= deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)

    def call(self, method, **params):
        if method != "daemon.shutdown":
            params = {"workspace_id": "actors", **params}
        process = subprocess.run([str(EXE), "call", str(self.address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
        self.assertTrue(process.stdout, process.stderr)
        return json.loads(process.stdout)

    def result(self, method, **params):
        reply = self.call(method, **params)
        self.assertIn("result", reply, reply)
        return reply["result"]

    def write(self, method, mutation, **params):
        return self.result(method, mutation_id=mutation, **{"actor_id": "worker", **params})

    def policy(self, revision, actors):
        return self.write("allocation.ticket_policy_put", "policy-" + str(revision), ticket_id="a", expected_revision=str(revision), required_capabilities=[], pools=[], allowed_actor_ids=actors)

    def stop(self):
        self.result("daemon.shutdown")
        self.daemon.wait(timeout=10)

    def tearDown(self):
        if self.daemon and self.daemon.poll() is None:
            self.stop()
        self.log.close()
        self.temp.cleanup()

    def test_actor_views_restart_and_historical_receipts(self):
        bad = {"actor_id": "outsider", "run_id": "outsider-run"}
        rejected = self.call("ticket.claim", mutation_id="rejected", ticket_id="a", **bad)
        self.assertEqual(rejected["error"]["data"]["details"]["reasons"], [{"kind": "actor_not_allowed", "actor_id": "outsider"}])
        self.assertEqual([], self.result("ticket.ready", target_run_id="outsider-run")["data"]["items"])
        blocked = self.result("coordinator.overview", run_id="outsider-run", kinds=["allocation_blocked"])["data"]["items"]
        self.assertEqual(blocked[0]["metadata"]["allocation_reasons"], [{"kind": "admission", "reason": {"kind": "actor_not_allowed", "actor_id": "outsider"}}])
        empty = self.write("ticket.claim_next", "empty", target_run_id="outsider-run", attempt_id="empty", **bad)
        self.assertFalse(empty["meta"]["durable"])
        self.assertEqual(empty["data"]["explanation"]["reasons"][0]["kind"], "actor_not_allowed")
        grant = self.write("ticket.claim", "grant", run_id="run", ticket_id="a")
        self.write("ticket.release", "release", run_id="run", ticket_id="a", token=grant["data"]["token"])
        self.assertEqual(["outsider"], self.policy(1, ["outsider"])["data"]["allowed_actor_ids"])
        self.stop()
        self.start()
        # Exact committed retry returns the historical receipt without acquiring
        # work or reauthorizing its former actor under the replacement policy.
        self.assertEqual(grant, self.write("ticket.claim", "grant", run_id="run", ticket_id="a"))
        self.assertEqual(1, len(self.result("ticket.ready", target_run_id="outsider-run")["data"]["items"]))
        selected = self.write("ticket.claim_next", "empty", target_run_id="outsider-run", attempt_id="empty", **bad)
        self.assertTrue(selected["meta"]["durable"])
        self.assertEqual("a", selected["data"]["claim"]["ticket_id"])
        self.assertEqual(selected, self.write("ticket.claim_next", "empty", target_run_id="outsider-run", attempt_id="empty", **bad))


if __name__ == "__main__":
    unittest.main()
