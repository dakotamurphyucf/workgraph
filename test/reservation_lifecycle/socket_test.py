"""Durable automatic ownership, exact acquisition retries and scoped path wakeups."""
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


class Reservations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wg-holds-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.address = self.root / "s"
        self.log = (self.root / "daemon.log").open("w+")
        self.daemon = None
        self.start()
        self.grant("workspace.create", "workspace", name="Reservations", root=str(self.root / "workspace"))
        for run in ["run", "other"]:
            self.grant("run.register", "register-" + run, target_run_id=run, objective="work")
        for ticket, kind, path in [("a", "subtree", "src"), ("b", "file", "src/b.ml"), ("c", "file", "src/c.ml")]:
            self.grant("ticket.create", "create-" + ticket, ticket_id=ticket, title=ticket)
            self.grant("ticket.paths.put", "paths-" + ticket, ticket_id=ticket, expected_revision="0",
                       require_reservations=True,
                       declarations=[{"target": self.target(path, kind), "mode": "exclusive"}])

    def target(self, path, kind="file", tree="tree"):
        return {"worktree_id": tree, "kind": kind, "path": path}

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
            params = {"workspace_id": "reservations", **params}
        response = subprocess.run([str(EXE), "call", str(self.address), method, json.dumps(params)],
                                  capture_output=True, text=True, timeout=10)
        self.assertTrue(response.stdout, response.stderr)
        return json.loads(response.stdout)

    def write(self, method, mutation, **params):
        return self.call(method, **{"actor_id": "worker", "mutation_id": mutation, **params})

    def grant(self, method, mutation, **params):
        reply = self.write(method, mutation, **params)
        self.assertIn("result", reply, reply)
        return reply["result"]

    def read(self, method, **params):
        reply = self.call(method, **params)
        self.assertIn("result", reply, reply)
        return reply["result"]["data"]

    def hold(self):
        return self.read("reservation.path.get", target=self.target("src", "subtree"))

    def test_batch_receipts_exact_retry_after_release_and_restart(self):
        requests = [{"target": self.target(path), "mode": "shared"} for path in ["z", "a"]]
        receipt = self.grant("reservation.paths.acquire", "paths", run_id="run", target_run_id="run", requests=requests)
        holds = receipt["data"]["holds"]
        self.assertEqual(["a", "z"], [row["target"]["path"] for row in holds])
        self.assertEqual(["1", "1"], [row["holder"]["token"] for row in holds])
        self.assertTrue(all(row["holder"]["origin"] == {"kind": "manual"} for row in holds))
        failed = self.write("reservation.paths.acquire", "fail", run_id="other", target_run_id="other",
                            requests=[{"target": self.target("0-free"), "mode": "exclusive"},
                                      {"target": self.target("z"), "mode": "exclusive"}])
        diagnostic = failed["error"]["data"]["details"]
        self.assertEqual("reservation_conflict", diagnostic["type"])
        self.assertNotIn("token", json.dumps(diagnostic))
        rows = self.read("reservation.path.list", target_run_id="other")["items"]
        self.assertEqual([], rows)
        for row in holds:
            self.grant("reservation.path.release", "release-" + row["target"]["path"], run_id="run",
                       target_run_id="run", target=row["target"], token=row["holder"]["token"])
        self.stop()
        self.start()
        self.assertEqual(receipt, self.grant("reservation.paths.acquire", "paths", run_id="run",
                                            target_run_id="run", requests=requests))
        self.assertEqual([], self.read("reservation.path.list", target_run_id="run")["items"])
        named = self.grant("reservation.acquire", "named", run_id="run", target_run_id="run",
                           requests=[{"reservation_id": "db", "mode": "exclusive"}])
        self.assertEqual("1", named["data"]["holds"][0]["holder"]["token"])
        self.assertEqual(named, self.grant("reservation.acquire", "named", run_id="run", target_run_id="run",
                                          requests=[{"reservation_id": "db", "mode": "exclusive"}]))

    def test_last_narrow_borrower_release_wakes_overlapping_sibling_and_replays(self):
        a = self.grant("ticket.claim", "a", run_id="run", ticket_id="a")
        b = self.grant("ticket.claim", "b", run_id="run", ticket_id="b")
        self.assertEqual(["a", "b"], [c["ticket_id"] for c in self.hold()["holders"][0]["origin"]["borrowers"]])
        self.grant("ticket.release", "release-a", run_id="run", ticket_id="a", token=a["data"]["token"])
        self.assertEqual(["b"], [c["ticket_id"] for c in self.hold()["holders"][0]["origin"]["borrowers"]])
        selected = {"kinds": ["readiness"], "ticket_ids": ["c"], "run_id": "other"}
        blocked = self.read("attention.read", filter=selected, initial_readiness=True)
        self.assertEqual([], blocked["readiness"]["items"])
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.read, "attention.wait", filter=selected, cursor=blocked["cursor"], timeout_ms="3000")
            time.sleep(.05)
            self.grant("fact.put", "unrelated", scope={"kind": "workspace"}, key="unrelated", expected_revision="0", value=True)
            time.sleep(.05)
            self.assertFalse(future.done())
            self.grant("ticket.finish", "finish-b", run_id="run", ticket_id="b", token=b["data"]["token"], evidence="done")
            wake = future.result(timeout=5)
            self.assertTrue(any(row["kind"] == "readiness_invalidated" for row in wake["items"]))
            self.assertEqual(["c"], [row["source"]["ticket_id"] for row in wake["readiness"]["items"]])
        self.assertEqual([], self.hold()["holders"])
        self.stop()
        self.start()
        self.assertEqual([], self.hold()["holders"])
        self.assertEqual(b, self.grant("ticket.claim", "b", run_id="run", ticket_id="b"))
        self.assertEqual([], self.hold()["holders"])
        self.grant("ticket.claim", "other-c", run_id="other", ticket_id="c")


if __name__ == "__main__":
    unittest.main()
