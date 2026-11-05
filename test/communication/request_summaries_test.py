"""Captured request-list thread summaries, exact retries and durable separation."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = str(Path(sys.argv.pop(1)).resolve())


class RequestSummaries(unittest.TestCase):
    def test_captured_projection_budgets_filters_and_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-summary-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            with (root / "daemon.log").open("w") as log:
                daemon = subprocess.Popen([EXE, "serve", str(root / "registry"), str(address)], stdout=log, stderr=log)
                def stop():
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(10)
                self.addCleanup(stop)
                deadline = time.monotonic() + 10
                while not address.exists():
                    self.assertIsNone(daemon.poll())
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.01)
                counter = 0
                def invoke(method, params, expected=0, friendly=False):
                    if friendly:
                        args = ["request", str(address), method]
                        for key, value in params.items():
                            args += ["--json-field", key, json.dumps(value)]
                    else:
                        args = ["call", str(address), method, json.dumps(params)]
                    result = subprocess.run([EXE, *args], capture_output=True, timeout=15)
                    self.assertEqual(expected, result.returncode, (args, result.stdout, result.stderr))
                    return json.loads(result.stdout)
                def read(method, **params):
                    return invoke(method, {"workspace_id": "w", **params})["result"]
                def write(method, **params):
                    nonlocal counter
                    counter += 1
                    return invoke(method, {"workspace_id": "w", "actor_id": "alice", "mutation_id": "m" + str(counter), **params})["result"]["data"]
                write("workspace.create", name="Summaries", root=str(root / "workspace"))
                write("project.create", project_id="p", title="Project")
                write("project.create", project_id="q", title="Other")
                write("board.put", board_id="board", expected_revision="0", title="Project board", scope={"kind": "project", "id": "p"})
                tickets = ["ticket-%02d-" % i + "x" * 80 for i in range(50)]
                for start in range(0, len(tickets), 25):
                    write("transaction.apply", operations=[{"method": "ticket.create", "params": {"ticket_id": ticket, "project_id": "p", "title": "Linked"}} for ticket in tickets[start:start + 25]])
                links = [{"kind": "ticket", "id": ticket} for ticket in tickets]
                title = "λ" * 256
                for i in range(3):
                    write("request.ask", request_id="request-%d" % i, title=title, body="Question", board_id="board", resolver_id="alice", recipients=[{"kind": "actor", "id": "bob"}])
                rows = read("request.list")["data"]["items"]
                for row in rows:
                    thread = read("thread.get", thread_id=row["thread_id"])["data"]
                    receipt = write("thread.put", thread_id=row["thread_id"], expected_revision=thread["revision"], board_id="board", title=title, state="open", links=links)
                    self.assertNotIn("thread_summary", receipt)
                page = invoke("request.list", {"workspace_id": "w", "limit": "100", "max_bytes": "4096"}, friendly=True)["result"]
                self.assertTrue(page["meta"]["budget"]["truncated"])
                self.assertTrue(page["meta"]["budget"]["details_complete"])
                bounded = page["data"]["items"][0]
                summary = bounded["thread_summary"]
                self.assertEqual("512", summary["title_bytes"])
                self.assertEqual("50", summary["link_count"])
                self.assertLess(len(summary["title"].encode()), 512)
                self.assertLess(len(summary["links"]), 50)
                self.assertEqual({"kind": "project", "id": "p"}, summary["scope"])
                paths = [detail["path"] for detail in page["meta"]["budget"]["details"]]
                self.assertTrue(any("thread_summary" in path for path in paths), paths)
                retry = page["meta"]["pagination"]["retry_request"]
                self.assertEqual(page["meta"]["query_revision"], retry["params"]["revision"])
                full = invoke(retry["method"], {**retry["params"], "max_bytes": "1048576"})["result"]
                self.assertEqual(3, len(full["data"]["items"]))
                for row in full["data"]["items"]:
                    self.assertEqual(title, row["thread_summary"]["title"])
                    self.assertEqual(links, row["thread_summary"]["links"])
                self.assertEqual([], read("request.list", scope={"kind": "project", "id": "q"})["data"]["items"])
                self.assertEqual(3, len(read("request.list", ticket_id=tickets[0])["data"]["items"]))
                first = read("request.list", limit="1")
                capture = first["meta"]["query_revision"]
                second = read("request.list", limit="1", offset=first["data"]["next_offset"], revision=capture)
                self.assertEqual("request-1", second["data"]["items"][0]["request_id"])
                before_history = read("request.history", request_id="request-0")["data"]["items"]
                self.assertTrue(all("thread_summary" not in row for row in before_history))
                current = full["data"]["items"][0]
                write("thread.put", thread_id=current["thread_id"], expected_revision=current["thread_summary"]["thread_revision"], board_id="board", title="Edited title", state="open", links=[])
                for params in [retry["params"], {"workspace_id": "w", "offset": "1", "revision": capture}]:
                    error = invoke("request.list", params, expected=1)
                    self.assertEqual("Conflict", error["error"]["data"]["kind"])
                updated = read("request.list")["data"]["items"][0]
                self.assertEqual("Edited title", updated["thread_summary"]["title"])
                self.assertEqual("0", updated["thread_summary"]["link_count"])
                self.assertEqual(current["revision"], updated["revision"])
                self.assertNotEqual(current["thread_summary"]["thread_revision"], read("thread.get", thread_id=current["thread_id"])["data"]["revision"])
                self.assertEqual(before_history, read("request.history", request_id="request-0")["data"]["items"])
                stop()
                daemon = subprocess.Popen([EXE, "serve", str(root / "registry"), str(address)], stdout=log, stderr=log)
                deadline = time.monotonic() + 10
                while True:
                    response = subprocess.run([EXE, "request", str(address), "daemon.health"], capture_output=True, timeout=10)
                    if response.returncode == 0:
                        break
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.01)
                self.assertEqual(updated, read("request.list")["data"]["items"][0])
                self.assertEqual(before_history, read("request.history", request_id="request-0")["data"]["items"])


if __name__ == "__main__":
    unittest.main()
