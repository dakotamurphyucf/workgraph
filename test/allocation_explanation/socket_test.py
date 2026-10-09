"""Empty allocation diagnosis uses captured selection state and durable retry receipts."""
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


class AllocationExplanation(unittest.TestCase):
    def test_reasons_budget_parents_and_exact_retry(self):
        with tempfile.TemporaryDirectory(prefix="wg-alloc-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
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
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "allocation", **params}
                    response = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    result = json.loads(response.stdout)
                    self.assertIn("result", result, result)
                    return result["result"]

                def write(method, mutation, **params):
                    return call(method, actor_id="worker", mutation_id=mutation, **params)

                def allocate(mutation, **params):
                    return write("ticket.claim_next", mutation, target_run_id="run", run_id="run", attempt_id=mutation, **params)

                def stop():
                    call("daemon.shutdown")
                    daemon.wait(timeout=10)

                try:
                    start()
                    write("workspace.create", "workspace", name="Allocation", root=str(root / "workspace"))
                    write("run.register", "run", target_run_id="run", objective="Work")
                    empty = allocate("empty")
                    self.assertEqual("0", empty["data"]["explanation"]["candidate_count"])
                    self.assertEqual([], empty["data"]["explanation"]["reasons"])
                    self.assertEqual(int(empty["meta"]["workspace_revision"])-1, int(empty["data"]["explanation"]["captured_workspace_revision"]))
                    write("allocation.pool_put", "pool", name="build", expected_revision="0", limit="1")
                    for ticket in ("a", "b"):
                        write("ticket.create", ticket, ticket_id=ticket, title=ticket)
                        write("allocation.ticket_policy_put", "policy-"+ticket, ticket_id=ticket, expected_revision="0", required_capabilities=[], pools=["build"])
                    selected = allocate("first")
                    self.assertEqual("a", selected["data"]["claim"]["ticket_id"])
                    pooled = allocate("pool-empty")
                    reasons = {row["kind"]: row for row in pooled["data"]["explanation"]["reasons"]}
                    self.assertEqual("2", reasons["pool_full"]["count"])
                    self.assertEqual(["a"], reasons["claimed"]["example_ticket_ids"])
                    write("run.budget_put", "budget", target_run_id="run", expected_revision="0", max_attempts="1", max_active_attempts="1", reported_token_limit=None, reported_elapsed_ms_limit=None)
                    budgeted = allocate("budget-empty")
                    self.assertEqual([{"kind":"attempts","used":"1","limit":"1"}, {"kind":"active_attempts","used":"1","limit":"1"}], budgeted["data"]["explanation"]["run_limits"])
                    write("ticket.finish", "finish-a", run_id="run", ticket_id="a", token=selected["data"]["claim"]["token"], evidence="Checked")
                    write("run.budget_put", "budget-grow", target_run_id="run", expected_revision="1", max_attempts="10", max_active_attempts="2", reported_token_limit=None, reported_elapsed_ms_limit=None)
                    write("allocation.ticket_policy_put", "capability", ticket_id="b", expected_revision="1", required_capabilities=["ocaml"], pools=[])
                    cap = allocate("cap-empty")
                    reasons = {row["kind"]: row for row in cap["data"]["explanation"]["reasons"]}
                    self.assertEqual(["b"], reasons["missing_capability"]["example_ticket_ids"])
                    write("project.create", "project", project_id="p", title="Parents")
                    write("ticket.create", "parent", ticket_id="parent", project_id="p", title="Parent")
                    write("ticket.create", "child", ticket_id="child", project_id="p", parent_ticket_id="parent", title="Child")
                    write("ticket.hold", "hold-child", ticket_id="child", expected_revision="1", reason="Waiting")
                    parent = allocate("parent-empty", project_id="p", leaf_only=True)
                    self.assertEqual([{"kind":"not_ready","count":"1","example_ticket_ids":["child"],"omitted_examples":"0"}, {"kind":"parent_filtered","count":"1","example_ticket_ids":["parent"],"omitted_examples":"0"}], parent["data"]["explanation"]["reasons"])
                    chosen = allocate("parent-selected", project_id="p", leaf_only=False)
                    self.assertEqual("parent", chosen["data"]["claim"]["ticket_id"])
                    self.assertEqual(empty, allocate("empty"))
                    self.assertEqual(pooled, allocate("pool-empty"))
                    self.assertEqual(budgeted, allocate("budget-empty"))
                    self.assertEqual(parent, allocate("parent-empty", project_id="p", leaf_only=True))
                    stop()
                    start()
                    self.assertEqual(pooled, allocate("pool-empty"))
                    self.assertEqual(budgeted, allocate("budget-empty"))
                    self.assertEqual(parent, allocate("parent-empty", project_id="p", leaf_only=True))
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
