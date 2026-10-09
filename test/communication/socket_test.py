"""Canonical communication and comment contracts across a real daemon restart."""
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


class CommunicationSocketTest(unittest.TestCase):
    def test_public_contracts_captures_routing_and_retry(self):
        catalog = json.loads(subprocess.check_output([str(EXE), "schema"]))
        methods = {method["name"]: method for method in catalog["methods"]}
        covered = set()
        with tempfile.TemporaryDirectory(prefix="wg-communication-", dir="/tmp") as temporary:
            root = Path(temporary)
            address = root / "socket"
            with (root / "daemon.log").open("w+") as log:
                process = None

                def start():
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    return daemon

                def call(method, **params):
                    return adapter.Workgraph(address).call(method, params)

                def read(method, **params):
                    covered.add(method)
                    result = call(method, workspace_id="communication", **params)
                    self.assertEqual(methods[method]["mode"], "read")
                    return result

                def mutate(method, mutation, actor="alice", **params):
                    covered.add(method)
                    result = call(method, workspace_id="communication", actor_id=actor, mutation_id=mutation, **params)
                    self.assertIs(result["meta"]["durable"], True)
                    return result

                def reject(method, expected_kind="Invalid_argument", **params):
                    with self.assertRaises(RuntimeError) as error:
                        call(method, workspace_id="communication", **params)
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], expected_kind)

                bob = {"kind": "actor", "id": "bob"}
                try:
                    process = start()
                    call("workspace.create", workspace_id="communication", actor_id="alice", mutation_id="workspace", name="Communication", root=str(root / "workspace"))
                    board = mutate("board.put", "board", board_id="board", expected_revision="0", scope={"kind": "workspace"}, title="Board")
                    self.assertEqual(board["data"]["board_id"], "board")
                    self.assertNotIn("id", board["data"])
                    mutate("team.put", "team", team_id="team", expected_revision="0", title="Reviewers", members=[bob])
                    mutate("thread.put", "thread", thread_id="thread", expected_revision="0", board_id="board", title="Review output", state="open", participants=["alice"], mentions=["bob"])
                    mutate("subscription.put", "subscription", actor="bob", subscription_id="subscription", expected_revision="0", recipient=bob, filter={"thread_id": "thread", "kinds": ["request_created"]}, active=True)
                    mutate("comment.add", "comment", comment_id="comment", target={"kind": "workspace"}, body="Original question")
                    attached = mutate("thread.attach", "attach", thread_id="thread", expected_revision="1", comment_id="comment")
                    self.assertEqual(attached["data"]["comment_ids"], ["comment"])
                    mutate("thread.pin_message", "pin", thread_id="thread", expected_revision="2", comment_id="comment", pinned=True)
                    created = mutate("request.create", "request", request_id="request", thread_id="thread", kind="review", comment_id="comment", resolver_id="alice", teams=["team"])
                    self.assertEqual(created["data"]["status"], {"kind": "open"})
                    self.assertEqual(created["data"]["created"]["actor_id"], "alice")
                    self.assertEqual(created["data"]["deliveries"][0]["recipient"], bob)
                    mutate("team.put", "team-empty", team_id="team", expected_revision="1", title="Reviewers", members=[])
                    self.assertEqual(read("request.get", request_id="request")["data"]["deliveries"], created["data"]["deliveries"])
                    mutate("request.acknowledge", "request-ack", actor="bob", request_id="request", expected_revision="1", recipient=bob)
                    accepted = mutate("request.accept", "request-accept", actor="bob", request_id="request", expected_revision="2", recipient=bob)
                    self.assertEqual(accepted["data"]["responsibility"]["kind"], "accepted")
                    cleared = mutate("request.reassign", "request-clear", request_id="request", expected_revision="3", recipient=None)
                    self.assertEqual(cleared["data"]["responsibility"], {"kind": "unaccepted"})
                    resolved = mutate("request.resolve", "request-resolve", request_id="request", expected_revision="4")
                    self.assertEqual(resolved["data"]["status"]["kind"], "resolved")
                    mutate("request.create", "followup", request_id="followup", thread_id="thread", kind="help", comment_id="comment", resolver_id="alice", recipients=[bob], reply_to_request_id="request")
                    mutate("request.cancel", "cancel", request_id="followup", expected_revision="1")
                    direct = read("request.get", request_id="request", include_messages=True, message_limit="1")
                    self.assertEqual(direct["data"]["related"]["source_message_version"], "current")
                    self.assertEqual(direct["data"]["related"]["source_message_reference"], {"comment_id": "comment", "revision": None})
                    self.assertEqual(direct["data"]["related"]["source_message"]["author_id"], "alice")
                    mutate("comment.edit", "edit", comment_id="comment", expected_revision="1", body="Corrected question")
                    reject("request.get", expected_kind="Conflict", request_id="request", include_messages=True, message_offset="1", revision=direct["meta"]["query_revision"], discussion_serial=direct["data"]["related"]["discussion_serial"])
                    self.assertEqual(read("request.get", request_id="request", include_messages=True)["data"]["related"]["source_message"]["body"], "Corrected question")
                    self.assertEqual(read("comment.get", comment_id="comment")["data"]["actor_id"], "alice")
                    read("comment.list", target={"kind": "workspace"})
                    history = read("comment.history", comment_id="comment", limit="1")
                    read("comment.history", comment_id="comment", limit="1", offset=history["data"]["next_offset"], at_revision=history["meta"]["workspace_revision"])
                    for method, params, identity in [
                        ("board.get", {"board_id": "board"}, "board_id"),
                        ("team.get", {"team_id": "team"}, "team_id"),
                        ("subscription.get", {"subscription_id": "subscription"}, "subscription_id"),
                        ("thread.get", {"thread_id": "thread"}, "thread_id"),
                    ]:
                        self.assertIn(identity, read(method, **params)["data"])
                    for method, params in [
                        ("board.list", {}), ("team.list", {}), ("subscription.list", {"recipient": bob}),
                        ("thread.list", {"state": "open"}), ("thread.search", {"text": "Review"}),
                        ("thread.history", {"thread_id": "thread"}), ("request.list", {"recipient": bob}),
                        ("request.history", {"request_id": "request"}),
                    ]:
                        result = read(method, **params)
                        self.assertTrue(result["data"]["items"])
                        self.assertIsNone(result["data"]["next_offset"])
                    page = read("request.list", limit="1")
                    next_params = {"limit": "1", "offset": page["data"]["next_offset"], "revision": page["meta"]["query_revision"]}
                    read("request.list", **next_params)
                    reject("thread.list", state=None)
                    reject("comment.list", ticket_id="ticket")
                    reject("request.create", actor_id="alice", mutation_id="bad", request_id="bad", thread_id="thread", kind="review", comment_id="comment", resolver_id="alice", recipients=[bob], reply_to=None)
                    reject("board.put", actor_id="alice", mutation_id="bad-board", board_id="bad", expected_revision="0", scope=["Workspace"], title="Bad")
                    huge = "é" * 20000
                    mutate("thread.reply", "reply", thread_id="thread", expected_revision="3", comment_id="long", body=huge)
                    bounded = read("thread.get", thread_id="thread", include_messages=True, max_bytes="4096")
                    self.assertLessEqual(len(json.dumps(bounded, separators=(",", ":"), ensure_ascii=False).encode()), 4096)
                    self.assertTrue(bounded["meta"]["budget"]["truncated"])
                    self.assertTrue(bounded["meta"]["budget"]["details"])
                    reject("request.list", expected_kind="Conflict", **next_params)
                    mutate("comment.tombstone", "tombstone", comment_id="long", expected_revision="1")
                    tombstone = read("comment.get", comment_id="long")["data"]
                    self.assertTrue(tombstone["tombstone"])
                    self.assertEqual(tombstone["body"], "")
                    mutate("message.send", "send", message_id="message", recipients=[bob], body="Initial delivery", correlation_id="c" * 512)
                    inbox = read("inbox.read", consumer_id="consumer-a", recipient=bob)
                    message_packet = next(item for item in inbox["data"]["items"] if item["source"]["kind"] == "message")
                    source = message_packet["body_source"]
                    mutate("comment.edit", "edit-message", comment_id=source["comment_id"], expected_revision="1", body="Edited delivery")
                    inbox = read("inbox.read", consumer_id="consumer-a", recipient=bob)
                    message_packet = next(item for item in inbox["data"]["items"] if item["source"]["kind"] == "message")
                    self.assertEqual(message_packet["body_source"]["body"], "Initial delivery")
                    self.assertEqual(message_packet["body_source"]["version_kind"], "initial")
                    selected = message_packet["notification_id"]
                    mutate("inbox.ack", "delivery-ack", actor="bob", consumer_id="consumer-a", recipient=bob, notification_ids=[selected])
                    self.assertNotIn(selected, [item["notification_id"] for item in read("inbox.read", consumer_id="consumer-a", recipient=bob)["data"]["items"]])
                    self.assertIn(selected, [item["notification_id"] for item in read("inbox.read", consumer_id="consumer-b", recipient=bob)["data"]["items"]])
                    # Save both compositions before sending; retries use their exact envelopes.
                    def saved_mutation(method, path, **params):
                        covered.add(method)
                        argv = [str(EXE), "request", str(address), method,
                                "--workspace-id", "communication", "--actor-id", "alice",
                                "--save-request", str(path)]
                        for key, value in params.items():
                            argv.extend(["--json-field", key, json.dumps(value)])
                        return json.loads(subprocess.check_output(argv))["result"]

                    ask_path = root / "ask.json"
                    asked = saved_mutation("request.ask", ask_path, request_id="asked",
                                           title="Choose an approach", body="Which approach?",
                                           recipients=[bob], resolver_id="alice")
                    ask = asked["data"]
                    self.assertEqual((ask["request_revision"], ask["thread_revision"]), ("1", "2"))
                    self.assertEqual(ask["question"]["revision"], "1")
                    self.assertEqual(read("request.get", request_id="asked")["data"]["thread_revision"], "2")
                    before_failure = call("activity.since", workspace_id="communication", limit="100", max_bytes="1048576")
                    for actor, revision, body, kind in [("bob", "1", "Unauthorized", "Conflict"),
                                                        ("alice", "0", "Stale", "Conflict"),
                                                        ("alice", "1", "   ", "Invalid_argument"),
                                                        ("alice", "1", "x" * 65537, "Invalid_argument")]:
                        reject("request.resolve", expected_kind=kind, actor_id=actor,
                               mutation_id="invalid-answer-" + actor + revision + str(len(body)),
                               request_id="asked", expected_revision=revision, body=body)
                    reject("request.ask", expected_kind="Conflict", actor_id="alice", mutation_id="collision",
                           request_id="asked", title="Collision", body="Question", recipients=[bob], resolver_id="alice")
                    self.assertEqual(call("activity.since", workspace_id="communication", limit="100", max_bytes="1048576"), before_failure)
                    answer_path = root / "answer.json"
                    answered = saved_mutation("request.resolve", answer_path, request_id="asked",
                                              expected_revision="1", body="Use existing events.")
                    self.assertEqual(answered["data"]["status"]["kind"], "resolved")
                    question_thread = read("thread.get", thread_id=ask["thread_id"])["data"]
                    self.assertEqual(question_thread["revision"], "3")
                    self.assertEqual(len(question_thread["comment_ids"]), 2)
                    answer_comment = read("comment.get", comment_id=question_thread["comment_ids"][1])["data"]
                    self.assertEqual(answer_comment["body"], "Use existing events.")
                    self.assertEqual(answer_comment["actor_id"], "alice")
                    self.assertEqual(answer_comment["reply_to_comment_id"], ask["question"]["comment_id"])
                    self.assertEqual(read("request.get", request_id="asked")["data"]["thread_revision"], "3")
                    mutate("ticket.create", "ask-ticket", ticket_id="task", title="Task")
                    ticket_ask = mutate("request.ask", "ticket-ask", request_id="ticket-ask",
                                        ticket_id="task", title="Task question", body="Which task?",
                                        recipients=[bob], resolver_id="bob")
                    filtered = read("request.list", ticket_id="task", resolver_id="bob", limit="1", max_bytes="4096")
                    self.assertEqual([item["request_id"] for item in filtered["data"]["items"]], ["ticket-ask"])
                    self.assertIsNone(filtered["data"]["next_offset"])
                    self.assertEqual(read("request.list", ticket_id="task", resolver_id="alice")["data"]["items"], [])
                    retry_inbox = read("inbox.read", consumer_id="ask-consumer", recipient=bob)
                    for path, original in [(ask_path, asked), (answer_path, answered)]:
                        self.assertEqual(json.loads(subprocess.check_output([str(EXE), "retry", str(address), str(path)]))["result"], original)
                    self.assertEqual(read("inbox.read", consumer_id="ask-consumer", recipient=bob), retry_inbox)
                    audit = call("activity.since", workspace_id="communication", limit="100", max_bytes="1048576")
                    retained = [change["event"] for row in audit["data"]["items"] for change in row["changes"] if change["kind"] == "communication_changed"]
                    sent = next(event["update"]["message"] for event in retained if event["update"]["kind"] == "message_put")
                    self.assertEqual(sent["comment_revision"], "1")
                    self.assertEqual(sent["correlation_id"], "c" * 512)
                    self.assertEqual(sent["recipients"], [bob])
                    acknowledged = next(event["update"] for event in retained if event["update"]["kind"] == "inbox_ack")
                    self.assertEqual(acknowledged["consumer_id"], "consumer-a")
                    self.assertEqual(acknowledged["notification_ids"], [selected])
                    initial_request = next(event["update"]["request"] for event in retained if event["update"]["kind"] == "request_put" and event["update"]["request"]["request_id"] == "request")
                    self.assertEqual(initial_request["deliveries"], created["data"]["deliveries"])
                    process.terminate()
                    process.wait(timeout=10)
                    address.unlink(missing_ok=True)
                    process = start()
                    retried = mutate("request.create", "request", request_id="request", thread_id="thread", kind="review", comment_id="comment", resolver_id="alice", teams=["team"])
                    self.assertEqual(retried, created)
                    for path, original in [(ask_path, asked), (answer_path, answered)]:
                        self.assertEqual(json.loads(subprocess.check_output([str(EXE), "retry", str(address), str(path)]))["result"], original)
                    self.assertEqual(read("inbox.read", consumer_id="ask-consumer", recipient=bob), retry_inbox)
                    self.assertEqual(call("activity.since", workspace_id="communication", limit="100", max_bytes="1048576"), audit)
                    self.assertEqual(read("request.get", request_id="request")["data"]["status"]["kind"], "resolved")
                    expected = {name for name in methods if name.split('.')[0] in {"board", "team", "subscription", "thread", "request"}}
                    self.assertTrue(expected <= covered, expected - covered)
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
