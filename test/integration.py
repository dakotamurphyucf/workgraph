"""Real process/socket/storage tests; no external services or Python packages."""
import base64
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import threading
import unittest
import uuid

EXE = Path(sys.argv.pop(1)).resolve()
CLIENT_EXE = Path(sys.argv.pop(1)).resolve()
PLATFORM_EXE = Path(sys.argv.pop(1)).resolve()
STORE_EXE = Path(sys.argv.pop(1)).resolve()


def request(address, method, params, request_id="test"):
    if method in {"workspace.create", "workspace.register", "workspace.open", "workspace.close", "workspace.unregister", "workspace.export", "daemon.export_all", "workspace.restore", "daemon.restore_all", "restore.cancel", "export.cancel", "export.retry"}:
        params = {"actor_id": "operator", "mutation_id": uuid.uuid4().hex, **params}
    payload = json.dumps({"jsonrpc": "2.0", "id": request_id,
                          "method": method, "params": params}).encode()
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(10)
        sock.connect(str(address))
        sock.sendall(struct.pack(">I", len(payload)) + payload)

        def exact(length):
            data = b""
            while len(data) < length:
                chunk = sock.recv(length - len(data))
                if not chunk:
                    raise EOFError("daemon closed without a full response")
                data += chunk
            return data

        return json.loads(exact(struct.unpack(">I", exact(4))[0]))


def read_frame(flow):
    def exact(length):
        data = b""
        while len(data) < length:
            chunk = flow.recv(length - len(data))
            if not chunk:
                raise EOFError("incomplete test request")
            data += chunk
        return data
    return json.loads(exact(struct.unpack(">I", exact(4))[0]))


def write_frame(flow, value):
    body = json.dumps(value).encode()
    flow.sendall(struct.pack(">I", len(body)) + body)


