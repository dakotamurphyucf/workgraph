"""Real durable finish patches retain rich values, history and retry identity."""
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


class FinishHandoffSocketTest(unittest.TestCase):
    def test_patch_finish_restart_and_exact_retry(self):
        with tempfile.TemporaryDirectory(prefix="wg-fh-", dir="/tmp") as directory:
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
                    params = {"workspace_id": "finish", **params} if method != "daemon.shutdown" else {}
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
                    return ok(method, actor_id="agent", mutation_id=mutation, **params)

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                try:
                    start()
                    write("workspace.create", "create", name="Finish", root=str(root / "workspace"))
                    write("ticket.create", "ticket", ticket_id="task", title="Task")
                    write("resource.put_text", "resource", resource_id="proof", expected_revision="0",
                          title="Proof", text="passed")
                    write("run.register", "run", target_run_id="run", objective="Complete feature")
                    write("ticket.start", "start", ticket_id="task", run_id="run", attempt_id="attempt")
                    coverage = ok("workspace.get")["meta"]["workspace_revision"]
                    write("handoff.set", "handoff", ticket_id="task", run_id="run", token="1",
                          expected_revision="0", summary="Earlier", next_steps="Finish", evidence="Earlier proof",
                          objective="Implement feature", completed="Built API", decisions="Immutable pins",
                          blockers="Review pending", resource_ids=["proof"], covers_through=coverage)
                    original = ok("handoff.history", ticket_id="task")["data"]["items"]
                    write("ticket.progress", "progress", ticket_id="task", run_id="run", token="1",
                          body="Uncovered work")
                    params = {"ticket_id": "task", "run_id": "run", "token": "1", "evidence": "Final proof",
                              "handoff": {"summary": "Done", "next_steps": "Ship"}}
                    finish = write("ticket.finish", "finish", **params)
                    handoff = ok("handoff.get", ticket_id="task")["data"]
                    for key in ("objective", "completed", "decisions", "blockers", "resource_ids", "covers_through"):
                        self.assertEqual(original[0][key], handoff[key], key)
                    self.assertEqual("Final proof", handoff["evidence"])
                    self.assertEqual(coverage, handoff["covers_through"])
                    self.assertEqual(original, ok("handoff.history", ticket_id="task")["data"]["items"][:1])
                    completed_attempt = ok("attempt.get", attempt_id="attempt")
                    self.assertEqual("completed", completed_attempt["data"]["state"])
                    changed = call("ticket.finish", actor_id="agent", mutation_id="finish",
                                   **{**params, "handoff": {"summary": "Done", "next_steps": "Ship", "blockers": ""}})
                    self.assertEqual("Idempotency_conflict", changed["error"]["data"]["kind"])
                    stop()
                    start()
                    self.assertEqual(finish, write("ticket.finish", "finish", **params))
                    self.assertEqual(handoff, ok("handoff.get", ticket_id="task")["data"])
                    self.assertEqual(original, ok("handoff.history", ticket_id="task")["data"]["items"][:1])
                    context = ok("ticket.context", ticket_id="task")["data"]
                    self.assertEqual("done", context["ticket"]["status"])
                    self.assertTrue(context["activity_since_handoff"]["items"])
                    comments = ok("comment.list", target={"kind": "ticket", "id": "task"})["data"]["items"]
                    evidence = [comment for comment in comments if comment["kind"] == "evidence"]
                    self.assertEqual(["Final proof"], [comment["body"] for comment in evidence])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
