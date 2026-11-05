"""Independent candidate-selector checks against a disposable Unix-socket daemon."""
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


class CandidateEligibility(unittest.TestCase):
    def test_read_only_candidate_and_real_acquisition_recheck(self):
        for method in ["ticket.ready", "ticket.readiness"]:
            help_result = subprocess.run([str(EXE), "help", method], capture_output=True,
                                         text=True, timeout=10, check=True)
            self.assertIn("mutually exclusive", help_result.stdout)
            self.assertIn("assessment.unknown_checks", help_result.stdout)
            self.assertIn("Actual claim/start", help_result.stdout)
        with tempfile.TemporaryDirectory(prefix="wg-candidate-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            with (root / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)],
                                          stdout=log, stderr=subprocess.STDOUT)

                def call(method, **params):
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "candidate", **params}
                    result = subprocess.run([str(EXE), "call", str(address), method, json.dumps(params)],
                                            capture_output=True, text=True, timeout=10)
                    self.assertTrue(result.stdout, result.stderr)
                    return json.loads(result.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    return ok(method, actor_id="worker", mutation_id=mutation, **params)

                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    write("workspace.create", "workspace", name="Candidate", root=str(root / "workspace"))
                    write("ticket.create", "ticket", ticket_id="task", title="Task")
                    write("allocation.ticket_policy_put", "policy", ticket_id="task", expected_revision="0",
                          required_capabilities=["ocaml"], pools=[], allowed_actor_ids=["worker"])
                    before = ok("workspace.get")["meta"]["workspace_revision"]
                    candidate = {"actor_id": "worker", "capabilities": ["ocaml"]}
                    ready = ok("ticket.ready", candidate=candidate)
                    self.assertEqual(["task"], [item["ticket_id"] for item in ready["data"]["items"]])
                    self.assertEqual({"scope": "candidate", "unknown_checks": ["run_lifecycle", "run_budget"]},
                                     ready["data"]["assessment"])
                    denied = ok("ticket.readiness", ticket_id="task", candidate={"actor_id": "other", "capabilities": []})
                    self.assertFalse(denied["data"]["ready"])
                    self.assertEqual([], ok("run.list")["data"]["items"])
                    self.assertEqual(before, ok("workspace.get")["meta"]["workspace_revision"])
                    conflict = call("ticket.ready", target_run_id="fake", candidate=candidate)
                    self.assertEqual("Invalid_argument", conflict["error"]["data"]["kind"])
                    rejected = call("ticket.start", actor_id="worker", mutation_id="without-run", ticket_id="task")
                    self.assertEqual("Blocked", rejected["error"]["data"]["kind"])
                    write("run.register", "run", target_run_id="real", objective="Work", capabilities=[])
                    rejected = call("ticket.start", actor_id="worker", run_id="real", mutation_id="wrong-capability", ticket_id="task")
                    self.assertEqual("Blocked", rejected["error"]["data"]["kind"])
                    # Candidate observations cannot authorize a later actor-policy change.
                    write("allocation.ticket_policy_put", "changed-policy", ticket_id="task", expected_revision="1",
                          required_capabilities=[], pools=[], allowed_actor_ids=["other"])
                    self.assertFalse(ok("ticket.readiness", ticket_id="task", candidate=candidate)["data"]["ready"])
                    rejected = call("ticket.claim", actor_id="worker", run_id="real", mutation_id="changed-policy-claim", ticket_id="task")
                    self.assertEqual("Blocked", rejected["error"]["data"]["kind"])
                finally:
                    if daemon.poll() is None:
                        ok("daemon.shutdown")
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
