"""Base planning reads preserve typed canonical records and capture paging."""
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


class BaseReadSocketTest(unittest.TestCase):
    def test_canonical_entities_explicit_budget_and_restart(self):
        catalog = json.loads(subprocess.check_output([str(EXE), "schema"]))
        methods = {method["name"]: method for method in catalog["methods"]}
        names = {"workspace.get", "project.get", "project.list", "milestone.get", "milestone.list", "actor.list", "label.list", "status.list"}
        for name in names:
            self.assertEqual(methods[name]["mode"], "read")
        with tempfile.TemporaryDirectory(prefix="wg-base-read-", dir="/tmp") as temporary:
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

                def mutate(method, mutation, **params):
                    return call(method, workspace_id="base", actor_id="owner", mutation_id=mutation, **params)

                def read(method, **params):
                    result = call(method, workspace_id="base", **params)
                    self.assertIn("workspace_revision", result["meta"])
                    return result

                def reject(method, expected_kind="Invalid_argument", **params):
                    with self.assertRaises(RuntimeError) as error:
                        call(method, workspace_id="base", **params)
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], expected_kind)

                try:
                    daemon = start()
                    call("workspace.create", workspace_id="base", actor_id="owner", mutation_id="workspace", name="Base reads", root=str(root / "workspace"))
                    large = "é" * 32000
                    for index in range(7):
                        created = mutate("project.create", "project-" + str(index), project_id="p" + str(index), title="T" * 512, description=large)
                        self.assertEqual(created["data"]["project_id"], "p" + str(index))
                        self.assertNotIn("id", created["data"])
                    milestone = mutate("milestone.create", "milestone", milestone_id="release", project_id="p0", title="Release", description=large, target_date="2028-02-29")
                    self.assertEqual(milestone["data"]["milestone_id"], "release")
                    self.assertEqual(milestone["data"]["project_id"], "p0")
                    mutate("actor.put", "actor", target_actor_id="worker", expected_revision="0", name="Worker", kind="agent", archived=False)
                    mutate("label.put", "label", label_id="label", expected_revision="0", name="Label", description=large, archived=False)
                    mutate("status.put", "status", status_id="status", expected_revision="0", name="Custom", category="todo", archived=False)
                    self.assertEqual(read("workspace.get")["data"]["name"], "Base reads")
                    bounded = read("project.get", project_id="p0", max_bytes="4096")
                    project = bounded["data"]
                    self.assertEqual(project["project_id"], "p0")
                    self.assertEqual(project["title"], "T" * 512)
                    self.assertEqual(project["revision"], "1")
                    self.assertEqual(project["status"], "todo")
                    self.assertTrue(bounded["meta"]["budget"]["truncated"])
                    self.assertLessEqual(len(json.dumps(bounded, ensure_ascii=False, separators=(",", ":")).encode()), 4096)
                    self.assertTrue(all(item["path"] == "/data/description" for item in bounded["meta"]["budget"]["details"]))
                    observed = []
                    offset = "0"
                    revision = None
                    while True:
                        params = {"offset": offset, "max_bytes": "4096"}
                        if revision is not None:
                            params["at_revision"] = revision
                        page = read("project.list", **params)
                        self.assertTrue(page["data"]["items"])
                        observed.extend(item["project_id"] for item in page["data"]["items"])
                        revision = page["meta"]["workspace_revision"]
                        offset = page["data"]["next_offset"]
                        if offset is None:
                            break
                    self.assertEqual(observed, ["p" + str(index) for index in range(7)])
                    self.assertEqual(read("milestone.get", milestone_id="release", max_bytes="4096")["data"]["milestone"]["target_date"], "2028-02-29")
                    self.assertEqual(read("milestone.list", project_id="p0")["data"]["items"][0]["milestone_id"], "release")
                    self.assertEqual(read("actor.list")["data"]["items"][0]["actor_id"], "worker")
                    self.assertEqual(read("label.list", max_bytes="4096")["data"]["items"][0]["label_id"], "label")
                    self.assertEqual(read("status.list")["data"]["items"][0]["status_id"], "status")
                    reject("project.get", project_id="$alias")
                    reject("project.list", offset="1")
                    reject("project.list", include_archived=None)
                    reject("milestone.list", project_id=None)
                    mutate("project.archive", "archive", project_id="p0", expected_revision="1", archived=True)
                    reject("project.list", expected_kind="Conflict", offset="1", at_revision=revision)
                    self.assertEqual(len(read("project.list", max_bytes="1048576")["data"]["items"]), 6)
                    self.assertEqual(len(read("project.list", include_archived=True, max_bytes="1048576")["data"]["items"]), 7)
                    daemon.terminate()
                    daemon.wait(timeout=10)
                    address.unlink(missing_ok=True)
                    daemon = start()
                    self.assertTrue(read("project.get", project_id="p0")["data"]["archived"])
                    self.assertEqual(read("milestone.get", milestone_id="release")["data"]["milestone"]["project_id"], "p0")
                    retried = mutate("milestone.create", "milestone", milestone_id="release", project_id="p0", title="Release", description=large, target_date="2028-02-29")
                    self.assertEqual(retried, milestone)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
