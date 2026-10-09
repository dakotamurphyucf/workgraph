"""Independent canonical acceptance fixtures across a real daemon restart."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
PIN = {"kind": "checksum", "source": "independent checks", "digest": "a" * 64}


class AcceptanceSocketTest(unittest.TestCase):
    def test_inherited_criteria_membership_retry_and_complete_proofs(self):
        with tempfile.TemporaryDirectory(prefix="wg-acceptance-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "socket"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "acceptance", **params}
                    response = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    return json.loads(response.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    result = ok(method, actor_id="worker", mutation_id=mutation, **params)
                    self.assertTrue(result["meta"]["durable"])
                    return result

                def reject(method, mutation, kind, **params):
                    before = ok("workspace.get")["meta"]["workspace_revision"]
                    response = call(method, actor_id="worker", mutation_id=mutation, **params)
                    self.assertEqual(kind, response.get("error", {}).get("data", {}).get("kind"), response)
                    self.assertEqual(before, ok("workspace.get")["meta"]["workspace_revision"])

                def effective():
                    return ok("acceptance.policy.effective", ticket_id="task")["data"]

                def policy(scope, revision, criteria, **extra):
                    return dict(scope=scope, expected_revision=str(revision), enabled=True,
                                reviewers=[], separate_actor=False, validators=[], criteria=criteria, **extra)

                def proof(mutation, scope, revision, key, passed=True, **extra):
                    params = dict(ticket_id="task", token="1", expected_policy_digest=effective()["digest"],
                                  criterion=dict(scope=scope, policy_revision=str(revision), key=key),
                                  passed=passed, evidence_pins=[PIN], evidence="independent check", **extra)
                    return write("acceptance.assert", mutation, **params), params

                def move(project):
                    ticket = ok("ticket.context", ticket_id="task")["data"]["ticket"]
                    write("ticket.move", "move-" + ticket["revision"], ticket_id="task", expected_revision=ticket["revision"], project_id=project, parent_ticket_id=None, milestone_id=None)

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                inherited = {"kind": "project", "project_id": "p"}
                local = {"kind": "ticket", "ticket_id": "task"}
                required = {"key": "tests", "description": "Tests pass", "required": True}
                own = {"key": "docs", "description": "Documentation checked", "required": True}
                optional = {"key": "extra", "description": "Optional observation", "required": False}
                try:
                    start()
                    write("workspace.create", "workspace", name="Acceptance", root=str(root / "workspace"))
                    write("transaction.apply", "create", operations=[
                        {"method": "project.create", "as": "plan", "params": {"project_id": "p", "title": "P"}},
                        {"method": "project.create", "params": {"project_id": "q", "title": "Q"}},
                        {"method": "ticket.create", "as": "work", "params": {"ticket_id": "task", "project_id": "$plan", "title": "Task"}},
                        {"method": "acceptance.policy.put", "params": policy({"kind": "project", "project_id": "$plan"}, 0, [required])},
                        {"method": "acceptance.policy.put", "params": policy({"kind": "ticket", "ticket_id": "$work"}, 0, [own, optional])}])
                    before_start = ok("evidence.context", ticket_id="task")["data"]
                    self.assertEqual("1", before_start["effective_policy"]["membership_revision"])
                    self.assertEqual(3, len(before_start["effective_policy"]["criteria"]))
                    self.assertEqual([], before_start["assertions"])
                    self.assertIsNone(before_start["manifest"])
                    write("ticket.start", "start", ticket_id="task")
                    self.assertFalse(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    proof("inherited-first", inherited, 1, "tests")
                    proof("own-first", local, 1, "docs", passed=False)
                    self.assertFalse(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    proof("own-pass", local, 1, "docs")
                    self.assertTrue(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    move("q")
                    move("p")
                    self.assertEqual("3", effective()["membership_revision"])
                    self.assertTrue(all(not item["current"] for item in ok("acceptance.assertions", ticket_id="task")["data"]["items"]))
                    self.assertFalse(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    reject("acceptance.policy.put", "weakening", "Invalid_argument", **policy(local, 1, [optional]))
                    override = dict(against=dict(scope=inherited, revision="1"), membership_revision="3", reviewers=[], validators=[], criteria=["tests"], waive_separate_actor=False, reason="Approved exception")
                    write("acceptance.policy.put", "override", **policy(local, 1, [own, optional], inherited_override=override, weakening_reason="Approved exception"))
                    proof("own-second", local, 2, "docs")
                    self.assertTrue(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    observed = effective()["digest"]
                    changed = {**required, "description": "Changed test agreement"}
                    write("acceptance.policy.put", "project-edit", **policy(inherited, 1, [changed], weakening_reason="New agreement"))
                    current = effective()
                    self.assertIsNotNone(current["stale_override"])
                    self.assertIsNone(current["applied_override"])
                    self.assertFalse(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    reject("acceptance.assert", "stale-check", "Conflict", ticket_id="task", token="1", expected_policy_digest=observed, criterion=dict(scope=local, policy_revision="2", key="docs"), passed=True, evidence_pins=[PIN], evidence="stale")
                    proof("inherited-fresh", inherited, 2, "tests")
                    assertion, assertion_params = proof("own-fresh", local, 2, "docs")
                    self.assertEqual("worker", assertion["data"]["attribution"]["actor_id"])
                    self.assertTrue(ok("review.gate", ticket_id="task")["data"]["allowed"])
                    finish_params = dict(ticket_id="task", token="1", evidence="all required checks passed")
                    finished = write("ticket.finish", "finish", **finish_params)
                    # A cancelled later attempt under the same claim must fence
                    # approval of the earlier attempt even when no new manifest exists.
                    write("run.register", "registered", target_run_id="run", objective="review fixture")
                    schema = write("resource.put_text", "schema", resource_id="schema", expected_revision="0", title="Schema", text="{}")['data']
                    write("contract.put", "contract", contract_id="contract", expected_revision="0", schema_version="1",
                          schema={"resource_id": "schema", "revision": schema['version']['revision'], "digest": schema['version']['digest']}, required_inputs=[], required_outputs=[])
                    write("ticket.create", "review-ticket", ticket_id="reviewed", title="Reviewed")
                    write("ticket.start", "review-start", ticket_id="reviewed", run_id="run", attempt_id="first")
                    write("review.policy.put", "review-policy", ticket_id="reviewed", expected_revision="0", enabled=True, reviewers=[], separate_actor=False, validators=["tests"])
                    manifest = {"manifest_id": "manifest", "revision": "1"}
                    write("manifest.publish", "manifest", manifest_id="manifest", expected_revision="0", schema_version="1", attempt_id="first", ticket_id="reviewed", run_id="run", contract={"contract_id": "contract", "revision": "1"}, inputs=[], outputs=[])
                    digest = ok("acceptance.policy.effective", ticket_id="reviewed")['data']['digest']
                    write("validation.add", "validation", validation_id="validation", manifest=manifest, name="tests", expected_policy_digest=digest, passed=True, evidence="Tests pass")
                    write("review.submit", "submit", ticket_id="reviewed", expected_revision="0", manifest=manifest, run_id="run")
                    write("review.accept", "accept", ticket_id="reviewed", expected_revision="1", run_id="run")
                    self.assertTrue(ok("review.gate", ticket_id="reviewed")['data']['allowed'])
                    write("attempt.finish", "cancel-first", attempt_id="first", expected_revision="1", state="cancelled", evidence="new attempt planned", run_id="run")
                    write("attempt.start", "second", attempt_id="second", ticket_id="reviewed", target_run_id="run", token="1", run_id="run")
                    write("attempt.finish", "cancel-second", attempt_id="second", expected_revision="1", state="cancelled", evidence="cancelled new work", run_id="run")
                    readiness = ok("ticket.readiness", ticket_id="reviewed")['data']['completion']
                    self.assertFalse(readiness['can_complete'])
                    self.assertIn("digest", readiness['policy'])
                    reject("ticket.complete", "stale-complete", "Conflict", ticket_id="reviewed", token="1", run_id="run", evidence="old approval")
                    reject("validation.add", "stale-validation", "Conflict", validation_id="stale", manifest=manifest, name="tests", expected_policy_digest=digest, passed=True, evidence="old manifest")
                    stop()
                    start()
                    self.assertEqual(assertion, write("acceptance.assert", "own-fresh", **assertion_params))
                    self.assertEqual(finished, write("ticket.finish", "finish", **finish_params))
                    self.assertEqual("done", ok("ticket.context", ticket_id="task")["data"]["ticket"]["status"])
                    self.assertIsNotNone(effective()["stale_override"])
                    self.assertEqual("2", ok("acceptance.policy.get", scope=inherited)["data"]["definition"]["revision"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
