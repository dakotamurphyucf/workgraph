"""Read-only answer waiting, immutable answer versions and local receipt paths."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = str(Path(sys.argv.pop(1)).resolve())


class RequestWait(unittest.TestCase):
    def test_answers_timeouts_and_no_delivery_side_effects(self):
        with tempfile.TemporaryDirectory(prefix="wg-answer-", dir="/tmp") as directory:
            root = Path(directory)
            socket = root / "s"
            with (root / "daemon.log").open("w") as log:
                daemon = subprocess.Popen([EXE, "serve", str(root / "registry"), str(socket)], stdout=log, stderr=log)
                def stop():
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(10)
                self.addCleanup(stop)
                deadline = time.monotonic() + 10
                while not is_listening(socket):
                    self.assertIsNone(daemon.poll())
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.01)
                count = 0
                def call(method, **params):
                    command = [EXE, "call", str(socket), method, json.dumps({"workspace_id": "w", **params})]
                    result = subprocess.run(command, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    return json.loads(result.stdout)["result"]
                def write(method, **params):
                    nonlocal count
                    count += 1
                    return call(method, actor_id="lead", mutation_id="m-" + str(count), **params)
                write("workspace.create", name="Wait", root=str(root / "workspace"))
                write("ticket.create", ticket_id="task", title="Task")
                claimed = write("ticket.claim", ticket_id="task")["data"]
                progress = write("ticket.progress", ticket_id="task", token=claimed["token"], body="Working")
                self.assertNotIn("revision", progress["data"])
                comment = call("comment.get", comment_id=progress["data"]["comment_id"])["data"]
                self.assertEqual(comment["body"], "Working")
                self.assertEqual(comment["revision"], "1")
                self.assertEqual(comment["sequence"], progress["meta"]["workspace_revision"])
                context = root / "context.json"
                context.write_text(json.dumps({"socket": str(socket), "workspace_id": "w", "actor_id": "worker", "request_directory": str(root / "never-created")}))
                def command(request_id, spelling=None):
                    return [EXE, "--context", str(context), *(spelling or ["request", "wait"]), "--request-id", request_id, "--wait-ms", "1000", "--poll-interval-ms", "250"]
                def wait(request_id, expected=0, spelling=None):
                    result = subprocess.run(command(request_id, spelling), capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    return json.loads(result.stdout)["result"]
                def ask(request_id):
                    result = write("request.ask", request_id=request_id, title="Question", body="Confirm", resolver_id="lead", recipients=[{"kind": "actor", "id": "worker"}])["data"]
                    self.assertNotIn("revision", result)
                    self.assertNotIn("status", result)
                    self.assertEqual(result["request_revision"], "1")
                    return result
                ask("delayed")
                waiting = subprocess.Popen(command("delayed"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.addCleanup(lambda: waiting.kill() if waiting.poll() is None else None)
                answered = write("request.resolve", request_id="delayed", expected_revision="1", body="Original answer")["data"]
                stdout, stderr = waiting.communicate(timeout=5)
                self.assertEqual(waiting.returncode, 0, stdout + stderr)
                response = json.loads(stdout)["result"]
                self.assertEqual(response["data"]["status"]["kind"], "resolved")
                self.assertEqual(response["data"]["answer"]["body"], "Original answer")
                self.assertTrue(response["meta"]["wait"]["resolved"])
                answer = answered["answer"]
                write("comment.edit", comment_id=answer["comment_id"], expected_revision=answer["revision"], body="Later edited answer")
                pinned = wait("delayed", spelling=["request.wait"])
                self.assertEqual(pinned["data"]["answer"]["body"], "Original answer")
                self.assertEqual(pinned["data"]["answer"]["revision"], answer["revision"])
                self.assertEqual(call("comment.get", comment_id=answer["comment_id"])["data"]["body"], "Later edited answer")
                self.assertIsNone(pinned["data"]["deliveries"][0]["acknowledged"])
                inbox = call("inbox.read", consumer_id="observer", recipient={"kind": "actor", "id": "worker"})["data"]
                self.assertGreater(len(inbox["items"]), 0)
                wait("delayed")
                self.assertEqual(call("inbox.read", consumer_id="observer", recipient={"kind": "actor", "id": "worker"})["data"], inbox)
                for identifier, method, expected in (("empty", "request.resolve", 0), ("cancelled", "request.cancel", 1)):
                    ask(identifier)
                    write(method, request_id=identifier, expected_revision="1")
                    observed = wait(identifier, expected)
                    self.assertIsNone(observed["data"]["answer"])
                    self.assertEqual(observed["meta"]["wait"]["stop"], "resolved" if expected == 0 else "cancelled")
                ask("open")
                observed = wait("open", 1)
                self.assertEqual(observed["meta"]["wait"]["stop"], "deadline")
                self.assertEqual(observed["data"]["status"]["kind"], "open")
                self.assertFalse((root / "never-created").exists())
                invalid = subprocess.run(command("open") + ["--save-request", str(root / "forbidden")], capture_output=True, text=True, timeout=5)
                self.assertEqual(invalid.returncode, 1)
                self.assertIn("read-only", invalid.stderr)
                self.assertFalse((root / "forbidden").exists())
                help_result = subprocess.run([EXE, "--context", str(root / "absent"), "request", "wait", "--help"], capture_output=True, text=True, timeout=5)
                self.assertEqual(help_result.returncode, 0, help_result.stderr)
                self.assertIn("pinned", help_result.stdout)


if __name__ == "__main__":
    unittest.main()
