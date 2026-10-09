"""Durable entity revision receipts and exact lifecycle attempt identities."""
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


class RunResultsSocketTest(unittest.TestCase):
    def test_entity_receipts_lifecycle_attempts_and_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-rr-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen(
                        [str(EXE), "serve", str(root / "registry"), str(address)],
                        stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    params = {"workspace_id": "results", **params} if method != "daemon.shutdown" else {}
                    response = subprocess.run(
                        [str(EXE), "call", str(address), method, json.dumps(params)],
                        capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    return json.loads(response.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    return ok(method, actor_id="worker", mutation_id=mutation, **params)

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                try:
                    start()
                    write("workspace.create", "create", name="Results", root=str(root / "workspace"))
                    write("run.register", "first", target_run_id="first", objective="First run")
                    write("ticket.create", "task", ticket_id="task", title="Task")
                    pool = write("allocation.pool_put", "pool", name="build", expected_revision="0", limit="2")
                    self.assertEqual({"revision": "1"}, pool["data"])
                    registered = write("run.register", "second", target_run_id="run", objective="Second run")
                    self.assertEqual({"revision": "1"}, registered["data"])
                    self.assertGreater(int(registered["meta"]["workspace_revision"]), 1)
                    overview = ok("coordinator.overview", run_id="run")["data"]["items"]
                    self.assertIn("unobserved_run", [item["kind"] for item in overview])
                    self.assertNotIn("stale_run", [item["kind"] for item in overview])
                    observed = write("run.observe", "observe", target_run_id="run",
                                     expected_revision=registered["data"]["revision"], observed_unix_ms="0")
                    self.assertEqual({"revision": "2"}, observed["data"])
                    overview = ok("coordinator.overview", run_id="run")["data"]["items"]
                    self.assertIn("stale_run", [item["kind"] for item in overview])
                    self.assertNotIn("unobserved_run", [item["kind"] for item in overview])
                    updated_pool = write("allocation.pool_put", "pool-update", name="build",
                                         expected_revision=pool["data"]["revision"], limit="3")
                    self.assertEqual({"revision": "2"}, updated_pool["data"])
                    paths = write("ticket.paths.put", "paths", ticket_id="task", expected_revision="0", declarations=[])
                    self.assertEqual({"revision": "1"}, paths["data"])
                    started_params = {"ticket_id": "task", "run_id": "run", "attempt_id": "attempt"}
                    started = write("ticket.start", "start", **started_params)
                    self.assertEqual({"attempt_id": "attempt", "revision": "1", "state": "running"}, started["data"]["attempt"])
                    self.assertEqual(started, write("ticket.start", "start", **started_params))
                    finish_params = {"ticket_id": "task", "run_id": "run", "token": started["data"]["token"], "evidence": "Checked"}
                    finished = write("ticket.finish", "finish", **finish_params)
                    self.assertEqual({"attempt_id": "attempt", "revision": "2", "state": "completed"}, finished["data"]["attempt"])
                    write("ticket.create", "later", ticket_id="later", title="Later")
                    later = write("ticket.claim_next", "allocate", run_id="run", target_run_id="run", attempt_id="allocated")
                    self.assertEqual("later", later["data"]["claim"]["ticket_id"])
                    self.assertEqual({"attempt_id": "allocated", "revision": "1", "state": "running"}, later["data"]["attempt"])
                    explicit_finished = write("attempt.finish", "attempt-finish", run_id="run", attempt_id="allocated",
                                              expected_revision=later["data"]["attempt"]["revision"], state="completed", evidence="Checked")
                    self.assertEqual({"attempt_id": "allocated", "revision": "2", "state": "completed"}, explicit_finished["data"])
                    without = write("ticket.finish", "later-finish", run_id="run", ticket_id="later", token=later["data"]["claim"]["token"], evidence="Checked")
                    self.assertEqual({"completed": True}, without["data"])
                    stop()
                    start()
                    self.assertEqual(registered, write("run.register", "second", target_run_id="run", objective="Second run"))
                    self.assertEqual(pool, write("allocation.pool_put", "pool", name="build", expected_revision="0", limit="2"))
                    self.assertEqual(started, write("ticket.start", "start", **started_params))
                    self.assertEqual(finished, write("ticket.finish", "finish", **finish_params))
                    self.assertEqual("2", ok("attempt.get", attempt_id="attempt")["data"]["revision"])
                    self.assertEqual("completed", ok("attempt.get", attempt_id="attempt")["data"]["state"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
