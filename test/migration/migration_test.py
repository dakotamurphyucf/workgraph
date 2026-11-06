"""Offline conversion of independent fixtures written by released Workgraph 0.6.2."""
import base64
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()
FIXTURES = Path(__file__).parent / "fixtures"


def tree(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file() and ".local" not in p.relative_to(root).parts}


def without_times(value):
    if isinstance(value, dict):
        return {key: without_times(item) for key, item in value.items()
                if key not in ("created_at_unix_ms", "last_event_at_unix_ms")}
    if isinstance(value, list):
        return [without_times(item) for item in value]
    return value


class MigrationTest(unittest.TestCase):
    def invoke(self, *args, ok=True):
        process = subprocess.run([str(EXE), *map(str, args)], capture_output=True, text=True, timeout=30)
        value = json.loads(process.stdout)
        if ok:
            self.assertEqual(process.returncode, 0, (process.stdout, process.stderr))
            self.assertNotIn("error", value)
        else:
            self.assertNotEqual(process.returncode, 0, process.stdout)
            self.assertIn("error", value)
        return value

    def source(self, parent):
        source = parent / "source"
        shutil.copytree(FIXTURES / "v062", source)
        for path in source.rglob("*"):
            if path.is_file():
                path.chmod(0o600)
        return source

    def migrate(self, source, destination, **kwargs):
        return self.invoke("migrate", "--from", "0.6.2", "--source", source,
                           "--destination", destination, **kwargs)

    def test_preserved_bytes_receipts_and_unknown_times(self):
        with tempfile.TemporaryDirectory(prefix="wg-migration-", dir="/tmp") as temporary:
            parent = Path(temporary)
            source = self.source(parent)
            before = tree(source)
            target = parent / "target"
            report = self.migrate(source, target)
            self.assertEqual(tree(source), before)
            self.assertEqual(report["source_format"], "5")
            self.assertEqual(report["from_release"], "0.6.2")
            self.assertFalse(report["old_api_requests_supported"])
            self.assertEqual((target / "HEAD.json").read_bytes(), (source / "HEAD.json").read_bytes())
            for directory in ("transactions", "blobs"):
                self.assertEqual(tree(target / directory), tree(source / directory))
            self.assertEqual(json.loads((target / "workspace.json").read_text())["version"], "6")
            self.assertEqual(report["history_heads"][report["source_history_head"]], report["history_head"])
            self.assertEqual(len(report["history_heads"]), 5)
            for old, new in report["history_heads"].items():
                original = json.loads((source / "history/batches" / (old + ".json")).read_text())
                changed = json.loads((target / "history/batches" / (new + ".json")).read_text())
                self.assertEqual(changed["version"], "2")
                self.assertEqual(changed["key"], original["key"])
                self.assertEqual(changed["request_hash"], original["request_hash"])
                self.assertEqual(changed["previous"], None if original["previous"] is None
                                 else report["history_heads"][original["previous"]])
                if original["change"]["kind"] == "append":
                    self.assertEqual(changed["change"]["events"], original["change"]["events"])
                    self.assertIsNone(changed["change"]["committed_at_unix_ms"])
            # Normal target runtime validates and serves this root after conversion.
            address = parent / "socket"
            with (parent / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen([str(EXE), "serve", str(parent / "registry"), str(address)],
                                          stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    def call(method, ok=True, **params):
                        return self.invoke("call", address, method, json.dumps(params), ok=ok)
                    unsupported = call("workspace.register", root=str(source), actor_id="agent", mutation_id="old-root", ok=False)
                    self.assertEqual(unsupported["error"]["data"]["kind"], "Unsupported_version")
                    call("workspace.register", root=str(target), actor_id="agent", mutation_id="register")
                    planning_head = (target / "HEAD.json").read_bytes()
                    history_head = (target / "history/HEAD.json").read_bytes()
                    for saved in json.loads((FIXTURES / "requests.json").read_text()):
                        result = call(saved["method"], **saved["params"])["result"]
                        self.assertEqual(without_times(result["data"]), saved["result"]["data"])
                    self.assertEqual((target / "HEAD.json").read_bytes(), planning_head)
                    self.assertEqual((target / "history/HEAD.json").read_bytes(), history_head)
                    metadata = call("session.get", workspace_id="migration", session_id="conversation")["result"]["data"]["session"]
                    self.assertIsNone(metadata["created_at_unix_ms"])
                    self.assertIsNone(metadata["last_event_at_unix_ms"])
                    pinned = call("session.get", workspace_id="migration", session_id="child", head=report["history_head"])
                    self.assertEqual(pinned["result"]["data"]["through"], "0")
                    rejected = call("session.get", workspace_id="migration", session_id="child", head=report["source_history_head"], ok=False)
                    self.assertEqual(rejected["error"]["data"]["kind"], "Conflict")
                    payload = call("history.payload", workspace_id="migration", event_ref={"session_id":"conversation","sequence":"1"}, length="262144")
                    self.assertEqual(base64.b64decode(payload["result"]["data"]["bytes_base64"]), b"\xff\x00migration payload")
                    hits = call("history.search", workspace_id="migration", text="needle")
                    self.assertEqual(len(hits["result"]["data"]["items"]), 1)
                    event = dict(client_id="new", role="assistant", kind="message", phase="completed",
                                 payload={"kind":"inline","bytes_base64":base64.b64encode(b"new").decode()})
                    call("session.append", workspace_id="migration", actor_id="agent", mutation_id="new-append", session_id="child", events=[event])
                    child = call("session.get", workspace_id="migration", session_id="child")["result"]["data"]["session"]
                    self.assertIsNone(child["created_at_unix_ms"])
                    self.assertIsNotNone(child["last_event_at_unix_ms"])
                    published = self.invoke("migrate", "cleanup", "--stage", target,
                                            "--owner-token", json.loads((target / ".local/migration.json").read_text())["owner_token"], ok=False)
                    self.assertEqual(published["error"]["data"]["kind"], "Conflict")
                finally:
                    daemon.terminate()
                    daemon.wait(timeout=15)
            self.assertEqual(tree(source), before)
            self.migrate(source, target, ok=False)
            self.migrate(target, parent / "already-current", ok=False)

    def test_refusals_and_owned_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="wg-migration-refuse-", dir="/tmp") as temporary:
            parent = Path(temporary)
            source = self.source(parent)
            self.migrate(source, source / "nested", ok=False)
            (source / ".local").mkdir()
            with (source / ".local/writer.lock").open("w") as guard:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                error = self.migrate(source, parent / "locked", ok=False)
                self.assertEqual(error["error"]["data"]["kind"], "Conflict")
            descriptor = source / "workspace.json"
            original = descriptor.read_bytes()
            value = json.loads(original); value["version"] = "4"
            descriptor.write_text(json.dumps(value))
            error = self.migrate(source, parent / "old", ok=False)
            self.assertEqual(error["error"]["data"]["kind"], "Unsupported_version")
            descriptor.write_bytes(original)
            # An error after staging leaves only an explicitly owned cleanup target.
            blob = next((source / "blobs").iterdir())
            original_blob = blob.read_bytes()
            blob.write_bytes(b"corrupted")
            target = parent / "failed"
            error = self.migrate(source, target, ok=False)
            self.assertIn("owned stage:", error["error"]["data"]["message"])
            stage, = parent.glob("failed.migrating-*")
            marker = json.loads((stage / ".local/migration.json").read_text())
            token = marker["owner_token"]
            before = tree(stage)
            self.invoke("migrate", "cleanup", "--stage", stage, "--owner-token", "forged", ok=False)
            (stage / "unexpected").write_text("preserve me")
            self.invoke("migrate", "cleanup", "--stage", stage, "--owner-token", token, ok=False)
            self.assertTrue((stage / "unexpected").exists())
            (stage / "unexpected").unlink()
            self.assertEqual(tree(stage), before)
            with (stage / ".local/migration.lock").open("r+") as guard:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.invoke("migrate", "cleanup", "--stage", stage, "--owner-token", token, ok=False)
            self.invoke("migrate", "cleanup", "--stage", stage, "--owner-token", token)
            self.assertFalse(stage.exists())
            self.assertTrue(source.exists())
            self.assertFalse(target.exists())
            blob.write_bytes(original_blob)
            self.migrate(source, target)

    def test_empty_source_and_canonical_symlink_refusal(self):
        with tempfile.TemporaryDirectory(prefix="wg-migration-empty-", dir="/tmp") as temporary:
            parent = Path(temporary)
            source = self.source(parent)
            shutil.rmtree(source / "history")
            shutil.rmtree(source / "transactions")
            (source / "transactions").mkdir()
            (source / "HEAD.json").write_text(json.dumps({"version":"1","sequence":"0","digest":None}))
            target = parent / "empty-target"
            report = self.migrate(source, target)
            self.assertEqual(report["planning_revision"], "0")
            self.assertIsNone(report["history_head"])
            self.assertEqual(report["history_heads"], {})
            self.assertEqual(list((target / "blobs").iterdir()), [])
            (source / "HEAD.json").unlink()
            (source / "HEAD.json").symlink_to(target / "HEAD.json")
            error = self.migrate(source, parent / "symlink", ok=False)
            self.assertEqual(error["error"]["data"]["kind"], "Corrupt_store")
            self.assertFalse((parent / "symlink").exists())


if __name__ == "__main__":
    unittest.main()
