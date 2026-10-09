"""All nineteen registry/export/restore contracts on a real daemon and replay."""
import hashlib
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()


def rpc(address, method, params):
    value = json.dumps({"jsonrpc": "2.0", "workgraph_api": "0.4", "id": "test", "method": method, "params": params}, separators=(",", ":")).encode()
    with socket.socket(socket.AF_UNIX) as flow:
        flow.settimeout(20)
        flow.connect(str(address))
        flow.sendall(struct.pack(">I", len(value)) + value)
        def exact(count):
            value = b""
            while len(value) < count:
                received = flow.recv(count - len(value))
                if not received:
                    raise EOFError("daemon ended before acknowledgement")
                value += received
            return value
        return json.loads(exact(struct.unpack(">I", exact(4))[0]))


class AdministrationSocketTest(unittest.TestCase):
    def test_complete_contracts_saved_receipts_jobs_and_restore_replay(self):
        names = {"daemon.health", "daemon.export_all", "daemon.restore_all", "workspace.list", "workspace.create",
                 "workspace.register", "workspace.open", "workspace.close", "workspace.unregister", "workspace.receipt",
                 "workspace.export", "workspace.restore", "registry.receipt", "export.get", "export.list", "export.cancel",
                 "export.retry", "export.verify", "restore.cancel"}
        catalog = json.loads(subprocess.check_output([str(EXE), "schema"]))
        descriptors = {m["name"]: m for m in catalog["methods"]}
        self.assertTrue(names <= descriptors.keys())
        covered = set()
        with tempfile.TemporaryDirectory(prefix="wg-admin-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "socket"
            process = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal process
                    process = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    covered.add(method)
                    return rpc(address, method, params)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    result = ok(method, actor_id="operator", mutation_id=mutation, **params)
                    self.assertTrue(result["meta"]["durable"])
                    return result

                def reject(method, kind, **params):
                    response = call(method, **params)
                    self.assertEqual(kind, response.get("error", {}).get("data", {}).get("kind"), response)

                def wait(job):
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        current = ok("export.get", job_id=job["job_id"])["data"]
                        if current["status"] != "running":
                            return current
                        time.sleep(.01)
                    self.fail("background export did not finish")

                def export(method, mutation, **params):
                    initial = write(method, mutation, **params)["data"]
                    final = wait(initial)
                    self.assertEqual(final["status"], "completed", final)
                    self.assertEqual(final["captures"], initial["captures"])
                    return initial

                try:
                    start()
                    creation = dict(workspace_id="work", name="Work", root=str(root / "workspace"))
                    created = write("workspace.create", "create", **creation)
                    self.assertEqual(created["data"], {"workspace_id": "work"})
                    other = write("workspace.create", "create-generated", name="Other", root=str(root / "other"))["data"]["workspace_id"]
                    self.assertEqual(ok("registry.receipt", actor_id="operator", mutation_id="create")["data"]["response"], created)
                    self.assertEqual(ok("registry.receipt", actor_id="operator", mutation_id="absent")["data"], {"status": "absent"})
                    ticket = write("ticket.create", "ticket", workspace_id="work", ticket_id="task", title="Task")
                    planning = ok("workspace.receipt", workspace_id="work", actor_id="operator", mutation_id="ticket")["data"]
                    self.assertEqual(planning["response"], ticket)
                    self.assertEqual(ok("workspace.receipt", workspace_id="work", actor_id="operator", mutation_id="absent")["data"], {"status": "absent"})
                    # Enough independent files keep the single export worker occupied
                    # while the second job is admitted and canceled over direct sockets.
                    for offset in range(0, 256, 32):
                        write("transaction.apply", "seed-" + str(offset), workspace_id="work", operations=[
                            {"method": "ticket.create", "params": {"ticket_id": "file-%03d" % i, "title": "Projection %d" % i, "description": "evidence " * 128}}
                            for i in range(offset, offset + 32)])
                    single = export("workspace.export", "single", workspace_id="work", destination=str(root / "single"))
                    verified = ok("export.verify", directory=str(root / "single"))["data"]
                    self.assertTrue(verified["verified"])
                    self.assertFalse(verified["canonical_state_validated"])
                    self.assertEqual(verified["head"], single["captures"][0]["head"])
                    busy = write("workspace.export", "busy", workspace_id="work", destination=str(root / "busy"))["data"]
                    queued = write("workspace.export", "queued", workspace_id=other, destination=str(root / "queued"))["data"]
                    canceled = write("export.cancel", "cancel", job_id=queued["job_id"])["data"]
                    self.assertTrue(canceled["cancel_requested"])
                    self.assertEqual(wait(canceled)["status"], "canceled")
                    self.assertFalse((root / "queued").exists())
                    self.assertEqual(wait(busy)["status"], "completed")
                    retried = write("export.retry", "retry", job_id=queued["job_id"])["data"]
                    self.assertEqual(retried["attempt"], "2")
                    self.assertEqual(retried["captures"], queued["captures"])
                    self.assertEqual(wait(retried)["status"], "completed")
                    all_job = export("daemon.export_all", "all", destination=str(root / "all"))
                    self.assertEqual(len(all_job["captures"]), 2)
                    listing = ok("export.list", limit="1", max_bytes="4096")
                    self.assertLessEqual(len(json.dumps(listing, ensure_ascii=False, separators=(",", ":")).encode()), 4096)
                    self.assertEqual(listing["meta"]["budget"]["returned_bytes"], str(len(json.dumps(listing, ensure_ascii=False, separators=(",", ":")).encode())))
                    page = ok("export.list", offset=listing["data"]["next_offset"], limit="1", at_snapshot=listing["meta"]["snapshot"])
                    self.assertTrue(page["data"]["items"])
                    reject("export.list", "Invalid_argument", offset="1")
                    reject("export.list", "Conflict", offset="1", at_snapshot="a" * 64)
                    reject("workspace.create", "Invalid_argument", actor_id="operator", mutation_id="bad-path", root="relative", name="Bad")
                    closed = write("workspace.close", "close", workspace_id="work")
                    self.assertEqual(closed["data"], {"closed": True})
                    # Replaying a historical create does not reopen current ownership.
                    self.assertEqual(write("workspace.create", "create", **creation), created)
                    health = ok("daemon.health")["data"]
                    self.assertFalse(next(w for w in health["workspaces"] if w["workspace_id"] == "work")["open"])
                    self.assertEqual(ok("workspace.list")["data"], health)
                    write("workspace.open", "open", workspace_id="work")
                    write("workspace.unregister", "unregister-original", workspace_id="work")
                    self.assertEqual(write("workspace.register", "register-existing", root=str(root / "workspace"))["data"], {"workspace_id": "work"})
                    write("workspace.unregister", "unregister-again", workspace_id="work")
                    # A self-consistent inventory with an unreferenced portable blob
                    # passes export verification but fails independent canonical replay.
                    bad = root / "single"
                    extra = "portable/blobs/" + hashlib.sha256(b"unreferenced").hexdigest()
                    (bad / extra).write_bytes(b"unreferenced")
                    manifest = json.loads((bad / "manifest.json").read_text())
                    manifest["files"][extra] = hashlib.sha256(b"unreferenced").hexdigest()
                    (bad / "manifest.json").write_text(json.dumps(manifest))
                    self.assertTrue(ok("export.verify", directory=str(bad))["data"]["verified"])
                    restore = dict(directory=str(bad), root=str(root / "restored"))
                    reject("workspace.restore", "Corrupt_store", actor_id="operator", mutation_id="restore", **restore)
                    self.assertFalse((root / "restored").exists())
                    self.assertEqual(ok("registry.receipt", actor_id="operator", mutation_id="restore")["data"], {"status": "pending"})
                    canceled_restore = write("restore.cancel", "cancel-restore", target_actor_id="operator", target_mutation_id="restore")
                    self.assertEqual(canceled_restore["data"], {"kind": "canceled"})
                    self.assertEqual(write("workspace.restore", "restore", **restore)["data"], {"kind": "canceled"})
                    manifest["files"].pop(extra)
                    (bad / extra).unlink()
                    (bad / "manifest.json").write_text(json.dumps(manifest))
                    installed = write("workspace.restore", "restore-fixed", **restore)
                    self.assertEqual(installed["data"]["kind"], "installed")
                    self.assertFalse(installed["data"]["open"])
                    write("workspace.open", "open-restored", workspace_id="work")
                    self.assertEqual(ok("workspace.receipt", workspace_id="work", actor_id="operator", mutation_id="ticket")["data"], planning)
                    write("workspace.unregister", "remove-restored", workspace_id="work")
                    write("workspace.unregister", "remove-other", workspace_id=other)
                    roots = {capture["workspace_id"]: str(root / ("all-" + capture["workspace_id"])) for capture in all_job["captures"]}
                    all_restore = write("daemon.restore_all", "restore-all", directory=str(root / "all"), roots=roots)
                    self.assertEqual(all_restore["data"]["kind"], "installed")
                    self.assertEqual(len(all_restore["data"]["workspaces"]), 2)
                    process.terminate()
                    process.wait(timeout=10)
                    address.unlink(missing_ok=True)
                    start()
                    self.assertEqual(write("workspace.create", "create", **creation), created)
                    self.assertEqual(write("workspace.restore", "restore-fixed", **restore), installed)
                    self.assertEqual(write("daemon.restore_all", "restore-all", directory=str(root / "all"), roots=roots), all_restore)
                    self.assertEqual(write("restore.cancel", "cancel-restore", target_actor_id="operator", target_mutation_id="restore"), canceled_restore)
                    self.assertTrue(all(not w["open"] for w in ok("workspace.list")["data"]["workspaces"]))
                    self.assertTrue(names <= covered, names - covered)
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
