"""Independent evidence publication identity, journaling and recovery fixtures."""
import json
import hashlib
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()


def frame(flow):
    def exact(size):
        data = b""
        while len(data) < size:
            part = flow.recv(size - len(data))
            if not part:
                raise EOFError("incomplete peer frame")
            data += part
        return data
    header = exact(4)
    body = exact(struct.unpack(">I", header)[0])
    return header + body, json.loads(body)


class FinishProxy:
    """Forward real calls; commit finish, then lose or delay its acknowledgement."""
    def __init__(self, path, upstream, delay):
        self.upstream = str(upstream)
        self.delay = delay
        self.receipt = None
        self.error = None
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        self.listener.listen()
        self.listener.settimeout(10)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while True:
                incoming, _ = self.listener.accept()
                with incoming, socket.socket(socket.AF_UNIX) as upstream:
                    incoming.settimeout(10)
                    upstream.settimeout(10)
                    upstream.connect(self.upstream)
                    encoded, request = frame(incoming)
                    upstream.sendall(encoded)
                    encoded, response = frame(upstream)
                    if request["method"] == "resource.finish_upload":
                        self.receipt = response["result"]
                        if self.delay:
                            time.sleep(self.delay)
                            try:
                                incoming.sendall(encoded)
                            except BrokenPipeError:
                                pass
                        return
                    incoming.sendall(encoded)
        except Exception as error:
            self.error = error
        finally:
            self.listener.close()


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-pub-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = self.root / "s"
        self.journal = self.root / "requests"
        self.journal.mkdir()
        self.context = self.root / "context.json"
        self.context.write_text(json.dumps({"socket": str(self.socket), "workspace_id": "w",
                                           "actor_id": "author", "request_directory": str(self.journal)}))
        self.log = (self.root / "daemon.log").open("w")
        self.addCleanup(self.log.close)
        self.daemon = subprocess.Popen([str(EXE), "serve", str(self.root / "registry"),
                                        str(self.socket)], stdout=subprocess.DEVNULL, stderr=self.log)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.socket.exists() and self.cli("request", self.socket, "daemon.health").returncode == 0:
                break
            self.assertIsNone(self.daemon.poll(), (self.root / "daemon.log").read_text())
            time.sleep(.02)
        else:
            self.fail("daemon failed to start")
        self.cli("request", self.socket, "workspace.create", "--workspace-id", "w",
                 "--actor-id", "operator", "--mutation-id", "create", "--name", "Work",
                 "--root", self.root / "workspace", expected=0)

    def stop(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=10)

    def cli(self, *args, expected=None):
        result = subprocess.run([str(EXE), *map(str, args)], capture_output=True, text=True,
                                timeout=15)
        if expected is not None:
            self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
        return result

    def stage(self, name="stage"):
        stage = self.root / name
        counter = self.root / (name + "-counter")
        script = "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_text(p.read_text()+'x' if p.exists() else 'x'); print('observed')"
        self.cli("evidence-run", "--stage", stage, "--cwd", self.root, "--",
                 sys.executable, "-c", script, counter, expected=0)
        self.assertEqual(counter.read_text(), "x")
        return stage, counter

    def first(self, stage, *options, expected=0):
        return self.cli("--context", self.context, "evidence-publish", "--stage", stage,
                        "--resource-id", stage.name, "--expected-revision", "0",
                        "--title", "Observed command", *options, expected=expected)

    def no_connection(self, action):
        address = self.root / "no-send"
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(address))
            listener.listen()
            listener.settimeout(.15)
            result = action(address)
            with self.assertRaises(socket.timeout):
                listener.accept()
        address.unlink()
        return result

    def assert_error(self, result, kind):
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(json.loads(result.stderr.splitlines()[-1])["kind"], kind,
                         result.stderr)

    def test_context_identity_journal_and_stage_only_retry(self):
        stage, counter = self.stage()
        published = json.loads(self.first(stage).stdout)
        saved_bytes = (stage / "publication.json").read_bytes()
        saved = json.loads(saved_bytes)
        mutation = saved["params"]["mutation_id"]
        self.assertEqual(len(mutation), 64)
        self.assertEqual(saved["params"]["actor_id"], "author")
        self.assertEqual(saved["params"]["workspace_id"], "w")
        self.assertIn("digest", saved["params"])
        self.assertIn("size_bytes", saved["params"])
        copies = list(self.journal.glob("*.json"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_bytes(), saved_bytes)
        self.assertEqual(published["jsonrpc"], "2.0")
        self.assertEqual(published["id"], saved["id"])
        self.assertTrue(published["result"]["meta"]["durable"])
        # Existing identical discovery copy remains valid and unchanged.
        repeated = self.cli("--context", self.context, "evidence-publish", "--stage", stage,
                            expected=0)
        self.assertEqual(json.loads(repeated.stdout), published)
        self.assertEqual(copies[0].read_bytes(), saved_bytes)
        # Context on a saved-stage retry changes neither scope nor attribution.
        context = json.loads(self.context.read_text())
        context.update(actor_id="other-author", workspace_id="other-workspace")
        self.context.write_text(json.dumps(context))
        repeated = self.cli("--context", self.context, "evidence-publish", "--stage", stage,
                            expected=0)
        self.assertEqual(json.loads(repeated.stdout), published)
        # Exact recovery no longer needs capture bytes or context.
        (stage / "capture.json").unlink()
        repeated = self.cli("evidence-publish", self.socket, "--stage", stage, expected=0)
        self.assertEqual(json.loads(repeated.stdout), published)
        ordinary_retry = self.cli("retry", self.socket, stage / "publication.json", expected=0)
        self.assertEqual(json.loads(ordinary_retry.stdout), published)
        self.assertEqual((stage / "publication.json").read_bytes(), saved_bytes)
        self.assertEqual(counter.read_text(), "x")

    def test_journal_partial_save_sends_nothing_and_retry_keeps_identity(self):
        stage, counter = self.stage()
        missing = self.root / "missing-journal"
        failed = self.no_connection(lambda address: self.first(stage, "--socket", address,
                                     "--request-directory", missing, expected=1))
        self.assert_error(failed, "Invalid_argument")
        original = (stage / "publication.json").read_bytes()
        # A configured retry still must save; no fresh identity after partial save.
        failed = self.no_connection(lambda address: self.cli("evidence-publish", address,
                                    "--stage", stage, "--request-directory", missing, expected=1))
        self.assert_error(failed, "Invalid_argument")
        self.assertEqual((stage / "publication.json").read_bytes(), original)
        missing.mkdir()
        retried = self.cli("evidence-publish", self.socket, "--stage", stage,
                           "--request-directory", missing, expected=0)
        self.assertTrue(json.loads(retried.stdout)["result"]["meta"]["durable"])
        self.assertEqual(list(missing.glob("*.json"))[0].read_bytes(), original)
        self.assertEqual(counter.read_text(), "x")

    def test_explicit_journal_override_collision_and_unjournaled_recovery(self):
        stage, counter = self.stage()
        collision = self.root / "collision.json"
        collision.write_bytes(b"unrelated request")
        failed = self.no_connection(lambda address: self.first(stage, "--socket", address,
                                     "--save-request", collision, expected=1))
        self.assert_error(failed, "Invalid_argument")
        original = (stage / "publication.json").read_bytes()
        self.assertEqual(collision.read_bytes(), b"unrelated request")
        self.assertEqual(list(self.journal.glob("*.json")), [])
        different = bytearray(original)
        different[-1] ^= 1
        collision.write_bytes(different)
        failed = self.no_connection(lambda address: self.cli("evidence-publish", address,
                                    "--stage", stage, "--save-request", collision, expected=1))
        self.assert_error(failed, "Invalid_argument")
        self.assertEqual(collision.read_bytes(), different)
        # The journal policy is per invocation: explicit stage-only recovery is allowed.
        retried = self.cli("evidence-publish", self.socket, "--stage", stage, expected=0)
        published = json.loads(retried.stdout)
        self.assertEqual((stage / "publication.json").read_bytes(), original)
        override = self.root / "override"
        override.mkdir()
        repeated = self.cli("--context", self.context, "evidence-publish", "--stage", stage,
                            "--request-directory", override, expected=0)
        self.assertEqual(json.loads(repeated.stdout), published)
        self.assertEqual(list(override.glob("*.json"))[0].read_bytes(), original)
        self.assertEqual(list(self.journal.glob("*.json")), [])
        collision.write_bytes(original)
        repeated = self.cli("evidence-publish", self.socket, "--stage", stage,
                            "--save-request", collision, expected=0)
        self.assertEqual(json.loads(repeated.stdout), published)
        self.assertEqual(collision.read_bytes(), original)
        self.assertEqual(counter.read_text(), "x")

    @unittest.skipIf(os.geteuid() == 0, "root bypasses ordinary directory permissions")
    def test_unwritable_stage_and_journal_send_nothing(self):
        stage, counter = self.stage()
        stage.chmod(0o500)
        try:
            result = self.no_connection(lambda address: self.first(stage, "--socket", address,
                                                                  expected=1))
            self.assert_error(result, "Local_io")
            self.assertFalse((stage / "publication.json").exists())
        finally:
            stage.chmod(0o700)
        locked = self.root / "locked"
        locked.mkdir(mode=0o500)
        try:
            result = self.no_connection(lambda address: self.first(stage, "--socket", address,
                                         "--request-directory", locked, expected=1))
            self.assert_error(result, "Local_io")
            self.assertTrue((stage / "publication.json").exists())
        finally:
            locked.chmod(0o700)
        self.cli("evidence-publish", self.socket, "--stage", stage, expected=0)
        self.assertEqual(counter.read_text(), "x")

    @unittest.skipIf(os.geteuid() == 0, "root bypasses ordinary directory permissions")
    def test_inaccessible_stage_preflight_is_local_io(self):
        stage, counter = self.stage()
        stage.chmod(0)
        try:
            failed = self.no_connection(lambda address: self.cli("evidence-publish", address,
                                        "--stage", stage, expected=1))
            self.assert_error(failed, "Local_io")
            self.assertIn("publication.json", failed.stderr)
        finally:
            stage.chmod(0o700)
        self.assertFalse((stage / "publication.json").exists())
        self.assertEqual(counter.read_text(), "x")

    def test_lost_and_timed_out_finish_recover_same_receipt_once(self):
        for name, delay in (("lost", 0), ("timeout", .5)):
            with self.subTest(name=name):
                stage, counter = self.stage(name)
                proxy_path = self.root / (name + "-proxy")
                proxy = FinishProxy(proxy_path, self.socket, delay)
                failed = self.first(stage, "--socket", proxy_path, "--timeout", ".1", expected=1)
                self.assert_error(failed, "Outcome_unknown")
                proxy.thread.join(timeout=5)
                self.assertFalse(proxy.thread.is_alive())
                self.assertIsNone(proxy.error)
                self.assertIsNotNone(proxy.receipt)
                original = (stage / "publication.json").read_bytes()
                copy = self.journal / (hashlib.sha256(original).hexdigest() + ".json")
                self.assertEqual(copy.read_bytes(), original)
                recovered = json.loads(self.cli("evidence-publish", self.socket,
                                               "--stage", stage, expected=0).stdout)
                self.assertEqual(recovered["result"], proxy.receipt)
                self.assertEqual((stage / "publication.json").read_bytes(), original)
                resource = json.loads(self.cli("request", self.socket, "resource.get",
                                               "--workspace-id", "w", "--resource-id", name,
                                               expected=0).stdout)["result"]["data"]
                self.assertEqual(resource["resource_id"], name)
                self.assertEqual(resource["revision"], "1")
                self.assertEqual(counter.read_text(), "x")

    def test_explicit_identity_and_malformed_or_unfinished_stages(self):
        stage, counter = self.stage()
        self.first(stage, "--mutation-id", "explicit-id", expected=0)
        saved = (stage / "publication.json").read_bytes()
        self.assertEqual(json.loads(saved)["params"]["mutation_id"], "explicit-id")
        malformed, other_counter = self.stage("malformed")
        broken = malformed / "publication.json"
        broken.write_bytes(b"{}")
        failed = self.no_connection(lambda address: self.cli("evidence-publish", address,
                                    "--stage", malformed, expected=1))
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(broken.read_bytes(), b"{}")
        self.assertEqual(other_counter.read_text(), "x")
        nonregular, fifo_counter = self.stage("nonregular")
        fifo = nonregular / "publication.json"
        os.mkfifo(fifo)
        failed = self.no_connection(lambda address: self.cli("evidence-publish", address,
                                    "--stage", nonregular, expected=1))
        self.assert_error(failed, "Invalid_argument")
        self.assertIn("regular file", failed.stderr)
        self.assertEqual(fifo_counter.read_text(), "x")
        unfinished, unfinished_counter = self.stage("unfinished")
        (unfinished / "capture.json").unlink()
        failed = self.no_connection(lambda address: self.first(unfinished, "--socket", address,
                                                               expected=1))
        self.assert_error(failed, "Conflict")
        self.assertFalse((unfinished / "publication.json").exists())
        self.assertEqual(unfinished_counter.read_text(), "x")
        self.assertEqual(counter.read_text(), "x")


if __name__ == "__main__":
    unittest.main()
