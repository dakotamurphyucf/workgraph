"""Bounded acquisition, atomic batches, exact journals and lost acknowledgements."""
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
EXE = str(Path(sys.argv.pop(1)).resolve())


def frame(flow):
    def exact(size):
        data = b""
        while len(data) < size:
            part = flow.recv(size-len(data))
            if not part:
                raise EOFError("truncated frame")
            data += part
        return data
    header = exact(4)
    body = exact(struct.unpack(">I", header)[0])
    return header+body, json.loads(body)


class Proxy:
    def __init__(self, root, upstream, journal, after_first=None, drop=False, stall_read=None):
        self.path, self.upstream, self.journal = root / "proxy", upstream, journal
        self.after_first, self.drop, self.stall_read = after_first, drop, stall_read
        self.requests, self.responses, self.error = [], [], None
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(self.path))
        self.listener.listen()
        self.listener.settimeout(.1)
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        try:
            while not self.stop.is_set():
                try:
                    incoming, _ = self.listener.accept()
                except socket.timeout:
                    continue
                with incoming, socket.socket(socket.AF_UNIX) as outgoing:
                    outgoing.settimeout(5)
                    encoded, request = frame(incoming)
                    if request["method"] == self.stall_read:
                        # Let the client exhaust its capped remaining read budget.
                        # Cleanup releases this wait without writing to its closed socket.
                        self.stop.wait(5)
                        continue
                    if request["method"] in ("reservation.acquire", "reservation.paths.acquire"):
                        path = self.journal / (request["params"]["mutation_id"]+".json")
                        assert json.loads(path.read_bytes()) == request, "journal must precede transmission"
                        self.requests.append(request)
                    outgoing.connect(str(self.upstream))
                    outgoing.sendall(encoded)
                    encoded, response = frame(outgoing)
                    if request["method"] in ("reservation.acquire", "reservation.paths.acquire"):
                        self.responses.append(response)
                        if len(self.responses) == 1:
                            if self.after_first:
                                self.after_first(response)
                            if self.drop:
                                continue
                    incoming.sendall(encoded)
        except Exception as error:
            self.error = error
        finally:
            self.listener.close()

    def close(self):
        self.stop.set()
        self.thread.join(6)
        assert not self.thread.is_alive() and self.error is None, self.error