class Daemon:
    def __init__(self, root, address):
        self.root, self.address = root, address
        self.process = None
        self.log = None

    def start(self):
        self.log = (self.root / "daemon.log").open("ab")
        self.process = subprocess.Popen(
            [str(EXE), "serve", str(self.root / "registry"), str(self.address)],
            stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError((self.root / "daemon.log").read_text())
            try:
                if "result" in request(self.address, "initialize", {}):
                    return
            except (OSError, EOFError):
                time.sleep(0.01)
        raise AssertionError("daemon startup timed out")

    def stop(self, kill=False):
        if self.process is not None and self.process.poll() is None:
            self.process.kill() if kill else self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise AssertionError("daemon failed to shut down")
        if self.log:
            self.log.close()


class Integration(unittest.TestCase):
    def test_store_rejects_wrong_workspace_and_receipt_before_publication(self):
        completed = subprocess.run([str(STORE_EXE), str(self.root / "store-api")],
                                   capture_output=True, text=True, check=True)
        self.assertEqual("store ownership and receipt validation passed\n", completed.stdout)

    def setUp(self):
        # Fixture bytes stay in the isolated Dune build directory. Unix socket
        # paths use a short temporary path for macOS's sockaddr_un length limit.
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=Path.cwd())
        self.sockets = tempfile.TemporaryDirectory(prefix="wg-")
        self.root = Path(self.temp.name).resolve()
        self.daemon = Daemon(self.root, Path(self.sockets.name) / "s")
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.sockets.cleanup)
        self.addCleanup(self.daemon.stop)
        self.daemon.start()
        self.sequence = 0
        self.data("workspace.create", {"workspace_id": "demo", "name": "Demo",
                                     "root": str(self.root / "workspace")})

    def call(self, method, params):
        return request(self.daemon.address, method, params)

    def ok(self, method, params):
        response = self.call(method, params)
        self.assertIn("result", response, response)
        return response["result"]

    def data(self, method, params):
        return self.ok(method, params)["data"]

    def wait_export(self, job_id):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            job = self.data("export.get", {"job_id": job_id})
            if job["status"] != "running":
                return job
            time.sleep(0.01)
        self.fail("export did not finish")

    def export(self, params):
        job = self.data("workspace.export", params)
        final = self.wait_export(job["job_id"])
        self.assertEqual("completed", final["status"], final)
        return json.loads((Path(params["destination"]) / "manifest.json").read_text())

    def seed_export_fixture(self, count=768):
        for offset in range(0, count, 32):
            operations = [{"method": "ticket.create", "params": {"ticket_id": "export-%04d" % i, "title": "Ticket %d" % i, "description": "details " * 128}} for i in range(offset, min(offset + 32, count))]
            self.assertIn("result", self.mutation("transaction.apply", {"operations": operations}))

    def mutation(self, method, params, actor="agent", mutation=None):
        self.sequence += 1
        return self.call(method, {"workspace_id": "demo", "actor_id": actor,
                                 "mutation_id": mutation or f"m{self.sequence}", **params})

    def ticket(self, ticket="a", **extra):
        response = self.mutation("ticket.create", {"ticket_id": ticket, "title": ticket, **extra})
        self.assertIn("result", response, response)
        return response["result"]

    def context(self, ticket="a"):
        return self.ok("ticket.context", {"workspace_id": "demo", "ticket_id": ticket})

    def kind(self, response):
        return response["error"]["data"]["kind"]

    def test_unknown_methods_reject_before_identity_or_workspace_access(self):
        before = self.ok("workspace.get", {"workspace_id": "demo"})["meta"]["workspace_revision"]
        identity = {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "unknown-reuse"}
        for method, params in [
            ("resource.read_text", {}),
            ("ticket.unimplemented", identity),
            ("workspace.unimplemented", {"workspace_id": "absent"}),
        ]:
            with self.subTest(method=method):
                response = self.call(method, params)
                self.assertEqual("test", response["id"])
                self.assertEqual("Invalid_argument", self.kind(response))
                self.assertEqual("unknown method: " + method, response["error"]["data"]["message"])
        after = self.ok("workspace.get", {"workspace_id": "demo"})["meta"]["workspace_revision"]
        self.assertEqual(before, after)
        # Admission failure must not reserve the supplied retry identity.
        created = self.call("ticket.create", {**identity, "ticket_id": "accepted", "title": "Accepted"})
        self.assertIn("result", created, created)
        self.assertEqual("accepted", created["result"]["data"]["ticket_id"])

    def test_managed_directory_admission_rejects_nested_and_aliased_roots(self):
        workspace = self.root / "workspace"
        alias = self.root / "alias"
        alias.symlink_to(workspace, target_is_directory=True)
        digest = hashlib.sha256(b"blocked").hexdigest()
        for base in [workspace, alias, self.root / "registry"]:
            destination = base / ("nested" if base.name == "registry" else "blobs/" + digest)
            with self.subTest(destination=destination):
                rejected = self.call("workspace.create", {
                    "workspace_id": "nested", "name": "Nested", "root": str(destination)})
                self.assertEqual("Conflict", self.kind(rejected))
                rejected = self.call("workspace.export", {
                    "workspace_id": "demo", "destination": str(destination)})
                self.assertEqual("Conflict", self.kind(rejected))
                self.assertFalse(destination.exists())
        # Rejected path admission must leave the parent's blob namespace usable.
        published = self.mutation("resource.put_text", {
            "resource_id": "body", "expected_revision": "0", "title": "Body", "text": "blocked"})
        self.assertIn("result", published, published)
        self.assertEqual(b"blocked", (workspace / "blobs" / digest).read_bytes())
        # Ancestor aliases remain useful when the actual new root is disjoint.
        parent_alias = self.root / "parent-alias"
        parent_alias.symlink_to(self.root, target_is_directory=True)
        self.data("workspace.create", {"workspace_id": "donor", "name": "Donor",
                                    "root": str(parent_alias / "donor")})
        snapshot = self.root / "donor-export"
        self.export({"workspace_id": "donor", "destination": str(snapshot)})
        self.data("workspace.close", {"workspace_id": "donor"})
        self.data("workspace.unregister", {"workspace_id": "donor"})
        rejected = self.call("workspace.restore", {
            "directory": str(snapshot), "root": str(alias / "blobs" / "restored")})
        self.assertEqual("Conflict", self.kind(rejected))
        self.assertFalse((workspace / "blobs" / "restored").exists())

    def test_scoped_facts_retry_restart_export_restore(self):
        self.ticket()
        scope = {"kind": "ticket", "id": "a"}
        put = {"scope": scope, "key": "build.command", "expected_revision": "0",
               "value": {"argv": ["dune", "build"], "exit": 0, "literal": "$task"}}
        receipt = self.mutation("fact.put", put, mutation="fact-once")
        self.assertIn("result", receipt, receipt)
        self.assertTrue(receipt["result"]["meta"]["durable"])
        self.assertEqual(receipt, self.mutation("fact.put", put, mutation="fact-once"))
        self.assertEqual("Conflict", self.kind(self.mutation("fact.put", put)))
        query = {"workspace_id": "demo", "scope": scope, "key": "build.command"}
        current = self.data("fact.get", query)
        self.assertEqual(put["value"], current["value"])
        keys = self.data("fact.keys", {"workspace_id": "demo", "scope": scope})
        self.assertEqual(["build.command"], [item["key"] for item in keys["items"]])
        self.assertNotIn("value", keys["items"][0])
        discovered = self.context()["data"]["fact_keys"]
        self.assertEqual("1", discovered["total"])
        self.assertEqual("build.command", discovered["items"][0]["key"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(current, self.data("fact.get", query))
        self.assertEqual(receipt, self.mutation("fact.put", put, mutation="fact-once"))
        destination = self.root / "facts-export"
        manifest = self.export({"workspace_id": "demo", "destination": str(destination)})
        fact_files = [name for name in manifest["files"] if name.startswith("facts/")]
        self.assertEqual(1, len(fact_files), fact_files)
        self.assertIn("build.command", (destination / fact_files[0]).read_text())
        self.data("workspace.unregister", {"workspace_id": "demo"})
        self.data("workspace.restore", {"directory": str(destination), "root": str(self.root / "facts-restored")})
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertEqual(current, self.data("fact.get", query))
        self.assertEqual(receipt, self.mutation("fact.put", put, mutation="fact-once"))
        deleted = self.mutation("fact.delete", {"scope": scope, "key": "build.command", "expected_revision": "1"})
        self.assertIn("result", deleted, deleted)
        self.assertTrue(self.data("fact.get", query)["deleted"])
        history = self.data("fact.history", query)["items"]
        self.assertEqual(["1", "2"], [item["revision"] for item in history])
        self.assertEqual(put["value"], history[0]["value"])

    def test_workflow_catalog_metadata_and_workspace_memory(self):
        operations = [
            {"method": "actor.put", "params": {"target_actor_id": "worker", "name": "Worker", "kind": "agent", "expected_revision": "0"}},
            {"method": "label.put", "params": {"label_id": "backend", "name": "Backend", "expected_revision": "0"}},
            {"method": "status.put", "params": {"status_id": "ready", "name": "Ready", "category": "todo", "expected_revision": "0"}},
            {"method": "workspace.update", "params": {"expected_revision": "0", "description": "Team memory", "instructions": "Read ticket.context first", "summary": "Implementation begun"}},
        ]
        self.assertIn("result", self.mutation("transaction.apply", {"operations": operations}))
        self.ticket("a")
        self.ticket("b")
        self.assertIn("result", self.mutation("ticket.metadata", {
            "ticket_id": "b", "expected_revision": "1", "priority": "1", "assignee_id": "worker",
            "label_ids": ["backend"], "status_id": "ready", "acceptance_criteria": "Tests pass"}))
        tickets = self.ok("ticket.ready", {"workspace_id": "demo"})["data"]["items"]
        self.assertEqual(["b", "a"], [ticket["ticket_id"] for ticket in tickets])
        selected = self.ok("ticket.list", {"workspace_id": "demo", "assignee_id": "worker", "label_id": "backend"})
        self.assertEqual(["b"], [ticket["ticket_id"] for ticket in selected["data"]["items"]])
        self.assertIn("result", self.mutation("actor.put", {"target_actor_id": "worker", "name": "Worker", "kind": "agent", "expected_revision": "1", "archived": True}))
        rejected = self.mutation("ticket.metadata", {"ticket_id": "a", "expected_revision": "1", "assignee_id": "worker"})
        self.assertEqual("Conflict", self.kind(rejected))
        malformed = self.mutation("project.create", {"project_id": "p", "title": "P"})
        self.assertIn("result", malformed)
        malformed = self.mutation("project.update", {"project_id": "p", "expected_revision": "1", "status": {"bad": True}})
        self.assertEqual("Invalid_argument", self.kind(malformed))
        before = self.context("b")
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(before, self.context("b"))
        overview = self.ok("workspace.overview", {"workspace_id": "demo"})["data"]
        self.assertEqual("Read ticket.context first", overview["settings"]["instructions"])
        actors = self.ok("actor.list", {"workspace_id": "demo", "include_archived": True})["data"]["items"]
        self.assertEqual("agent", actors[0]["kind"])
        self.assertTrue(actors[0]["archived"])
        destination = self.root / "workflow-export"
        self.export({"workspace_id": "demo", "destination": str(destination)})
        snapshot = json.loads((destination / "workspace.json").read_text())
        self.assertEqual("Ready", snapshot["workflow"]["statuses"][0]["name"])
        self.assertEqual("Implementation begun", snapshot["settings"]["summary"])

    def test_holds_waivers_reassignment_recover_and_fence(self):
        self.ticket("a")
        self.ticket("b")
        self.assertIn("result", self.mutation("dependency.add", {"ticket_id": "a", "prerequisite_id": "b"}))
        self.assertIn("result", self.mutation("dependency.waive", {"ticket_id": "a", "prerequisite_id": "b", "expected_revision": "2", "reason": "Parallel experiment"}))
        self.assertIn("result", self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "3"}))
        self.assertIn("result", self.mutation("ticket.hold", {"ticket_id": "a", "expected_revision": "4", "reason": "Need review"}))
        reassigned = self.mutation("ticket.reassign", {"ticket_id": "a", "expected_revision": "5", "claimant_id": "reviewer", "reason": "Agent session ended"}, mutation="reassign")
        self.assertIn("result", reassigned)
        before = self.context()
        readiness = self.ok("ticket.readiness", {"workspace_id": "demo", "ticket_id": "a"})["data"]
        self.assertFalse(readiness["ready"])
        self.assertEqual({"status", "hold", "claimed"}, {item["kind"] for item in readiness["reasons"]})
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(before, self.context())
        retry = self.mutation("ticket.reassign", {"ticket_id": "a", "expected_revision": "5", "claimant_id": "reviewer", "reason": "Agent session ended"}, mutation="reassign")
        self.assertEqual(reassigned, retry)
        stale = self.mutation("ticket.complete", {"ticket_id": "a", "token": "1", "evidence": "old claim"})
        self.assertEqual("Stale_claim", self.kind(stale))
        held = self.mutation("ticket.complete", {"ticket_id": "a", "token": "2", "evidence": "review complete"}, actor="reviewer")
        self.assertEqual("Blocked", self.kind(held))
        self.assertIn("result", self.mutation("ticket.hold", {"ticket_id": "a", "expected_revision": "6", "reason": None}))
        self.assertIn("result", self.mutation("ticket.complete", {"ticket_id": "a", "token": "2", "evidence": "review complete"}, actor="reviewer"))
        self.assertEqual("done", self.context()["data"]["ticket"]["status"])

    def test_restart_receipt_and_context(self):
        original = self.mutation("ticket.create", {"ticket_id": "a", "title": "A"}, mutation="retry")
        self.assertIn("result", original)
        self.assertIn("result", self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "tests passed"}))
        before = self.context()
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(before, self.context())
        retried = self.mutation("ticket.create", {"ticket_id": "a", "title": "A"}, mutation="retry")
        self.assertEqual(original, retried)
        changed = self.mutation("ticket.create", {"ticket_id": "a", "title": "Changed"}, mutation="retry")
        self.assertEqual("Idempotency_conflict", self.kind(changed))
        self.assertEqual("2", self.context()["meta"]["workspace_revision"])

    def test_related_links_are_atomic_nonblocking_and_portable(self):
        self.ticket("a")
        self.ticket("b")
        self.ticket("c")
        for left, right, left_rev, right_rev in [("a", "b", "1", "1"), ("b", "c", "2", "1"), ("c", "a", "2", "2")]:
            self.assertIn("result", self.mutation("related.add", {"ticket_id": left, "related_id": right, "expected_revision": left_rev, "related_expected_revision": right_rev}))
        before = self.context("a")
        self.assertEqual(["b", "c"], before["data"]["ticket"]["related_ticket_ids"])
        self.assertEqual(["a", "b", "c"], [item["ticket_id"] for item in self.ok("ticket.ready", {"workspace_id": "demo"})["data"]["items"]])
        self.assertEqual("Conflict", self.kind(self.mutation("related.remove", {"ticket_id": "a", "related_id": "b", "expected_revision": "3", "related_expected_revision": "2"})))
        self.assertEqual(before, self.context("a"))
        self.assertIn("result", self.mutation("related.remove", {"ticket_id": "a", "related_id": "b", "expected_revision": "3", "related_expected_revision": "3"}))
        after = [self.context(ticket) for ticket in ["a", "b", "c"]]
        destination = self.root / "related-snapshot"
        self.export({"workspace_id": "demo", "destination": str(destination)})
        self.data("workspace.unregister", {"workspace_id": "demo"})
        self.data("workspace.restore", {"directory": str(destination), "root": str(self.root / "restored")})
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertEqual(after, [self.context(ticket) for ticket in ["a", "b", "c"]])

    def test_generated_ids_display_keys_and_saved_retry(self):
        saved = self.root / "generated.request.json"
        result = self.cli("ticket", "create", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--title", "Generated", "--save-request", saved)
        self.assertEqual(0, result.returncode, result.stderr)
        created = json.loads(result.stdout)["result"]
        ticket = created["data"]
        self.assertRegex(ticket["ticket_id"], r"^ticket_[0-9a-f]{64}$")
        self.assertEqual("WG-1", ticket["display_key"])
        self.assertNotIn("ticket_id", json.loads(saved.read_text())["params"])
        self.assertEqual(ticket["ticket_id"], self.ok("ticket.resolve", {"workspace_id": "demo", "display_key": "WG-1"})["data"]["ticket_id"])
        self.ticket("explicit")
        self.assertEqual("WG-2", self.context("explicit")["data"]["ticket"]["display_key"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        repeated = self.cli("retry", self.daemon.address, saved)
        self.assertEqual(0, repeated.returncode, repeated.stderr)
        self.assertEqual(created, json.loads(repeated.stdout)["result"])
        self.assertEqual("2", self.context(ticket["ticket_id"])["meta"]["workspace_revision"])
        workspace_params = {"name": "Generated workspace", "root": str(self.root / "generated"), "actor_id": "operator", "mutation_id": "generated-workspace"}
        workspace = self.data("workspace.create", workspace_params)
        self.assertRegex(workspace["workspace_id"], r"^ws_[0-9a-f]{64}$")
        self.assertEqual(workspace, self.data("workspace.create", workspace_params))
        operations = [{"method": "project.create", "as": "project", "params": {"title": "Generated project"}}, {"method": "ticket.create", "as": "ticket", "params": {"title": "Generated ticket", "project_id": "$project"}}, {"method": "comment.add", "params": {"target": {"kind": "ticket", "id": "$ticket"}, "body": "Linked generated IDs"}}]
        response = self.mutation("transaction.apply", {"operations": operations}, mutation="generated-batch")
        self.assertIn("result", response)
        self.assertEqual(response, self.mutation("transaction.apply", {"operations": operations}, mutation="generated-batch"))
        self.assertEqual(3, len(self.ok("ticket.list", {"workspace_id": "demo"})["data"]["items"]))
        # Cut after publishing a generated workspace root, before its receipt.
        self.daemon.stop(kill=True)
        registry_file = self.root / "registry/registry.json"
        registry = json.loads(registry_file.read_text())
        receipt = registry["receipts"].pop("operator:generated-workspace")
        registry["workspaces"].pop(workspace["workspace_id"])
        token = json.loads((self.root / "generated/.local/creation.json").read_text())["token"]
        registry["creates"]["operator:generated-workspace"] = {"request_hash": receipt["request_hash"], "root": workspace_params["root"], "workspace_id": workspace["workspace_id"], "name": workspace_params["name"], "token": token}
        registry_file.write_text(json.dumps(registry))
        self.daemon.start()
        self.assertEqual(workspace, self.data("workspace.create", workspace_params))

    def test_run_attribution_claim_fences_receipts_and_file_transfer(self):
        self.ticket()
        claimed = self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "1", "run_id": "first"}, mutation="claim-run")
        self.assertIn("result", claimed)
        self.assertEqual("Idempotency_conflict", self.kind(self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "1", "run_id": "second"}, mutation="claim-run")))
        self.assertEqual("first", self.context()["data"]["ticket"]["claim"]["run_id"])
        for run in [None, "second"]:
            fields = {} if run is None else {"run_id": run}
            self.assertEqual("Stale_claim", self.kind(self.mutation("ticket.progress", {"ticket_id": "a", "token": "1", "body": "Wrong run", **fields})))
        self.assertIn("result", self.mutation("ticket.progress", {"ticket_id": "a", "token": "1", "body": "First run progress", "run_id": "first"}))
        self.assertEqual([], self.ok("workspace.overview", {"workspace_id": "demo", "actor_id": "agent", "run_id": "second"})["data"]["held_work"]["items"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(claimed, self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "1", "run_id": "first"}, mutation="claim-run"))
        self.assertIn("result", self.mutation("ticket.reassign", {"ticket_id": "a", "expected_revision": "2", "claimant_id": "agent", "claimant_run_id": "second", "reason": "New invocation", "run_id": "orchestrator"}))
        self.assertEqual("Stale_claim", self.kind(self.mutation("ticket.complete", {"ticket_id": "a", "token": "2", "evidence": "Old run", "run_id": "first"})))
        self.assertIn("result", self.mutation("ticket.complete", {"ticket_id": "a", "token": "2", "evidence": "New run", "run_id": "second"}))
        source = self.root / "run-bytes"
        source.write_bytes(b"run-aware transfer")
        saved = self.root / "run-upload.json"
        uploaded = self.cli("resource", "upload", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--run-id", "second", "--resource-id", "binary", "--expected-revision", "0", "--title", "Run bytes", "--file", source, "--save-request", saved)
        self.assertEqual(0, uploaded.returncode, uploaded.stderr)
        self.assertEqual("second", json.loads(saved.read_text())["params"]["run_id"])
        source.unlink()
        retry = self.cli("retry", self.daemon.address, saved)
        self.assertEqual(0, retry.returncode, retry.stderr)
        self.assertEqual(json.loads(uploaded.stdout), json.loads(retry.stdout))
        events = self.ok("activity.since", {"workspace_id": "demo", "after": "0"})["data"]["items"]
        self.assertEqual([None, "first", "first", "orchestrator", "second", "second"], [event.get("run_id") for event in events])

    def test_claim_race_and_fencing(self):
        self.ticket()
        def claim(actor):
            return self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "1"}, actor=actor, mutation="claim")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(claim, ["agent1", "agent2"]))
        self.assertEqual(1, sum("result" in response for response in responses))
        winner = "agent1" if "result" in responses[0] else "agent2"
        self.assertEqual("Stale_claim", self.kind(self.mutation("ticket.complete", {"ticket_id": "a", "token": "1", "evidence": "passed"}, actor="outsider")))
        self.assertIn("result", self.mutation("ticket.release", {"ticket_id": "a", "token": "1"}, actor=winner))
        self.assertIn("result", self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "3"}, actor="agent3"))
        self.assertEqual("Stale_claim", self.kind(self.mutation("ticket.complete", {"ticket_id": "a", "token": "1", "evidence": "passed"}, actor=winner)))
        self.assertIn("result", self.mutation("ticket.complete", {"ticket_id": "a", "token": "2", "evidence": "passed"}, actor="agent3"))

    def test_atomic_batch_durable_retry_and_rollback(self):
        operations = [
            {"method": "ticket.create", "as": "task", "params": {"ticket_id": "a", "title": "A", "project_id": "$plan"}},
            {"method": "project.create", "as": "plan", "params": {"project_id": "p", "title": "P"}},
            {"method": "comment.add", "params": {"target": {"kind": "ticket", "id": "$task"}, "body": "One transaction"}},
            {"method": "resource.put_text", "params": {"resource_id": "r", "expected_revision": "0", "title": "R", "text": "Resource in same commit"}},
        ]
        result = self.mutation("transaction.apply", {"operations": operations}, mutation="batch")
        self.assertIn("result", result)
        self.assertEqual("1", result["result"]["meta"]["workspace_revision"])
        self.assertEqual(4, len(result["result"]["data"]["results"]))
        self.assertEqual("ticket.create", result["result"]["data"]["results"][0]["method"])
        self.assertEqual("a", result["result"]["data"]["results"][0]["data"]["ticket_id"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(result, self.mutation("transaction.apply", {"operations": operations}, mutation="batch"))
        self.assertEqual("1", self.context()["meta"]["workspace_revision"])
        bad = self.mutation("transaction.apply", {"operations": [
            {"method": "ticket.create", "params": {"ticket_id": "bad", "title": "Bad"}},
            {"method": "dependency.add", "params": {"ticket_id": "bad", "prerequisite_id": "bad"}},
        ]})
        self.assertEqual("Dependency_cycle", self.kind(bad))
        self.assertEqual("1", self.context()["meta"]["workspace_revision"])
        self.assertEqual("Not_found", self.kind(self.call("ticket.context", {"workspace_id": "demo", "ticket_id": "bad"})))

    def test_project_milestone_archive_restart_export(self):
        batch = self.mutation("transaction.apply", {"operations": [
            {"method": "project.create", "params": {"project_id": "p", "title": "Project"}},
            {"method": "milestone.create", "params": {"milestone_id": "m", "project_id": "p", "title": "Release", "target_date": "2026-12-01"}},
            {"method": "ticket.create", "params": {"ticket_id": "a", "title": "Task", "project_id": "p", "milestone_id": "m"}},
        ]})
        self.assertIn("result", batch)
        self.assertIn("result", self.mutation("project.update", {"project_id": "p", "expected_revision": "1", "summary": "Implementation started", "acceptance_criteria": "All tests pass"}))
        self.assertIn("result", self.mutation("ticket.start", {"ticket_id": "a", "expected_revision": "1"}))
        self.assertIn("result", self.mutation("ticket.finish", {"ticket_id": "a", "token": "1", "evidence": "validated"}))
        brief = self.ok("project.brief", {"workspace_id": "demo", "project_id": "p"})
        self.assertEqual("1", brief["data"]["progress"]["done"])
        self.assertEqual("todo", brief["data"]["project"]["status"])
        milestone = self.ok("milestone.get", {"workspace_id": "demo", "milestone_id": "m"})
        self.assertEqual("todo", milestone["data"]["milestone"]["status"])
        self.assertIn("result", self.mutation("project.archive", {"project_id": "p", "expected_revision": "2", "archived": True}))
        self.assertEqual([], self.ok("project.list", {"workspace_id": "demo"})["data"]["items"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertTrue(self.ok("project.get", {"workspace_id": "demo", "project_id": "p"})["data"]["archived"])
        destination = self.root / "hierarchy-export"
        self.export({"workspace_id": "demo", "destination": str(destination)})
        self.assertTrue((destination / "milestones/m.md").is_file())
        self.assertIn("Implementation started", (destination / "projects/p.md").read_text())

    def test_graph_and_atomic_failure(self):
        self.ticket("a")
        self.ticket("b")
        self.assertIn("result", self.mutation("dependency.add", {"ticket_id": "b", "prerequisite_id": "a"}))
        before = self.context("a")["meta"]["workspace_revision"]
        self.assertEqual("Dependency_cycle", self.kind(self.mutation("dependency.add", {"ticket_id": "a", "prerequisite_id": "b"})))
        self.assertEqual(before, self.context("a")["meta"]["workspace_revision"])
        self.assertEqual("Blocked", self.kind(self.mutation("ticket.claim", {"ticket_id": "b", "expected_revision": "2"})))
        self.assertIn("result", self.mutation("ticket.start", {"ticket_id": "a", "expected_revision": "1"}))
        self.assertIn("result", self.mutation("ticket.finish", {"ticket_id": "a", "token": "1", "evidence": "validated"}))
        ready = self.ok("ticket.ready", {"workspace_id": "demo"})["data"]["items"]
        self.assertEqual(["b"], [ticket["ticket_id"] for ticket in ready])

    def test_resource_export_and_portable_recovery(self):
        self.ticket()
        self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "Audit evidence"})
        self.mutation("handoff.set", {"ticket_id": "a", "expected_revision": "0", "summary": "Built", "next_steps": "Test", "evidence": "build passed"})
        digests = []
        for revision, text in enumerate(["Research v1", "Research v2"]):
            response = self.mutation("resource.put_text", {"resource_id": "research", "expected_revision": str(revision), "title": "Research", "text": text})
            self.assertIn("result", response)
            digests.append(hashlib.sha256(text.encode()).hexdigest())
        export = self.root / "export"
        manifest = self.export({"workspace_id": "demo", "destination": str(export)})
        self.assertTrue(manifest["complete"])
        for name, digest in manifest["files"].items():
            self.assertEqual(digest, hashlib.sha256((export / name).read_bytes()).hexdigest())
        self.assertIn("Audit evidence", (export / "tickets/a.md").read_text())
        for digest in digests:
            self.assertTrue((export / "portable/blobs" / digest).is_file())
        copy = self.root / "clone"
        shutil.copytree(export / "portable", copy)
        second_root = self.root / "second"
        second_root.mkdir()
        second = Daemon(second_root, Path(self.sockets.name) / "s2")
        self.addCleanup(second.stop)
        second.start()
        registered = request(second.address, "workspace.register", {"root": str(copy)})
        self.assertIn("result", registered)
        self.assertEqual(self.context(), request(second.address, "ticket.context", {"workspace_id": "demo", "ticket_id": "a"})["result"])

    def test_restore_replays_full_history_receipts_and_binary_versions(self):
        self.assertIn("result", self.mutation("project.create", {"project_id": "p", "title": "Project"}))
        self.assertIn("result", self.mutation("milestone.create", {"milestone_id": "m", "project_id": "p", "title": "Milestone"}))
        self.ticket("a", project_id="p", milestone_id="m")
        self.ticket("b", project_id="p", parent_ticket_id="a")
        self.assertIn("result", self.mutation("dependency.add", {"ticket_id": "a", "prerequisite_id": "b"}))
        self.assertIn("result", self.mutation("comment.add", {"comment_id": "note", "target": {"kind": "ticket", "id": "a"}, "body": "Original"}))
        self.assertIn("result", self.mutation("comment.edit", {"comment_id": "note", "expected_revision": "1", "body": "Revised"}))
        self.assertIn("result", self.mutation("comment.tombstone", {"comment_id": "note", "expected_revision": "2"}))
        self.assertIn("result", self.mutation("handoff.set", {"ticket_id": "a", "expected_revision": "0", "summary": "Audit", "next_steps": "Restore", "evidence": "Tests"}))
        self.assertIn("result", self.mutation("ticket.claim", {"ticket_id": "b", "expected_revision": "1"}))
        self.assertIn("result", self.mutation("project.create", {"project_id": "archived", "title": "Archive"}))
        self.assertIn("result", self.mutation("project.archive", {"project_id": "archived", "expected_revision": "1", "archived": True}))
        for revision, body in enumerate([bytes(range(256)) * 4096, b"new bytes"]):
            self.upload_all("upload%d" % revision, body)
            self.assertIn("result", self.finish_upload("upload%d" % revision, revision=str(revision)))
        receipt = self.data("workspace.receipt", {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "m1"})
        contexts = [self.context(ticket) for ticket in ["a", "b"]]
        history = self.ok("comment.history", {"workspace_id": "demo", "comment_id": "note"})
        destination = self.root / "snapshot"
        self.export({"workspace_id": "demo", "destination": str(destination)})
        restored = self.root / "restored"
        params = {"actor_id": "operator", "mutation_id": "restore", "directory": str(destination), "root": str(restored)}
        self.assertEqual("Conflict", self.kind(self.call("workspace.restore", params)))
        self.data("workspace.unregister", {"workspace_id": "demo"})
        response = self.data("workspace.restore", params)
        self.assertFalse(response["open"])
        self.assertEqual("Workspace_closed", self.kind(self.call("ticket.context", {"workspace_id": "demo", "ticket_id": "a"})))
        self.assertEqual(response, self.data("workspace.restore", params))
        self.assertEqual("Idempotency_conflict", self.kind(self.call("workspace.restore", {**params, "root": str(self.root / "other")})))
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertEqual(contexts, [self.context(ticket) for ticket in ["a", "b"]])
        self.assertEqual(history, self.ok("comment.history", {"workspace_id": "demo", "comment_id": "note"}))
        self.assertEqual(receipt, self.data("workspace.receipt", {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "m1"}))
        self.assertEqual(bytes(range(256)) * 4096, self.read_resource_bytes("binary", version=1))
        self.assertEqual(b"new bytes", self.read_resource_bytes("binary", version=2))
        again = self.root / "again"
        self.export({"workspace_id": "demo", "destination": str(again)})
        before_files = json.loads((destination / "manifest.json").read_text())["files"]
        after_files = json.loads((again / "manifest.json").read_text())["files"]
        for name in before_files:
            self.assertEqual((destination / name).read_bytes(), (again / name).read_bytes(), name)
        self.assertEqual(before_files, after_files)
        shutil.rmtree(destination)
        self.assertEqual(response, self.data("workspace.restore", params))

    def test_restore_all_requires_complete_export_and_exact_mapping(self):
        self.ticket()
        self.data("workspace.create", {"workspace_id": "other", "root": str(self.root / "other"), "name": "Other"})
        destination = self.root / "all"
        job = self.data("daemon.export_all", {"destination": str(destination)})
        self.assertEqual("completed", self.wait_export(job["job_id"])["status"])
        for workspace in ["demo", "other"]:
            self.data("workspace.unregister", {"workspace_id": workspace})
        roots = {workspace: str(self.root / (workspace + "-restored")) for workspace in ["demo", "other"]}
        params = {"directory": str(destination), "roots": roots, "actor_id": "operator", "mutation_id": "restore-all"}
        self.assertEqual("Invalid_argument", self.kind(self.call("daemon.restore_all", {**params, "roots": {"demo": roots["demo"]}})))
        result = self.data("daemon.restore_all", params)
        self.assertEqual(2, len(result["workspaces"]))
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertEqual("1", self.context()["meta"]["workspace_revision"])
        partial = self.root / "partial"
        job = self.data("daemon.export_all", {"destination": str(partial), "allow_partial": True})
        self.assertEqual("completed", self.wait_export(job["job_id"])["status"])
        self.assertEqual("Invalid_argument", self.kind(self.call("daemon.restore_all", {"directory": str(partial), "roots": {"demo": str(self.root / "extra")}})))
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(result, self.data("daemon.restore_all", params))

    def test_restore_rejects_self_consistent_manifest_with_noncanonical_data(self):
        self.ticket()
        destination = self.root / "bad-snapshot"
        self.export({"workspace_id": "demo", "destination": str(destination)})
        self.data("workspace.unregister", {"workspace_id": "demo"})
        extra = "portable/blobs/" + hashlib.sha256(b"unreferenced").hexdigest()
        (destination / extra).write_bytes(b"unreferenced")
        manifest = json.loads((destination / "manifest.json").read_text())
        manifest["files"][extra] = hashlib.sha256(b"unreferenced").hexdigest()
        (destination / "manifest.json").write_text(json.dumps(manifest))
        self.assertTrue(self.data("export.verify", {"directory": str(destination)})["verified"])
        restored = self.root / "restored"
        params = {"directory": str(destination), "root": str(restored), "actor_id": "operator", "mutation_id": "invalid-restore"}
        self.assertEqual("Corrupt_store", self.kind(self.call("workspace.restore", params)))
        self.assertFalse(restored.exists())
        self.assertEqual("pending", self.data("registry.receipt", {"actor_id": "operator", "mutation_id": "invalid-restore"})["status"])
        self.assertEqual("Conflict", self.kind(self.call("workspace.create", {"workspace_id": "demo", "root": str(restored), "name": "Collision"})))
        self.assertEqual("Idempotency_conflict", self.kind(self.call("workspace.close", {"workspace_id": "demo", "actor_id": "operator", "mutation_id": "invalid-restore"})))
        manifest["files"].pop(extra)
        (destination / extra).unlink()
        (destination / "manifest.json").write_text(json.dumps(manifest))
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual("Conflict", self.kind(self.call("workspace.restore", params)))
        cancellation = {"target_actor_id": "operator", "target_mutation_id": "invalid-restore", "actor_id": "operator", "mutation_id": "cancel-restore"}
        self.assertEqual("canceled", self.data("restore.cancel", cancellation)["kind"])
        self.assertEqual({"kind": "canceled"}, self.data("workspace.restore", params))
        self.assertEqual("canceled", self.data("restore.cancel", cancellation)["kind"])
        self.assertEqual("installed", self.data("workspace.restore", {**params, "mutation_id": "fixed-restore"})["kind"])

    def test_restore_recovers_installed_and_partial_multi_root_cuts(self):
        self.ticket()
        self.data("workspace.create", {"workspace_id": "other", "root": str(self.root / "other"), "name": "Other"})
        destination = self.root / "all"
        job = self.data("daemon.export_all", {"destination": str(destination)})
        self.assertEqual("completed", self.wait_export(job["job_id"])["status"])
        for workspace in ["demo", "other"]:
            self.data("workspace.unregister", {"workspace_id": workspace})
        roots = {workspace: str(self.root / (workspace + "-restored")) for workspace in ["demo", "other"]}
        params = {"directory": str(destination), "roots": roots, "actor_id": "operator", "mutation_id": "cut-restore"}
        original = self.data("daemon.restore_all", params)
        self.daemon.stop(kill=True)
        registry_file = self.root / "registry/registry.json"
        registry = json.loads(registry_file.read_text())
        plan = json.loads((Path(roots["demo"]) / ".local/restore.json").read_text())
        registry["restores"]["operator:cut-restore"] = plan
        registry["receipts"].pop("operator:cut-restore")
        for workspace in roots:
            registry["workspaces"].pop(workspace)
        registry_file.write_text(json.dumps(registry))
        # Installed first root and abandoned staging for the second. No source
        # needed for an already installed, validated root owned by this intent.
        abandoned = self.root / "abandoned-restoring-stage"
        Path(roots["other"]).rename(abandoned)
        shutil.rmtree(destination / "workspaces/demo")
        self.daemon.start()
        self.assertEqual("pending", self.data("registry.receipt", {"actor_id": "operator", "mutation_id": "cut-restore"})["status"])
        self.assertEqual("Conflict", self.kind(self.call("restore.cancel", {"target_actor_id": "operator", "target_mutation_id": "cut-restore"})))
        self.assertEqual("Conflict", self.kind(self.call("workspace.register", {"root": roots["demo"]})))
        self.assertEqual(original, self.data("daemon.restore_all", params))
        self.assertTrue(abandoned.is_dir())
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertEqual("1", self.context()["meta"]["workspace_revision"])
        self.data("workspace.close", {"workspace_id": "demo"})
        self.daemon.stop(kill=True)
        # All roots installed but registry completion not committed.
        registry = json.loads(registry_file.read_text())
        registry["restores"]["operator:cut-restore"] = plan
        registry["receipts"].pop("operator:cut-restore")
        for workspace in roots:
            registry["workspaces"].pop(workspace)
        registry_file.write_text(json.dumps(registry))
        shutil.rmtree(destination)
        self.daemon.start()
        self.assertEqual(original, self.data("daemon.restore_all", params))

    def test_git_clone_writer_handoff_and_descendant_reopen(self):
        self.ticket()
        self.assertIn("result", self.mutation("resource.put_text", {"resource_id": "notes", "expected_revision": "0", "title": "Notes", "text": "Portable context"}))
        before = self.context()
        original = self.root / "workspace"
        self.data("workspace.close", {"workspace_id": "demo"})
        def git(directory, *args):
            result = subprocess.run(["git", "-C", str(directory), "-c", "user.name=Workgraph Test", "-c", "user.email=workgraph@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args], text=True, capture_output=True, timeout=15)
            self.assertEqual(0, result.returncode, result.stderr)
            return result.stdout
        git(original, "init", "--initial-branch=main")
        git(original, "add", ".")
        git(original, "commit", "-m", "Closed writer handoff")
        self.assertNotIn(".local/", git(original, "ls-files"))
        clone = self.root / "clone"
        git(self.root, "clone", "--no-hardlinks", str(original), str(clone))
        second_root = self.root / "second"
        second_root.mkdir()
        second = Daemon(second_root, Path(self.sockets.name) / "git-handoff")
        self.addCleanup(second.stop)
        second.start()
        self.assertIn("result", request(second.address, "workspace.register", {"root": str(clone)}))
        self.assertEqual(before, request(second.address, "ticket.context", {"workspace_id": "demo", "ticket_id": "a"})["result"])
        self.assertIn("result", request(second.address, "comment.add", {"workspace_id": "demo", "target": {"kind": "ticket", "id": "a"}, "actor_id": "second", "mutation_id": "progress", "body": "Work on receiving machine"}))
        after = request(second.address, "ticket.context", {"workspace_id": "demo", "ticket_id": "a"})["result"]
        self.assertIn("result", request(second.address, "workspace.close", {"workspace_id": "demo"}))
        git(clone, "add", ".")
        git(clone, "commit", "-m", "Return writer handoff")
        git(original, "fetch", str(clone), "main")
        git(original, "merge", "--ff-only", "FETCH_HEAD")
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertEqual(after, self.context())
        self.assertEqual("committed", self.data("workspace.receipt", {"workspace_id": "demo", "actor_id": "second", "mutation_id": "progress"})["status"])
        self.assertEqual("", git(original, "status", "--porcelain"))

    def test_handoff_and_audit(self):
        self.ticket()
        self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "Before"})
        self.mutation("handoff.set", {"ticket_id": "a", "expected_revision": "0", "summary": "Summary", "next_steps": "Next", "evidence": "Passed"})
        self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "After"})
        context = self.context()["data"]
        self.assertEqual(["Before", "After"], [item["body"] for item in context["updates"]["items"]])
        audit = self.ok("activity.since", {"workspace_id": "demo", "after": "0"})["data"]["items"]
        self.assertEqual(["1", "2", "3", "4"], [item["revision"] for item in audit])

    def test_discussion_history_scoped_audit_and_restart(self):
        for project in ["p", "q"]:
            self.assertIn("result", self.mutation("project.create", {"project_id": project, "title": project}))
        self.ticket("a", project_id="p")
        batch = {"operations": [
            {"method": "comment.add", "as": "original", "params": {"comment_id": "note", "target": {"kind": "ticket", "id": "a"}, "kind": "decision", "body": "Original"}},
            {"method": "comment.add", "params": {"comment_id": "reply", "target": {"kind": "ticket", "id": "a"}, "reply_to_id": "$original", "body": "Reply"}},
            {"method": "comment.add", "params": {"comment_id": "workspace-note", "target": {"kind": "workspace"}, "body": "Workspace context"}},
            {"method": "comment.add", "params": {"comment_id": "project-note", "target": {"kind": "project", "id": "p"}, "body": "Project context"}},
        ]}
        self.assertIn("result", self.mutation("transaction.apply", batch))
        self.assertIn("result", self.mutation("handoff.set", {"ticket_id": "a", "expected_revision": "0", "summary": "Review", "next_steps": "Revise", "evidence": "Notes", "covers_through": "4"}))
        self.assertIn("result", self.mutation("comment.edit", {"comment_id": "note", "expected_revision": "1", "body": "Revised"}))
        self.assertIn("result", self.mutation("comment.tombstone", {"comment_id": "note", "expected_revision": "2"}))
        self.assertIn("result", self.mutation("ticket.move", {"ticket_id": "a", "expected_revision": "1", "project_id": "q", "parent_ticket_id": None, "milestone_id": None}))
        history = self.ok("comment.history", {"workspace_id": "demo", "comment_id": "note"})
        self.assertEqual(["Original", "Revised", ""], [item["body"] for item in history["data"]["items"]])
        current = self.ok("comment.get", {"workspace_id": "demo", "comment_id": "note"})["data"]
        self.assertTrue(current["tombstone"])
        self.assertEqual(["Revised", ""], [item["body"] for item in self.context()["data"]["updates"]["items"]])
        visible = self.ok("comment.list", {"workspace_id": "demo", "target": {"kind": "ticket", "id": "a"}})["data"]["items"]
        self.assertEqual(["reply"], [item["comment_id"] for item in visible])
        first = self.ok("comment.history", {"workspace_id": "demo", "comment_id": "note", "limit": "1"})
        second = self.ok("comment.history", {"workspace_id": "demo", "comment_id": "note", "limit": "1", "offset": "1", "at_revision": first["meta"]["workspace_revision"]})
        self.assertEqual("Revised", second["data"]["items"][0]["body"])
        scoped = self.ok("activity.since", {"workspace_id": "demo", "project_id": "p", "actor_id": "agent"})
        self.assertEqual(["1", "3", "4", "5", "6", "7", "8"], [event["revision"] for event in scoped["data"]["items"]])
        before = self.context()
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(before, self.context())
        self.assertEqual(history, self.ok("comment.history", {"workspace_id": "demo", "comment_id": "note"}))
        self.assertEqual(scoped, self.ok("activity.since", {"workspace_id": "demo", "project_id": "p", "actor_id": "agent"}))
        destination = self.root / "discussion-export"
        self.export({"workspace_id": "demo", "destination": str(destination)})
        readable = (destination / "comments" / "note.md").read_text()
        self.assertIn("Original", readable)
        self.assertIn("Revised", readable)
        self.assertIn('"tombstone": true', readable)

    def upload_begin(self, upload, data):
        return self.data("upload.begin", {"workspace_id": "demo", "actor_id": "agent", "upload_id": upload,
                                       "size_bytes": str(len(data)), "digest": hashlib.sha256(data).hexdigest()})

    def upload_chunk(self, upload, offset, data):
        return self.call("upload.chunk", {"workspace_id": "demo", "actor_id": "agent", "upload_id": upload,
                                          "offset": str(offset), "data_base64": base64.b64encode(data).decode()})

    def upload_all(self, upload, data):
        self.upload_begin(upload, data)
        for offset in range(0, len(data), 262144):
            self.assertIn("result", self.upload_chunk(upload, offset, data[offset:offset + 262144]))

    def finish_upload(self, upload, resource="binary", revision="0", mutation=None):
        return self.mutation("resource.finish_upload", {"upload_id": upload, "resource_id": resource,
            "expected_revision": revision, "title": resource, "filename": resource + ".bin",
            "mime_type": "application/octet-stream"}, mutation=mutation)

    def read_resource_bytes(self, resource, version=None):
        result = bytearray()
        offset = 0
        while True:
            params = {"workspace_id": "demo", "resource_id": resource, "offset": str(offset), "length": "131071"}
            if version is not None:
                params["version"] = str(version)
            chunk = self.data("resource.read_chunk", params)
            data = base64.b64decode(chunk["data_base64"], validate=True)
            self.assertEqual(hashlib.sha256(data).hexdigest(), chunk["chunk_digest"])
            result.extend(data)
            if chunk["eof"]:
                self.assertIsNone(chunk["next_offset"])
                self.assertEqual(len(result), int(chunk["size_bytes"]))
                self.assertEqual(hashlib.sha256(result).hexdigest(), chunk["digest"])
                return bytes(result)
            offset = int(chunk["next_offset"])

    def test_binary_upload_versions_retry_export_and_restart(self):
        data = bytes(range(256)) * 20500  # >4MiB; includes NUL and invalid UTF-8.
        first = data[:262144]
        self.upload_begin("large", data)
        self.assertEqual("Conflict", self.kind(self.upload_chunk("large", 262144, first)))
        self.assertIn("result", self.upload_chunk("large", 0, first))
        self.assertIn("result", self.upload_chunk("large", 0, first))
        self.assertEqual("Conflict", self.kind(self.upload_chunk("large", 0, bytes(len(first)))))
        incomplete = self.finish_upload("large", mutation="finish")
        self.assertEqual("Conflict", self.kind(incomplete))
        self.assertEqual([], self.ok("resource.list", {"workspace_id": "demo"})["data"]["items"])
        for offset in range(262144, len(data), 262144):
            self.assertIn("result", self.upload_chunk("large", offset, data[offset:offset + 262144]))
        completed = self.finish_upload("large", mutation="finish")
        self.assertIn("result", completed)
        self.assertEqual(completed, self.finish_upload("large", mutation="finish"))
        self.assertEqual(data, self.read_resource_bytes("binary"))
        self.ticket()
        self.assertIn("result", self.mutation("resource.link", {"resource_id": "binary", "expected_revision": "1", "target": {"kind": "ticket", "id": "a"}}))
        self.upload_all("empty", b"")
        self.assertIn("result", self.finish_upload("empty", revision="2"))
        self.assertEqual(b"", self.read_resource_bytes("binary"))
        self.assertEqual(data, self.read_resource_bytes("binary", version=1))
        self.upload_all("same-bytes", data)
        self.assertIn("result", self.finish_upload("same-bytes", resource="copy"))
        self.assertEqual(2, len(list((self.root / "workspace" / "blobs").iterdir())))
        before = self.context()
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(completed, self.finish_upload("large", mutation="finish"))
        self.assertEqual(before, self.context())
        self.assertEqual(data, self.read_resource_bytes("binary", version=1))
        destination = self.root / "binary-export"
        manifest = self.export({"workspace_id": "demo", "destination": str(destination)})
        for name, digest in manifest["files"].items():
            self.assertEqual(digest, hashlib.sha256((destination / name).read_bytes()).hexdigest())
        self.assertEqual(data, (destination / "portable" / "blobs" / hashlib.sha256(data).hexdigest()).read_bytes())
        self.assertIn("Version 1", (destination / "resources" / "binary.md").read_text())
        self.assertIn("Version 2", (destination / "resources" / "binary.md").read_text())
        snapshot = json.loads((destination / "workspace.json").read_text())
        binary = next(resource for resource in snapshot["resources"] if resource["id"] == "binary")
        self.assertEqual(["2", "1"], [version["revision"] for version in binary["versions"]])

    def test_interrupted_upload_checksum_and_publication_failure(self):
        data = b"\x00\xffpayload"
        self.upload_begin("interrupted", data)
        self.assertIn("result", self.upload_chunk("interrupted", 0, data[:3]))
        self.daemon.stop(kill=True)
        self.daemon.start()
        status = self.call("upload.status", {"workspace_id": "demo", "actor_id": "agent", "upload_id": "interrupted"})
        self.assertEqual("Not_found", self.kind(status))
        self.assertEqual([], self.ok("resource.list", {"workspace_id": "demo"})["data"]["items"])
        self.assertEqual([], list((self.root / "workspace" / ".local" / "uploads").iterdir()))
        self.upload_begin("interrupted", data)
        self.assertIn("result", self.upload_chunk("interrupted", 0, b"x" * len(data)))
        self.assertEqual("Invalid_argument", self.kind(self.finish_upload("interrupted")))
        self.data("upload.abort", {"workspace_id": "demo", "actor_id": "agent", "upload_id": "interrupted"})
        self.upload_all("valid", data)
        transactions = self.root / "workspace" / "transactions"
        saved = self.root / "saved-transactions"
        transactions.rename(saved)
        failed = self.finish_upload("valid", mutation="publish")
        self.assertEqual("Corrupt_store", self.kind(failed))
        self.assertEqual([], self.ok("resource.list", {"workspace_id": "demo"})["data"]["items"])
        saved.rename(transactions)
        # Repairing paths does not un-fence an owner after external corruption.
        self.assertIn("error", self.finish_upload("valid", mutation="publish"))
        self.data("workspace.close", {"workspace_id": "demo"})
        self.data("workspace.open", {"workspace_id": "demo"})
        self.upload_all("valid", data)
        self.assertIn("result", self.finish_upload("valid", mutation="publish"))
        self.assertEqual(data, self.read_resource_bytes("binary"))
        invalid_text = self.call("resource.read", {"workspace_id": "demo", "resource_id": "binary"})
        self.assertEqual("Invalid_argument", self.kind(invalid_text))
        self.assertIn("result", self.call("daemon.health", {}))

    def test_finish_recovers_rename_before_sync_acknowledgement(self):
        data = b"finish boundary bytes"
        self.upload_all("boundary", data)
        root = self.root / "workspace"
        # Reproduce the observable filesystem state after rename but before the
        # worker marks the upload installed. Finish must verify and sync again.
        (root / ".local" / "uploads" / "boundary.part").rename(root / "blobs" / hashlib.sha256(data).hexdigest())
        self.assertIn("result", self.finish_upload("boundary"))
        self.assertEqual(data, self.read_resource_bytes("binary"))

    def test_upload_bounds_actor_and_binary_corruption(self):
        params = {"workspace_id": "demo", "actor_id": "agent", "upload_id": "u"}
        invalid = self.call("upload.begin", {**params, "size_bytes": str(64 * 1024 * 1024 + 1), "digest": "a" * 64})
        self.assertEqual("Invalid_argument", self.kind(invalid))
        self.upload_begin("u", b"abc")
        self.assertEqual("Conflict", self.kind(self.call("upload.status", {**params, "actor_id": "other"})))
        self.assertEqual("Invalid_argument", self.kind(self.call("upload.chunk", {**params, "offset": "0", "data_base64": "%%%"})))
        for i in range(1, 8):
            self.upload_begin("u" + str(i), b"")
        self.assertEqual("Invalid_argument", self.kind(self.call("upload.begin", {**params, "upload_id": "overflow", "size_bytes": "0", "digest": hashlib.sha256(b"").hexdigest()})))
        self.assertIn("result", self.upload_chunk("u", 0, b"abc"))
        self.assertIn("result", self.finish_upload("u"))
        self.daemon.stop(kill=True)
        (self.root / "workspace" / "blobs" / hashlib.sha256(b"abc").hexdigest()).write_bytes(b"bad")
        self.daemon.start()
        self.assertEqual("Workspace_closed", self.kind(self.call("resource.get", {"workspace_id": "demo", "resource_id": "binary"})))
        health = self.data("daemon.health", {})
        self.assertEqual("Corrupt_store", health["workspaces"][0]["error"]["kind"])

    def test_query_byte_budgets_and_search_current_sources(self):
        self.assertIn("result", self.mutation("project.create", {"project_id": "p", "title": "Needle plan"}))
        for i in range(6):
            self.ticket("t" + str(i), project_id="p", description="x" * 50000)
        self.assertIn("result", self.mutation("comment.add", {"target": {"kind": "ticket", "id": "t0"}, "comment_id": "note", "body": "Needle decision"}))
        self.assertIn("result", self.mutation("handoff.set", {"ticket_id": "t0", "expected_revision": "0", "summary": "Needle handoff", "next_steps": "Test", "evidence": "Fixture"}))
        self.assertIn("result", self.mutation("resource.put_text", {"resource_id": "text", "expected_revision": "0", "title": "Research", "text": "needle only inside resource"}))
        self.assertIn("result", self.mutation("resource.link", {"resource_id": "text", "expected_revision": "1", "target": {"kind": "project", "id": "p"}}))
        seen = []
        offset = "0"
        revision = None
        while offset is not None:
            params = {"workspace_id": "demo", "max_bytes": "4096", "offset": offset}
            if revision is not None:
                params["at_revision"] = revision
            result = self.ok("ticket.list", params)
            encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode()
            self.assertLessEqual(len(encoded), 4096)
            self.assertEqual(len(encoded), int(result["meta"]["budget"]["returned_bytes"]))
            self.assertTrue(result["meta"]["budget"]["truncated"])
            self.assertTrue(result["data"]["items"])
            revision = result["meta"]["workspace_revision"]
            seen.extend(item["ticket_id"] for item in result["data"]["items"])
            offset = result["data"]["next_offset"]
        self.assertEqual(["t" + str(i) for i in range(6)], seen)
        search = self.ok("search.query", {"workspace_id": "demo", "project_id": "p", "text": "NEEDLE"})
        self.assertEqual({"project", "comment", "handoff", "resource_text"}, {item["source"]["kind"] for item in search["data"]["items"]})
        self.assertEqual(search["meta"]["workspace_revision"], search["data"]["index_revision"])
        self.assertEqual("1", search["data"]["coverage"]["indexed_text_resources"])
        paged = []
        cursor = "0"
        while cursor is not None:
            page = self.ok("search.query", {"workspace_id": "demo", "project_id": "p", "text": "NEEDLE", "limit": "1", "offset": cursor, "at_revision": search["meta"]["workspace_revision"]})["data"]
            paged.extend(page["items"])
            cursor = page["next_offset"]
        self.assertEqual(search["data"]["items"], paged)
        self.assertIn("result", self.mutation("comment.edit", {"comment_id": "note", "expected_revision": "1", "body": "Replaced discussion"}))
        stale = self.call("search.query", {"workspace_id": "demo", "text": "needle", "offset": "1", "at_revision": search["meta"]["workspace_revision"]})
        self.assertEqual("Conflict", self.kind(stale))
        current = self.ok("search.query", {"workspace_id": "demo", "text": "needle", "kinds": ["comment"]})
        self.assertEqual([], current["data"]["items"])
        self.assertIn("result", self.mutation("ticket.claim", {"ticket_id": "t0", "expected_revision": "1"}))
        self.assertIn("result", self.mutation("ticket.hold", {"ticket_id": "t0", "expected_revision": "2", "reason": "Review"}))
        overview = self.ok("workspace.overview", {"workspace_id": "demo", "actor_id": "agent", "max_bytes": "4096"})
        self.assertEqual("1", overview["data"]["counts_by_status"]["in_progress"])
        self.assertEqual("t0", overview["data"]["held_work"]["items"][0]["ticket_id"])
        self.assertEqual("t0", overview["data"]["blocked_work"]["items"][0]["ticket_id"])
        too_small = self.call("ticket.context", {"workspace_id": "demo", "ticket_id": "t0", "max_bytes": "4096"})
        self.assertEqual("Invalid_argument", self.kind(too_small))
        context = self.ok("ticket.context", {"workspace_id": "demo", "ticket_id": "t0", "max_bytes": "16384"})
        self.assertTrue(context["data"]["activity_since_handoff"]["items"])
        self.assertLessEqual(len(json.dumps(context, separators=(",", ":"), ensure_ascii=False).encode()), 16384)

    def test_search_discloses_binary_invalid_and_truncated_text(self):
        payload = b"needle" + b"a" * 70000
        self.upload_all("long", payload)
        self.assertIn("result", self.mutation("resource.finish_upload", {"upload_id": "long", "resource_id": "long", "expected_revision": "0", "title": "Long", "filename": "long.txt", "mime_type": "text/plain"}))
        self.upload_all("invalid", b"\xffneedle")
        self.assertIn("result", self.mutation("resource.finish_upload", {"upload_id": "invalid", "resource_id": "invalid", "expected_revision": "0", "title": "Invalid", "filename": "invalid.txt", "mime_type": "text/plain"}))
        self.upload_all("binary", b"needle")
        self.assertIn("result", self.finish_upload("binary"))
        search = self.ok("search.query", {"workspace_id": "demo", "text": "needle"})
        matches = search["data"]["items"]
        self.assertEqual(["long"], [item["source"]["resource_id"] for item in matches])
        omitted = {item["source"]["resource_id"]: item["reason"] for item in search["data"]["unindexed_resources"]["items"]}
        self.assertEqual({"binary": "unsupported_mime", "invalid": "invalid_utf8", "long": "prefix_only"}, omitted)
        self.assertEqual("1", search["data"]["coverage"]["truncated_text_resources"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(search, self.ok("search.query", {"workspace_id": "demo", "text": "needle"}))

    def test_search_enforces_aggregate_text_scan_budget(self):
        text = "needle" + "x" * (65536 - 6)
        operations = [{"method": "resource.put_text", "params": {"resource_id": "r%02d" % i, "expected_revision": "0", "title": "R", "text": text}} for i in range(17)]
        self.assertIn("result", self.mutation("transaction.apply", {"operations": operations}))
        result = self.ok("search.query", {"workspace_id": "demo", "text": "needle", "kinds": ["resource_text"]})["data"]
        self.assertEqual("17", result["coverage"]["eligible_text_resources"])
        self.assertEqual("16", result["coverage"]["indexed_text_resources"])
        self.assertEqual("1", result["coverage"]["unindexed_text_resources"])
        self.assertEqual("r16", result["unindexed_resources"]["items"][0]["source"]["resource_id"])
        self.assertEqual("query_text_budget", result["unindexed_resources"]["items"][0]["reason"])
        narrow = self.ok("search.query", {"workspace_id": "demo", "text": "needle", "target": {"kind": "resource", "resource_id": "r16"}})["data"]
        self.assertEqual("r16", narrow["items"][0]["source"]["resource_id"])
        self.assertEqual([], narrow["unindexed_resources"]["items"])

    def test_exclusive_directory_publication_preserves_existing_empty_destination(self):
        root = self.root / "platform-test"
        root.mkdir()
        (root / "source").mkdir()
        (root / "source/marker").write_text("source data")
        (root / "destination").mkdir()
        result = subprocess.run([str(PLATFORM_EXE), str(root)], capture_output=True, text=True, timeout=10)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("exclusive directory publication passed\n", result.stdout)

    def test_background_export_captures_revision_while_mutations_continue(self):
        self.seed_export_fixture()
        original = self.mutation("resource.put_text", {"resource_id": "snapshot-text", "expected_revision": "0", "title": "Before", "text": "original resource"})
        self.assertIn("result", original)
        destination = self.root / "background"
        params = {"workspace_id": "demo", "destination": str(destination), "actor_id": "operator", "mutation_id": "background"}
        job = self.data("workspace.export", params)
        self.assertEqual("running", job["status"])
        self.assertEqual(job, self.data("workspace.export", params))
        close = self.call("workspace.close", {"workspace_id": "demo"})
        self.assertEqual("Conflict", self.kind(close), close)
        update = self.mutation("comment.add", {"target": {"kind": "ticket", "id": "export-0000"}, "body": "after capture"})
        self.assertIn("result", update)
        self.assertGreater(int(update["result"]["meta"]["workspace_revision"]), int(job["captures"][0]["revision"]))
        self.assertIn("result", self.mutation("resource.put_text", {"resource_id": "snapshot-text", "expected_revision": "1", "title": "After", "text": "new resource"}))
        final = self.wait_export(job["job_id"])
        self.assertEqual("completed", final["status"], final)
        manifest = json.loads((destination / "manifest.json").read_text())
        self.assertEqual(job["captures"][0]["revision"], manifest["revision"])
        self.assertEqual(job["captures"][0]["head"], manifest["head"])
        self.assertNotIn("after capture", (destination / "tickets/export-0000.md").read_text())
        old_digest = hashlib.sha256(b"original resource").hexdigest()
        new_digest = hashlib.sha256(b"new resource").hexdigest()
        self.assertEqual(b"original resource", (destination / "portable/blobs" / old_digest).read_bytes())
        self.assertFalse((destination / "portable/blobs" / new_digest).exists())
        self.assertIn("after capture", json.dumps(self.context("export-0000")))
        self.data("workspace.close", {"workspace_id": "demo"})
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(final, self.data("export.get", {"job_id": job["job_id"]}))
        self.assertEqual(job, self.data("workspace.export", params))

    def test_export_cancel_retry_preserves_capture(self):
        self.seed_export_fixture()
        destination = self.root / "cancel-retry"
        job = self.data("workspace.export", {"workspace_id": "demo", "destination": str(destination)})
        canceled = self.data("export.cancel", {"job_id": job["job_id"]})
        self.assertTrue(canceled["cancel_requested"])
        self.assertEqual("canceled", self.wait_export(job["job_id"])["status"])
        self.assertFalse(destination.exists())
        self.assertIn("result", self.mutation("comment.add", {"target": {"kind": "ticket", "id": "export-0000"}, "body": "after canceled capture"}))
        retried = self.data("export.retry", {"job_id": job["job_id"]})
        self.assertEqual("2", retried["attempt"])
        self.assertEqual(job["captures"], retried["captures"])
        self.assertEqual("completed", self.wait_export(job["job_id"])["status"])
        self.assertNotIn("after canceled capture", (destination / "workspace.json").read_text())
        self.assertEqual("Conflict", self.kind(self.call("export.cancel", {"job_id": job["job_id"]})))

    def test_export_crash_recovery_and_retry_original_revision(self):
        self.seed_export_fixture()
        destination = self.root / "interrupted"
        job = self.data("workspace.export", {"workspace_id": "demo", "destination": str(destination)})
        self.daemon.stop(kill=True)
        self.daemon.start()
        recovered = self.data("export.get", {"job_id": job["job_id"]})
        self.assertEqual("interrupted", recovered["status"], recovered)
        self.assertFalse(destination.exists())
        self.assertIn("result", self.mutation("comment.add", {"target": {"kind": "ticket", "id": "export-0000"}, "body": "after restart"}))
        self.data("export.retry", {"job_id": job["job_id"]})
        self.assertEqual("completed", self.wait_export(job["job_id"])["status"])
        self.assertNotIn("after restart", (destination / "workspace.json").read_text())
        # Simulate the durable cut after publication but before completion status.
        self.daemon.stop(kill=True)
        registry = self.root / "registry/registry.json"
        saved = json.loads(registry.read_text())
        saved["exports"][job["job_id"]]["status"] = "running"
        registry.write_text(json.dumps(saved))
        self.daemon.start()
        self.assertEqual("completed", self.data("export.get", {"job_id": job["job_id"]})["status"])

    def test_export_shutdown_failure_and_listing_snapshot(self):
        self.seed_export_fixture()
        destination = self.root / "shutdown-export"
        job = self.data("workspace.export", {"workspace_id": "demo", "destination": str(destination)})
        self.daemon.stop()
        self.assertEqual(0, self.daemon.process.returncode)
        self.daemon.start()
        stopped = self.data("export.get", {"job_id": job["job_id"]})
        self.assertIn(stopped["status"], ["canceled", "completed"])
        missing = self.root / "absent-parent" / "export"
        failed = self.data("workspace.export", {"workspace_id": "demo", "destination": str(missing)})
        self.assertEqual("failed", self.wait_export(failed["job_id"])["status"])
        self.assertFalse(missing.exists())
        page = self.ok("export.list", {"limit": "1", "max_bytes": "4096"})
        self.assertEqual(1, len(page["data"]["items"]))
        second = self.ok("export.list", {"limit": "1", "offset": "1", "at_snapshot": page["meta"]["snapshot"]})
        self.assertEqual(1, len(second["data"]["items"]))
        self.assertEqual("Invalid_argument", self.kind(self.call("export.list", {"offset": "1"})))
        missing.parent.mkdir()
        self.data("export.retry", {"job_id": failed["job_id"]})
        self.assertEqual("Conflict", self.kind(self.call("export.list", {"offset": "1", "at_snapshot": page["meta"]["snapshot"]})))
        self.assertEqual("completed", self.wait_export(failed["job_id"])["status"])
        self.data("workspace.close", {"workspace_id": "demo"})

    def test_export_all_inventory_and_explicit_omissions(self):
        self.ticket()
        self.data("workspace.create", {"workspace_id": "second", "name": "Second", "root": str(self.root / "second-workspace")})
        destination = self.root / "all"
        job = self.data("daemon.export_all", {"destination": str(destination)})
        self.assertEqual("completed", self.wait_export(job["job_id"])["status"])
        manifest = json.loads((destination / "manifest.json").read_text())
        self.assertTrue(manifest["complete"])
        self.assertEqual(["demo", "second"], sorted(manifest["workspaces"]))
        self.assertEqual([], manifest["omitted"])
        for workspace in ["demo", "second"]:
            self.assertTrue(self.data("export.verify", {"directory": str(destination / "workspaces" / workspace)})["verified"])
        self.data("workspace.close", {"workspace_id": "second"})
        rejected = self.call("daemon.export_all", {"destination": str(self.root / "incomplete")})
        self.assertEqual("Workspace_closed", self.kind(rejected))
        partial = self.data("daemon.export_all", {"destination": str(self.root / "partial"), "allow_partial": True})
        self.assertEqual(["second"], partial["omitted"])
        self.assertEqual("completed", self.wait_export(partial["job_id"])["status"])
        self.assertFalse(json.loads((self.root / "partial/manifest.json").read_text())["complete"])
        self.daemon.stop(kill=True)
        registry = self.root / "registry/registry.json"
        saved = json.loads(registry.read_text())
        saved["exports"][partial["job_id"]]["status"] = "running"
        registry.write_text(json.dumps(saved))
        self.daemon.start()
        self.assertEqual("completed", self.data("export.get", {"job_id": partial["job_id"]})["status"])

    def test_full_export_manifest_verification_and_rejections(self):
        self.ticket()
        root = self.root / "verified-export"
        manifest = self.export({"workspace_id": "demo", "destination": str(root)})
        self.assertEqual("1", manifest["version"])
        self.assertEqual(json.loads((root / "portable/HEAD.json").read_text())["digest"], manifest["head"])
        verified = self.data("export.verify", {"directory": str(root)})
        self.assertTrue(verified["verified"])
        self.assertEqual("1", verified["revision"])
        for change in ["extra", "checksum", "symlink", "traversal", "partial", "head"]:
            copy = self.root / ("bad-export-" + change)
            shutil.copytree(root, copy)
            changed = json.loads((copy / "manifest.json").read_text())
            if change == "extra":
                (copy / "unlisted").write_text("not listed")
            elif change == "checksum":
                (copy / "tickets/a.md").write_text("changed")
            elif change == "symlink":
                (copy / "tickets/a.md").unlink()
                (copy / "tickets/a.md").symlink_to(root / "tickets/a.md")
            elif change == "traversal":
                changed["files"]["../escape"] = "0" * 64
            elif change == "partial":
                changed["complete"] = False
            else:
                changed["head"] = "0" * 64
            (copy / "manifest.json").write_text(json.dumps(changed))
            result = self.call("export.verify", {"directory": str(copy)})
            self.assertEqual("Corrupt_store", self.kind(result), (change, result))
        self.assertFalse((self.root / "escape").exists())

        for change in ["unknown-field", "missing-field", "unsupported-version", "legacy-schema"]:
            copy = self.root / ("bad-manifest-schema-" + change)
            shutil.copytree(root, copy)
            changed = json.loads((copy / "manifest.json").read_text())
            if change == "unknown-field":
                changed["legacy_adapter"] = True
                expected_kind = "Invalid_argument"
            elif change == "missing-field":
                changed.pop("options")
                expected_kind = "Invalid_argument"
            elif change == "unsupported-version":
                changed["version"] = "2"
                expected_kind = "Unsupported_version"
            else:
                changed.pop("head")
                changed.pop("options")
                expected_kind = "Invalid_argument"
            (copy / "manifest.json").write_text(json.dumps(changed))
            result = self.call("export.verify", {"directory": str(copy)})
            self.assertEqual(expected_kind, self.kind(result), (change, result))

    def test_export_verifier_streams_projections_over_resource_limit(self):
        root = self.root / "large-export"
        manifest = self.export({"workspace_id": "demo", "destination": str(root)})
        projection = root / "large-audit.bin"
        with projection.open("wb") as file:
            file.truncate(65 * 1024 * 1024)
        digest = hashlib.sha256()
        with projection.open("rb") as file:
            while block := file.read(256 * 1024):
                digest.update(block)
        manifest["files"][projection.name] = digest.hexdigest()
        (root / "manifest.json").write_text(json.dumps(manifest))
        self.assertTrue(self.data("export.verify", {"directory": str(root)})["verified"])

    def test_closed_intent_and_locking(self):
        second_root = self.root / "second"
        second_root.mkdir()
        second = Daemon(second_root, Path(self.sockets.name) / "s2")
        self.addCleanup(second.stop)
        second.start()
        result = request(second.address, "workspace.register", {"root": str(self.root / "workspace")})
        self.assertEqual("Conflict", self.kind(result))
        self.data("workspace.close", {"workspace_id": "demo"})
        self.daemon.stop()
        self.assertEqual(0, self.daemon.process.returncode, (self.root / "daemon.log").read_text())
        self.daemon.start()
        self.assertEqual("Workspace_closed", self.kind(self.call("workspace.overview", {"workspace_id": "demo"})))
        self.data("workspace.open", {"workspace_id": "demo"})

    def test_admin_receipts_move_unregister_and_retry(self):
        params = {"workspace_id": "demo", "actor_id": "operator", "mutation_id": "close-once"}
        closed = self.ok("workspace.close", params)
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(closed, self.ok("workspace.close", params))
        changed = self.call("workspace.open", params)
        self.assertEqual("Idempotency_conflict", self.kind(changed))
        receipt = self.data("registry.receipt", {"actor_id": "operator", "mutation_id": "close-once"})
        self.assertEqual("committed", receipt["status"])
        self.assertEqual(closed, receipt["response"])
        old = self.root / "workspace"
        moved = self.root / "moved"
        copied = self.root / "copy"
        shutil.copytree(old, copied, ignore=shutil.ignore_patterns(".local"))
        self.assertEqual("Conflict", self.kind(self.call("workspace.register", {"root": str(copied)})))
        old.rename(moved)
        registration = {"root": str(moved), "actor_id": "operator", "mutation_id": "move-once"}
        self.assertEqual({"workspace_id": "demo"}, self.data("workspace.register", registration))
        self.assertEqual(str(moved), self.data("workspace.list", {})["workspaces"][0]["root"])
        unregister = {"workspace_id": "demo", "actor_id": "operator", "mutation_id": "unregister-once"}
        response = self.data("workspace.unregister", unregister)
        self.assertTrue((moved / "HEAD.json").is_file())
        self.assertEqual([], self.data("workspace.list", {})["workspaces"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(response, self.data("workspace.unregister", unregister))
        # An old receipt reports the old result; it never repeats a side effect.
        self.assertEqual({"workspace_id": "demo"}, self.data("workspace.register", registration))
        self.assertEqual([], self.data("workspace.list", {})["workspaces"])
        self.data("workspace.register", {"root": str(moved)})
        self.assertEqual("demo", self.data("workspace.list", {})["workspaces"][0]["workspace_id"])

    def test_workspace_rename_archive_history_and_restart(self):
        self.ticket()
        claim = self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "1"})["result"]["data"]
        self.assertEqual("Conflict", self.kind(self.mutation("workspace.archive", {"expected_revision": "0", "archived": True})))
        self.assertIn("result", self.mutation("ticket.release", {"ticket_id": "a", "token": claim["token"]}))
        self.assertIn("result", self.mutation("workspace.update", {"expected_revision": "0", "name": "Renamed", "instructions": "Keep receipts"}))
        self.assertIn("result", self.mutation("workspace.archive", {"expected_revision": "1", "archived": True}))
        before = self.ok("workspace.get", {"workspace_id": "demo"})
        self.assertEqual("Renamed", before["data"]["name"])
        self.assertEqual("Keep receipts", before["data"]["settings"]["instructions"])
        self.assertTrue(before["data"]["settings"]["archived"])
        self.assertEqual([], self.ok("ticket.ready", {"workspace_id": "demo"})["data"]["items"])
        self.assertTrue(self.data("workspace.list", {})["workspaces"][0]["archived"])
        self.assertEqual("a", self.context()["data"]["ticket"]["ticket_id"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(before, self.ok("workspace.get", {"workspace_id": "demo"}))
        self.assertIn("result", self.mutation("workspace.archive", {"expected_revision": "2", "archived": False}))
        self.assertFalse(self.ok("workspace.get", {"workspace_id": "demo"})["data"]["settings"]["archived"])
        self.assertEqual("Invalid_argument", self.kind(self.mutation("workspace.update", {"expected_revision": "3", "name": " "})))
        self.assertEqual("Conflict", self.kind(self.mutation("workspace.archive", {"expected_revision": "2", "archived": True})))

    def test_typed_client_end_to_end(self):
        result = subprocess.run([str(CLIENT_EXE), str(self.daemon.address), str(self.root / "sdk")], capture_output=True, text=True, timeout=10)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("typed workflow passed\n", result.stdout)
        self.daemon.stop(kill=True)
        self.daemon.start()
        result = subprocess.run([str(CLIENT_EXE), str(self.daemon.address), str(self.root / "sdk")], capture_output=True, text=True, timeout=10)
        self.assertEqual(0, result.returncode, result.stderr)

    def cli(self, *args):
        return subprocess.run([str(EXE), *map(str, args)], capture_output=True, text=True, timeout=10)

    def test_cli_named_fields_files_saved_retry_and_text(self):
        saved = self.root / "create-ticket.request.json"
        body = self.root / "description.txt"
        body.write_text("Description from file\nwith another line")
        result = self.cli("ticket", "create", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--ticket-id", "cli-ticket", "--title", "CLI ticket", "--field-file", "description", body, "--save-request", saved)
        self.assertEqual(0, result.returncode, result.stderr)
        response = json.loads(result.stdout)
        retry = json.loads(saved.read_text())
        self.assertEqual(64, len(retry["params"]["mutation_id"]))
        self.assertEqual("Description from file\nwith another line", self.context("cli-ticket")["data"]["ticket"]["description"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        repeated = self.cli("retry", self.daemon.address, saved)
        self.assertEqual(0, repeated.returncode, repeated.stderr)
        self.assertEqual(response, json.loads(repeated.stdout))
        text = self.cli("workspace", "get", self.daemon.address, "--workspace-id", "demo", "--output", "text")
        self.assertEqual(0, text.returncode, text.stderr)
        self.assertIn("name: Demo", text.stdout)
        duplicate = self.cli("ticket", "create", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--ticket-id", "other", "--title", "Other", "--save-request", saved)
        self.assertNotEqual(0, duplicate.returncode)
        self.assertEqual(retry, json.loads(saved.read_text()))
        invalid = self.cli("retry", self.daemon.address, saved, "--title", "Changed")
        self.assertNotEqual(0, invalid.returncode)
        self.assertEqual("Invalid_argument", json.loads(invalid.stderr.splitlines()[-1])["kind"])
        missing_id = self.cli("ticket", "create", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--ticket-id", "other", "--title", "Other")
        self.assertNotEqual(0, missing_id.returncode)
        self.assertEqual("Invalid_argument", json.loads(missing_id.stderr.splitlines()[-1])["kind"])

    def test_complete_shell_workflow_replays_after_restart(self):
        source = self.root / "research.txt"
        source.write_text("Persistent research")
        args = ["sh", str(Path("../examples/agent-workflow.sh").resolve()), str(EXE), str(self.daemon.address), str(self.root / "workflow"), str(self.root / "local-notes"), str(source)]
        first = subprocess.run(args, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, first.returncode, first.stderr)
        before = request(self.daemon.address, "ticket.context", {"workspace_id": "workflow-demo", "ticket_id": "research"})
        self.daemon.stop(kill=True)
        self.daemon.start()
        second = subprocess.run(args, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, second.returncode, second.stderr)
        after = request(self.daemon.address, "ticket.context", {"workspace_id": "workflow-demo", "ticket_id": "research"})
        self.assertEqual(before, after)

    @unittest.skipUnless(shutil.which("jq"), "coordination shell example requires jq")
    def test_coordination_shell_workflow_retains_claim_and_replays_after_restart(self):
        self.assertIn("result", self.mutation("project.create", {"project_id": "project", "title": "Project"}))
        self.ticket("work", project_id="project")
        notes = self.root / "coordination-notes"
        args = ["sh", str(Path("../examples/coordination-workflow.sh").resolve()),
                str(EXE), str(self.daemon.address), "demo", "project", "worker", "reviewer", str(notes)]
        first = subprocess.run(args, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, first.returncode, first.stderr)
        claim = json.loads((notes / "claim-next.response.json").read_text())["result"]["data"]
        self.assertEqual("selected", claim["kind"])
        self.assertEqual("work", claim["claim"]["ticket_id"])
        before = self.context("work")
        self.daemon.stop(kill=True)
        self.daemon.start()
        second = subprocess.run(args, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, second.returncode, second.stderr)
        self.assertEqual(before, self.context("work"))
        self.assertEqual(claim, json.loads((notes / "claim-next.response.json").read_text())["result"]["data"])

    def test_cli_null_device_output_and_diagnostic(self):
        version = subprocess.run([str(EXE), "--version"], stdout=subprocess.DEVNULL,
                                 capture_output=False, stderr=subprocess.PIPE, text=True, timeout=10)
        self.assertEqual(0, version.returncode, version.stderr)
        invalid = subprocess.run([str(EXE), "request"], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, timeout=10)
        self.assertEqual(1, invalid.returncode, invalid.stdout)

        # Daemon diagnostics use the same adapter: a failed advisory heartbeat
        # flush must not crash workspace.close when stderr is a null device.
        address = Path(self.sockets.name) / "null"
        workspace = self.root / "null-workspace"
        daemon = subprocess.Popen([str(EXE), "serve", str(self.root / "null-registry"), str(address)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while not address.exists():
                self.assertIsNone(daemon.poll())
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            def call(method, **params):
                response = request(address, method, params)
                self.assertIn("result", response, response)
                return response["result"]["data"]
            call("workspace.create", workspace_id="null", name="Null output", root=str(workspace))
            for run in ["first", "second"]:
                call("run.register", workspace_id="null", actor_id="worker", mutation_id=run,
                     target_run_id=run, objective="Check daemon diagnostics", capabilities=[])
                heartbeat = call("run.heartbeat", workspace_id="null", actor_id="worker", target_run_id=run)
            self.assertFalse(heartbeat["durable"])
            cache = workspace / ".local" / "heartbeats.json"
            cache.unlink()
            cache.mkdir()
            self.assertTrue(call("workspace.close", workspace_id="null")["closed"])
            call("daemon.health")
        finally:
            daemon.terminate()
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
                raise
        self.assertEqual(0, daemon.returncode)

    def test_cli_binary_transfer_saved_retry_versions_and_fresh_destination(self):
        source = self.root / "binary.data"
        content = bytes(range(256)) * 4097
        source.write_bytes(content)
        saved = self.root / "upload.request.json"
        uploaded = self.cli("resource", "upload", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--resource-id", "binary", "--expected-revision", "0", "--title", "Binary data", "--file", source, "--save-request", saved)
        self.assertEqual(0, uploaded.returncode, uploaded.stderr)
        first = json.loads(uploaded.stdout)
        plan = json.loads(saved.read_text())
        self.assertEqual({"jsonrpc", "id", "method", "params"}, set(plan))
        self.assertEqual("resource.upload", plan["method"])
        self.assertEqual("2.0", plan["jsonrpc"])
        self.assertEqual(hashlib.sha256(content).hexdigest(), plan["params"]["digest"])
        self.assertEqual(str(len(content)), plan["params"]["size_bytes"])
        source.unlink()
        self.daemon.stop(kill=True)
        self.daemon.start()
        retried = self.cli("retry", self.daemon.address, saved)
        self.assertEqual(0, retried.returncode, retried.stderr)
        self.assertEqual(first, json.loads(retried.stdout))
        # New binary version; old version remains independently downloadable.
        source.write_bytes(b"new version")
        updated = self.cli("resource", "upload", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--resource-id", "binary", "--expected-revision", "1", "--title", "New", "--file", source, "--mutation-id", "binary-v2")
        self.assertEqual(0, updated.returncode, updated.stderr)
        destination = self.root / "downloaded.data"
        downloaded = self.cli("resource", "download", self.daemon.address, "--workspace-id", "demo", "--resource-id", "binary", "--version", "1", "--destination", destination)
        self.assertEqual(0, downloaded.returncode, downloaded.stderr)
        self.assertEqual(content, destination.read_bytes())
        self.assertEqual("1", json.loads(downloaded.stdout)["result"]["data"]["version"])
        again = self.cli("resource", "download", self.daemon.address, "--workspace-id", "demo", "--resource-id", "binary", "--destination", destination)
        self.assertNotEqual(0, again.returncode)
        self.assertEqual("Conflict", json.loads(again.stderr.splitlines()[-1])["kind"])
        self.assertEqual(content, destination.read_bytes())
        self.assertEqual([], list(self.root.glob("*.downloading-*")))
        # Reusing a committed mutation with different bytes cannot report success.
        conflict = self.cli("resource", "upload", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--resource-id", "binary", "--expected-revision", "0", "--title", "Binary data", "--file", source, "--mutation-id", plan["params"]["mutation_id"])
        self.assertEqual("Idempotency_conflict", json.loads(conflict.stderr.splitlines()[-1])["kind"])

    def test_cli_upload_retry_before_connect_and_changed_source(self):
        source = self.root / "source"
        source.write_bytes(b"original")
        saved = self.root / "pending-upload.json"
        unavailable = Path(self.sockets.name) / "unavailable"
        result = self.cli("resource", "upload", unavailable, "--workspace-id", "demo", "--actor-id", "agent", "--resource-id", "retry-file", "--expected-revision", "0", "--title", "Retry file", "--file", source, "--save-request", saved)
        self.assertNotEqual(0, result.returncode)
        self.assertTrue(saved.is_file())
        source.write_bytes(b"changed")
        rejected = self.cli("retry", self.daemon.address, saved)
        self.assertEqual("Conflict", json.loads(rejected.stderr.splitlines()[-1])["kind"])
        self.assertEqual([], self.ok("resource.list", {"workspace_id": "demo"})["data"]["items"])
        source.write_bytes(b"original")
        accepted = self.cli("retry", self.daemon.address, saved)
        self.assertEqual(0, accepted.returncode, accepted.stderr)
        # Empty files also publish and download with complete digest validation.
        source.write_bytes(b"")
        empty = self.cli("resource", "upload", self.daemon.address, "--workspace-id", "demo", "--actor-id", "agent", "--resource-id", "empty", "--expected-revision", "0", "--title", "Empty", "--file", source, "--mutation-id", "empty")
        self.assertEqual(0, empty.returncode, empty.stderr)
        destination = self.root / "empty-download"
        empty_download = self.cli("resource", "download", self.daemon.address, "--workspace-id", "demo", "--resource-id", "empty", "--destination", destination)
        self.assertEqual(0, empty_download.returncode, empty_download.stderr)
        self.assertEqual(b"", destination.read_bytes())

    def test_cli_upload_resumes_lost_chunk_ack_with_and_without_restart(self):
        source = self.root / "large-source"
        content = bytes(range(256)) * 3001
        source.write_bytes(content)
        for restart in [False, True]:
            address = Path(self.sockets.name) / ("proxy-" + str(restart))
            captured = []
            failures = []
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(address))
                server.listen(1)
                server.settimeout(3)
                def proxy():
                    try:
                        while True:
                            flow, _ = server.accept()
                            with flow:
                                incoming = read_frame(flow)
                                result = request(self.daemon.address, incoming["method"], incoming["params"], incoming["id"])
                                captured.append(incoming)
                                if incoming["method"] == "upload.chunk":
                                    self.assertIn("result", result)
                                    return  # Bytes accepted; acknowledgement lost.
                                write_frame(flow, result)
                    except Exception as error:
                        failures.append(error)
                thread = threading.Thread(target=proxy, daemon=True)
                thread.start()
                saved = self.root / ("resume-" + str(restart) + ".json")
                failed = self.cli("resource", "upload", address, "--workspace-id", "demo", "--actor-id", "agent", "--resource-id", "resume-" + str(restart), "--expected-revision", "0", "--title", "Resume", "--file", source, "--save-request", saved)
                thread.join(timeout=4)
                self.assertFalse(thread.is_alive())
                self.assertEqual([], failures)
                self.assertEqual("Outcome_unknown", json.loads(failed.stderr.splitlines()[-1])["kind"])
                self.assertEqual("upload.chunk", captured[-1]["method"])
            if restart:
                self.daemon.stop(kill=True)
                self.daemon.start()
            resumed = self.cli("retry", self.daemon.address, saved)
            self.assertEqual(0, resumed.returncode, resumed.stderr)
            destination = self.root / ("resumed-" + str(restart))
            downloaded = self.cli("resource", "download", self.daemon.address, "--workspace-id", "demo", "--resource-id", "resume-" + str(restart), "--destination", destination)
            self.assertEqual(0, downloaded.returncode, downloaded.stderr)
            self.assertEqual(content, destination.read_bytes())

    def test_cli_download_rejects_corruption_and_destination_race(self):
        for mode in ["bad-chunk", "bad-whole", "raced-destination"]:
            address = Path(self.sockets.name) / mode
            destination = self.root / mode
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(address))
                server.listen(1)
                server.settimeout(3)
                def respond():
                    flow, _ = server.accept()
                    with flow:
                        incoming = read_frame(flow)
                        data = b"complete"
                        checksum = hashlib.sha256(data).hexdigest()
                        result = {"resource_id": "r", "version": "1", "offset": "0", "size_bytes": str(len(data)), "digest": "0" * 64 if mode == "bad-whole" else checksum, "data_base64": base64.b64encode(data).decode(), "chunk_digest": "0" * 64 if mode == "bad-chunk" else checksum, "eof": True, "next_offset": None}
                        if mode == "raced-destination":
                            destination.write_bytes(b"keep existing")
                        write_frame(flow, {"jsonrpc": "2.0", "id": incoming["id"], "result": {"data": result, "meta": {}}})
                thread = threading.Thread(target=respond, daemon=True)
                thread.start()
                result = self.cli("resource", "download", address, "--workspace-id", "demo", "--resource-id", "r", "--destination", destination)
                thread.join(timeout=4)
                self.assertFalse(thread.is_alive())
                self.assertNotEqual(0, result.returncode)
                if mode == "raced-destination":
                    self.assertEqual("Conflict", json.loads(result.stderr.splitlines()[-1])["kind"])
                    self.assertEqual(b"keep existing", destination.read_bytes())
                else:
                    self.assertEqual("Corrupt_store", json.loads(result.stderr.splitlines()[-1])["kind"])
                    self.assertFalse(destination.exists())
                self.assertEqual([], list(self.root.glob("*.downloading-*")))

    def test_cli_timeout_and_response_identity_do_not_retry_writes(self):
        for mode in ["timeout", "wrong-id", "eof", "missing-meta", "bad-meta", "missing-durable"]:
            address = Path(self.sockets.name) / ("fake-" + mode)
            captured = []
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(address))
                server.listen(1)
                def handle():
                    flow, _ = server.accept()
                    with flow:
                        header = flow.recv(4)
                        length = struct.unpack(">I", header)[0]
                        body = b""
                        while len(body) < length:
                            body += flow.recv(length - len(body))
                        captured.append(json.loads(body))
                        if mode == "timeout":
                            time.sleep(0.25)
                        elif mode in {"wrong-id", "missing-meta", "bad-meta", "missing-durable"}:
                            response_id = "someone-else" if mode == "wrong-id" else captured[0]["id"]
                            result = {"data": {}} if mode != "bad-meta" else {"data": {}, "meta": None}
                            if mode == "missing-durable":
                                result = {"data": {}, "meta": {}}
                            response = json.dumps({"jsonrpc": "2.0", "id": response_id, "result": result}).encode()
                            flow.sendall(struct.pack(">I", len(response)) + response)
                thread = threading.Thread(target=handle)
                thread.start()
                saved = self.root / (mode + ".request.json")
                result = self.cli("ticket", "create", address, "--workspace-id", "demo", "--actor-id", "agent", "--ticket-id", "a", "--title", "A", "--save-request", saved, "--timeout", "0.05")
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
                self.assertEqual(1, len(captured))
                self.assertEqual(captured[0], json.loads(saved.read_text()))
                self.assertNotEqual(0, result.returncode)
                self.assertEqual("Outcome_unknown", json.loads(result.stderr.splitlines()[-1])["kind"])
                self.assertEqual("", result.stdout)

    def test_api_shutdown_drains_and_restarts(self):
        self.ticket()
        self.assertEqual({"stopping": True}, self.data("daemon.shutdown", {}))
        self.daemon.process.wait(timeout=10)
        self.assertEqual(0, self.daemon.process.returncode)
        self.assertFalse(self.daemon.address.exists())
        self.daemon.stop()
        self.daemon.start()
        self.assertEqual("a", self.context()["data"]["ticket"]["ticket_id"])

    def test_registry_external_edit_fences_all_mutations(self):
        registry_file = self.root / "registry/registry.json"
        original = registry_file.read_bytes()
        registry_file.write_bytes(original + b" ")
        params = {"workspace_id": "demo", "actor_id": "operator", "mutation_id": "fenced-close"}
        self.assertEqual("Outcome_unknown", self.kind(self.call("workspace.close", params)))
        self.assertTrue(self.data("daemon.health", {})["registry_requires_restart"])
        self.assertEqual("Outcome_unknown", self.kind(self.mutation("ticket.create", {"ticket_id": "a", "title": "Must not publish"})))
        self.assertEqual("Outcome_unknown", self.kind(self.call("registry.receipt", {"actor_id": "operator", "mutation_id": "fenced-close"})))
        registry_file.write_bytes(original)
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertFalse(self.data("daemon.health", {})["registry_requires_restart"])
        self.assertEqual("absent", self.data("registry.receipt", {"actor_id": "operator", "mutation_id": "fenced-close"})["status"])
        self.data("workspace.close", params)

    def test_workspace_receipts_and_admin_input_validation(self):
        response = self.mutation("ticket.create", {"ticket_id": "a", "title": "A"}, mutation="inspect-receipt")["result"]
        lookup = {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "inspect-receipt"}
        self.assertEqual(response, self.data("workspace.receipt", lookup)["response"])
        self.assertEqual("absent", self.data("workspace.receipt", {**lookup, "mutation_id": "absent"})["status"])
        self.assertEqual("Invalid_argument", self.kind(self.call("workspace.close", {"workspace_id": "demo", "unknown": True})))
        self.assertEqual("Conflict", self.kind(self.call("workspace.create", {"workspace_id": "another", "name": "Other", "root": str(self.root / "workspace")})))
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(response, self.data("workspace.receipt", lookup)["response"])

    def test_pending_create_retry_after_storage_failure(self):
        root = self.root / "missing-parent" / "retry"
        params = {"root": str(root), "workspace_id": "retry", "name": "Retry", "actor_id": "operator", "mutation_id": "retry-create"}
        self.assertEqual("Storage_unavailable", self.kind(self.call("workspace.create", params)))
        lookup = {"actor_id": "operator", "mutation_id": "retry-create"}
        self.assertEqual("pending", self.data("registry.receipt", lookup)["status"])
        self.assertEqual("Idempotency_conflict", self.kind(self.call("workspace.create", {**params, "name": "Changed"})))
        self.assertEqual("Conflict", self.kind(self.call("workspace.create", {**params, "mutation_id": "other"})))
        self.daemon.stop(kill=True)
        root.parent.mkdir()
        self.daemon.start()
        self.assertEqual({"workspace_id": "retry"}, self.data("workspace.create", params))
        self.assertEqual("committed", self.data("registry.receipt", lookup)["status"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual({"workspace_id": "retry"}, self.data("workspace.create", params))

    def test_create_recovery_at_staged_and_installed_cut_points(self):
        params = {"root": str(self.root / "cut"), "workspace_id": "cut", "name": "Cut", "actor_id": "operator", "mutation_id": "cut-create"}
        self.data("workspace.create", params)
        self.daemon.stop(kill=True)
        registry_file = self.root / "registry/registry.json"
        saved = json.loads(registry_file.read_text())
        receipt = saved["receipts"].pop("operator:cut-create")
        saved["workspaces"].pop("cut")
        token = json.loads((self.root / "cut/.local/creation.json").read_text())["token"]
        saved["creates"]["operator:cut-create"] = {"request_hash": receipt["request_hash"], "root": params["root"], "workspace_id": "cut", "name": "Cut", "token": token}
        # Durable intent + installed directory, before registry publication.
        registry_file.write_text(json.dumps(saved))
        self.daemon.start()
        self.assertEqual({"workspace_id": "cut"}, self.data("workspace.create", params))
        self.daemon.stop(kill=True)
        # Durable intent + interrupted stage, before installation.
        registry_file.write_text(json.dumps(saved))
        stage = self.root / ("cut.initializing-" + token)
        (self.root / "cut").rename(stage)
        (stage / "HEAD.json").write_text("partial")
        (stage / ".local/creation.json").unlink()
        self.daemon.start()
        self.assertEqual({"workspace_id": "cut"}, self.data("workspace.create", params))
        self.assertEqual("0", json.loads((self.root / "cut/HEAD.json").read_text())["sequence"])
        self.assertFalse(stage.exists())

    def test_corruption_is_quarantined(self):
        self.ticket()
        self.daemon.stop(kill=True)
        transaction = next((self.root / "workspace/transactions").glob("*.json"))
        transaction.write_text("corrupt")
        self.daemon.start()
        health = self.data("daemon.health", {})
        self.assertFalse(health["workspaces"][0]["open"])
        self.assertEqual("Corrupt_store", health["workspaces"][0]["error"]["kind"])

    def test_recovery_rejects_rehashed_receipts_and_future_event_shapes(self):
        self.ticket()
        before = self.context()
        self.daemon.stop()
        directory = self.root / "workspace/transactions"
        original = next(directory.glob("*.json"))
        transaction = json.loads(original.read_bytes())
        head_file = self.root / "workspace/HEAD.json"
        original_head = head_file.read_bytes()
        variants = [
            {**transaction, "key": "other:create"},
            {**transaction, "response": {**transaction["response"], "workspace_revision": "2"}},
            {**transaction, "response": {**transaction["response"], "durable": False}},
            {**transaction, "events": {**transaction["events"], "changes": [["Future_event", {}]]}},
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                raw = json.dumps(variant, sort_keys=True, separators=(",", ":")).encode()
                digest = hashlib.sha256(raw).hexdigest()
                forged = directory / ("000000000001-" + digest + ".json")
                forged.write_bytes(raw)
                head_file.write_text(json.dumps({"version": "1", "sequence": "1", "digest": digest}))
                self.daemon.start()
                health = self.data("daemon.health", {})["workspaces"][0]
                self.assertFalse(health["open"])
                self.assertEqual("Corrupt_store", health["error"]["kind"])
                self.daemon.stop()
                forged.unlink()
        head_file.write_bytes(original_head)
        self.daemon.start()
        self.assertEqual(before, self.context())

    def test_orphans_are_not_commits(self):
        self.ticket()
        before = self.context()
        self.daemon.stop(kill=True)
        (self.root / "workspace/transactions/999999999999-orphan.json").write_text("incomplete")
        self.daemon.start()
        self.assertEqual(before, self.context())

    def test_external_head_edit_fences_writes(self):
        self.ticket()
        head = self.root / "workspace/HEAD.json"
        original = head.read_bytes()
        head.write_bytes(original + b" ")
        self.assertEqual("Conflict", self.kind(self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "must fail"})))
        head.write_bytes(original)
        self.assertEqual("Outcome_unknown", self.kind(self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "still fenced"})))
        self.data("workspace.close", {"workspace_id": "demo"})
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertIn("result", self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "recovered"}))

    def test_cli_heartbeat_and_coordinator_query(self):
        self.assertIn("result", self.mutation("run.register", {
            "target_run_id": "runner", "objective": "Check advisory liveness", "capabilities": []}))
        params = {"workspace_id": "demo", "actor_id": "agent", "target_run_id": "runner"}
        direct = self.data("run.heartbeat", params)
        cli = subprocess.run([str(EXE), "call", str(self.daemon.address),
                              "run.heartbeat", json.dumps(params)],
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(0, cli.returncode, cli.stderr)
        self.assertTrue(direct["advisory"])
        self.assertTrue(json.loads(cli.stdout)["result"]["data"]["advisory"])
        self.assertEqual("runner", json.loads(cli.stdout)["result"]["data"]["target_run_id"])
        self.assertEqual("runner", self.data("run.heartbeat_get", {
            "workspace_id": "demo", "target_run_id": "runner"})["target_run_id"])
        self.assertEqual("Invalid_argument", self.kind(self.call("run.heartbeat", {
            **params, "mutation_id": "not-a-transaction"})))
        self.assertEqual("Invalid_argument", self.kind(self.call("run.heartbeat", {
            "workspace_id": "demo", "actor_id": "agent", "run_id": "runner"})))
        self.ticket()
        overview = self.data("coordinator.overview", {"workspace_id": "demo"})
        ready = [item for item in overview["items"] if item["kind"] == "ready_work"]
        self.assertEqual(["a"], [item["source"]["ticket_id"] for item in ready])
        invalid = self.call("coordinator.overview", {"workspace_id": "demo", "surprise": True})
        self.assertEqual("Invalid_argument", self.kind(invalid))

    def test_completion_evidence_is_immutable_and_corrections_are_linked(self):
        self.ticket()
        claim = self.mutation("ticket.claim", {"ticket_id": "a", "expected_revision": "1"})
        token = claim["result"]["data"]["token"]
        self.assertIn("result", self.mutation("ticket.complete", {
            "ticket_id": "a", "token": token, "evidence": "Original completion"}))
        comments = self.ok("comment.list", {"workspace_id": "demo", "target": {"kind": "ticket", "id": "a"}})["data"]["items"]
        original = comments[0]
        self.assertEqual("completion", original["origin"])
        for actor in ["agent", "other"]:
            for method, extra in [("comment.edit", {"body": "replacement"}), ("comment.tombstone", {})]:
                response = self.mutation(method, {"comment_id": original["comment_id"],
                                                  "expected_revision": "1", **extra}, actor=actor)
                self.assertEqual("Conflict", self.kind(response))
        self.assertIn("result", self.mutation("comment.add", {
            "target": {"kind": "ticket", "id": "a"}, "comment_id": "correction", "reply_to_id": original["comment_id"],
            "kind": "evidence", "body": "Correction: command checked only one platform"}, actor="other"))
        self.assertEqual("Conflict", self.kind(self.mutation("comment.edit", {
            "comment_id": "correction", "expected_revision": "1", "body": "not my note"})))
        self.daemon.stop(kill=True)
        self.daemon.start()
        comments = self.ok("comment.list", {"workspace_id": "demo", "target": {"kind": "ticket", "id": "a"}})["data"]["items"]
        self.assertEqual(original, next(item for item in comments if item["comment_id"] == original["comment_id"]))
        correction = next(item for item in comments if item["comment_id"] == "correction")
        self.assertEqual(original["comment_id"], correction["reply_to_comment_id"])
        self.assertEqual("authored", correction["origin"])

    def test_protocol_limits_and_permissions(self):
        self.assertEqual(0o600, stat.S_IMODE(self.daemon.address.stat().st_mode))
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3)
            client.connect(str(self.daemon.address))
            client.sendall(struct.pack(">I", 0xFFFFFFFF))
            self.assertTrue(client.recv(4096))
        self.assertIn("name", self.data("initialize", {}))
        result = subprocess.run([str(EXE), "call", str(self.daemon.address), "workspace.overview", '{"workspace_id":"demo"}'], capture_output=True, text=True, timeout=10)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("result", json.loads(result.stdout))

    def test_partial_frames_notifications_and_slow_readers_do_not_block_commits(self):
        self.ticket()
        operations = [{"method": "comment.add", "params": {"target": {"kind": "ticket", "id": "a"}, "body": "x" * 60000}} for _ in range(24)]
        self.assertIn("result", self.mutation("transaction.apply", {"operations": operations}))
        readers = []
        try:
            # Incomplete header and body stay in separate bounded reader fibers.
            for wire in [b"\x00\x00", struct.pack(">I", 100) + b"{"]:
                reader = socket.socket(socket.AF_UNIX)
                reader.connect(str(self.daemon.address))
                reader.sendall(wire)
                readers.append(reader)
            # Large bounded output with a tiny receive buffer. Never drain it;
            # dispatcher progress and graceful shutdown must remain independent.
            reader = socket.socket(socket.AF_UNIX)
            reader.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            reader.connect(str(self.daemon.address))
            write_frame(reader, {"jsonrpc": "2.0", "id": "slow", "method": "comment.list", "params": {"workspace_id": "demo", "max_bytes": "1048576"}})
            readers.append(reader)
            with socket.socket(socket.AF_UNIX) as notification:
                notification.settimeout(3)
                notification.connect(str(self.daemon.address))
                write_frame(notification, {"jsonrpc": "2.0", "method": "ticket.create", "params": {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "notification", "ticket_id": "ignored", "title": "Ignored"}})
                self.assertEqual(b"", notification.recv(1))
            committed = self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "While peers stall"}, mutation="unblocked")
            self.assertIn("result", committed)
            self.assertEqual("absent", self.data("workspace.receipt", {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "notification"})["status"])
            self.data("daemon.shutdown", {})
            self.daemon.process.wait(timeout=5)
            self.assertEqual(0, self.daemon.process.returncode)
        finally:
            for reader in readers:
                reader.close()
        self.daemon.stop()
        self.daemon.start()
        self.assertEqual(committed["result"], self.ok("comment.add", {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "unblocked", "target": {"kind": "ticket", "id": "a"}, "body": "While peers stall"}))

    def test_malformed_envelopes_and_frames_leave_workspace_unchanged(self):
        bodies = [b"{", b"[]", b'{"id":"a","id":"b"}', b'{"jsonrpc":"3.0","id":"a","method":"initialize"}', b'{"jsonrpc":"2.0","id":{},"method":"initialize"}', b'{"jsonrpc":"2.0","id":"a","method":"ticket.create","params":[]}']
        bodies.extend([b'{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"bad":"\xff"}}', b'{"jsonrpc":"2.0","id":1e309,"method":"initialize"}'])
        for body in bodies:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(3)
                client.connect(str(self.daemon.address))
                client.sendall(struct.pack(">I", len(body)) + body)
                response = read_frame(client)
                self.assertEqual(-32600, response["error"]["code"])
                self.assertIsNone(response["id"])
        self.assertEqual("0", self.ok("workspace.get", {"workspace_id": "demo"})["meta"]["workspace_revision"])

    def test_disconnect_after_admission_and_retry(self):
        params = {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "lost-reply",
                  "ticket_id": "a", "title": "Persist despite disconnect"}
        payload = json.dumps({"jsonrpc": "2.0", "id": "disconnected", "method": "ticket.create", "params": params}).encode()
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(str(self.daemon.address))
            client.sendall(struct.pack(">I", len(payload)) + payload)
        # Retrying the exact same mutation is safe whether or not the first
        # connection reached admission before it disconnected.
        result = self.ok("ticket.create", params)
        self.assertEqual("1", result["meta"]["workspace_revision"])
        self.daemon.stop(kill=True)
        self.daemon.start()
        self.assertEqual(result, self.ok("ticket.create", params))
        self.assertEqual("1", self.context()["meta"]["workspace_revision"])

    def test_write_failure_preserves_published_state(self):
        self.ticket()
        root = self.root / "workspace"
        (root / "transactions").rename(root / "saved-transactions")
        (root / "transactions").write_text("not a directory")
        failed = self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "must not publish"})
        self.assertEqual("Corrupt_store", self.kind(failed))
        self.assertEqual("1", self.context()["meta"]["workspace_revision"])
        (root / "transactions").unlink()
        (root / "saved-transactions").rename(root / "transactions")
        fenced = self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "still fenced"})
        self.assertEqual("Outcome_unknown", self.kind(fenced))
        self.data("workspace.close", {"workspace_id": "demo"})
        self.data("workspace.open", {"workspace_id": "demo"})
        self.assertIn("result", self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "recovered"}))
        self.assertEqual("2", self.context()["meta"]["workspace_revision"])

    def test_closed_head_divergence_is_rejected(self):
        self.ticket()
        head = self.root / "workspace/HEAD.json"
        earlier = head.read_bytes()
        self.mutation("comment.add", {"target": {"kind": "ticket", "id": "a"}, "body": "new committed head"})
        self.data("workspace.close", {"workspace_id": "demo"})
        head.write_bytes(earlier)
        self.assertEqual("Conflict", self.kind(self.call("workspace.open", {"workspace_id": "demo"})))

    def test_pagination_revision_and_unknown_fields(self):
        self.ticket("a")
        self.ticket("b")
        page = self.ok("ticket.list", {"workspace_id": "demo", "limit": "1"})
        self.assertEqual("1", page["data"]["next_offset"])
        self.ticket("c")
        response = self.call("ticket.list", {"workspace_id": "demo", "offset": "1", "at_revision": page["meta"]["workspace_revision"]})
        self.assertEqual("Conflict", self.kind(response))
        self.assertEqual("Invalid_argument", self.kind(self.call("ticket.list", {"workspace_id": "demo", "limti": "1"})))
        self.assertEqual("Invalid_argument", self.kind(self.call("workspace.register", {"root": "/invalid\x00path"})))
        self.assertEqual("Invalid_argument", self.kind(self.call("workspace.create", {"workspace_id": "invalid", "root": str(self.root / "invalid")})))
        self.assertEqual("Invalid_argument", self.kind(self.call("workspace.export", {"workspace_id": "demo", "destination": []})))
        self.assertIn("name", self.data("initialize", {}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
