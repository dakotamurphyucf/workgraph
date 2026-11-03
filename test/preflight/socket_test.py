"""Preflight uses real preparation and never publishes state or a retry journal."""
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
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("adapter", ROOT / "skills/workgraph/scripts/history-adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class PreflightTest(unittest.TestCase):
    def test_validation_is_read_only_and_apply_rechecks_ownership(self):
        with tempfile.TemporaryDirectory(prefix="wg-preflight-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "socket"
            workspace = root / "workspace"
            registry = root / "registry"
            with (root / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen([str(EXE), "serve", str(registry), str(address)],
                                          stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    client = adapter.Workgraph(address)
                    def call(method, **params):
                        return client.call(method, dict(workspace_id="w", **params))
                    serial = 0
                    def write(method, **params):
                        nonlocal serial
                        serial += 1
                        return call(method, actor_id="agent", mutation_id="m" + str(serial), **params)
                    def disk_snapshot():
                        return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                                for base in [workspace, registry] for p in base.rglob("*") if p.is_file()}
                    write("workspace.create", root=str(workspace), name="Preflight")
                    write("ticket.create", ticket_id="task", title="Task")
                    token = write("ticket.start", ticket_id="task")["data"]["token"]
                    operations = [
                        {"method": "resource.put_text", "params": {"resource_id": "notes", "title": "Notes", "expected_revision": "0", "text": "done\n"}},
                        {"method": "fact.put", "params": {"scope": {"kind": "ticket", "id": "task"}, "key": "result", "expected_revision": "0", "value": {"checked": True}, "references": [{"kind": "resource", "id": "notes"}]}},
                        {"method": "ticket.finish", "params": {"ticket_id": "task", "token": token, "evidence": "Checked"}},
                    ]
                    revision = call("workspace.get")["meta"]["workspace_revision"]
                    before = disk_snapshot()
                    metrics = call("workspace.metrics")
                    preview = call("transaction.preflight", actor_id="agent", at_revision=revision, operations=operations)
                    self.assertEqual(preview["meta"], {"workspace_revision": revision})
                    self.assertEqual(preview["data"]["validation"], "domain_preparation")
                    self.assertEqual(preview["data"]["staged_blob_bytes"], "5")
                    self.assertEqual(preview["data"]["operation_count"], "3")
                    self.assertEqual(preview["data"]["proposed_revision"], str(int(revision) + 1))
                    with self.assertRaises(RuntimeError):
                        call("transaction.preflight", actor_id="other", operations=operations)
                    with self.assertRaises(RuntimeError):
                        call("transaction.preflight", actor_id="agent", at_revision="0", operations=operations)
                    with self.assertRaises(RuntimeError):
                        call("resource.get", resource_id="notes")
                    # Alias expansion generates provisional IDs, but creates no entities.
                    alias_ops = [
                        {"method": "project.create", "as": "p", "params": {"title": "Project"}},
                        {"method": "ticket.create", "params": {"title": "Task", "project_id": "$p"}},
                    ]
                    generated = call("transaction.preflight", actor_id="agent", operations=alias_ops)["data"]["generated_ids"]
                    self.assertEqual([g["kind"] for g in generated], ["project", "ticket"])
                    self.assertEqual(call("project.list")["data"]["items"], [])
                    # CLI reads require explicit simulation attribution and never use the write journal.
                    journal = root / "requests"
                    args = [str(EXE), "request", str(address), "transaction.preflight",
                            "--workspace-id", "w", "--actor-id", "agent",
                            "--json-field", "operations", json.dumps(operations),
                            "--request-directory", str(journal)]
                    cli = subprocess.run(args, capture_output=True, text=True, timeout=10)
                    self.assertEqual(cli.returncode, 0, (cli.stdout, cli.stderr))
                    self.assertNotIn("durable", json.loads(cli.stdout)["result"]["meta"])
                    self.assertFalse(journal.exists())
                    after_metrics = call("workspace.metrics")
                    self.assertEqual(after_metrics["meta"], metrics["meta"])
                    for field in ["planning_commits", "history_commits", "history_head",
                                  "planning_admission", "storage_admission", "reported_usage"]:
                        self.assertEqual(after_metrics["data"][field], metrics["data"][field])
                    self.assertEqual(disk_snapshot(), before)
                    # The same plan must fail if ownership changes after successful preflight.
                    write("ticket.release", ticket_id="task", token=token)
                    with self.assertRaises(RuntimeError):
                        write("transaction.apply", operations=operations)
                    with self.assertRaises(RuntimeError):
                        call("resource.get", resource_id="notes")
                    token = write("ticket.start", ticket_id="task")["data"]["token"]
                    operations[-1]["params"]["token"] = token
                    preview = call("transaction.preflight", actor_id="agent", operations=operations)
                    applied = write("transaction.apply", operations=operations)
                    self.assertTrue(applied["meta"]["durable"])
                    self.assertEqual(applied["meta"]["workspace_revision"], preview["data"]["proposed_revision"])
                    self.assertEqual(call("resource.read", resource_id="notes")["data"]["text"], "done\n")
                    self.assertEqual(call("ticket.context", ticket_id="task")["data"]["ticket"]["status"], "done")
                    client.call("daemon.shutdown", {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