class ReservationWait(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-wait-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = self.root / "s"
        self.journal = self.root / "journal"
        self.journal.mkdir()
        self.log = (self.root / "daemon.log").open("w+")
        self.addCleanup(self.log.close)
        self.daemon = subprocess.Popen([EXE, "serve", str(self.root / "registry"), str(self.socket)], stdout=self.log, stderr=self.log)
        self.addCleanup(self.shutdown)
        deadline = time.monotonic()+10
        while not is_listening(self.socket):
            assert self.daemon.poll() is None and time.monotonic() < deadline
            time.sleep(.01)
        self.counter = 0
        self.write("workspace.create", name="Wait", root=str(self.root / "workspace"))
        for run in ["holder", "waiter", "invocation"]:
            self.write("run.register", target_run_id=run, objective="test")

    def shutdown(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(10)

    def cli(self, *args, expected=0):
        result = subprocess.run([EXE, *map(str, args)], capture_output=True, text=True, timeout=15)
        if expected is not None:
            self.assertEqual(result.returncode, expected, (args, result.stdout, result.stderr))
        return result

    def read(self, method, **params):
        reply = self.cli("call", self.socket, method, json.dumps(dict(workspace_id="w", **params)))
        return json.loads(reply.stdout)["result"]

    def write(self, method, **params):
        self.counter += 1
        return self.read(method, actor_id="worker", mutation_id="fixture"+str(self.counter), **params)

    def proxy(self, **options):
        proxy = Proxy(self.root, self.socket, self.journal, **options)
        self.addCleanup(proxy.close)
        return proxy

    def wait(self, requests, paths=False, address=None, options=(), expected=0, timeout_ms=3000):
        command = ["reservation", "paths", "wait"] if paths else ["reservation", "wait"]
        result = self.cli(*command, address or self.socket, "--workspace-id", "w", "--actor-id", "worker",
                          "--run-id", "waiter", "--target-run-id", "waiter", "--json-field", "requests", json.dumps(requests),
                          "--request-directory", self.journal, "--mutation-id", "first", "--wait-ms", str(timeout_ms),
                          "--wait-slice-ms", "100", *options, expected=expected)
        return result, json.loads(result.stdout)["result"]["data"] if result.stdout else None

    def test_named_release_preserves_atomic_batch_and_actual_receipt(self):
        held = self.write("reservation.acquire", target_run_id="holder", requests=[{"reservation_id":"b", "mode":"exclusive"}])
        def release(conflict):
            self.assertEqual(conflict["error"]["data"]["details"]["type"], "reservation_conflict")
            self.assertEqual(self.read("reservation.list", target_run_id="waiter")["data"]["items"], [])
            self.write("reservation.release", target_run_id="holder", reservation_id="b", token=held["data"]["holds"][0]["holder"]["token"])
        proxy = self.proxy(after_first=release)
        requests = [{"reservation_id": name, "mode":"exclusive"} for name in ["a", "b"]]
        result, data = self.wait(requests, address=proxy.path)
        self.assertTrue(data["wait"]["completed"])
        self.assertEqual(data["wait"]["attempt_count"], "2")
        self.assertEqual(data["daemon_response"], proxy.responses[-1]["result"])
        self.assertEqual(len(data["daemon_response"]["data"]["holds"]), 2)
        self.assertEqual(len(proxy.requests), 2)
        first, second = [request["params"].copy() for request in proxy.requests]
        self.assertNotEqual(first.pop("mutation_id"), second.pop("mutation_id"))
        self.assertEqual(first, second)
        self.assertEqual(first["run_id"], "waiter")
        self.assertEqual(len(list(self.journal.iterdir())), 2)
        self.assertEqual(result.stderr.count("saved_request:"), 2)

    def test_paths_release_uses_original_normalized_batch(self):
        target = {"worktree_id":"tree", "kind":"subtree", "path":"src"}
        held = self.write("reservation.paths.acquire", target_run_id="holder", requests=[{"target":target, "mode":"exclusive"}])
        def release(_):
            self.write("reservation.path.release", target_run_id="holder", target=target, token=held["data"]["holds"][0]["holder"]["token"])
        proxy = self.proxy(after_first=release)
        child = {"worktree_id":"tree", "kind":"file", "path":"src/file.ml"}
        _, data = self.wait([{"target":child, "mode":"exclusive"}], paths=True, address=proxy.path)
        self.assertEqual(data["wait"]["attempt_count"], "2")
        self.assertEqual(data["daemon_response"]["data"]["holds"][0]["target"], child)

    def test_timed_expiry_rechecks_without_recovering_foreign_owner(self):
        original = self.write("reservation.acquire", target_run_id="holder", requests=[{"reservation_id":"build", "mode":"exclusive", "lease_duration_ms":"100"}])
        _, data = self.wait([{"reservation_id":"build", "mode":"exclusive"}], options=["--max-attempts", "4"], expected=1)
        self.assertFalse(data["wait"]["completed"])
        self.assertEqual((data["wait"]["stop"], data["wait"]["attempt_count"]), ("attempt_limit", "4"))
        self.assertEqual(self.read("run.get", target_run_id="holder")["data"]["status"], "running")
        holder = self.read("reservation.get", reservation_id="build")["data"]["holders"][0]
        self.assertEqual(holder, original["data"]["holds"][0]["holder"])
        self.assertLess(int(holder["lease"]["deadline_unix_ms"]), int(time.time()*1000))
        self.assertIsNone(data["daemon_response"])

    def test_attempt_limit_retains_conflict_and_exact_retry(self):
        self.write("reservation.acquire", target_run_id="holder", requests=[{"reservation_id":"build", "mode":"exclusive"}])
        _, data = self.wait([{"reservation_id":"build", "mode":"exclusive"}], options=["--max-attempts", "1"], expected=1)
        wait = data["wait"]
        self.assertEqual((wait["completed"], wait["stop"], wait["attempt_count"]), (False, "attempt_limit", "1"))
        self.assertEqual(wait["last_conflict"]["details"]["requested"], {"kind":"named", "reservation_id":"build"})
        self.assertEqual(json.loads(Path(wait["saved_request"]).read_bytes()), wait["retry_request"])
        self.assertIsNone(data["daemon_response"])

    def test_lost_ack_stops_and_exact_manual_retry_returns_original_receipt(self):
        proxy = self.proxy(drop=True)
        _, data = self.wait([{"reservation_id":"build", "mode":"exclusive"}], address=proxy.path, expected=1)
        wait = data["wait"]
        self.assertEqual((wait["stop"], wait["attempt_count"]), ("uncertain", "1"))
        self.assertEqual(wait["problem"]["kind"], "Outcome_unknown")
        self.assertEqual(len(proxy.requests), 1)
        saved = Path(wait["saved_request"])
        frozen = saved.read_bytes()
        self.write("reservation.release", target_run_id="waiter", reservation_id="build", token=proxy.responses[0]["result"]["data"]["holds"][0]["holder"]["token"])
        retry = self.cli("retry", self.socket, saved)
        self.assertEqual(json.loads(retry.stdout)["result"], proxy.responses[0]["result"])
        self.assertEqual(saved.read_bytes(), frozen)
        self.assertEqual(self.read("reservation.list", target_run_id="waiter")["data"]["items"], [])

    def test_deadline_caps_total_wait_and_preserves_foreign_holder(self):
        original = self.write("reservation.acquire", target_run_id="holder", requests=[{"reservation_id":"build", "mode":"exclusive"}])
        started = time.monotonic()
        _, data = self.wait([{"reservation_id":"build", "mode":"exclusive"}], options=["--max-attempts", "100"], timeout_ms=1000, expected=1)
        self.assertLess(time.monotonic()-started, 3)
        wait = data["wait"]
        if wait["stop"] == "uncertain":
            # A write already in flight can lose its reply at the total deadline.
            # It must retain its exact identity and stop instead of fabricating
            # a known timeout or issuing a fresh acquisition.
            self.assertEqual(wait["problem"]["kind"], "Outcome_unknown")
            saved = Path(wait["saved_request"])
            frozen = saved.read_bytes()
            self.assertEqual(json.loads(frozen), wait["retry_request"])
            retry = json.loads(self.cli("retry", self.socket, saved, expected=1).stdout)
            self.assertEqual(retry["error"]["data"]["kind"], "Already_claimed")
            self.assertEqual(retry["error"]["data"]["details"]["type"], "reservation_conflict")
            self.assertEqual(saved.read_bytes(), frozen)
        else:
            self.assertEqual(wait["stop"], "deadline", wait)
        self.assertLessEqual(int(data["wait"]["attempt_count"]), 100)
        self.assertEqual(self.read("reservation.get", reservation_id="build")["data"]["holders"][0], original["data"]["holds"][0]["holder"])

    def test_feed_transport_timeout_at_total_deadline_is_deadline(self):
        original = self.write("reservation.acquire", target_run_id="holder", requests=[{"reservation_id":"build", "mode":"exclusive"}])
        proxy = self.proxy(stall_read="changes.wait")
        _, data = self.wait([{"reservation_id":"build", "mode":"exclusive"}], address=proxy.path,
                            options=["--max-attempts", "100"], timeout_ms=1000, expected=1)
        wait = data["wait"]
        self.assertEqual((wait["stop"], wait["attempt_count"]), ("deadline", "1"), wait)
        self.assertEqual(wait["problem"], {"kind":"Storage_unavailable", "message":"request timed out"})
        self.assertEqual(wait["last_conflict"]["kind"], "Already_claimed")
        self.assertEqual(len(proxy.requests), 1)
        self.assertEqual(json.loads(Path(wait["saved_request"]).read_bytes()), wait["retry_request"])
        self.assertIsNone(data["daemon_response"])
        self.assertEqual(self.read("reservation.get", reservation_id="build")["data"]["holders"][0], original["data"]["holds"][0]["holder"])

    def test_existing_journal_never_overwrites_or_sends(self):
        sentinel = self.journal / "first.json"
        sentinel.write_bytes(b"do not overwrite")
        _, data = self.wait([{"reservation_id":"build", "mode":"exclusive"}], expected=1)
        self.assertEqual(data["wait"]["stop"], "failed")
        self.assertEqual(data["wait"]["attempt_count"], "0")
        self.assertEqual(sentinel.read_bytes(), b"do not overwrite")
        self.assertEqual(self.read("reservation.list", target_run_id="waiter")["data"]["items"], [])

    def test_help_offline_and_invalid_bounds_before_stdin_materialization(self):
        for command in [["reservation", "wait"], ["reservation", "paths", "wait"], ["reservation.wait"], ["reservation.paths.wait"], ["reservation-wait"]]:
            result = self.cli("--context", self.root / "missing", *command, "--help")
            self.assertIn("local acquisition helper", result.stdout)
        process = subprocess.Popen([EXE, "reservation", "wait", str(self.socket), "--wait-ms", "0", "--params-file", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.wait(timeout=2)
            self.assertEqual(process.returncode, 1)
            self.assertIn(b"reservation wait bounds", process.stderr.read())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(list(self.journal.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
