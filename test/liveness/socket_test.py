"""Advisory observation diagnostics and exact held-work capture across restart."""
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


class Liveness(unittest.TestCase):
    def test_held_records_shared_scopes_capture_and_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-liveness-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=log)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "liveness", **params}
                    result = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                    self.assertTrue(result.stdout, result.stderr)
                    return json.loads(result.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    return ok(method, actor_id="worker", mutation_id=mutation, **params)

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                def overview(**params):
                    return ok("coordinator.overview", **params)["data"]

                def counts(row):
                    return row["metadata"]["held_work"]

                try:
                    start()
                    write("workspace.create", "workspace", name="Liveness", root=str(root / "workspace"))
                    for run in ["a-run", "b-run", "unknown"]:
                        write("run.register", "register-" + run, target_run_id=run, objective="Work")
                    src = {"worktree_id": "tree", "kind": "subtree", "path": "src"}
                    vendor = {"worktree_id": "tree", "kind": "subtree", "path": "vendor"}
                    for project in ["a-project", "b-project"]:
                        write("project.create", "create-" + project, project_id=project, title=project)
                    for ticket in ["a", "b"]:
                        write("ticket.create", "create-" + ticket, ticket_id=ticket, title=ticket, project_id=ticket + "-project")
                        write("ticket.paths.put", "paths-" + ticket, ticket_id=ticket, expected_revision="0", require_reservations=True,
                              declarations=[{"target": src, "mode": "exclusive"}])
                        write("ticket.start", "start-" + ticket, run_id="a-run", ticket_id=ticket, attempt_id="try-" + ticket,
                              **({"lease_duration_ms": "1"} if ticket == "a" else {}))
                    # Both borrowers share one automatic covering path record.
                    held = ok("reservation.path.get", target=src)["data"]["holders"]
                    self.assertEqual(1, len(held))
                    revision = ok("ticket.read", ticket_id="b")["data"]["ticket"]["revision"]
                    rejected_archive = call("ticket.archive", actor_id="worker", mutation_id="archive", ticket_id="b", expected_revision=revision, archived=True)
                    self.assertEqual("Conflict", rejected_archive["error"]["data"]["kind"])
                    write("reservation.acquire", "named-a", target_run_id="a-run", requests=[
                        {"reservation_id": "build", "mode": "shared"},
                        {"reservation_id": "expired", "mode": "exclusive", "lease_duration_ms": "1"}])
                    write("reservation.acquire", "named-b", target_run_id="b-run", requests=[{"reservation_id": "build", "mode": "shared"}])
                    for run in ["a-run", "b-run"]:
                        write("reservation.paths.acquire", "vendor-" + run, target_run_id=run, requests=[{"target": vendor, "mode": "shared"}])
                        write("run.observe", "observe-" + run, target_run_id=run, expected_revision="1", observed_unix_ms="100")
                    # Complete records survive expiry; archive rejection and diagnostics do not release them.
                    ticket_before = ok("ticket.read", ticket_id="a")["data"]["ticket"]
                    archived_before = ok("ticket.read", ticket_id="b")["data"]["ticket"]
                    named_before = ok("reservation.get", reservation_id="expired")["data"]
                    paths_before = ok("reservation.path.get", target=src)["data"]
                    run_before = ok("run.get", target_run_id="a-run")["data"]
                    revision_before = ok("workspace.get")["meta"]["workspace_revision"]
                    warnings = ["stale_run", "unobserved_run"]
                    first = overview(kinds=warnings, limit="1", stale_after_ms="100")
                    row = first["items"][0]
                    self.assertEqual("a-run", row["source"]["run_id"])
                    self.assertEqual({"ticket_claim_count": "2", "named_reservation_count": "2", "path_reservation_count": "2", "active_attempt_count": "2"}, counts(row))
                    self.assertEqual(int(first["captured_now_unix_ms"]) - 100, int(row["metadata"]["observation_age_ms"]))
                    project_row = overview(kinds=warnings, run_id="a-run", project_id="a-project", stale_after_ms="100")["items"][0]
                    self.assertEqual(counts(row), counts(project_row))
                    self.assertFalse(row["metadata"]["clock_regressed"])
                    self.assertTrue(row["metadata"]["liveness_is_advisory"])
                    self.assertNotIn("b", [item["source"].get("ticket_id") for item in overview(kinds=["ready_work"])["items"]])
                    expired = overview(kinds=["expired_ownership"], run_id="a-run")
                    self.assertTrue(any(item["source"].get("ticket_id") == "a" for item in expired["items"]))
                    stop()
                    start()
                    second = overview(kinds=warnings, limit="1", stale_after_ms="100", cursor=first["next_cursor"])
                    self.assertEqual(first["captured_now_unix_ms"], second["captured_now_unix_ms"])
                    row_b = second["items"][0]
                    self.assertEqual("b-run", row_b["source"]["run_id"])
                    self.assertEqual(row["metadata"]["observation_age_ms"], row_b["metadata"]["observation_age_ms"])
                    self.assertEqual({"ticket_claim_count": "0", "named_reservation_count": "1", "path_reservation_count": "1", "active_attempt_count": "0"}, counts(row_b))
                    third = overview(kinds=warnings, limit="1", stale_after_ms="100", cursor=second["next_cursor"])
                    unknown = third["items"][0]
                    self.assertEqual("unobserved_run", unknown["kind"])
                    self.assertIsNone(unknown["metadata"]["observation_age_ms"])
                    self.assertFalse(unknown["metadata"]["clock_regressed"])
                    self.assertEqual(ticket_before, ok("ticket.read", ticket_id="a")["data"]["ticket"])
                    self.assertEqual(archived_before, ok("ticket.read", ticket_id="b")["data"]["ticket"])
                    self.assertEqual(named_before, ok("reservation.get", reservation_id="expired")["data"])
                    self.assertEqual(paths_before, ok("reservation.path.get", target=src)["data"])
                    self.assertEqual(run_before, ok("run.get", target_run_id="a-run")["data"])
                    self.assertEqual(revision_before, ok("workspace.get")["meta"]["workspace_revision"])
                    # A new advisory heartbeat changes the captured heartbeat map, not ownership.
                    heartbeat = ok("run.heartbeat", actor_id="worker", target_run_id="a-run")["data"]
                    self.assertTrue(heartbeat["advisory"])
                    self.assertEqual("Conflict", call("coordinator.overview", kinds=warnings, limit="1", stale_after_ms="100", cursor=first["next_cursor"])["error"]["data"]["kind"])
                    self.assertEqual([], overview(run_id="a-run", kinds=warnings, stale_after_ms="86400000")["items"])
                    self.assertEqual(ticket_before, ok("ticket.read", ticket_id="a")["data"]["ticket"])
                    self.assertEqual(paths_before, ok("reservation.path.get", target=src)["data"])
                    self.assertEqual(revision_before, ok("workspace.get")["meta"]["workspace_revision"])
                    stop()
                    start()
                    self.assertTrue(ok("run.heartbeat_get", target_run_id="a-run")["data"]["durable"])
                    self.assertEqual([], overview(run_id="a-run", kinds=warnings, stale_after_ms="86400000")["items"])
                    self.assertEqual(ticket_before, ok("ticket.read", ticket_id="a")["data"]["ticket"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
