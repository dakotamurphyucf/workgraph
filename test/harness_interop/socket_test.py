"""Both reference harness drivers share durable state; no hosted model is involved."""
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
ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "examples/codex-hooks/workgraph-hook.py"
WATCHER = ROOT / "examples/notification-watcher.py"
ADAPTER = ROOT / "examples/history-adapter.py"
SPEC = importlib.util.spec_from_file_location("adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)
CORRECTION = "Correction: use SHA256 for the input checksum."

# The explicit callback acts as an independent deterministic reviewer. Every
# mutation is submitted to the actual daemon before the watcher acknowledges.
CALLBACK = '''import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("adapter",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
client=module.Workgraph(sys.argv[2]);packet=json.load(sys.stdin)
notification=packet["notification"];prefix="review-"+packet["delivery_id"]
receipts=[]
def write(method, suffix, **params):
    receipt=client.call(method,{"workspace_id":"demo","actor_id":"reviewer",
        "mutation_id":prefix+suffix,**params})
    assert receipt["meta"]["durable"] is True
    receipts.append(receipt)
if notification["kind"]=="message_received":
    body=notification["body_source"]["body"]
    assert body=="Correction: use SHA256 for the input checksum."
    write("fact.put","-fact",scope={"kind":"ticket","id":"task"},
        key="checksum",expected_revision="1",value={"algorithm":"SHA256","reason":body})
elif notification["kind"]=="request_created":
    request=client.call("request.get",{"workspace_id":"demo","request_id":"review"})["data"]
    thread=client.call("thread.get",{"workspace_id":"demo","thread_id":request["thread_id"]})["data"]
    write("thread.reply","-reply",thread_id=request["thread_id"],
        expected_revision=thread["revision"],comment_id="correction-reply",
        body="Correction confirmed: SHA256; the task remains pending.")
    write("request.resolve","-resolve",request_id=request["request_id"],expected_revision=request["revision"])
else:
    raise AssertionError(notification["kind"])
Path(sys.argv[3],packet["delivery_id"]+".json").write_text(json.dumps({"packet":packet,"receipts":receipts}))
'''


class HarnessInteropTest(unittest.TestCase):
    def test_hook_watcher_correction_and_restart_resume(self):
        with tempfile.TemporaryDirectory(prefix="wg-interop-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "socket"
            client = adapter.Workgraph(address)
            binding = root / "binding.json"
            request_path, receipt_path = root / "handoff.json", root / "handoff-receipt.json"
            binding.write_text(json.dumps({"socket": str(address), "workspace_id": "demo",
                "actor_id": "worker", "ticket_id": "task", "max_bytes": 16384,
                "handoff_request": str(request_path), "handoff_receipt": str(receipt_path)}))
            callback = root / "review.py"
            callback.write_text(CALLBACK)
            records = root / "records"
            records.mkdir()
            checkpoint = root / "watcher.json"
            watch = [sys.executable, str(WATCHER), "--socket", str(address),
                "--workspace-id", "demo", "--actor-id", "reviewer", "--consumer-id", "reviewer-driver",
                "--recipient-id", "reviewer", "--state", str(checkpoint), "--kind", "message_received",
                "--kind", "request_created", "--callback-cwd", str(root), "--timeout-ms", "5", "--once",
                "--", sys.executable, str(callback), str(ADAPTER), str(address), str(records)]
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)],
                        stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def stop():
                    client.call("daemon.shutdown", {})
                    self.assertEqual(daemon.wait(timeout=10), 0)

                def write(method, mutation, **params):
                    result = client.call(method, {"workspace_id": "demo", "actor_id": "worker",
                        "mutation_id": mutation, **params})
                    self.assertIs(result["meta"]["durable"], True)
                    return result

                def hook(name):
                    event = {"hook_event_name": name, "session_id": "harness-session",
                        "cwd": str(root), "transcript_path": "/unavailable-after-reset"}
                    if name == "SessionStart":
                        event["source"] = "compact"
                    else:
                        event.update(trigger="auto", turn_id="harness-turn")
                    result = subprocess.run([sys.executable, str(HOOK), "--config", str(binding)],
                        input=json.dumps(event), capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    output = json.loads(result.stdout)
                    if name == "SessionStart":
                        return json.loads(output["hookSpecificOutput"]["additionalContext"].split("\n", 1)[1])
                    return output

                def watcher_step():
                    result = subprocess.run(watch, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return json.loads(result.stdout)["delivered"]

                try:
                    start()
                    write("workspace.create", "workspace", name="Shared harness", root=str(root / "workspace"))
                    write("ticket.create", "task", ticket_id="task", title="Implement checksum validation")
                    write("fact.put", "initial-fact", scope={"kind": "ticket", "id": "task"}, key="checksum", expected_revision="0", value={"algorithm": "MD5"})
                    write("board.put", "board", board_id="board", expected_revision="0", scope={"kind": "workspace"}, title="Review")
                    write("thread.put", "thread", thread_id="thread", expected_revision="0", board_id="board", title="Checksum review", state="open", links=[{"kind": "ticket", "id": "task"}], participants=["worker", "reviewer"], mentions=[])
                    write("comment.add", "question", comment_id="question", target={"kind": "workspace"}, body="Review the checksum choice before implementation.")
                    observed = write("thread.attach", "attach", thread_id="thread", expected_revision="1", comment_id="question")
                    explicit = {"method": "handoff.set", "params": {"workspace_id": "demo", "actor_id": "worker", "mutation_id": "explicit-handoff", "ticket_id": "task", "expected_revision": "0", "covers_through": observed["meta"]["workspace_revision"], "summary": "Current recorded choice: MD5; independent review is pending.", "next_steps": "Wait for the review and implement the correction.", "evidence": "No completion evidence yet."}}
                    request_path.write_text(json.dumps(explicit))
                    self.assertIn("durably acknowledged", hook("PreCompact")["systemMessage"])
                    handoff_receipt = json.loads(receipt_path.read_text())
                    write("message.send", "correction-message", message_id="correction", ticket_id="task", body=CORRECTION, recipients=[{"kind": "actor", "id": "reviewer"}])
                    write("request.create", "review", request_id="review", thread_id="thread", kind="review", comment_id="question", resolver_id="reviewer", recipients=[{"kind": "actor", "id": "reviewer"}])
                    before = hook("SessionStart")
                    self.assertTrue(any(item["kind"] == "request" and item["record"]["request_id"] == "review" and item["record"]["status"]["kind"] == "open" for item in before["data"]["items"]))
                    self.assertTrue(watcher_step())
                    self.assertTrue(watcher_step())
                    self.assertIsNone(json.loads(checkpoint.read_text())["pending"])
                    packets = [json.loads(path.read_text()) for path in records.glob("*.json")]
                    self.assertEqual({packet["packet"]["notification"]["kind"] for packet in packets}, {"message_received", "request_created"})
                    self.assertTrue(all(receipt["meta"]["durable"] for packet in packets for receipt in packet["receipts"]))
                    stop()
                    start()
                    recovered = hook("SessionStart")
                    self.assertLessEqual(len(adapter.canonical(recovered).encode()), 16384)
                    task = next(item["record"] for item in recovered["data"]["items"] if item["kind"] == "task")
                    self.assertEqual(task["status"], "todo")
                    self.assertIsNone(task["claim"])
                    self.assertFalse(any(item["kind"] == "request" for item in recovered["data"]["items"]))
                    changes = [row["item"] for row in recovered["data"]["changes"]]
                    fact = next(item for item in changes if item["kind"] == "fact")
                    self.assertEqual(fact["record"]["value"], {"algorithm": "SHA256", "reason": CORRECTION})
                    self.assertTrue(any(item["kind"] == "request" and item["record"]["status"]["kind"] == "resolved" for item in changes))
                    # Thread replies target the board scope (workspace here),
                    # while the request and correction fact are linked to this ticket.
                    reply = client.call("comment.get", {"workspace_id": "demo", "comment_id": "correction-reply"})["data"]
                    self.assertEqual(reply["body"], "Correction confirmed: SHA256; the task remains pending.")
                    self.assertEqual(reply["actor_id"], "reviewer")
                    thread = client.call("thread.get", {"workspace_id": "demo", "thread_id": "thread"})["data"]
                    self.assertIn("correction-reply", thread["comment_ids"])
                    self.assertEqual(client.call("request.get", {"workspace_id": "demo", "request_id": "review"})["data"]["status"]["kind"], "resolved")
                    self.assertEqual(json.loads(request_path.read_text()), explicit)
                    self.assertEqual(json.loads(receipt_path.read_text()), handoff_receipt)
                    self.assertFalse(watcher_step())
                    self.assertEqual(len(list(records.glob("*.json"))), 2)
                    stop()
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
