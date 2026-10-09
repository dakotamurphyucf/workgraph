"""Independent socket/restart fixtures for path fencing and durable condition signals."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()
TARGET = {"worktree_id": "tree", "kind": "subtree", "path": "src"}
PIN = {"kind": "checksum", "source": "deployment", "digest": "a" * 64}
PROOF = {"kind": "checksum", "source": "result", "digest": "b" * 64}


class CoordinationSocketTest(unittest.TestCase):
    def test_atomic_paths_signal_retry_and_recovery_fence(self):
        with tempfile.TemporaryDirectory(prefix="wg-coord-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            daemon = None
            with (root / "daemon.log").open("w+") as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen(
                        [str(EXE), "serve", str(root / "registry"), str(address)],
                        stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "coordination", **params}
                    response = subprocess.run(
                        [str(EXE), "call", str(address), method, json.dumps(params)],
                        capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    return json.loads(response.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, **params):
                    return ok(method, actor_id="worker", mutation_id=mutation, **params)

                def rejected(method, kind, **params):
                    response = call(method, **params)
                    self.assertEqual(kind, response.get("error", {}).get("data", {}).get("kind"), response)

                def revision():
                    return ok("workspace.get")["meta"]["workspace_revision"]

                def stop():
                    ok("daemon.shutdown")
                    daemon.wait(timeout=10)

                try:
                    start()
                    write("workspace.create", "workspace", name="Coordination", root=str(root / "workspace"))
                    write("run.register", "run", target_run_id="run", objective="work")
                    write("ticket.create", "ticket", ticket_id="task", title="Task")
                    alias_target = {"worktree_id": "tree", "kind": "file", "path": "aliases"}
                    write("transaction.apply", "alias-batch", operations=[
                        {"method": "ticket.create", "as": "child", "params": {"ticket_id": "child", "title": "Child"}},
                        {"method": "ticket.paths.put", "params": {"ticket_id": "$child", "expected_revision": "0", "declarations": []}},
                        {"method": "run.register", "as": "alias_run", "params": {"target_run_id": "alias-run", "objective": "aliases"}},
                        {"method": "reservation.paths.acquire", "params": {"target_run_id": "$alias_run", "requests": [{"target": alias_target, "mode": "exclusive"}]}},
                        {"method": "reservation.path.recover", "params": {
                            "recovery_id": "alias-recovery", "target": {"kind": "path", "target": alias_target},
                            "expected_epoch": "1", "old_run_id": "$alias_run", "old_actor_id": "worker",
                            "token": "1", "expected_lease_revision": "1", "confirmation": "isolated", "reason": "$opaque reason"}}])
                    self.assertEqual([], ok("reservation.path.get", target=alias_target)["data"]["holders"])
                    write("ticket.paths.put", "paths", ticket_id="task", expected_revision="0",
                          require_reservations=True, declarations=[{"target": TARGET, "mode": "exclusive"}])
                    before = revision()
                    rejected("ticket.start", "Blocked", actor_id="worker", mutation_id="no-run", ticket_id="task")
                    self.assertEqual(before, revision())
                    rejected("transaction.apply", "Conflict", actor_id="worker", run_id="run", mutation_id="bad-batch",
                             operations=[
                                 {"method": "ticket.start", "params": {"ticket_id": "task", "initial_note": "must roll back"}},
                                 {"method": "ticket.update", "params": {"ticket_id": "task", "expected_revision": "0", "title": "bad"}}])
                    self.assertEqual(before, revision())
                    rejected("reservation.path.get", "Not_found", target=TARGET)
                    write("ticket.start", "start", run_id="run", ticket_id="task", attempt_id="attempt")
                    held = ok("reservation.path.get", target=TARGET)["data"]
                    self.assertEqual("run", held["holders"][0]["run_id"])
                    self.assertEqual("1", held["holders"][0]["token"])
                    write("condition.put", "condition", condition_id="deploy", expected_revision="0", ticket_id="task",
                          operation_id="operation", artifact=PIN, label="Deployment", recipients=["worker", "worker"])
                    signal = dict(condition_id="deploy", signal_id="signal", expected_revision="1",
                                  operation_id="operation", artifact=PIN, evidence=[PROOF], summary="done")
                    original = write("condition.signal", "signal", **signal)
                    duplicate = write("condition.signal", "signal-again", **signal)
                    self.assertEqual(original["data"]["signal"], duplicate["data"]["signal"])
                    self.assertNotEqual(original["meta"]["workspace_revision"], duplicate["meta"]["workspace_revision"])
                    before = revision()
                    rejected("condition.signal", "Conflict", actor_id="other", mutation_id="changed-actor", **signal)
                    self.assertEqual(before, revision())
                    ticket = ok("ticket.context", ticket_id="task")["data"]["ticket"]
                    recovery = dict(ticket_id="task", expected_revision=ticket["revision"], recovery_id="recover",
                                    old_actor_id="worker", old_run_id="run", token=ticket["claim"]["token"],
                                    expected_lease_revision=ticket["claim"]["lease"]["revision"],
                                    confirmation="isolated", reason="old sandbox stopped")
                    recovered = write("ticket.recover", "recover", **recovery)
                    after_recovery = ok("ticket.context", ticket_id="task")["data"]["ticket"]
                    self.assertIsNone(after_recovery["claim"])
                    self.assertEqual("in_progress", after_recovery["status"])
                    write("ticket.update", "resume-ready", ticket_id="task",
                          expected_revision=after_recovery["revision"], status="todo")
                    write("ticket.claim", "replacement", run_id="run", ticket_id="task")
                    before = revision()
                    rejected("ticket.recover", "Conflict", actor_id="worker", mutation_id="stale-recovery", **recovery)
                    self.assertEqual(before, revision())
                    self.assertEqual("2", ok("ticket.context", ticket_id="task")["data"]["ticket"]["claim"]["token"])
                    stop()
                    start()
                    self.assertEqual(original, write("condition.signal", "signal", **signal))
                    self.assertEqual(duplicate, write("condition.signal", "signal-again", **signal))
                    self.assertEqual(recovered, write("ticket.recover", "recover", **recovery))
                    audit = ok("ticket.recovery.get", recovery_id="recover")
                    self.assertEqual("recover", audit["data"]["request"]["recovery_id"])
                    self.assertEqual(revision(), audit["meta"]["workspace_revision"])
                    self.assertEqual("2", ok("ticket.context", ticket_id="task")["data"]["ticket"]["claim"]["token"])
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()

    def test_simultaneous_overlapping_required_starts_have_one_atomic_winner(self):
        with tempfile.TemporaryDirectory(prefix="wg-path-race-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            with (root / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen(
                    [str(EXE), "serve", str(root / "registry"), str(address)],
                    stdout=log, stderr=subprocess.STDOUT)

                def call(method, **params):
                    if method != "daemon.shutdown":
                        params = {"workspace_id": "path-race", **params}
                    response = subprocess.run(
                        [str(EXE), "call", str(address), method, json.dumps(params)],
                        capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    return json.loads(response.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn("result", response, response)
                    return response["result"]

                def write(method, mutation, actor="setup", **params):
                    return ok(method, actor_id=actor, mutation_id=mutation, **params)

                def revision():
                    return ok("workspace.get")["meta"]["workspace_revision"]

                def ticket(name):
                    return ok("ticket.context", ticket_id=name)["data"]

                try:
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    write("workspace.create", "workspace", name="Path race", root=str(root / "workspace"))
                    candidates = [
                        {"actor": "worker-a", "run": "run-a", "ticket": "ticket-a", "attempt": "attempt-a",
                         "target": {"worktree_id": "race-tree", "kind": "subtree", "path": "src"}},
                        {"actor": "worker-b", "run": "run-b", "ticket": "ticket-b", "attempt": "attempt-b",
                         "target": {"worktree_id": "race-tree", "kind": "file", "path": "src/main.ml"}},
                    ]
                    for candidate in candidates:
                        write("run.register", "register-" + candidate["run"], actor=candidate["actor"],
                              target_run_id=candidate["run"], objective="Exclusive work")
                        write("ticket.create", "create-" + candidate["ticket"], ticket_id=candidate["ticket"], title="Work")
                        write("ticket.paths.put", "paths-" + candidate["ticket"], ticket_id=candidate["ticket"],
                              expected_revision="0", require_reservations=True,
                              declarations=[{"target": candidate["target"], "mode": "exclusive"}])
                    before = revision()
                    barrier = threading.Barrier(2)

                    def start(candidate):
                        barrier.wait(timeout=5)
                        params = {"actor_id": candidate["actor"], "run_id": candidate["run"],
                                  "mutation_id": "start-" + candidate["ticket"], "ticket_id": candidate["ticket"],
                                  "attempt_id": candidate["attempt"], "initial_note": "Started " + candidate["run"]}
                        return candidate, params, call("ticket.start", **params)

                    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [pool.submit(start, candidate) for candidate in candidates]
                        results = [future.result(timeout=15) for future in futures]
                    winners = [result for result in results if "result" in result[2]]
                    losers = [result for result in results if "error" in result[2]]
                    self.assertEqual(len(winners), 1, results)
                    self.assertEqual(len(losers), 1, results)
                    winner, winner_params, won = winners[0]
                    loser, loser_params, lost = losers[0]
                    self.assertEqual(lost["error"]["data"]["kind"], "Blocked", lost)
                    self.assertEqual(int(revision()), int(before) + 1)
                    stable_revision = revision()

                    def assert_atomic_state():
                        winning_ticket = ticket(winner["ticket"])
                        losing_ticket = ticket(loser["ticket"])
                        self.assertEqual(winning_ticket["ticket"]["claim"]["run_id"], winner["run"])
                        self.assertEqual(winning_ticket["ticket"]["status"], "in_progress")
                        self.assertIsNone(losing_ticket["ticket"]["claim"])
                        self.assertEqual(losing_ticket["ticket"]["status"], "todo")
                        self.assertEqual(losing_ticket["updates"]["items"], [])
                        attempts = ok("attempt.list")["data"]["items"]
                        self.assertEqual(len(attempts), 1)
                        self.assertEqual(attempts[0]["attempt_id"], winner["attempt"])
                        self.assertEqual(attempts[0]["ticket_id"], winner["ticket"])
                        self.assertEqual(attempts[0]["run_id"], winner["run"])
                        self.assertEqual(attempts[0]["token"], winning_ticket["ticket"]["claim"]["token"])
                        missing_attempt = call("attempt.get", attempt_id=loser["attempt"])
                        self.assertEqual(missing_attempt["error"]["data"]["kind"], "Not_found")
                        paths = ok("reservation.path.list")["data"]["items"]
                        self.assertEqual(len(paths), 1)
                        self.assertEqual(paths[0]["target"], winner["target"])
                        self.assertEqual(len(paths[0]["holders"]), 1)
                        self.assertEqual(paths[0]["holders"][0]["run_id"], winner["run"])
                        self.assertEqual(paths[0]["holders"][0]["actor_id"], winner["actor"])
                        losing_path = call("reservation.path.get", target=loser["target"])
                        self.assertEqual(losing_path["error"]["data"]["kind"], "Not_found")
                        self.assertEqual(revision(), stable_revision)

                    assert_atomic_state()
                    self.assertEqual(call("ticket.start", **winner_params)["result"], won["result"])
                    retried_loser = call("ticket.start", **loser_params)
                    self.assertEqual(retried_loser["error"]["data"]["kind"], "Blocked")
                    assert_atomic_state()
                finally:
                    if daemon.poll() is None:
                        ok("daemon.shutdown")
                        self.assertEqual(daemon.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()
