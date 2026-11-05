"""Exact bounded audit traversal: immutable capture, ordinals, chunks and replay."""
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()
SPEC = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[2] / "skills/workgraph/scripts/history-adapter.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


class TraversalTest(unittest.TestCase):
    def test_large_commit_chunks_capture_and_replay(self):
        with tempfile.TemporaryDirectory(prefix="wg-audit-pages-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "socket"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 15
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def read(method="activity.read", **params):
                    return adapter.Workgraph(address).call(method, {"workspace_id": "audit", **params})

                def write(method, mutation, **params):
                    return read(method, actor_id="owner", mutation_id=mutation, **params)

                def stop():
                    adapter.Workgraph(address).call("daemon.shutdown", {})
                    daemon.wait(timeout=15)

                def bounded(page, maximum):
                    actual = len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode())
                    self.assertEqual(int(page["meta"]["budget"]["returned_bytes"]), actual)
                    self.assertLessEqual(actual, maximum)
                    self.assertTrue(page["data"]["items"])

                try:
                    start()
                    write("workspace.create", "workspace", name="Audit", root=str(root / "workspace"))
                    write("transaction.apply", "tickets", operations=[{"method": "ticket.create", "params": {"ticket_id": f"t-{i}", "title": f"Ticket {i}"}} for i in range(32)])
                    before = read("workspace.get")["meta"]["workspace_revision"]
                    write("transaction.apply", "policies", operations=[{"method": "ticket.hierarchy.put", "params": {"ticket_id": f"t-{i}", "expected_revision": "0", "descendant_prerequisites": "inherit", "child_completion": "all_done", "reason": "x" * 2400}} for i in range(32)])
                    with self.assertRaises(RuntimeError) as oversized:
                        read("activity.since", after=before)
                    problem = json.loads(str(oversized.exception))["data"]
                    self.assertEqual("Invalid_argument", problem["kind"])
                    self.assertEqual("activity.read", problem["details"]["suggestion"])
                    exact = read("activity.since", after=before, max_bytes="1048576")["data"]["items"][0]
                    self.assertGreater(len(canonical(exact)), 65536)
                    page = read(after=before, max_bytes="8192")
                    pinned = {key: page["data"][key] for key in ("through", "lineage")}
                    cursor = page["data"]["cursor"]
                    # A mutation while paging must neither invalidate nor extend this capture.
                    write("ticket.create", "later", ticket_id="later", title="Outside pinned audit")
                    records = []
                    while True:
                        bounded(page, 8192)
                        self.assertEqual(pinned, {key: page["data"][key] for key in pinned})
                        for row in page["data"]["items"]:
                            self.assertEqual("change", row["kind"])
                            self.assertEqual(len(records), int(row["change_index"]))
                            self.assertEqual("32", row["change_count"])
                            self.assertEqual(hashlib.sha256(canonical(row["value"])).hexdigest(), row["digest"])
                            records.extend(row["value"]["changes"])
                        if page["data"]["cursor"] is None:
                            break
                        page = read(cursor=page["data"]["cursor"], max_bytes="8192")
                    self.assertEqual(exact["changes"], records)
                    with self.assertRaises(RuntimeError) as altered:
                        read(cursor=cursor, actor_id="other")
                    self.assertEqual("Conflict", json.loads(str(altered.exception))["data"]["kind"])
                    bad = json.loads(base64.b64decode(cursor))
                    bad["byte_offset"] = "999999999"
                    bad_cursor = base64.b64encode(canonical(bad)).decode()
                    # Cursor offsets are validated against the pending exact canonical source.
                    with self.assertRaises(RuntimeError):
                        read(cursor=bad_cursor)
                    bad = json.loads(base64.b64decode(cursor))
                    inner = json.loads(base64.b64decode(bad["capture"]))
                    inner["anchor"] = "0" * 64
                    bad["capture"] = base64.b64encode(canonical(inner)).decode()
                    with self.assertRaises(RuntimeError) as lineage_error:
                        read(cursor=base64.b64encode(canonical(bad)).decode())
                    self.assertEqual("Conflict", json.loads(str(lineage_error.exception))["data"]["kind"])
                    continued = read(cursor=cursor, max_bytes="8192")["data"]
                    stop()
                    start()
                    self.assertEqual(continued, read(cursor=cursor, max_bytes="8192")["data"])
                    before = read("workspace.get")["meta"]["workspace_revision"]
                    body = '\"é\\\n' * 9000
                    write("transaction.apply", "huge", operations=[{"method": "comment.add", "params": {"comment_id": f"large-{i}", "target": {"kind": "ticket", "id": "t-0"}, "body": body}} for i in range(32)])
                    # This valid atomic commit exceeds the maximum single-response budget.
                    with self.assertRaises(RuntimeError):
                        read("activity.since", after=before, max_bytes="1048576")
                    page = read(after=before, target={"kind": "ticket", "ticket_id": "t-0"}, limit="2", max_bytes="4096")
                    data = bytearray()
                    originals = []
                    current_index = 0
                    chunk_count = 0
                    while True:
                        bounded(page, 16384)
                        for row in page["data"]["items"]:
                            self.assertEqual(current_index, int(row["change_index"]))
                            self.assertEqual(len(data), int(row["byte_offset"]))
                            if row["kind"] == "change":
                                data.extend(canonical(row["value"]))
                            else:
                                chunk_count += 1
                                data.extend(row["value"].encode())
                            if len(data) == int(row["total_bytes"]):
                                self.assertEqual(row["digest"], hashlib.sha256(data).hexdigest())
                                record = json.loads(data)
                                self.assertEqual(body, record["changes"][0]["change"]["version"]["body"])
                                originals.append(record)
                                current_index += 1
                                data.clear()
                        if page["data"]["cursor"] is None:
                            break
                        page = read(cursor=page["data"]["cursor"], target={"kind": "ticket", "ticket_id": "t-0"}, limit="2", max_bytes="16384")
                    self.assertEqual(32, len(originals))
                    self.assertGreater(chunk_count, 32)
                    self.assertFalse(data)
                    # One template registration is itself larger than 1 MiB. Spaces
                    # exercise chunks that are nonempty UTF8 but entirely whitespace.
                    spec = {"parameters": [], "nodes": [{"alias": f"node-{i}", "title": "Node", "description": " " * 65536, "depends_on": [], "parent": None, "capabilities": [], "allowed_actor_ids": None, "reviewers": [], "separate_actor": False} for i in range(20)]}
                    asset = canonical(spec)
                    digest = hashlib.sha256(asset).hexdigest()
                    read("upload.begin", actor_id="owner", upload_id="template", size_bytes=str(len(asset)), digest=digest)
                    for offset in range(0, len(asset), 262144):
                        read("upload.chunk", actor_id="owner", upload_id="template", offset=str(offset), data_base64=base64.b64encode(asset[offset:offset + 262144]).decode())
                    write("resource.finish_upload", "template-asset", upload_id="template", resource_id="template", expected_revision="0", title="Large template", filename="template.json", mime_type="application/json")
                    before = read("workspace.get")["meta"]["workspace_revision"]
                    write("template.register", "template", template_id="template", template_revision="1", digest=digest, spec=spec)
                    page = read(after=before, max_bytes="262144")
                    next_cursor = page["data"]["cursor"]
                    next_page = read(cursor=next_cursor, max_bytes="262144")
                    stop()
                    start()
                    self.assertEqual(next_page, read(cursor=next_cursor, max_bytes="262144"))
                    chunks = bytearray()
                    row = None
                    while True:
                        bounded(page, 262144)
                        row = page["data"]["items"][0]
                        self.assertEqual("chunk", row["kind"])
                        self.assertEqual("0", row["change_index"])
                        self.assertEqual(len(chunks), int(row["byte_offset"]))
                        chunks.extend(row["value"].encode())
                        if page["data"]["cursor"] is None:
                            break
                        page = read(cursor=page["data"]["cursor"], max_bytes="262144")
                    self.assertGreater(len(chunks), 1048576)
                    self.assertEqual(row["digest"], hashlib.sha256(chunks).hexdigest())
                    decoded = json.loads(chunks)
                    self.assertEqual(spec, decoded["changes"][0]["change"]["command"]["template"]["spec"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=15)


if __name__ == "__main__":
    unittest.main()
