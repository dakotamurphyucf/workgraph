"""Canonical History API through a real daemon, including durable restart."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
ADAPTER = Path(__file__).resolve().parents[2] / "examples/history-adapter.py"
spec = importlib.util.spec_from_file_location("history_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class HistorySocketTest(unittest.TestCase):
    def test_canonical_history_retries_captures_and_bytes_survive_restart(self):
        with tempfile.TemporaryDirectory(prefix="wg-history-", dir="/tmp") as temporary:
            directory = Path(temporary)
            address = directory / "socket"
            with (directory / "daemon.log").open("w+") as log:
                daemon = None

                def start():
                    process = subprocess.Popen(
                        [str(EXE), "serve", str(directory / "registry"), str(address)],
                        stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if process.poll() is not None:
                            log.seek(0)
                            self.fail(log.read())
                        if time.monotonic() >= deadline:
                            self.fail("daemon startup timed out")
                        time.sleep(.01)
                    return process

                def call(method, **params):
                    return adapter.Workgraph(address).call(method, params)

                def mutate(method, mutation, **params):
                    result = call(method, workspace_id="history", actor_id="agent",
                                  mutation_id=mutation, **params)
                    self.assertIs(result["meta"]["durable"], True)
                    self.assertNotIn("workspace_revision", result["meta"])
                    return result

                def read(method, **params):
                    result = call(method, workspace_id="history", **params)
                    self.assertIn("history_capture", result["meta"])
                    self.assertNotIn("workspace_revision", result["meta"])
                    return result

                def rejected(method, expected, **params):
                    with self.assertRaises(RuntimeError) as error:
                        call(method, workspace_id="history", **params)
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], expected)

                try:
                    daemon = start()
                    call("workspace.create", workspace_id="history", actor_id="agent",
                         mutation_id="workspace", name="History", root=str(directory / "workspace"))
                    planning_before = call("changes.read", workspace_id="history")
                    create_params = dict(session_id="conversation", title="Conversation")
                    created = mutate("session.create", "create", **create_params)
                    payload = b"\xff\x00" * 4500 + b"tail"
                    text = b"needle in the retained text"
                    event = dict(client_id="source", role="user", kind="message", phase="completed",
                                 provenance={"literal": "$unresolved"},
                                 payload={"kind": "inline", "bytes_base64": base64.b64encode(payload).decode()},
                                 searchable_text={"kind": "inline", "bytes_base64": base64.b64encode(text).decode()})
                    append_params = dict(session_id="conversation", events=[event])
                    appended = mutate("session.append", "append", **append_params)
                    self.assertEqual(appended, mutate("session.append", "append", **append_params))
                    self.assertEqual(appended["data"], mutate("session.append", "deduplicate", **append_params)["data"])
                    rejected("session.append", "Idempotency_conflict", actor_id="agent", mutation_id="append",
                             **append_params, run_id="different")
                    event_ref = appended["data"]["events"][0]
                    metadata = read("history.get", event_ref=event_ref)
                    capture = metadata["meta"]["history_capture"]
                    head = capture["head"]
                    self.assertEqual(metadata["data"]["event_ref"], event_ref)
                    self.assertEqual(metadata["data"]["event"]["payload"]["kind"], "blob")
                    self.assertEqual(metadata["data"]["event"]["provenance"], {"literal": "$unresolved"})
                    session = read("session.get", session_id="conversation", head=head)
                    self.assertEqual(session["data"]["session"]["actor_id"], "agent")
                    self.assertEqual(session["data"]["through"], "1")
                    empty = read("session.list", head=None)
                    self.assertEqual(empty["data"]["items"], [])
                    later = dict(event, client_id="later")
                    mutate("session.append", "later", session_id="conversation", events=[later])
                    page = read("history.read", session_id="conversation", direction="after", head=head)
                    self.assertEqual(page["data"]["through"], "1")
                    self.assertEqual(len(page["data"]["items"]), 1)
                    hits = read("history.search", text="needle", head=head)
                    self.assertIs(hits["data"]["complete"], True)
                    self.assertEqual([hit["event_ref"] for hit in hits["data"]["items"]], [event_ref])
                    after = read("history.search", text="needle", head=head, after_event=event_ref)
                    self.assertEqual(after["data"]["items"], [])
                    rejected("history.get", "Invalid_argument", ref=event_ref)
                    rejected("history.payload", "Invalid_argument", event_ref=event_ref, part="payload")
                    rejected("history.search", "Invalid_argument", text="needle", after=event_ref)

                    recovered = bytearray()
                    chunks = 0
                    while True:
                        chunk = read("history.payload", event_ref=event_ref, head=head,
                                     offset=str(len(recovered)), length="262144", max_bytes="4096")
                        self.assertLessEqual(len(adapter.canonical(chunk).encode()), 4096)
                        self.assertEqual(chunk["meta"]["history_capture"], capture)
                        recovered.extend(base64.b64decode(chunk["data"]["bytes_base64"], validate=True))
                        self.assertEqual(int(chunk["data"]["next_offset"]), len(recovered))
                        chunks += 1
                        if not chunk["data"]["has_more"]:
                            self.assertEqual(chunk["data"]["blob"]["digest"], hashlib.sha256(recovered).hexdigest())
                            self.assertEqual(int(chunk["data"]["total_bytes"]), len(payload))
                            break
                        self.assertLess(chunks, 10)
                    self.assertEqual(bytes(recovered), payload)
                    self.assertGreater(chunks, 1)
                    searchable = read("history.payload", event_ref=event_ref, head=head,
                                      part={"kind": "searchable_text"})
                    self.assertEqual(base64.b64decode(searchable["data"]["bytes_base64"]), text)
                    archived = mutate("session.archive", "archive", session_id="conversation")
                    self.assertIs(archived["data"]["session"]["archived"], True)
                    self.assertEqual(read("session.list")["data"]["items"], [])
                    listed = read("session.list", include_archived=True)["data"]["items"]
                    self.assertEqual(len(listed), 1)
                    self.assertIs(listed[0]["archived"], True)
                    rejected("session.append", "Conflict", actor_id="agent", mutation_id="archived-append",
                             session_id="conversation", events=[dict(event, client_id="forbidden")])
                    self.assertEqual(created, mutate("session.create", "create", **create_params))
                    self.assertEqual(call("changes.read", workspace_id="history"), planning_before)
                    call("daemon.shutdown")
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    daemon = start()
                    self.assertEqual(created, mutate("session.create", "create", **create_params))
                    self.assertEqual(appended, mutate("session.append", "append", **append_params))
                    self.assertEqual(archived, mutate("session.archive", "archive", session_id="conversation"))
                    old = read("history.read", session_id="conversation", direction="after", head=head)
                    self.assertEqual(old, page)
                    self.assertIs(read("session.get", session_id="conversation")["data"]["session"]["archived"], True)
                    call("daemon.shutdown")
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            daemon.wait()


if __name__ == "__main__":
    unittest.main()
