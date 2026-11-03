"""Hierarchy policies survive crash/retry and route only relevant attention."""
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


class Hierarchy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wg-hierarchy-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.address = self.root / "s"
        self.log = (self.root / "daemon.log").open("w+")
        self.daemon = None
        self.counter = 0
        self.start()
        self.write("workspace.create", name="Hierarchy", root=str(self.root / "workspace"))
        self.write("run.register", target_run_id="run", objective="Work")
        for ticket, parent in (("source", None), ("parent", None), ("middle", "parent"), ("leaf", "middle"), ("unrelated", None)):
            params = {} if parent is None else {"parent_ticket_id": parent}
            self.write("ticket.create", ticket_id=ticket, title=ticket, **params)
        self.write("dependency.add", ticket_id="parent", prerequisite_id="source")

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
            params = {"workspace_id": "hierarchy", **params}
        process = subprocess.run([str(EXE), "call", str(self.address), method, json.dumps(params, ensure_ascii=False)], capture_output=True, text=True, timeout=10)
        if not process.stdout:
            self.log.flush()
            self.fail(process.stderr + "\n" + (self.root / "daemon.log").read_text())
        return json.loads(process.stdout)

    def result(self, method, **params):
        reply = self.call(method, **params)
        self.assertIn("result", reply, reply)
        return reply["result"]

    def write(self, method, mutation=None, **params):
        self.counter += 1
        attribution = {} if method == "workspace.create" else {"run_id": "run"}
        return self.result(method, actor_id="worker", mutation_id=mutation or "write-" + str(self.counter), **attribution, **params)

    def policy(self, revision, inheritance="inherit", children="all_done", reason="Reviewed", ticket="parent", mutation=None):
        return self.write("ticket.hierarchy.put", mutation, ticket_id=ticket, expected_revision=str(revision), descendant_prerequisites=inheritance, child_completion=children, reason=reason)

    def read(self, method="attention.read", **params):
        return self.result(method, **params)["data"]

    def stop(self):
        self.result("daemon.shutdown")
        self.daemon.wait(timeout=10)

    def tearDown(self):
        if self.daemon and self.daemon.poll() is None:
            self.stop()
        self.log.close()
        self.temp.cleanup()

    def test_crash_restart_policy_identity_and_public_activity(self):
        before = self.read("ticket.context", ticket_id="parent")["ticket"]["revision"]
        receipt = self.policy(0, mutation="policy")
        self.assertEqual(before, self.read("ticket.context", ticket_id="parent")["ticket"]["revision"])
        self.assertEqual("1", self.read("ticket.hierarchy.get", ticket_id="parent")["policy"]["revision"])
        reasons = self.read("ticket.readiness", ticket_id="leaf")["reasons"]
        self.assertEqual([{"kind": "inherited_prerequisite", "ancestor_ticket_id": "parent", "prerequisite_ticket_id": "source"}], reasons)
        rejected = self.call("ticket.start", actor_id="worker", run_id="run", mutation_id="blocked", ticket_id="leaf", attempt_id="leaf-attempt")
        self.assertEqual("Blocked", rejected["error"]["data"]["kind"])
        self.policy(1, inheritance="independent")
        activity = self.read("activity.since", target={"kind": "ticket", "ticket_id": "parent"})["items"]
        changes = [change for entry in activity for change in entry["changes"] if change["kind"] == "hierarchy_policy_put"]
        self.assertEqual(["1", "2"], [change["policy"]["revision"] for change in changes])
        digest = self.read("activity.digest", scope={"kind": "ticket", "ticket_id": "parent"})["entries"]
        policies = [entry for entry in digest if entry["item"]["kind"] == "hierarchy_policy"]
        self.assertEqual(["decision", "decision"], [entry["category"] for entry in policies])
        self.daemon.kill()
        self.daemon.wait(timeout=10)
        self.start()
        # A historical committed identity freezes its receipt and cannot restore
        # the former policy or acquire anything on retry.
        self.assertEqual(receipt, self.policy(0, mutation="policy"))
        self.assertEqual("independent", self.read("ticket.hierarchy.get", ticket_id="parent")["effective"]["descendant_prerequisites"])
        self.assertEqual([], self.read("ticket.readiness", ticket_id="leaf")["reasons"])
        audit = self.read(filter={"ticket_ids": ["parent"], "kinds": ["ticket"]})["items"]
        policy_rows = [row for row in audit if row["kind"] == "hierarchy_policy_changed"]
        self.assertEqual(["1", "2"], [row["policy_revision"] for row in policy_rows])
        self.write("ticket.start", ticket_id="leaf", attempt_id="leaf-attempt")

    def test_reason_only_and_unrelated_policy_do_not_wake_descendant_wait(self):
        self.policy(0)
        selected = {"kinds": ["readiness"], "ticket_ids": ["leaf"]}
        base = self.read(filter=selected)["cursor"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(self.read, "attention.wait", filter=selected, cursor=base, timeout_ms="3000")
            time.sleep(.04)
            self.policy(0, children="done_or_canceled", ticket="unrelated")
            self.policy(1, reason="Audit reason only")
            time.sleep(.06)
            self.assertFalse(waiting.done(), "unrelated or audit-only hierarchy edit woke selected descendant")
            self.policy(2, inheritance="independent")
            result = waiting.result(timeout=5)
            self.assertEqual(["hierarchy_readiness"], [row["reason"] for row in result["items"]])
            self.assertEqual(["leaf"], [row["source"]["ticket_id"] for row in result["readiness"]["items"]])

    def test_large_policy_audit_reason_requires_budget_without_fabricated_clipping(self):
        before = self.read(filter={"ticket_ids": ["parent"], "kinds": ["ticket"]})["through"]
        reason = "é" * 32768
        self.policy(0, reason=reason)
        params = {"scope": {"kind": "ticket", "ticket_id": "parent"}, "after": before}
        small = self.call("activity.digest", max_bytes="4096", **params)
        self.assertEqual("Invalid_argument", small["error"]["data"]["kind"])
        large = self.read("activity.digest", max_bytes="1048576", **params)
        item = large["entries"][0]["item"]
        self.assertEqual("hierarchy_policy", item["kind"])
        self.assertEqual(reason, item["record"]["reason"])
        self.assertEqual([], item["clipped_fields"])

    def test_amendment_publication_and_ack_digest_reuse_exact_typed_changes(self):
        self.write("ticket.claim", ticket_id="leaf")
        before = self.read(filter={"ticket_ids": ["leaf"], "kinds": ["ticket"]})["through"]
        body = "Z" * 65536
        published = self.write("ticket.amendment.publish", amendment_id="instruction", ticket_id="leaf", expected_revision="0", title="Instruction", source={"kind": "text", "body": body}, require_ack=True)
        scope = {"kind": "ticket", "ticket_id": "leaf"}
        small = self.call("activity.digest", scope=scope, after=before, max_bytes="4096")
        self.assertEqual("Invalid_argument", small["error"]["data"]["kind"])
        def exact_change(after, revision):
            history = self.read("activity.since", target=scope, after=after, max_bytes="1048576")["items"]
            event = next(event for event in history if event["revision"] == revision)
            expected = next(change["change"] for change in event["changes"] if change["kind"] == "amendment_changed")
            digest = self.read("activity.digest", scope=scope, after=after, max_bytes="1048576")["entries"]
            entries = [entry for entry in digest if entry["item"]["kind"] == "amendment"]
            self.assertEqual(1, len(entries))
            entry = entries[0]
            self.assertEqual(expected, entry["item"]["record"])
            self.assertEqual([], entry["item"]["clipped_fields"])
            self.assertEqual(revision, entry["workspace_revision"])
            self.assertIn({"kind": "planning_change", "workspace_revision": revision, "change_index": entry["change_index"]}, entry["item"]["sources"])
            return entry["item"]["record"]
        publication = exact_change(before, published["meta"]["workspace_revision"])
        self.assertIn(body, json.dumps(publication))
        before = published["meta"]["workspace_revision"]
        ack = self.write("ticket.amendment.acknowledge", amendment_id="instruction", expected_revision="1", ticket_id="leaf", token="1")
        exact_change(before, ack["meta"]["workspace_revision"])

    def test_frozen_continuation_and_parent_move_remain_exact(self):
        selected = {"kinds": ["readiness"], "ticket_ids": ["leaf"]}
        base = self.read(filter=selected)["through"]
        self.policy(0)
        self.policy(1, inheritance="independent")
        self.policy(2)
        first = self.read(filter=selected, after=base, limit="1")
        self.assertTrue(first["has_more"])
        expected = self.read(filter=selected, cursor=first["cursor"], limit="1")
        before_move = self.read(filter=selected)["through"]
        revision = self.read("ticket.context", ticket_id="middle")["ticket"]["revision"]
        self.write("ticket.move", ticket_id="middle", expected_revision=revision, project_id=None, milestone_id=None, parent_ticket_id="unrelated")
        repeated = self.read(filter=selected, cursor=first["cursor"], limit="1")
        self.assertEqual(expected["through"], repeated["through"])
        self.assertEqual(expected["items"], repeated["items"])
        moved = self.read(filter=selected, after=before_move)
        self.assertTrue(moved["items"], "removing ancestor condition must invalidate descendant readiness")
        self.assertEqual([], self.read("ticket.readiness", ticket_id="leaf")["reasons"])


if __name__ == "__main__":
    unittest.main()
