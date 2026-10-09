"""Independent daemon fixture for bounded resume and captured ordinal digest."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
SCOPE = {"kind": "ticket", "ticket_id": "task"}
FACT_SCOPE = {"kind": "ticket", "id": "task"}
TARGET = {"kind": "ticket", "id": "task"}


class ResumeSocketTest(unittest.TestCase):
    def test_capture_requests_budget_sources_and_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-resume-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "resume", **params}
                    response = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
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
                    write("workspace.create", "workspace", name="Resume", root=str(root / "workspace"))
                    write("ticket.create", "task", ticket_id="task", title="Recorded task", description="Objective from reset")
                    write("board.put", "board", board_id="board", expected_revision="0", scope={"kind": "workspace"}, title="Board")
                    write("thread.put", "thread", thread_id="thread", expected_revision="0", board_id="board", title="Review", links=[TARGET], state="open", participants=["worker"], mentions=[])
                    write("comment.add", "question", comment_id="question", target={"kind": "workspace"}, body="Review this recorded work")
                    write("thread.attach", "attach", thread_id="thread", expected_revision="1", comment_id="question")
                    write("request.create", "request", request_id="request", thread_id="thread", kind="review", comment_id="question", resolver_id="worker", recipients=[{"kind": "actor", "id": "reviewer"}])
                    write("fact.put", "fact", scope=FACT_SCOPE, key="decision", expected_revision="0", value={"choice": "durable", "literal": "$opaque"})
                    before = ok("workspace.get")["meta"]["workspace_revision"]
                    write("transaction.apply", "batch", operations=[{"method": "comment.add", "params": {"comment_id": f"decision-{index}", "target": TARGET, "body": f"Decision {index}", "kind": "decision"}} for index in range(9)])
                    page = ok("activity.digest", scope=SCOPE, after=before, limit="2", max_bytes="4096")
                    capture = page["data"]["capture"]
                    self.assertEqual(2, len(page["data"]["entries"]))
                    self.assertEqual("request", page["data"]["outstanding_requests"][0]["record"]["request_id"])
                    write("request.resolve", "resolve", request_id="request", expected_revision="1")
                    write("thread.put", "detach-scope", thread_id="thread", expected_revision="2", board_id="board", title="Review", links=[], state="open", participants=["worker"], mentions=[])
                    write("comment.add", "later", comment_id="later", target=TARGET, body="New activity after capture", kind="decision")
                    ordinals = [int(row["change_index"]) for row in page["data"]["entries"]]
                    while page["data"]["has_more"]:
                        page = ok("activity.digest", scope=SCOPE, cursor=page["data"]["cursor"], limit="2", max_bytes="4096")
                        self.assertEqual(capture["through"], page["data"]["capture"]["through"])
                        self.assertEqual(capture["lineage"], page["data"]["capture"]["lineage"])
                        self.assertEqual("open", page["data"]["outstanding_requests"][0]["record"]["status"]["kind"])
                        ordinals.extend(int(row["change_index"]) for row in page["data"]["entries"])
                    self.assertEqual(list(range(9)), ordinals)
                    terminal_cursor = page["data"]["cursor"]
                    brief = ok("ticket.resume", ticket_id="task", max_bytes="4096", fact_selections=[{"scope": FACT_SCOPE, "key": "decision"}])
                    self.assertLessEqual(len(json.dumps(brief, ensure_ascii=False, separators=(",", ":")).encode()), 4096)
                    self.assertNotIn("markdown", brief["data"])
                    rich = ok("ticket.resume", ticket_id="task", include_markdown=True, fact_selections=[{"scope": FACT_SCOPE, "key": "decision"}])
                    self.assertIn("Objective from reset", rich["data"]["markdown"])
                    self.assertIn("$opaque", rich["data"]["markdown"])
                    fact = next(row for row in rich["data"]["items"] if row["kind"] == "fact")
                    pin = fact["sources"][0]
                    self.assertEqual("1", pin["revision"])
                    history = ok("fact.history", scope=FACT_SCOPE, key="decision")["data"]["items"]
                    self.assertEqual(fact["record"]["value"], history[0]["value"])
                    historical = rich["data"]["changes"][0]
                    activity = ok("activity.since", after=str(int(historical["workspace_revision"]) - 1), limit="100")["data"]["items"]
                    self.assertTrue(any(row["revision"] == historical["workspace_revision"] for row in activity))
                    stop()
                    start()
                    advanced = ok("activity.digest", scope=SCOPE, cursor=terminal_cursor)
                    self.assertTrue(any(row["item"]["record"].get("body") == "New activity after capture" for row in advanced["data"]["entries"]))
                    self.assertEqual([], advanced["data"]["outstanding_requests"])
                    error = call("activity.digest", cursor=terminal_cursor)
                    self.assertEqual("Conflict", error["error"]["data"]["kind"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        try:
                            stop()
                        except Exception:
                            daemon.terminate()
                            daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
