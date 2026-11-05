"""Participant provenance, exact paging and replay on a disposable daemon."""
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


class Participants(unittest.TestCase):
    def test_attribution_paging_and_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-participants-", dir="/tmp") as directory:
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
                        params = {"workspace_id": "participants", **params}
                    result = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                    self.assertTrue(result.stdout, result.stderr)
                    return json.loads(result.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, actor="lead", **params):
                    return ok(method, actor_id=actor, mutation_id=mutation, **params)

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                try:
                    start()
                    write("workspace.create", "workspace", name="Participants", root=str(root / "workspace"))
                    self.assertEqual([], ok("participant.list")["data"]["items"])
                    write("actor.put", "catalog", target_actor_id="catalog-only", expected_revision="0", name="Catalog", kind="agent", archived=True)
                    write("actor.put", "registered", target_actor_id="run-only", expected_revision="0", name="Runner", kind="agent")
                    scope = {"kind": "workspace"}
                    first = write("fact.put", "first", actor="historical-fact", scope=scope, key="history", expected_revision="0", value=1)
                    write("fact.put", "replace", actor="current-fact", scope=scope, key="history", expected_revision="1", value=2)
                    write("fact.delete", "delete", actor="current-fact", scope=scope, key="history", expected_revision="2")
                    write("comment.add", "comment", actor="comment-only", comment_id="note", target=scope, body="Original")
                    write("comment.edit", "edit", actor="comment-only", comment_id="note", expected_revision="1", body="Revised")
                    last_comment = write("comment.tombstone", "tombstone", actor="comment-only", comment_id="note", expected_revision="2")
                    write("request.ask", "ask", actor="request-only", request_id="question", title="Question", body="Answer?", recipients=[{"kind": "actor", "id": "named-only"}, {"kind": "actor", "id": "ack-only"}], resolver_id="resolver-only")
                    unobserved = ok("participant.list")["data"]["items"]
                    self.assertNotIn("resolver-only", [row["actor_id"] for row in unobserved])
                    write("request.acknowledge", "ack", actor="ack-only", request_id="question", expected_revision="1", recipient={"kind": "actor", "id": "ack-only"})
                    write("request.resolve", "resolve", actor="resolver-only", request_id="question", expected_revision="2", body="Recorded answer")
                    write("run.register", "run", actor="run-only", target_run_id="real", objective="Work")
                    for index in range(20):
                        write("actor.put", "bulk-" + str(index), target_actor_id="bulk-%02d" % index, expected_revision="0", name="Large " + "é" * 200, kind="person")
                    before = ok("workspace.get")["meta"]["workspace_revision"]
                    page = ok("participant.list", max_bytes="4096", limit="100")
                    self.assertLessEqual(len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode()), 4096)
                    self.assertGreater(int(page["data"]["remaining"]), 0)
                    self.assertGreater(int(page["meta"]["budget"]["omitted_items"]), 0)
                    self.assertEqual(len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode()), int(page["meta"]["budget"]["returned_bytes"]))
                    self.assertEqual(str(len(page["data"]["items"])), page["data"]["next_offset"])
                    self.assertEqual(before, page["meta"]["workspace_revision"])
                    first_page = page
                    all_rows = list(page["data"]["items"])
                    # A restart must preserve the exact capture and next position.
                    stop()
                    start()
                    self.assertEqual(first_page, ok("participant.list", max_bytes="4096", limit="100", at_revision=before))
                    while page["data"]["next_offset"] is not None:
                        page = ok("participant.list", max_bytes="4096", limit="100", offset=page["data"]["next_offset"], at_revision=before)
                        all_rows.extend(page["data"]["items"])
                    self.assertEqual(sorted({row["actor_id"] for row in all_rows}), [row["actor_id"] for row in all_rows])
                    rows = {row["actor_id"]: row for row in all_rows}
                    self.assertNotIn("named-only", rows)
                    for index in range(20):
                        self.assertEqual("Large " + "é" * 200, rows["bulk-%02d" % index]["registration"]["name"])
                    self.assertEqual(["catalog"], rows["catalog-only"]["sources"])
                    self.assertTrue(rows["catalog-only"]["registration"]["archived"])
                    self.assertIsNone(rows["catalog-only"]["observed"])
                    self.assertIsNone(rows["historical-fact"]["registration"])
                    self.assertEqual(["activity", "fact"], rows["historical-fact"]["sources"])
                    self.assertEqual(first["meta"]["workspace_revision"], rows["historical-fact"]["observed"]["first_revision"])
                    self.assertEqual(first["meta"]["workspace_revision"], rows["historical-fact"]["observed"]["last_revision"])
                    self.assertEqual(last_comment["meta"]["workspace_revision"], rows["comment-only"]["observed"]["last_revision"])
                    self.assertEqual(["activity", "comment"], rows["comment-only"]["sources"])
                    for actor in ["request-only", "resolver-only"]:
                        self.assertEqual(["activity", "comment", "request"], rows[actor]["sources"])
                    self.assertEqual(["activity", "request"], rows["ack-only"]["sources"])
                    self.assertEqual(["catalog", "activity", "run"], rows["run-only"]["sources"])
                    self.assertEqual(22, len(ok("actor.list", limit="100", include_archived=True)["data"]["items"]))
                    self.assertEqual(1, len(ok("run.list")["data"]["items"]))
                    self.assertEqual(before, ok("workspace.get")["meta"]["workspace_revision"])
                    self.assertEqual("Invalid_argument", call("participant.list", offset="1")["error"]["data"]["kind"])
                    write("comment.add", "later", actor="later", comment_id="later", target=scope, body="New writer")
                    self.assertEqual("Conflict", call("participant.list", offset="1", at_revision=before)["error"]["data"]["kind"])
                    fresh = ok("participant.list", limit="100")
                    self.assertIn("later", [row["actor_id"] for row in fresh["data"]["items"]])
                    help_text = subprocess.check_output([str(EXE), "help", "participant.list"], text=True)
                    self.assertIn("retained history", help_text)
                    self.assertIn("at_revision", help_text)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
