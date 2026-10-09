"""Complete retained activity and canonical current search sources survive replay."""
import importlib.util
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
SPEC = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[2] / "examples/history-adapter.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class ActivitySocketTest(unittest.TestCase):
    def test_retained_content_named_variants_source_versions_and_budget(self):
        methods = {row["name"]: row for row in json.loads(subprocess.check_output([str(EXE), "schema"]))["methods"]}
        self.assertEqual(methods["activity.since"]["mode"], "read")
        self.assertEqual(methods["search.query"]["mode"], "read")
        with tempfile.TemporaryDirectory(prefix="wg-full-activity-", dir="/tmp") as temporary:
            root = Path(temporary)
            address = root / "socket"
            with (root / "daemon.log").open("w+") as log:
                daemon = None

                def start():
                    process = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    return process

                def call(method, **params):
                    return adapter.Workgraph(address).call(method, params)

                def write(method, mutation, **params):
                    return call(method, workspace_id="audit", actor_id="owner", mutation_id=mutation, **params)

                def read(method, **params):
                    return call(method, workspace_id="audit", **params)

                try:
                    daemon = start()
                    call("workspace.create", workspace_id="audit", actor_id="owner", mutation_id="workspace", name="Audit", root=str(root / "workspace"))
                    write("project.create", "project", project_id="p", title="Needle project")
                    initial = "Needle " + "é" * 30000
                    write("ticket.create", "task", ticket_id="task", project_id="p", title="Needle ticket", description=initial)
                    write("ticket.update", "update", ticket_id="task", expected_revision="1", title="Current title", description="Replaced description")
                    write("comment.add", "comment", target={"kind": "ticket", "id": "task"}, comment_id="comment", body="Needle original")
                    write("comment.edit", "edit", comment_id="comment", expected_revision="1", body="Current discussion")
                    write("fact.put", "fact", scope={"kind": "ticket", "id": "task"}, key="nullable", expected_revision="0", value=None)
                    write("handoff.set", "handoff", ticket_id="task", expected_revision="0", summary="Needle handoff", next_steps="Next", evidence="Evidence")
                    write("resource.put_text", "resource", resource_id="resource", expected_revision="0", title="Needle resource", text="Needle full resource")
                    activity = read("activity.since", max_bytes="1048576")
                    rows = activity["data"]["items"]
                    self.assertEqual([row["revision"] for row in rows], [str(index) for index in range(1, 9)])
                    self.assertTrue(all(row["actor_id"] == "owner" for row in rows))
                    original = rows[1]["changes"][0]
                    self.assertEqual(original["kind"], "ticket_put")
                    self.assertEqual(original["ticket"]["ticket_id"], "task")
                    self.assertEqual(original["ticket"]["description"], initial)
                    self.assertEqual(rows[3]["changes"][0]["change"]["version"]["body"], "Needle original")
                    fact = rows[5]["changes"][0]["fact"]
                    self.assertIn("value", fact)
                    self.assertIsNone(fact["value"])
                    self.assertFalse(fact["deleted"])
                    version = rows[7]["changes"][0]["change"]["version"]
                    self.assertEqual(len(version["digest"]), 64)
                    self.assertEqual(version["actor_id"], "owner")
                    small = read("activity.since", max_bytes="4096")
                    self.assertEqual(small["data"]["next_offset"], "1")
                    with self.assertRaises(RuntimeError) as error:
                        read("activity.since", offset="1", at_revision=small["meta"]["workspace_revision"], max_bytes="4096")
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], "Invalid_argument")
                    expanded = read("activity.since", after="1", max_bytes="1048576")
                    self.assertEqual(expanded["data"]["items"][0], rows[1])
                    search = read("search.query", text="needle")
                    sources = [row["source"] for row in search["data"]["items"]]
                    self.assertFalse(any(row["kind"] in {"ticket", "comment"} for row in sources))
                    self.assertTrue(all("id" not in row for row in sources))
                    self.assertTrue(any(row.get("project_id") == "p" for row in sources))
                    facts = read("search.query", text="nullable", kinds=["fact"], target={"kind": "ticket", "ticket_id": "task"})["data"]["items"]
                    self.assertEqual(facts[0]["source"]["scope"], {"kind": "ticket", "id": "task"})
                    self.assertEqual(facts[0]["source"]["key"], "nullable")
                    daemon.terminate()
                    daemon.wait(timeout=10)
                    address.unlink(missing_ok=True)
                    daemon = start()
                    self.assertEqual(read("activity.since", max_bytes="1048576"), activity)
                    self.assertEqual(read("search.query", text="needle"), search)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
