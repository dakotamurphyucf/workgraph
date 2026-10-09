"""Canonical rich reads retain controls, immutable handoffs, and advancing pages."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
SPEC = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[2] / "examples/history-adapter.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class RichReadSocketTest(unittest.TestCase):
    def test_contracts_history_budget_exact_retry_and_restart(self):
        methods = {entry["name"]: entry for entry in json.loads(subprocess.check_output([str(EXE), "schema"]))["methods"]}
        names = {"workspace.overview", "project.brief", "ticket.context", "ticket.list", "ticket.ready", "ticket.readiness", "ticket.blockers", "ticket.resolve", "handoff.get", "handoff.history"}
        for name in names:
            self.assertEqual(methods[name]["mode"], "read")
        with tempfile.TemporaryDirectory(prefix="wg-rich-read-", dir="/tmp") as temporary:
            root = Path(temporary)
            address = root / "socket"
            with (root / "daemon.log").open("w+") as log:
                daemon = None

                def start():
                    process = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    return process

                def call(method, **params):
                    return adapter.Workgraph(address).call(method, params)

                def write(method, identity, **params):
                    return call(method, workspace_id="rich", actor_id="owner", mutation_id=identity, **params)

                def read(method, **params):
                    result = call(method, workspace_id="rich", **params)
                    self.assertIn("workspace_revision", result["meta"])
                    return result

                def reject(method, expected="Invalid_argument", **params):
                    with self.assertRaises(RuntimeError) as error:
                        read(method, **params)
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], expected)

                try:
                    daemon = start()
                    call("workspace.create", workspace_id="rich", actor_id="owner", mutation_id="workspace", name="Rich", root=str(root / "workspace"))
                    write("project.create", "project", project_id="p", title="Project")
                    large = "é" * 32000
                    first = None
                    for index in range(6):
                        created = write("ticket.create", "create-" + str(index), ticket_id="task" + str(index), title="T" * 512, description=large, project_id="p")
                        self.assertEqual(created["data"]["ticket_id"], "task" + str(index))
                        self.assertNotIn("id", created["data"])
                        if index == 0:
                            first = created
                    write("ticket.claim", "claim", ticket_id="task0", expected_revision="1")
                    overview = read("workspace.overview", actor_id="owner", max_bytes="16384")
                    self.assertEqual(overview["data"]["held_work"]["items"][0]["ticket_id"], "task0")
                    self.assertEqual(overview["data"]["recent_changes"]["items"][0]["actor_id"], "owner")
                    brief = read("project.brief", project_id="p", max_bytes="16384")
                    self.assertEqual(brief["data"]["project"]["project_id"], "p")
                    self.assertEqual(brief["data"]["tickets"]["items"][0]["ticket_id"], "task0")
                    context = read("ticket.context", ticket_id="task0", max_bytes="16384")
                    self.assertEqual(context["data"]["ticket"]["claim"]["actor_id"], "owner")
                    self.assertEqual(context["data"]["blocker_ticket_ids"], [])
                    self.assertEqual(context["data"]["evidence"]["meta"]["query_scope"], "evidence")
                    self.assertIn("query_revision", context["data"]["evidence"]["meta"])
                    self.assertTrue(context["data"]["activity_since_handoff"]["items"])
                    self.assertLessEqual(len(json.dumps(context, ensure_ascii=False, separators=(",", ":")).encode()), 16384)
                    bounded = read("ticket.list", max_bytes="4096")
                    row = bounded["data"]["items"][0]
                    self.assertEqual(row["ticket_id"], "task0")
                    self.assertEqual(row["title"], "T" * 512)
                    self.assertEqual(row["membership_revision"], "1")
                    self.assertEqual(row["claim"]["actor_id"], "owner")
                    self.assertEqual(row["claim"]["token"], row["claim"]["lease"]["epoch"])
                    self.assertEqual(row["next_token"], "2")
                    self.assertTrue(bounded["meta"]["budget"]["truncated"])
                    self.assertLessEqual(len(json.dumps(bounded, ensure_ascii=False, separators=(",", ":")).encode()), 4096)
                    self.assertTrue(all(entry["path"].endswith(("/description", "/acceptance_criteria")) or entry["path"] == "/data/items" for entry in bounded["meta"]["budget"]["details"]))
                    seen = []
                    offset, capture = "0", None
                    while True:
                        params = {"max_bytes": "4096", "offset": offset}
                        if capture is not None:
                            params["at_revision"] = capture
                        page = read("ticket.list", **params)
                        self.assertTrue(page["data"]["items"])
                        seen.extend(item["ticket_id"] for item in page["data"]["items"])
                        capture = page["meta"]["workspace_revision"]
                        offset = page["data"]["next_offset"]
                        if offset is None:
                            break
                    self.assertEqual(seen, ["task" + str(index) for index in range(6)])
                    ready = read("ticket.ready", max_bytes="1048576")["data"]["items"]
                    self.assertEqual([item["ticket_id"] for item in ready], ["task" + str(index) for index in range(1, 6)])
                    readiness = read("ticket.readiness", ticket_id="task0")["data"]
                    self.assertFalse(readiness["ready"])
                    self.assertIn("claimed", [reason["kind"] for reason in readiness["reasons"]])
                    self.assertEqual(read("ticket.blockers", ticket_id="task0")["data"]["items"], [])
                    self.assertEqual(read("ticket.resolve", display_key="WG-1")["data"]["ticket_id"], "task0")
                    receipt = write("handoff.set", "handoff", ticket_id="task1", expected_revision="0", summary="Exact history", next_steps="Next", evidence="Evidence")
                    self.assertEqual(receipt["data"]["actor_id"], "owner")
                    self.assertEqual(read("handoff.get", ticket_id="task1")["data"]["summary"], "Exact history")
                    write("handoff.set", "handoff-large", ticket_id="task1", expected_revision="1", summary=large, next_steps="Next", evidence="Evidence")
                    history = read("handoff.history", ticket_id="task1", max_bytes="1048576")["data"]["items"]
                    self.assertEqual([item["summary"] for item in history], ["Exact history", large])
                    reject("handoff.get", ticket_id="task1", max_bytes="4096")
                    history_page = read("handoff.history", ticket_id="task1", max_bytes="4096")
                    self.assertEqual(history_page["data"]["items"][0]["summary"], "Exact history")
                    self.assertEqual(history_page["data"]["next_offset"], "1")
                    reject("handoff.history", ticket_id="task1", offset="1", at_revision=history_page["meta"]["workspace_revision"], max_bytes="4096")
                    reject("ticket.list", include_archived=None)
                    reject("ticket.list", project_id="$alias")
                    reject("ticket.list", offset="1")
                    with self.assertRaises(RuntimeError) as error:
                        write("ticket.create", "bad-parent", title="Bad", parent_id="task0")
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], "Invalid_argument")
                    reject("ticket.list", expected="Conflict", offset="1", at_revision=capture)
                    daemon.terminate()
                    daemon.wait(timeout=10)
                    address.unlink(missing_ok=True)
                    daemon = start()
                    self.assertEqual(read("handoff.history", ticket_id="task1", max_bytes="1048576")["data"]["items"], history)
                    retried = write("ticket.create", "create-0", ticket_id="task0", title="T" * 512, description=large, project_id="p")
                    self.assertEqual(retried, first)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
