"""Real daemon upload/private staging and canonical resource publication APIs."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import socket
import struct
import threading
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()
ADAPTER = Path(__file__).resolve().parents[2] / "skills/workgraph/scripts/history-adapter.py"
spec = importlib.util.spec_from_file_location("history_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class UploadSocketTest(unittest.TestCase):
    def test_private_staging_publication_budgets_and_exact_restart_retry(self):
        catalog = json.loads(subprocess.check_output([str(EXE), "schema"]))
        methods = {method["name"]: method for method in catalog["methods"]}
        for name in ["upload.begin", "upload.chunk", "upload.status", "upload.abort", "upload.list"]:
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
                    while not is_listening(address):
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

                    # A definitive failed CAS releases installed staging admission.
                    empty_digest = hashlib.sha256(b"").hexdigest()
                    for index in range(8):
                        upload("upload.begin", f"cap-{index}", size_bytes="0", digest=empty_digest)
                    rejected("upload.begin", "Invalid_argument", actor_id="agent", upload_id="overflow",
                             size_bytes="0", digest=empty_digest)
                    live = read("upload.list")["data"]
                    self.assertEqual(len(live["items"]), 8)
                    self.assertEqual([item["upload_id"] for item in live["items"]], [f"cap-{i}" for i in range(8)])
                    for item in live["items"]:
                        self.assertEqual(item["actor_id"], "agent")
                        self.assertEqual(item["lifecycle"], "ready")
                        self.assertLessEqual(int(item["created_unix_ms"]), int(item["updated_unix_ms"]))
                        self.assertLessEqual(int(item["updated_unix_ms"]), int(live["observed_unix_ms"]))
                    rejected("resource.finish_upload", "Conflict", actor_id="agent", mutation_id="stale-finish",
                             upload_id="cap-0", resource_id="attachment", expected_revision="0", title="Stale",
                             filename="stale.bin", mime_type="application/octet-stream")
                    rejected("upload.status", "Not_found", actor_id="agent", upload_id="cap-0")
                    upload("upload.begin", "overflow", size_bytes="0", digest=empty_digest)
                    for id in [*[f"cap-{i}" for i in range(1, 8)], "overflow"]:
                        upload("upload.abort", id)
                    self.assertEqual(read("upload.list")["data"]["items"], [])
                    self.assertEqual(read("resource.get", resource_id="attachment")["data"]["version_count"], "2")

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
                    # A real forwarding endpoint pauses a chunk acknowledgement, so
                    # cancelling the helper leaves resumable owner staging. Dropping
                    # a finish acknowledgement instead preserves exact receipt recovery.
                    def proxy_transfer(name, stop_method, cancel):
                        proxy_path = directory / (name + ".sock")
                        reached = threading.Event()
                        release = threading.Event()
                        failures = []
                        listener = socket.socket(socket.AF_UNIX)
                        listener.bind(str(proxy_path))
                        listener.listen()
                        listener.settimeout(10)

                        def frame(connection):
                            def exact(count):
                                data = b""
                                while len(data) < count:
                                    part = connection.recv(count - len(data))
                                    if not part:
                                        raise EOFError("forwarding endpoint closed")
                                    data += part
                                return data
                            header = exact(4)
                            return header + exact(struct.unpack(">I", header)[0])

                        def forward():
                            try:
                                while True:
                                    connection, _ = listener.accept()
                                    with connection, socket.socket(socket.AF_UNIX) as upstream:
                                        request = frame(connection)
                                        upstream.connect(str(address))
                                        upstream.sendall(request)
                                        response = frame(upstream)
                                        if json.loads(request[4:])["method"] == stop_method:
                                            reached.set()
                                            if cancel:
                                                release.wait(10)
                                            break
                                        connection.sendall(response)
                            except BaseException as error:
                                failures.append(error)
                            finally:
                                listener.close()

                        thread = threading.Thread(target=forward, daemon=True)
                        thread.start()
                        transfer_source = directory / (name + ".bin")
                        transfer_source.write_bytes(b"cancel/resume" * 30000)
                        transfer_plan = directory / (name + ".json")
                        process = subprocess.Popen(
                            [str(EXE), "resource", "upload", str(proxy_path), "--workspace-id", "uploads",
                             "--actor-id", "agent", "--resource-id", name, "--expected-revision", "0",
                             "--title", name, "--file", str(transfer_source), "--save-request", str(transfer_plan)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                        try:
                            self.assertTrue(reached.wait(10), failures)
                            if cancel:
                                process.terminate()
                            stdout, stderr = process.communicate(timeout=10)
                            if not cancel:
                                self.assertEqual(process.returncode, 1, (stdout, stderr))
                                self.assertIn("Outcome_unknown", stderr)
                            frozen = json.loads(transfer_plan.read_text())["params"]
                            if cancel:
                                staged = upload("upload.status", frozen["upload_id"])["data"]
                                self.assertEqual(staged["received"], "262144")
                                row = next(item for item in read("upload.list")["data"]["items"]
                                           if item["upload_id"] == frozen["upload_id"])
                                self.assertEqual(row["lifecycle"], "receiving")
                            else:
                                transfer_source.unlink()
                                self.assertEqual(read("resource.get", resource_id=name)["data"]["version_count"], "1")
                            resumed = subprocess.run([str(EXE), "retry", str(address), str(transfer_plan)],
                                                     capture_output=True, text=True, timeout=10)
                            self.assertEqual(resumed.returncode, 0, resumed.stderr)
                            self.assertEqual(read("resource.get", resource_id=name)["data"]["version_count"], "1")
                            rejected("upload.status", "Not_found", actor_id="agent", upload_id=frozen["upload_id"])
                        finally:
                            release.set()
                            if process.poll() is None:
                                process.kill()
                                process.communicate(timeout=10)
                            thread.join(timeout=10)
                            self.assertFalse(thread.is_alive())
                            self.assertEqual(failures, [])

                    proxy_transfer("cancelled-helper", "upload.chunk", True)
                    proxy_transfer("uncertain-finish", "resource.finish_upload", False)

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
                    plan = json.loads(saved.read_text())
                    upload_id = plan["params"]["upload_id"]
                    self.assertTrue(upload_id.startswith("u_"))
                    # Plan abort is safe after publication and does not require the source.
                    source.unlink()
                    aborted = subprocess.run([str(EXE), "resource", "upload-abort", str(address), str(saved)],
                                             capture_output=True, text=True, timeout=10)
                    self.assertEqual(aborted.returncode, 0, aborted.stderr)
                    self.assertEqual(json.loads(aborted.stdout)["result"]["data"], {"aborted": True})
                    # A saved plan can clean its interrupted staging, but not another owner/scope.
                    call("upload.begin", workspace_id="uploads", actor_id="agent", upload_id=upload_id,
                         size_bytes=plan["params"]["size_bytes"], digest=plan["params"]["digest"])
                    context = directory / "wrong-context.json"
                    for field, value in [("workspace_id", "other"), ("actor_id", "other")]:
                        scope = dict(socket=str(address), workspace_id="uploads", actor_id="agent")
                        scope[field] = value
                        context.write_text(json.dumps(scope))
                        guarded = subprocess.run([str(EXE), "--context", str(context), "resource", "upload-abort", str(saved)],
                                                 capture_output=True, text=True, timeout=10)
                        self.assertEqual(guarded.returncode, 1)
                        self.assertEqual(json.loads(guarded.stderr)["kind"], "Conflict")
                    self.assertEqual(upload("upload.status", upload_id)["data"]["received"], "0")
                    tampered = directory / "tampered.json"
                    changed = json.loads(saved.read_text())
                    changed["params"]["upload_id"] = "another-stage"
                    tampered.write_text(json.dumps(changed))
                    invalid = subprocess.run([str(EXE), "resource", "upload-abort", str(address), str(tampered)],
                                             capture_output=True, text=True, timeout=10)
                    self.assertEqual(invalid.returncode, 1)
                    self.assertEqual(json.loads(invalid.stderr)["kind"], "Invalid_argument")
                    aborted = subprocess.run([str(EXE), "resource", "upload-abort", str(address), str(saved)],
                                             capture_output=True, text=True, timeout=10)
                    self.assertEqual(aborted.returncode, 0, aborted.stderr)
                    rejected("upload.status", "Not_found", actor_id="agent", upload_id=upload_id)
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
