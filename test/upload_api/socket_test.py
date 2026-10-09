"""Real daemon upload/private staging and canonical resource publication APIs."""
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


class UploadSocketTest(unittest.TestCase):
    def test_private_staging_publication_budgets_and_exact_restart_retry(self):
        catalog = json.loads(subprocess.check_output([str(EXE), "schema"]))
        methods = {method["name"]: method for method in catalog["methods"]}
        for name in ["upload.begin", "upload.chunk", "upload.status", "upload.abort"]:
            self.assertEqual(methods[name]["mode"], "write")
        self.assertEqual(methods["resource.finish_upload"]["mode"], "mutation")
        for name in ["resource.get", "resource.list", "resource.history"]:
            self.assertEqual(methods[name]["mode"], "read")

        with tempfile.TemporaryDirectory(prefix="wg-upload-", dir="/tmp") as temporary:
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

                def upload(method, id, **params):
                    result = call(method, workspace_id="uploads", actor_id="agent", upload_id=id, **params)
                    self.assertEqual(result["meta"], {})
                    return result

                def mutate(method, mutation, **params):
                    result = call(method, workspace_id="uploads", actor_id="agent", mutation_id=mutation, **params)
                    self.assertIs(result["meta"]["durable"], True)
                    self.assertIn("workspace_revision", result["meta"])
                    return result

                def read(method, **params):
                    return call(method, workspace_id="uploads", **params)

                def rejected(method, kind, **params):
                    with self.assertRaises(RuntimeError) as error:
                        call(method, workspace_id="uploads", **params)
                    self.assertEqual(json.loads(str(error.exception))["data"]["kind"], kind)

                def encoded(bytes):
                    return base64.b64encode(bytes).decode()

                try:
                    daemon = start()
                    workspace = call("workspace.create", workspace_id="uploads", actor_id="agent",
                                     mutation_id="workspace", name="Uploads", root=str(directory / "workspace"))
                    self.assertIs(workspace["meta"]["durable"], True)
                    mutate("ticket.create", "ticket", ticket_id="task", title="Task")
                    bytes = b"\xff\x00" * 140000 + b"tail"
                    digest = hashlib.sha256(bytes).hexdigest()
                    begin = dict(size_bytes=str(len(bytes)), digest=digest)
                    staged = upload("upload.begin", "binary", **begin)
                    self.assertEqual(staged["data"]["received"], "0")
                    self.assertEqual(upload("upload.begin", "binary", **begin), staged)
                    rejected("upload.begin", "Invalid_argument", actor_id="agent", upload_id="bad-envelope",
                             mutation_id="forbidden", size_bytes="1", digest=digest)
                    rejected("upload.status", "Conflict", actor_id="other", upload_id="binary")
                    rejected("upload.chunk", "Invalid_argument", actor_id="agent", upload_id="binary",
                             offset="0", data_base64="/wA")
                    rejected("upload.chunk", "Conflict", actor_id="agent", upload_id="binary",
                             offset="1", data_base64=encoded(b"gap"))
                    first_bytes = bytes[:262144]
                    first = upload("upload.chunk", "binary", offset="0", data_base64=encoded(first_bytes))
                    self.assertEqual(first["data"]["received"], "262144")
                    self.assertEqual(first, upload("upload.chunk", "binary", offset="0", data_base64=encoded(first_bytes)))
                    rejected("upload.chunk", "Conflict", actor_id="agent", upload_id="binary",
                             offset="262143", data_base64=encoded(bytes[262143:262145]))
                    rejected("upload.chunk", "Conflict", actor_id="agent", upload_id="binary",
                             offset="0", data_base64=encoded(b"changed"))
                    self.assertEqual(upload("upload.status", "binary"), first)
                    finish = dict(upload_id="binary", resource_id="attachment", expected_revision="0",
                                  title="Attachment", filename="attachment.bin", mime_type="application/octet-stream")
                    rejected("resource.finish_upload", "Conflict", actor_id="agent", mutation_id="finish", **finish)
                    upload("upload.chunk", "binary", offset="262144", data_base64=encoded(bytes[262144:]))
                    published = mutate("resource.finish_upload", "finish", **finish)
                    self.assertEqual(published["data"]["version"]["actor_id"], "agent")
                    self.assertEqual(published["data"]["version"]["digest"], digest)
                    self.assertEqual(published["data"]["version"]["size_bytes"], str(len(bytes)))
                    self.assertEqual(published, mutate("resource.finish_upload", "finish", **finish))
                    rejected("upload.status", "Not_found", actor_id="agent", upload_id="binary")
                    summary = read("resource.get", resource_id="attachment")["data"]
                    self.assertEqual(summary["resource_id"], "attachment")
                    self.assertNotIn("id", summary)
                    self.assertEqual(summary["current_version"]["actor_id"], "agent")
                    self.assertNotIn("actor", summary["current_version"])
                    chunk = read("resource.read_chunk", resource_id="attachment", version="1", offset="262144", length="262144")
                    self.assertEqual(base64.b64decode(chunk["data"]["data_base64"]), bytes[262144:])

                    mutate("resource.update", "metadata", resource_id="attachment", expected_revision="1",
                           description="x" * 60000)
                    mutate("resource.link", "link", resource_id="attachment", expected_revision="2",
                           target={"kind": "ticket", "id": "task"})
                    view = read("resource.get", resource_id="attachment", max_bytes="4096")
                    self.assertLessEqual(len(adapter.canonical(view).encode()), 4096)
                    self.assertIs(view["meta"]["budget"]["truncated"], True)
                    self.assertEqual(view["data"]["current_version"]["digest"], digest)
                    self.assertEqual(view["data"]["current_version"]["size_bytes"], str(len(bytes)))
                    self.assertEqual(view["data"]["metadata"]["targets"], [{"kind": "ticket", "id": "task"}])
                    self.assertEqual(view["data"]["version_count"], "1")
                    listed = read("resource.list", target={"kind": "ticket", "id": "task"}, max_bytes="4096")
                    self.assertEqual([item["resource_id"] for item in listed["data"]["items"]], ["attachment"])
                    self.assertLessEqual(len(adapter.canonical(listed).encode()), 4096)
                    rejected("resource.list", "Invalid_argument", offset="1")
                    rejected("resource.get", "Invalid_argument", id="attachment")

                    upload("upload.begin", "second", size_bytes="0", digest=hashlib.sha256(b"").hexdigest())
                    second = mutate("resource.finish_upload", "second-finish", upload_id="second", resource_id="attachment",
                                    expected_revision="3", title="Attachment", filename="empty.bin", mime_type="application/octet-stream")
                    self.assertEqual(second["data"]["revision"], "4")
                    self.assertEqual(second["data"]["version"]["revision"], "2")
                    history = read("resource.history", resource_id="attachment", limit="1")
                    self.assertEqual(history["data"]["next_offset"], "1")
                    self.assertEqual(history["data"]["items"][0]["revision"], "1")
                    rest = read("resource.history", resource_id="attachment", limit="1", offset="1",
                                at_revision=history["meta"]["workspace_revision"])
                    self.assertEqual(rest["data"]["items"][0]["revision"], "2")
                    self.assertIsNone(rest["data"]["next_offset"])

                    upload("upload.begin", "mismatch", size_bytes="1", digest="0" * 64)
                    upload("upload.chunk", "mismatch", offset="0", data_base64=encoded(b"x"))
                    rejected("resource.finish_upload", "Invalid_argument", actor_id="agent", mutation_id="mismatch-finish",
                             upload_id="mismatch", resource_id="wrong", expected_revision="0", title="Wrong",
                             filename="wrong.bin", mime_type="application/octet-stream")
                    rejected("resource.get", "Not_found", resource_id="wrong")
                    self.assertEqual(upload("upload.abort", "mismatch")["data"], {"aborted": True})
                    self.assertEqual(upload("upload.abort", "mismatch")["data"], {"aborted": True})
                    rejected("upload.status", "Not_found", actor_id="agent", upload_id="mismatch")
                    upload("upload.begin", "interrupted", size_bytes="1", digest=hashlib.sha256(b"x").hexdigest())
                    upload("upload.chunk", "interrupted", offset="0", data_base64=encoded(b"x"))
                    call("daemon.shutdown")
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    daemon = start()
                    rejected("upload.status", "Not_found", actor_id="agent", upload_id="interrupted")
                    self.assertEqual(published, mutate("resource.finish_upload", "finish", **finish))
                    durable = read("resource.get", resource_id="attachment")["data"]
                    self.assertEqual(durable["version_count"], "2")
                    self.assertEqual(durable["current_version"]["revision"], "2")
                    source = directory / "source.bin"
                    saved = directory / "upload.request.json"
                    source.write_bytes(b"\xff\x00 saved transfer")
                    cli = subprocess.run(
                        [str(EXE), "resource", "upload", str(address), "--workspace-id", "uploads",
                         "--actor-id", "agent", "--resource-id", "cli-copy", "--expected-revision", "0",
                         "--title", "CLI copy", "--file", str(source), "--save-request", str(saved)],
                        capture_output=True, text=True, timeout=10)
                    self.assertEqual(cli.returncode, 0, cli.stderr)
                    receipt = json.loads(cli.stdout)
                    self.assertEqual(receipt["result"]["data"]["version"]["actor_id"], "agent")
                    source.unlink()
                    retry = subprocess.run([str(EXE), "retry", str(address), str(saved)],
                                           capture_output=True, text=True, timeout=10)
                    self.assertEqual(retry.returncode, 0, retry.stderr)
                    self.assertEqual(json.loads(retry.stdout)["result"], receipt["result"])
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
