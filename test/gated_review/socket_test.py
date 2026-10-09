"""Run the documented two-round review and retry it across daemon restart."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
EXAMPLE = Path(sys.argv.pop(1)).resolve()


class GatedReviewSocketTest(unittest.TestCase):
    def test_two_round_workflow_exact_retries_and_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-review-", dir="/tmp") as directory:
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
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    response = subprocess.run(
                        [str(EXE), "call", str(address), method, json.dumps(params)],
                        capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    result = json.loads(response.stdout)
                    self.assertIn("result", result, result)
                    return result["result"]["data"]

                def stop():
                    call("daemon.shutdown")
                    daemon.wait(timeout=10)

                def example():
                    response = subprocess.run(
                        [sys.executable, str(EXAMPLE), str(EXE), str(address), "review",
                         str(root / "journal")], capture_output=True, text=True, timeout=30)
                    self.assertEqual(0, response.returncode, response.stderr + response.stdout)
                    return json.loads(response.stdout)

                def packets():
                    return call("inbox.read", workspace_id="review", consumer_id="verify",
                                recipient={"kind": "run", "id": "review-demo-worker"},
                                after="0", kinds=["message_received"])["items"]

                try:
                    start()
                    call("workspace.create", workspace_id="review", actor_id="worker",
                         mutation_id="create", name="Review", root=str(root / "workspace"))
                    report = example()
                    self.assertEqual(["Blocked"], report["expected_policy_blocks"])
                    self.assertEqual([], report["unexpected_failures"])
                    self.assertEqual("1", report["first_generation"])
                    self.assertEqual("2", report["second_generation"])
                    self.assertEqual("3", report["submission_revision_after_approval"])
                    self.assertEqual("4", report["accepted_revision"])
                    self.assertEqual("not_evaluated", report["approval_notification"]["gate_status"])
                    self.assertEqual(report["second_manifest"], report["approval_notification"]["manifest"])
                    self.assertEqual("completed", report["finish"]["attempt"]["state"])
                    self.assertEqual(1, len(packets()))
                    self.assertEqual(report, example())
                    self.assertEqual(1, len(packets()))
                    stop()
                    start()
                    self.assertEqual(report, example())
                    self.assertEqual(1, len(packets()))
                    for key in ["resolved_changes_request", "resolved_superseded_review_request"]:
                        request = call("request.get", workspace_id="review", request_id=report[key])
                        self.assertEqual("resolved", request["status"]["kind"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()


if __name__ == "__main__":
    unittest.main()
