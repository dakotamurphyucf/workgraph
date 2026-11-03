"""Captured attention pagination, explicit ack, parked waits and current eligibility."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
EXE = Path(sys.argv.pop(1)).resolve()
SPEC = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[2] / "examples/history-adapter.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)

class AttentionTest(unittest.TestCase):
    def test_captures_groups_overview_and_filtered_wait(self):
        with tempfile.TemporaryDirectory(prefix="wg-attention-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            log = (root / "daemon.log").open("w+")
            daemon = None
            mutation = 0
            def start():
                nonlocal daemon
                daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 10
                while not is_listening(address):
                    if daemon.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        self.fail(log.read())
                    time.sleep(.01)
            def call(method, **params):
                return adapter.Workgraph(address).call(method, {"workspace_id": "attention", **params})
            def read(method="attention.read", **params):
                return call(method, **params)["data"]
            def write(method, **params):
                nonlocal mutation
                mutation += 1
                return call(method, actor_id="alice", mutation_id=f"m-{mutation}", **params)
            def reject(method, kind="Invalid_argument", **params):
                with self.assertRaises(RuntimeError) as error:
                    call(method, **params)
                self.assertEqual(json.loads(str(error.exception))["data"]["kind"], kind)
            bob = {"kind": "actor", "id": "bob"}
            communication = {"kinds": ["communication"], "consumer_id": "driver", "recipient": bob}
            def ask(identifier):
                return {"method": "request.ask", "params": {"request_id": identifier, "title": identifier, "body": "Same text", "resolver_id": "alice", "recipients": [bob]}}
            try:
                start()
                write("workspace.create", name="Attention", root=str(root / "workspace"))
                write("transaction.apply", operations=[ask("one"), ask("two")])
                first = read(filter=communication, limit="1")
                self.assertEqual(len(first["items"]), 1)
                self.assertTrue(first["has_more"])
                through = first["through"]
                ids = first["items"][0]["notification_ids"]
                self.assertEqual(ids, [n["notification_id"] for n in first["items"][0]["notifications"]])
                write("fact.put", scope={"kind": "workspace"}, key="unrelated", expected_revision="0", value=True)
                second = read(filter=communication, cursor=first["cursor"], limit="1")
                self.assertEqual(second["through"], through)
                self.assertNotEqual(first["items"][0]["group_id"], second["items"][0]["group_id"])
                self.assertEqual(len(second["items"]), 1)
                reject("attention.read", "Conflict", filter={**communication, "exclude_self": True}, cursor=first["cursor"])
                reject("attention.read", filter={"kinds": ["communication"]})
                reject("attention.read", filter={"kinds": ["fact"], "unknown": True})
                reject("attention.read", filter={"kinds": ["fact", "fact"]})
                reject("attention.read", filter={"consumer_id": "driver"})
                # Acknowledgement consumes selected delivery IDs only, never requests.
                call("inbox.ack", actor_id="bob", mutation_id="ack", consumer_id="driver", recipient=bob, notification_ids=ids)
                overview = read("actor.overview", actor_id="bob", consumer_id="driver", kinds=["request"])
                self.assertEqual(len(overview["items"]), 2)
                self.assertTrue(all("incoming_delivery" in row["roles"] for row in overview["items"]))
                own = read("actor.overview", actor_id="alice", kinds=["request"])
                self.assertEqual(own["items"][0]["roles"], ["incoming_resolver", "outgoing"])
                page = read("actor.overview", actor_id="bob", kinds=["request"], limit="1")
                write("fact.put", scope={"kind": "workspace"}, key="noise", expected_revision="0", value=1)
                reject("actor.overview", "Conflict", actor_id="bob", kinds=["request"], cursor=page["cursor"])
                # Frozen audit continuation is valid across restart, later ack and commits.
                daemon.terminate(); daemon.wait(timeout=10); start()
                repeated = read(filter=communication, cursor=first["cursor"], limit="1")
                self.assertEqual(repeated["items"], second["items"])
                # 32 operations can cause >32 raw deliveries in one logical group.
                before = read(filter=communication)["cursor"]
                operations = [ask("fragmented")] + [
                    {"method": "request.metadata", "params": {"request_id": "fragmented", "expected_revision": str(i + 1), "priority": str((i % 4) + 1)}}
                    for i in range(31)]
                operations[0]["params"]["resolver_id"] = "bob"
                write("transaction.apply", operations=operations)
                tiny = read(filter=communication, cursor=before, max_bytes="4096")
                self.assertEqual(tiny["items"], [])
                self.assertTrue(tiny["needs_larger_budget"])
                self.assertGreater(int(tiny["required_bytes"]), 4096)
                large = read(filter=communication, cursor=tiny["cursor"], max_bytes="1048576")
                self.assertEqual(len(large["items"]), 2)
                self.assertEqual(large["items"][0]["fragment_count"], "2")
                all_ids = [i for row in large["items"] for i in row["notification_ids"]]
                self.assertEqual(len(all_ids), 34)
                self.assertEqual(len(all_ids), len(set(all_ids)))
                self.assertEqual(large["items"][0]["group_id"], large["items"][1]["group_id"])
                # Facts inside one transaction page by exact change index, not commit alone.
                facts = {"kinds": ["fact"], "fact_scope": {"kind": "workspace"}, "fact_prefix": "selected."}
                base = read(filter=facts)["cursor"]
                write("transaction.apply", operations=[
                    {"method": "fact.put", "params": {"scope": {"kind": "workspace"}, "key": "selected." + str(i), "expected_revision": "0", "value": i}}
                    for i in range(2)])
                fact_one = read(filter=facts, cursor=base, limit="1")
                write("fact.put", scope={"kind": "workspace"}, key="selected.later", expected_revision="0", value=3)
                fact_two = read(filter=facts, cursor=fact_one["cursor"], limit="1")
                self.assertEqual(fact_one["through"], fact_two["through"])
                self.assertNotEqual(fact_one["items"][0]["source"]["change_index"], fact_two["items"][0]["source"]["change_index"])
                # Wait stays parked through unrelated commits and wakes on selected prefix.
                base = read(filter=facts)["cursor"]
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(read, "attention.wait", filter=facts, cursor=base, timeout_ms="3000")
                    time.sleep(.08)
                    write("fact.put", scope={"kind": "workspace"}, key="not-selected", expected_revision="0", value=False)
                    time.sleep(.08)
                    self.assertFalse(future.done())
                    write("fact.put", scope={"kind": "workspace"}, key="selected.wake", expected_revision="0", value="wake")
                    result = future.result(timeout=5)
                    self.assertEqual(len(result["items"]), 1)
                    self.assertEqual(result["items"][0]["fact"]["key"], "selected.wake")
                # Read/park races are covered by immediate commits after wait submission.
                for i in range(8):
                    base = read(filter=facts)["cursor"]
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        future = pool.submit(read, "attention.wait", filter=facts, cursor=base, timeout_ms="1000")
                        write("fact.put", scope={"kind": "workspace"}, key=f"selected.race-{i}", expected_revision="0", value=i)
                        self.assertEqual(len(future.result(timeout=3)["items"]), 1)
                # Current eligibility is independently captured and never asserted historical.
                write("ticket.create", ticket_id="ready-a", title="Ready A")
                write("ticket.create", ticket_id="ready-b", title="Ready B")
                readiness = {"kinds": ["readiness"]}
                snapshot = read(filter=readiness, initial_readiness=True, limit="1")
                self.assertIsNotNone(snapshot["readiness"])
                self.assertEqual(len(snapshot["readiness"]["items"]), 1)
                self.assertTrue(snapshot["readiness"]["has_more"])
                current_cursor = snapshot["readiness"]["cursor"]
                write("fact.put", scope={"kind": "workspace"}, key="later-current", expected_revision="0", value=1)
                reject("attention.read", "Conflict", filter=readiness, readiness_cursor=current_cursor)
                # Dependency effects invalidate selected work even when the dependent
                # itself has no audit mutation in the completion transaction.
                write("ticket.create", ticket_id="prerequisite", title="Prerequisite")
                write("ticket.create", ticket_id="dependent", title="Dependent")
                write("dependency.add", ticket_id="dependent", prerequisite_id="prerequisite")
                prerequisite_claim = write("ticket.claim", ticket_id="prerequisite")["data"]
                selected_ready = {"kinds": ["readiness"], "ticket_ids": ["dependent"]}
                base = read(filter=selected_ready)["cursor"]
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(read, "attention.wait", filter=selected_ready, cursor=base, timeout_ms="3000")
                    time.sleep(.04)
                    write("fact.put", scope={"kind": "workspace"}, key="irrelevant-to-ready", expected_revision="0", value=1)
                    time.sleep(.04)
                    self.assertFalse(future.done())
                    write("ticket.complete", ticket_id="prerequisite", token=prerequisite_claim["token"], evidence="prerequisite checked")
                    ready = future.result(timeout=5)
                    self.assertEqual(ready["readiness"]["items"][0]["source"]["ticket_id"], "dependent")
                # Pool capacity and conflicting path releases are readiness causes.
                write("run.register", target_run_id="worker", objective="Work")
                write("run.register", target_run_id="holder", objective="Hold")
                write("allocation.pool_put", name="shared", expected_revision="0", limit="1")
                for name in ("dependent", "occupant"):
                    if name == "occupant":
                        write("ticket.create", ticket_id=name, title=name)
                    write("allocation.ticket_policy_put", ticket_id=name, expected_revision="0", required_capabilities=[], pools=["shared"])
                write("ticket.start", ticket_id="occupant", run_id="worker", attempt_id="occupied-attempt")
                selected_ready["run_id"] = "worker"
                blocked = read(filter=selected_ready, initial_readiness=True)
                self.assertEqual(blocked["readiness"]["items"], [])
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(read, "attention.wait", filter=selected_ready, cursor=blocked["cursor"], timeout_ms="3000")
                    time.sleep(.04)
                    write("allocation.pool_put", name="shared", expected_revision="1", limit="2")
                    capacity = future.result(timeout=5)
                    self.assertEqual(capacity["readiness"]["items"][0]["source"]["ticket_id"], "dependent")
                target = {"worktree_id": "tree", "kind": "subtree", "path": "src"}
                write("ticket.paths.put", ticket_id="dependent", expected_revision="0", require_reservations=True,
                      declarations=[{"target": target, "mode": "exclusive"}])
                write("reservation.paths.acquire", target_run_id="holder", requests=[{"target": target, "mode": "exclusive"}])
                blocked = read(filter=selected_ready, initial_readiness=True)
                self.assertEqual(blocked["readiness"]["items"], [])
                holder = read("reservation.path.get", target=target)["holders"][0]
                ownership = read("actor.overview", actor_id="alice", kinds=["claim", "attempt", "path_reservation"])
                self.assertEqual({row["kind"] for row in ownership["items"]}, {"claim", "attempt", "path_reservation"})
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(read, "attention.wait", filter=selected_ready, cursor=blocked["cursor"], timeout_ms="3000")
                    time.sleep(.04)
                    write("reservation.path.release", target=target, target_run_id="holder", token=holder["token"])
                    free = future.result(timeout=5)
                    self.assertEqual(free["readiness"]["items"][0]["source"]["ticket_id"], "dependent")
                # Project and run source filters are exact, including mixed-scope batches.
                for name in ("selected-project", "other-project"):
                    write("project.create", project_id=name, title=name)
                write("transaction.apply", run_id="worker", operations=[
                    {"method": "fact.put", "params": {"scope": {"kind": "project", "id": project}, "key": "scoped.fact", "expected_revision": "0", "value": project}}
                    for project in ("selected-project", "other-project")])
                scoped = {"kinds": ["fact"], "project_id": "selected-project", "run_id": "worker", "fact_prefix": "scoped."}
                self.assertEqual(len(read(filter=scoped)["items"]), 1)
                self.assertEqual(read(filter={**scoped, "run_id": "holder"})["items"], [])
                # A frozen page must not acquire old readiness rows when later
                # dependency/pool/path routing changes make those old events relevant.
                write("ticket.create", ticket_id="routing-selected", project_id="selected-project", title="Routing selected")
                write("ticket.create", ticket_id="routing-outside", project_id="other-project", title="Routing outside")
                frozen_filter = {"kinds": ["readiness", "fact"], "project_id": "selected-project", "ticket_ids": ["routing-selected"]}
                frozen_base = read(filter=frozen_filter)["cursor"]
                write("ticket.claim", ticket_id="routing-outside", run_id="holder")
                write("allocation.pool_put", name="routing-pool", expected_revision="0", limit="1")
                routing_path = {"worktree_id": "tree", "kind": "subtree", "path": "routing"}
                write("reservation.paths.acquire", target_run_id="holder", requests=[{"target": routing_path, "mode": "exclusive"}])
                for i in range(2):
                    write("fact.put", scope={"kind": "ticket", "id": "routing-selected"}, key=f"frozen-{i}", expected_revision="0", value=i)
                expected = read(filter=frozen_filter, cursor=frozen_base, max_bytes="1048576")
                frozen = read(filter=frozen_filter, cursor=frozen_base, limit="1")
                self.assertEqual(len(expected["items"]), 2)
                self.assertTrue(frozen["has_more"])
                def still_frozen():
                    continued = read(filter=frozen_filter, cursor=frozen["cursor"], max_bytes="1048576")
                    self.assertEqual(continued["through"], frozen["through"])
                    self.assertEqual(frozen["items"] + continued["items"], expected["items"])
                write("dependency.add", ticket_id="routing-selected", prerequisite_id="routing-outside")
                still_frozen()
                write("allocation.ticket_policy_put", ticket_id="routing-selected", expected_revision="0", required_capabilities=[], pools=["routing-pool"])
                still_frozen()
                write("ticket.paths.put", ticket_id="routing-selected", expected_revision="0", require_reservations=True,
                      declarations=[{"target": routing_path, "mode": "exclusive"}])
                still_frozen()
                # Moving selected membership after capturing pool invalidation must
                # not remove that old row and skip a following fact fragment.
                membership_base = read(filter=frozen_filter)["cursor"]
                write("allocation.pool_put", name="routing-pool", expected_revision="1", limit="2")
                for i in range(2):
                    write("fact.put", scope={"kind": "ticket", "id": "routing-selected"}, key=f"membership-{i}", expected_revision="0", value=i)
                membership_expected = read(filter=frozen_filter, cursor=membership_base, max_bytes="1048576")
                membership_first = read(filter=frozen_filter, cursor=membership_base, limit="1")
                ticket = read("ticket.context", ticket_id="routing-selected")["ticket"]
                write("ticket.move", ticket_id="routing-selected", expected_revision=ticket["revision"], project_id="other-project", milestone_id=None, parent_ticket_id=None)
                membership_rest = read(filter=frozen_filter, cursor=membership_first["cursor"], max_bytes="1048576")
                self.assertEqual(membership_first["items"] + membership_rest["items"], membership_expected["items"])
                # Claims without attempts occupy shared pools too. Releasing one
                # in another project invalidates selected run eligibility.
                write("allocation.pool_put", name="cross-project", expected_revision="0", limit="1")
                for identity, project in (("pool-selected", "selected-project"), ("pool-outside", "other-project")):
                    write("ticket.create", ticket_id=identity, project_id=project, title=identity)
                    write("allocation.ticket_policy_put", ticket_id=identity, expected_revision="0", required_capabilities=[], pools=["cross-project"])
                claim = write("ticket.claim", ticket_id="pool-outside", run_id="holder")["data"]
                held = read("actor.overview", actor_id="alice", run_id="holder", kinds=["claim", "attempt"])
                self.assertTrue(any(row["kind"] == "claim" and row["ticket_id"] == "pool-outside" for row in held["items"]))
                self.assertFalse(any(row["kind"] == "attempt" for row in held["items"]))
                cross_filter = {"kinds": ["readiness"], "project_id": "selected-project", "ticket_ids": ["pool-selected"], "run_id": "worker"}
                blocked = read(filter=cross_filter, initial_readiness=True)
                self.assertEqual(blocked["readiness"]["items"], [])
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(read, "attention.wait", filter=cross_filter, cursor=blocked["cursor"], timeout_ms="2000")
                    time.sleep(.04)
                    write("ticket.release", ticket_id="pool-outside", run_id="holder", token=claim["token"])
                    available = future.result(timeout=4)
                    self.assertEqual(available["readiness"]["items"][0]["source"]["ticket_id"], "pool-selected")
                # Timeout is nondurable and safely advances unmatched audit ranges.
                empty_filter = {"kinds": ["fact"], "fact_prefix": "never."}
                prior = read(filter=empty_filter)
                empty = read("attention.wait", filter=empty_filter, cursor=prior["cursor"], timeout_ms="20")
                self.assertEqual(empty["items"], [])
                self.assertEqual(empty["through"], prior["through"])
            finally:
                if daemon is not None:
                    daemon.terminate(); daemon.wait(timeout=10)
                log.close()

if __name__ == "__main__":
    unittest.main()
