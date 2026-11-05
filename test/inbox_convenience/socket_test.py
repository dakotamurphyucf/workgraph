"""Explicit CLI addressing and unread self-filter pagination through real sockets."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()


class InboxConvenienceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-self-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = self.root / "s"
        self.requests = self.root / "requests"
        self.requests.mkdir()
        self.context = self.root / "context.json"
        self.context.write_text(json.dumps({"socket": str(self.socket), "workspace_id": "w",
                                           "actor_id": "alice", "run_id": "run",
                                           "request_directory": str(self.requests)}))
        self.log = (self.root / "daemon.log").open("w")
        self.addCleanup(self.log.close)
        self.daemon = subprocess.Popen([str(EXE), "serve", str(self.root / "registry"),
                                        str(self.socket)], stdout=subprocess.DEVNULL, stderr=self.log)
        self.addCleanup(self.stop)
        self.mutation = 0
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.socket.exists() and self.cli("request", self.socket, "daemon.health").returncode == 0:
                break
            self.assertIsNone(self.daemon.poll(), (self.root / "daemon.log").read_text())
            time.sleep(.02)
        else:
            self.fail("daemon did not become ready")
        self.write("workspace.create", name="Work", root=str(self.root / "workspace"))
        self.write("run.register", actor="alice", target_run_id="run", objective="Work")
        self.write("run.register", actor="alice", target_run_id="other", objective="Other work")

    def stop(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=10)

    def cli(self, *args, expected=None):
        result = subprocess.run([str(EXE), *map(str, args)], capture_output=True, text=True,
                                timeout=10)
        if expected is not None:
            self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
        return result

    def rpc(self, method, **params):
        result = self.cli("call", self.socket, method,
                          json.dumps({"workspace_id": "w", **params}), expected=0)
        return json.loads(result.stdout)["result"]

    def write(self, method, actor="operator", **params):
        self.mutation += 1
        return self.rpc(method, actor_id=actor, mutation_id=f"m-{self.mutation}", **params)

    def error(self, result, substring):
        self.assertEqual(result.returncode, 1, result.stdout)
        value = json.loads(result.stdout)["error"]["data"]
        self.assertEqual(value["kind"], "Invalid_argument", value)
        self.assertIn(substring, value["message"])

    def message(self, identity, *, actor="bob", run=None, body="body", recipients=None):
        params = dict(message_id=identity, body=body,
                      recipients=recipients or [{"kind": "actor", "id": "alice"},
                                                {"kind": "run", "id": "run"}])
        if run is not None:
            params["run_id"] = run
        return self.write("message.send", actor=actor, **params)

    def inbox(self, *, recipient=None, **params):
        return self.rpc("inbox.read", consumer_id="consumer",
                        recipient=recipient or {"kind": "actor", "id": "alice"},
                        **params)["data"]

    def test_self_recipient_override_and_no_implicit_general_filters(self):
        self.message("mine", recipients=[{"kind": "actor", "id": "alice"}])
        self.message("theirs", recipients=[{"kind": "actor", "id": "bob"}])
        own = self.cli("--context", self.context, "inbox", "read", "--self",
                       "--consumer-id", "consumer", expected=0)
        own_data = json.loads(own.stdout)["result"]["data"]
        self.assertEqual(own_data["recipient"], {"kind": "actor", "id": "alice"})
        self.assertEqual(own_data["items"][0]["source"]["id"], "mine")
        explicit = self.cli("--context", self.context, "request", "inbox.read", "--self",
                            "--consumer-id", "consumer", "--json-field", "recipient",
                            '{"kind":"actor","id":"bob"}', expected=0)
        self.assertEqual(json.loads(explicit.stdout)["result"]["data"]["items"][0]["source"]["id"],
                         "theirs")
        without_context = self.cli("request", self.socket, "inbox.read", "--self",
                                   "--workspace-id", "w", "--consumer-id", "consumer",
                                   "--json-field", "recipient", '{"kind":"actor","id":"bob"}',
                                   expected=0)
        self.assertEqual(json.loads(without_context.stdout)["result"]["data"]["recipient"]["id"], "bob")
        self.error(self.cli("request", self.socket, "inbox.read", "--self", "--workspace-id", "w",
                            "--consumer-id", "consumer"), "requires --context")
        unflagged = self.cli("--context", self.context, "request", "inbox.read", "--consumer-id",
                             "consumer", expected=1)
        self.assertIn("recipient", unflagged.stdout)
        raw = self.cli("--context", self.context, "request", "inbox.read", "--json-field", "self",
                        "true", "--consumer-id", "consumer", "--json-field", "recipient",
                        '{"kind":"actor","id":"alice"}', expected=1)
        self.assertIn("unknown field", raw.stdout)
        self.error(self.cli("--context", self.context, "request", "request.reassign", "--self"),
                   "unsupported")
        listed = self.cli("--context", self.context, "request", "run.list", expected=0)
        self.assertEqual(len(json.loads(listed.stdout)["result"]["data"]["items"]), 2)
        self.cli("--context", self.context, "request", "request.list", "--self", expected=0)
        self.write("board.put", board_id="board", expected_revision="0",
                   scope={"kind": "workspace"}, title="Board")
        self.write("thread.put", thread_id="thread", expected_revision="0", board_id="board",
                   title="Question", state="open", participants=["alice"], mentions=["bob"])
        self.write("comment.add", comment_id="comment", target={"kind": "workspace"}, body="Question")
        self.write("thread.attach", thread_id="thread", expected_revision="1", comment_id="comment")
        for request_id, recipient in (("for-alice", "alice"), ("for-bob", "bob")):
            self.write("request.create", request_id=request_id, thread_id="thread", kind="help",
                       comment_id="comment", resolver_id="operator",
                       recipients=[{"kind": "actor", "id": recipient}])
        personal = self.cli("--context", self.context, "request", "request.list", "--self", expected=0)
        self.assertEqual([item["request_id"] for item in json.loads(personal.stdout)["result"]["data"]["items"]],
                         ["for-alice"])
        all_requests = self.cli("--context", self.context, "request", "request.list", expected=0)
        self.assertEqual(len(json.loads(all_requests.stdout)["result"]["data"]["items"]), 2)
        self.cli("--context", self.context, "request", "request.acknowledge", "--self",
                 "--request-id", "for-alice", "--expected-revision", "1", expected=0)
        accepted = self.cli("--context", self.context, "request", "request.accept", "--self",
                            "--request-id", "for-alice", "--expected-revision", "2", expected=0)
        self.assertEqual(json.loads(accepted.stdout)["result"]["data"]["responsibility"]["kind"], "accepted")

    def test_current_run_self_selector_and_saved_request_has_no_self_param(self):
        selected = self.cli("--context", self.context, "request", "run.get", "--self", expected=0)
        selected = json.loads(selected.stdout)["result"]["data"]
        self.assertEqual(selected["run_id"], "run")
        explicit = self.cli("request", self.socket, "run.get", "--self", "--workspace-id", "w",
                            "--target-run-id", "other", expected=0)
        self.assertEqual(json.loads(explicit.stdout)["result"]["data"]["run_id"], "other")
        saved = self.root / "observe.json"
        observed = self.cli("--context", self.context, "request", "run.observe", "--self",
                            "--expected-revision", selected["revision"], "--observed-unix-ms", "1000",
                            "--save-request", saved, expected=0)
        request = json.loads(saved.read_text())
        self.assertEqual(request["params"]["target_run_id"], "run")
        self.assertNotIn("self", request["params"])
        self.assertTrue(json.loads(observed.stdout)["result"]["meta"]["durable"])
        self.error(self.cli("retry", self.socket, saved, "--self"), "cannot change")
        self.error(self.cli("--context", self.context, "request", "run.register", "--self"), "unsupported")
        values = json.loads(self.context.read_text())
        values.pop("run_id")
        self.context.write_text(json.dumps(values))
        self.error(self.cli("--context", self.context, "request", "run.get", "--self"), "run_id in --context")

    def test_exclude_self_visible_pagination_and_hidden_rows_remain_unacked(self):
        self.message("hidden-first", actor="alice", body="h" * 4500)
        self.message("visible-first", body="a" * 1800)
        self.message("hidden-middle", actor="alice", run="other")
        self.message("visible-last", body="b" * 1800)
        self.message("hidden-last", actor="alice", run="run")
        unfiltered = self.inbox()
        self.assertFalse(unfiltered["exclude_self"])
        self.assertEqual(len(unfiltered["items"]), 5)
        page = self.inbox(exclude_self=True, limit="1")
        self.assertTrue(page["exclude_self"])
        self.assertEqual([item["source"]["id"] for item in page["items"]], ["visible-first"])
        self.assertEqual(page["next_after"], page["items"][-1]["notification_id"])
        self.assertEqual(page["remaining"], "1")
        second = self.inbox(exclude_self=True, after=page["next_after"], through=page["through"],
                            limit="1")
        self.assertEqual([item["source"]["id"] for item in second["items"]], ["visible-last"])
        self.assertEqual(second["remaining"], "0")
        processed = [page["items"][0]["notification_id"], second["items"][0]["notification_id"]]
        self.write("inbox.ack", actor="alice", consumer_id="consumer",
                   recipient={"kind": "actor", "id": "alice"}, notification_ids=processed)
        hidden = self.inbox(exclude_self=False, through=page["through"])
        self.assertEqual([item["source"]["id"] for item in hidden["items"]],
                         ["hidden-first", "hidden-middle", "hidden-last"])
        empty = self.inbox(exclude_self=True)
        self.assertEqual(empty["items"], [])
        self.assertEqual(empty["next_after"], "0")
        # Same actor on another run, and absent run, remain visible to a run recipient.
        run_page = self.inbox(recipient={"kind": "run", "id": "run"}, exclude_self=True)
        self.assertEqual([item["source"]["id"] for item in run_page["items"]],
                         ["hidden-first", "visible-first", "hidden-middle", "visible-last"])
        expected = [f"budget-{index}" for index in range(6)]
        for identity in expected:
            self.message(identity, body="v" * 1800)
        budget = self.inbox(exclude_self=True, limit="100", max_bytes="4096")
        self.assertLess(len(budget["items"]), len(expected))
        actual = []
        while True:
            self.assertTrue(budget["items"])
            actual.extend(item["source"]["id"] for item in budget["items"])
            self.assertEqual(actual, expected[:len(actual)])
            self.assertEqual(budget["remaining"], str(len(expected) - len(actual)))
            self.assertEqual(budget["next_after"], budget["items"][-1]["notification_id"])
            if budget["remaining"] == "0":
                break
            budget = self.inbox(exclude_self=True, after=budget["next_after"],
                                through=budget["through"], limit="100", max_bytes="4096")
        self.assertEqual(actual, expected)

    def test_empty_inbox_diagnostics_and_communication_observation(self):
        actor = {"kind": "actor", "id": "alice"}
        run = {"kind": "run", "id": "run"}
        self.message("actor-only", recipients=[actor])
        self.message("run-only", recipients=[run])
        self.message("self", actor="alice", recipients=[actor])
        captured = self.inbox()
        ids = [row["notification_id"] for row in captured["items"]]
        self.assertEqual(captured["recipient"], actor)
        self.assertEqual(captured["consumer_id"], "consumer")
        self.assertEqual(captured["after"], "0")
        self.assertEqual([row["source"]["id"] for row in captured["items"]], ["actor-only", "self"])
        self.assertEqual([row["source"]["id"] for row in self.inbox(recipient=run)["items"]], ["run-only"])
        self.assertEqual(self.inbox(kinds=["request_created"])["items"], [])
        self.assertEqual(self.inbox(after=captured["through"])["items"], [])
        self.assertEqual([row["source"]["id"] for row in self.inbox(exclude_self=True)["items"]], ["actor-only"])
        self.message("later", recipients=[actor])
        self.assertEqual(self.inbox(through=captured["through"])["items"], captured["items"])

        # Communication-only observation drains an immutable capture without ack.
        selected = {"recipient": actor, "consumer_id": "consumer", "kinds": ["communication"]}
        first = self.rpc("attention.read", filter=selected, limit="1")["data"]
        page = first
        observed = []
        while True:
            self.assertEqual(page["through"], first["through"])
            self.assertFalse(page["needs_larger_budget"])
            self.assertTrue(all(row["kind"] == "communication_group" for row in page["items"]))
            observed.extend(identifier for row in page["items"] for identifier in row["notification_ids"])
            if not page["has_more"]:
                break
            page = self.rpc("attention.read", filter=selected, cursor=page["cursor"], limit="1")["data"]
        all_ids = [row["notification_id"] for row in self.inbox()["items"]]
        self.assertEqual(observed, all_ids)
        self.assertEqual(ids, all_ids[:2])
        self.assertEqual(self.rpc("attention.wait", filter=selected, cursor=page["cursor"],
                                  timeout_ms="1")["data"]["items"], [])
        self.assertEqual([row["notification_id"] for row in self.inbox()["items"]], all_ids)
        self.write("inbox.ack", actor="alice", consumer_id="consumer", recipient=actor,
                   notification_ids=all_ids)
        self.assertEqual(self.inbox()["items"], [])
        self.assertEqual(self.rpc("attention.read", filter=selected)["data"]["items"], [])
        fresh = self.rpc("inbox.read", consumer_id="diagnostic", recipient=actor)["data"]
        self.assertEqual([row["notification_id"] for row in fresh["items"]], all_ids)
        self.assertEqual([row["source"]["id"] for row in self.inbox(recipient=run)["items"]], ["run-only"])

        # A request's status does not clear unread delivery, and ticket filters
        # select the actual linked ticket rather than the recipient's current work.
        for ticket in ("selected", "other"):
            self.write("ticket.create", ticket_id=ticket, title=ticket)
        asked = self.write("request.ask", request_id="question", ticket_id="selected",
                           title="Question", body="Confirm", resolver_id="operator",
                           recipients=[actor])["data"]
        only_question = self.inbox(ticket_id="selected", kinds=["request_created"])
        self.assertEqual(len(only_question["items"]), 1)
        self.assertEqual(self.inbox(ticket_id="other")["items"], [])
        self.write("request.resolve", request_id="question", expected_revision=asked["request_revision"],
                   body="Confirmed")
        still_unread = self.inbox(ticket_id="selected", kinds=["request_created"])
        self.assertEqual([row["notification_id"] for row in still_unread["items"]],
                         [row["notification_id"] for row in only_question["items"]])
        self.assertEqual(self.rpc("request.get", request_id="question")["data"]["status"]["kind"], "resolved")

    def test_wait_diagnostics_filters_and_shutdown_cancellation(self):
        bad = self.cli("--context", self.context, "request", "inbox.wait", "--self",
                       "--consumer-id", "consumer", "--timeout-ms", "25001", expected=1)
        response = json.loads(bad.stdout)["error"]["data"]
        self.assertIn("timeout_ms", response["message"])
        self.assertIn("25-second server cap", response["message"])
        wrong = self.cli("call", self.socket, "inbox.wait", json.dumps({"workspace_id": "w",
                         "consumer_id": "consumer", "recipient": {"kind": "actor", "id": "alice"},
                         "timeout_ms": True}), expected=1)
        self.assertIn("25-second server cap", json.loads(wrong.stdout)["error"]["data"]["message"])
        with concurrent.futures.ThreadPoolExecutor() as pool:
            wait = pool.submit(self.cli, "--context", self.context, "request", "inbox.wait", "--self",
                               "--consumer-id", "consumer", "--exclude-self", "true", "--timeout-ms", "3000")
            time.sleep(.1)
            self.message("only-self", actor="alice")
            time.sleep(.1)
            if wait.done():
                unexpected = wait.result()
                self.fail("filtered wait completed early: " + unexpected.stderr + unexpected.stdout)
            self.message("external")
            waited = wait.result(timeout=5)
            self.assertEqual(waited.returncode, 0, waited.stderr)
            self.assertEqual([item["source"]["id"] for item in json.loads(waited.stdout)["result"]["data"]["items"]],
                             ["external"])
        # A read waiter must never hold serialized dispatch or delay shutdown.
        pending = subprocess.Popen([str(EXE), "--context", str(self.context), "request", "inbox.wait",
                                    "--self", "--consumer-id", "fresh", "--exclude-self", "true",
                                    "--after", self.inbox()["through"], "--timeout-ms", "25000"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(.1)
        started = time.monotonic()
        self.cli("request", self.socket, "daemon.shutdown", expected=0)
        self.daemon.wait(timeout=5)
        pending.communicate(timeout=5)
        self.assertLess(time.monotonic() - started, 5)

    def test_cli_receive_process_then_ack_only_visible_ids(self):
        self.message("example-hidden", actor="alice")
        self.message("example-visible")
        original = self.inbox()
        original_ids = [item["notification_id"] for item in original["items"]]
        self.assertEqual([item["source"]["id"] for item in original["items"]],
                         ["example-hidden", "example-visible"])

        received = self.cli("--context", self.context, "request", "inbox.wait", "--self",
                            "--consumer-id", "consumer", "--exclude-self", "true",
                            "--timeout-ms", "1", expected=0)
        visible = json.loads(received.stdout)["result"]["data"]
        self.assertTrue(visible["exclude_self"])
        self.assertEqual([item["source"]["id"] for item in visible["items"]],
                         ["example-visible"])
        processed = []

        def process_once(item):
            # Neither receiving nor callback work acknowledges delivery. A harness
            # must complete its own durable processing before constructing the ack.
            self.assertEqual([entry["notification_id"] for entry in self.inbox()["items"]],
                             original_ids)
            self.assertEqual(list(self.requests.glob("*.json")), [])
            processed.append((item["notification_id"], item["source"]["id"]))

        for item in visible["items"]:
            process_once(item)
        self.assertEqual([source for _, source in processed], ["example-visible"])
        processed_ids = [identity for identity, _ in processed]
        acknowledged = self.cli("--context", self.context, "request", "inbox.ack", "--self",
                                "--consumer-id", "consumer", "--json-field", "notification_ids",
                                json.dumps(processed_ids), expected=0)
        self.assertTrue(json.loads(acknowledged.stdout)["result"]["meta"]["durable"])
        remaining = self.inbox()
        self.assertEqual([item["source"]["id"] for item in remaining["items"]], ["example-hidden"])
        independent = self.rpc("inbox.read", consumer_id="independent",
                               recipient={"kind": "actor", "id": "alice"})["data"]
        self.assertEqual([item["notification_id"] for item in independent["items"]], original_ids)
        saved = list(self.requests.glob("*.json"))
        self.assertEqual(len(saved), 1)
        request = json.loads(saved[0].read_text())
        self.assertEqual(request["method"], "inbox.ack")
        self.assertEqual(request["params"]["notification_ids"], processed_ids)
        self.assertEqual(request["params"]["recipient"], {"kind": "actor", "id": "alice"})
        self.assertEqual(request["params"]["consumer_id"], "consumer")
        self.assertNotIn("self", request["params"])


if __name__ == "__main__":
    unittest.main()
