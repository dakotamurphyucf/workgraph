"""Independent template/budget/usage public fixtures across daemon replay."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class PolicySocketTest(unittest.TestCase):
    def test_actual_catalog_templates_usage_identity_and_replay(self):
        names = {"template.register", "template.get", "template.list", "template.instance_register",
                 "template.instance_get", "template.instance_list", "run.budget_put", "run.budget_get",
                 "run.budget_attention", "usage.report", "usage.list"}
        catalog = json.loads(subprocess.check_output([str(EXE), "schema"]))
        methods = {method["name"]: method for method in catalog["methods"]}
        self.assertTrue(names <= methods.keys())
        covered = set()
        with tempfile.TemporaryDirectory(prefix="wg-policy-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "socket"
            process = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal process
                    process = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    response = subprocess.run([str(EXE), "call", str(address), method,
                                               json.dumps({"workspace_id": "policy", **params})], capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    return json.loads(response.stdout)

                def ok(method, **params):
                    covered.add(method)
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    result = ok(method, actor_id="worker", mutation_id=mutation, **params)
                    self.assertTrue(result["meta"]["durable"])
                    return result

                def reject(method, kind, **params):
                    before = ok("workspace.get")["meta"]["workspace_revision"]
                    response = call(method, **params)
                    self.assertEqual(kind, response.get("error", {}).get("data", {}).get("kind"), response)
                    self.assertEqual(before, ok("workspace.get")["meta"]["workspace_revision"])

                spec = {"parameters": ["ticket_id"], "nodes": [{"alias": "node", "title": "Build {{ticket_id}}",
                        "description": "Literal $runner", "depends_on": [], "parent": None,
                        "capabilities": [], "reviewer_ids": [], "separate_actor": False}]}
                text = canonical(spec)
                template = {"template_id": "a-plan", "template_revision": "1", "digest": hashlib.sha256(text.encode()).hexdigest(), "spec": spec}
                limits = {"max_attempts": "4", "max_active_attempts": "1", "reported_token_limit": "5", "reported_elapsed_ms_limit": None}
                usage = {"usage_id": "usage", "scope": {"kind": "run", "run_id": "run"},
                         "reported_actor_id": "worker", "tokens": "5", "elapsed_ms": "7",
                         "provenance": "$runner external provider report", "timestamp": "2026-10-08T00:00:00Z"}
                try:
                    start()
                    write("workspace.create", "workspace", name="Policy", root=str(root / "workspace"))
                    write("resource.put_text", "asset", resource_id="a-plan", expected_revision="0", title="Plan", text=text)
                    registered = write("template.register", "template", **template)
                    self.assertEqual(ok("template.get", template_id="a-plan", template_revision="1")["data"], template)
                    write("transaction.apply", "run-budget", operations=[
                        {"method": "run.register", "as": "runner", "params": {"target_run_id": "run", "objective": "External work"}},
                        {"method": "run.budget_put", "params": {"target_run_id": "$runner", "expected_revision": "0", **limits}}])
                    budget_result = ok("run.budget_get", target_run_id="run")
                    budget = budget_result["data"]
                    self.assertEqual(budget_result["meta"]["query_scope"], "policy")
                    self.assertNotEqual(budget_result["meta"]["query_revision"], budget["revision"])
                    self.assertEqual(budget, {"target_run_id": "run", "revision": "1", **limits})
                    write("run.budget_put", "budget-next", target_run_id="run", expected_revision="1", **limits)
                    reported = write("usage.report", "usage", **usage)
                    duplicate = write("usage.report", "usage-duplicate", **usage)
                    self.assertTrue(duplicate["data"]["duplicate"])
                    reject("usage.report", "Conflict", actor_id="other", mutation_id="wrong-reporter", **usage)
                    reject("usage.report", "Idempotency_conflict", actor_id="worker", mutation_id="changed-usage", **{**usage, "tokens": "6"})
                    records = ok("usage.list")["data"]["items"]
                    self.assertEqual(records[0], {"actor_id": "worker", **{k: v for k, v in usage.items() if k != "reported_actor_id"}})
                    attention = ok("run.budget_attention")["data"]["items"]
                    self.assertEqual(attention[0]["run_id"], "run")
                    self.assertEqual(attention[0]["reported"], "5")
                    self.assertEqual(attention[0]["provenance"], "externally_reported")
                    instantiated = write("template.instantiate", "instance", template_id="a-plan", template_revision="1", instance_id="instance", parameters={"ticket_id": "$runner"})
                    instance = instantiated["data"]["instance"]
                    self.assertEqual(instance["parameters"], {"ticket_id": "$runner"})
                    self.assertEqual(instance["tickets"][0]["title"], "Build $runner")
                    self.assertIn("ticket_id", instance["tickets"][0])
                    self.assertEqual(ok("template.instance_get", instance_id="instance")["data"], instance)
                    self.assertTrue(write("template.instance_register", "instance-duplicate", **instance)["data"]["duplicate"])
                    self.assertEqual(ok("template.instance_list")["data"]["items"], [instance])
                    huge_spec = {**spec, "nodes": [{**spec["nodes"][0], "description": "x" * 6000}]}
                    huge_text = canonical(huge_spec)
                    write("resource.put_text", "large-asset", resource_id="z-plan", expected_revision="0", title="Large Plan", text=huge_text)
                    write("template.register", "large-template", template_id="z-plan", template_revision="1", digest=hashlib.sha256(huge_text.encode()).hexdigest(), spec=huge_spec)
                    reject("template.get", "Invalid_argument", template_id="z-plan", template_revision="1", max_bytes="4096")
                    first = ok("template.list", max_bytes="4096")
                    self.assertLessEqual(len(canonical(first).encode()), 4096)
                    self.assertEqual(first["data"]["items"], [template])
                    self.assertEqual(first["data"]["next_offset"], "1")
                    self.assertEqual(first["data"]["omitted"], "1")
                    reject("template.list", "Invalid_argument", max_bytes="4096", offset="1", expected_revision=first["meta"]["query_revision"])
                    rest = ok("template.list", max_bytes="16384", offset="1", expected_revision=first["meta"]["query_revision"])
                    self.assertEqual(rest["data"]["items"][0]["spec"], huge_spec)
                    reject("template.list", "Invalid_argument", offset="1")
                    process.terminate()
                    process.wait(timeout=10)
                    address.unlink(missing_ok=True)
                    start()
                    self.assertEqual(write("template.register", "template", **template), registered)
                    self.assertEqual(write("usage.report", "usage", **usage), reported)
                    self.assertEqual(ok("template.instance_get", instance_id="instance")["data"], instance)
                    self.assertEqual(len(ok("usage.list")["data"]["items"]), 1)
                    self.assertTrue(names <= covered, names - covered)
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
