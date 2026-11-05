"""Durable advisory contention metadata, exact retries, cleanup and actual fences."""
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
TARGET = {"kind": "named", "reservation_id": "test-db"}


class Contention(unittest.TestCase):
    def test_explicit_advisory_lifecycle_exact_retry_restart_and_no_grant(self):
        with tempfile.TemporaryDirectory(prefix="wg-contention-", dir="/tmp") as directory:
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
                        params = {"workspace_id": "contention", **params}
                    reply = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                    self.assertTrue(reply.stdout, reply.stderr)
                    return json.loads(reply.stdout)

                def ok(method, **params):
                    reply = call(method, **params)
                    self.assertIn("result", reply, reply)
                    return reply["result"]

                def write(method, mutation, **params):
                    return ok(method, actor_id="worker", mutation_id=mutation, **params)

                def view(**params):
                    return ok("reservation.contention", target=TARGET, **params)

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                def holder():
                    return ok("reservation.get", reservation_id="test-db")["data"]["holders"]

                try:
                    start()
                    write("workspace.create", "workspace", name="Contention", root=str(root / "workspace"))
                    for run in ["holder", "first", "second"]:
                        write("run.register", "register-" + run, target_run_id=run, objective="Use database")
                    grant = write("reservation.acquire", "acquire", target_run_id="holder", requests=[{"reservation_id": "test-db", "mode": "exclusive"}])
                    before = holder()
                    note_params = dict(target=TARGET, target_run_id="holder", token="1", expected_revision="0", action="set", duration_ms="300000", note="Finish current test pass, then release", expected_release_unix_ms="500")
                    note = write("reservation.holder_note.put", "note", **note_params)
                    self.assertTrue(note["data"]["advisory"])
                    first_params = dict(target=TARGET, target_run_id="first", expected_revision="0", action="begin", duration_ms="300000", note="Needs test database")
                    first = write("reservation.waiter.put", "first-begin", **first_params)
                    write("reservation.waiter.put", "second-begin", target=TARGET, target_run_id="second", expected_revision="0", action="begin", duration_ms="300000", note="Also waiting")
                    self.assertEqual(before, holder())
                    current = view()["data"]
                    self.assertEqual(["holder", "waiter", "waiter"], [row["kind"] for row in current["items"]])
                    self.assertNotIn("queue_position", json.dumps(current))
                    self.assertIsNone(current["items"][0]["holder"]["lease"]["deadline_unix_ms"])
                    self.assertEqual("500", current["items"][0]["note"]["contents"]["expected_release_unix_ms"])
                    self.assertEqual("Already_claimed", call("reservation.acquire", actor_id="worker", mutation_id="still-held", target_run_id="first", requests=[{"reservation_id": "test-db", "mode": "exclusive"}])["error"]["data"]["kind"])
                    page = view(limit="1")["data"]
                    stop()
                    start()
                    continuation = view(limit="1", cursor=page["cursor"])["data"]
                    self.assertEqual(page["observed_unix_ms"], continuation["observed_unix_ms"])
                    waiting = continuation["items"][0]
                    self.assertEqual(int(page["observed_unix_ms"]) - int(waiting["record"]["started_unix_ms"]), int(waiting["elapsed_ms"]))
                    closed = write("reservation.waiter.put", "first-close", target=TARGET, target_run_id="first", expected_revision="1", action="close", reason="Cancelled bounded wait")
                    self.assertEqual("closed", closed["data"]["record"]["state"]["kind"])
                    # Exact retry returns its original record, not the newer closed state.
                    self.assertEqual(first, write("reservation.waiter.put", "first-begin", **first_params))
                    self.assertEqual(before, holder())
                    active = view()["data"]["items"]
                    self.assertEqual(["second"], [row["record"]["run_id"] for row in active if row["kind"] == "waiter"])
                    self.assertEqual("Conflict", call("reservation.contention", target=TARGET, cursor=continuation["cursor"])["error"]["data"]["kind"])
                    write("reservation.release", "release", target_run_id="holder", reservation_id="test-db", token="1")
                    self.assertEqual([], holder())
                    # A caller can reacquire despite another announced waiter: no queue gate.
                    write("reservation.acquire", "holder-again", target_run_id="holder", requests=[{"reservation_id": "test-db", "mode": "exclusive"}])
                    self.assertEqual("2", holder()[0]["token"])
                    self.assertEqual(note, write("reservation.holder_note.put", "note", **note_params))
                    self.assertIsNone(view()["data"]["items"][0]["note"])
                    self.assertEqual("Stale_claim", call("reservation.holder_note.put", actor_id="worker", mutation_id="stale-note", **{**note_params, "expected_revision": "1"})["error"]["data"]["kind"])
                    write("reservation.release", "release-again", target_run_id="holder", reservation_id="test-db", token="2")
                    write("reservation.acquire", "second-wins", target_run_id="second", requests=[{"reservation_id": "test-db", "mode": "exclusive"}])
                    self.assertEqual("second", holder()[0]["run_id"])
                    write("reservation.waiter.put", "second-close", target=TARGET, target_run_id="second", expected_revision="1", action="close", reason="Acquired using actual reservation receipt")
                    write("reservation.waiter.put", "first-reopen", target=TARGET, target_run_id="first", expected_revision="2", action="begin", duration_ms="1", note="Short lived advisory wait")
                    time.sleep(.01)
                    self.assertEqual(["holder"], [r["kind"] for r in view()["data"]["items"]])
                    inactive = view(include_inactive=True)["data"]["items"]
                    self.assertEqual(["expired", "closed"], [r["phase"] for r in inactive if r["kind"] == "waiter"])
                    stop()
                    start()
                    self.assertEqual(first, write("reservation.waiter.put", "first-begin", **first_params))
                    self.assertEqual(["holder"], [r["kind"] for r in view()["data"]["items"]])
                    self.assertEqual("second", holder()[0]["run_id"])
                    write("transaction.apply", "alias-intent", operations=[
                        {"method": "run.register", "as": "newrun", "params": {"target_run_id": "alias-run", "objective": "Wait"}},
                        {"method": "reservation.waiter.put", "params": {"target": {"kind": "named", "reservation_id": "alias-db"}, "target_run_id": "$newrun", "expected_revision": "0", "action": "begin", "duration_ms": "300000", "note": "Aliased waiter"}}])
                    # Exact overlapping path scopes reuse authoritative holder records.
                    path = {"worktree_id": "tree", "kind": "subtree", "path": "src"}
                    write("reservation.paths.acquire", "path", target_run_id="holder", requests=[{"target": path, "mode": "exclusive"}])
                    file_target = {"kind": "path", "target": {"worktree_id": "tree", "kind": "file", "path": "src/test.ml"}}
                    write("reservation.waiter.put", "path-wait", target=file_target, target_run_id="first", expected_revision="0", action="begin", duration_ms="300000", note="Uses source checkout")
                    path_rows = ok("reservation.contention", target=file_target)["data"]["items"]
                    self.assertEqual(["holder", "waiter"], [r["kind"] for r in path_rows])
                    self.assertEqual("src", path_rows[0]["target"]["target"]["path"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
