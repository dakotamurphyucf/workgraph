"""Independent typed coordinator capture and whole commit feed socket contracts."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
ADAPTER = Path(__file__).resolve().parents[2] / "examples/history-adapter.py"
spec = importlib.util.spec_from_file_location("history_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class CoordinatorSocketTest(unittest.TestCase):
    def test_typed_sources_capture_fences_and_whole_feed_targets(self):
        with tempfile.TemporaryDirectory(prefix="wg-coordinator-", dir="/tmp") as temporary:
            root = Path(temporary)
            address = root / "s"
            with (root / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)],
                                          stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None:
                            log.seek(0)
                            self.fail(log.read())
                        if time.monotonic() >= deadline:
                            self.fail("daemon startup timed out")
                        time.sleep(.01)
                    client = adapter.Workgraph(address)
                    def call(method, **params):
                        return client.call(method, params)
                    def body(method, **params):
                        return adapter.body(call(method, **params))
                    scope = {"workspace_id": "coord"}
                    def mutate(method, mutation, **params):
                        return body(method, **scope, actor_id="owner", mutation_id=mutation, **params)
                    mutate("workspace.create", "workspace", name="Coordination", root=str(root / "workspace"))
                    for name in ("a", "b", "c"):
                        mutate("ticket.create", "create-" + name, ticket_id=name, title=name)
                    first = body("coordinator.overview", **scope, kinds=["ready_work"], limit="1")
                    self.assertEqual(first["workspace_id"], "coord")
                    self.assertEqual(first["items"][0]["source"], {"kind": "ticket", "ticket_id": "a"})
                    self.assertEqual(first["items"][0]["metadata"]["allocation_reasons"], [])
                    second = body("coordinator.overview", **scope, kinds=["ready_work"], limit="1", cursor=first["next_cursor"])
                    self.assertEqual(second["items"][0]["source"]["ticket_id"], "b")
                    self.assertEqual(second["captured_now_unix_ms"], first["captured_now_unix_ms"])
                    mutate("ticket.create", "new-capture", ticket_id="d", title="D")
                    with self.assertRaises(RuntimeError) as changed:
                        body("coordinator.overview", **scope, kinds=["ready_work"], cursor=second["next_cursor"])
                    self.assertEqual(json.loads(str(changed.exception))["data"]["kind"], "Conflict")
                    with self.assertRaises(RuntimeError) as old_field:
                        body("coordinator.overview", **scope, run="unknown")
                    self.assertEqual(json.loads(str(old_field.exception))["data"]["kind"], "Invalid_argument")
                    with self.assertRaises(RuntimeError) as unknown:
                        body("coordinator.overview", **scope, run_id="unknown")
                    self.assertEqual(json.loads(str(unknown.exception))["data"]["kind"], "Not_found")
                    mutate("run.register", "selected-run", target_run_id="run", objective="Work")
                    mutate("ticket.paths.put", "selected-paths", ticket_id="a", expected_revision="0",
                           require_reservations=True, declarations=[{"target": {"worktree_id": "tree", "kind": "subtree", "path": "src"}, "mode": "exclusive"}])
                    absent = body("coordinator.overview", **scope, kinds=["allocation_blocked"])
                    self.assertEqual(absent["items"][0]["metadata"]["blockers"]["reason_count"], "1")
                    self.assertEqual(absent["items"][0]["metadata"]["blockers"]["reasons"][0]["kind"], "run_required")
                    selected = body("coordinator.overview", **scope, kinds=["ready_work"], run_id="run")
                    selected_a = next(row for row in selected["items"] if row["source"]["ticket_id"] == "a")
                    self.assertTrue(selected_a["metadata"]["blockers"]["ready"])
                    self.assertEqual(selected_a["metadata"]["blockers"]["reasons"], [])
                    self.assertEqual(selected_a["metadata"]["eligibility_scope"], "run")
                    base = body("changes.read", **scope)
                    ids = ["target-" + str(i) + "-" + "x" * 78 for i in range(32)]
                    mutate("transaction.apply", "whole-targets", operations=[
                        {"method": "ticket.create", "params": {"ticket_id": name, "title": str(i)}}
                        for i, name in enumerate(ids)])
                    tiny_response = call("changes.read", **scope, cursor=base["cursor"], max_bytes="4096")
                    tiny = adapter.body(tiny_response)
                    self.assertEqual(tiny["items"], [])
                    self.assertTrue(tiny["needs_larger_budget"])
                    self.assertTrue(tiny["has_more"])
                    self.assertEqual(tiny_response["meta"]["budget"]["omitted_fields"], "0")
                    self.assertEqual(tiny_response["meta"]["budget"]["omitted_items"], "1")
                    actual_bytes = len(json.dumps(tiny_response, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode())
                    self.assertEqual(int(tiny_response["meta"]["budget"]["returned_bytes"]), actual_bytes)
                    mutate("ticket.create", "later", ticket_id="later", title="Later")
                    whole = body("changes.read", **scope, cursor=tiny["cursor"], max_bytes="1048576")
                    self.assertEqual(len(whole["items"]), 1)
                    item = whole["items"][0]
                    self.assertEqual(item["actor_id"], "owner")
                    self.assertIsNone(item["run_id"])
                    self.assertEqual(item["kinds"], ["ticket_put"])
                    captured = {t["ticket_id"] for t in item["targets"] if t["kind"] == "ticket"}
                    self.assertEqual(captured, set(ids))
                    self.assertEqual(whole["through"], tiny["through"])
                    self.assertFalse(whole["has_more"])
                    call("daemon.shutdown")
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)],
                                              stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    later = body("changes.read", **scope, cursor=whole["cursor"])
                    self.assertEqual(len(later["items"]), 1)
                    self.assertEqual(later["items"][0]["kinds"], ["ticket_put"])
                    call("daemon.shutdown")
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            daemon.wait()


if __name__ == "__main__":
    unittest.main()
