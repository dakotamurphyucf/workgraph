"""Mixed pinned readers and durable writers through independent real sockets."""
import base64
import concurrent.futures
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
spec = importlib.util.spec_from_file_location(
    "history_adapter", Path(__file__).resolve().parents[2] / "skills/workgraph/scripts/history-adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ConcurrentHistory(unittest.TestCase):
    def test_pinned_reads_exact_payloads_and_writes_remain_independent(self):
        with tempfile.TemporaryDirectory(prefix="wg-history-concurrent-", dir="/tmp") as d:
            root = Path(d)
            sock = root / "socket"
            with (root / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(sock)],
                                          stdout=log, stderr=log)
                def call(method, **params):
                    return adapter.Workgraph(sock).call(method, params)
                def write(method, identity, **params):
                    result = call(method, workspace_id="history", actor_id="writer",
                                  mutation_id=identity, **params)
                    self.assertIs(result["meta"]["durable"], True)
                    return result
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(sock):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    write("workspace.create", "workspace", name="History", root=str(root / "workspace"))
                    write("session.create", "session", session_id="session", title="Session")
                    bodies = [f"needle-{i}:".encode() + bytes(range(256)) * 8 for i in range(60)]
                    events = [{"client_id":str(i), "role":"tool", "kind":"result", "phase":"completed",
                               "payload":{"kind":"inline", "bytes_base64":base64.b64encode(body).decode()},
                               "searchable_text":{"kind":"inline", "bytes_base64":base64.b64encode(f"needle-{i}".encode()).decode()}}
                              for i, body in enumerate(bodies)]
                    write("session.append", "initial", session_id="session", events=events)
                    captured = call("history.read", workspace_id="history", session_id="session", direction="after")
                    head = captured["meta"]["history_capture"]["head"]
                    write("session.append", "later", session_id="session", events=[dict(events[0],client_id="later")])
                    # Cold ancestor is resolved once, then cache hits must remain frozen.
                    old = call("history.read", workspace_id="history", session_id="session", direction="after", head=head)
                    self.assertEqual(old["data"]["through"], "60")
                    def reader(i):
                        if i % 3 == 0:
                            result = call("history.search", workspace_id="history", text="needle", head=head,limit="100")
                            self.assertEqual(len(result["data"]["items"]), 60)
                            self.assertFalse(result["data"]["has_more"])
                            self.assertIsNone(result["data"]["next"])
                            self.assertTrue(result["data"]["index_complete"])
                        else:
                            index = i % 60
                            result = call("history.payload", workspace_id="history", head=head,
                                          event_ref={"session_id":"session","sequence":str(index+1)})
                            self.assertEqual(base64.b64decode(result["data"]["bytes_base64"],validate=True), bodies[index])
                        self.assertEqual(result["meta"]["history_capture"], captured["meta"]["history_capture"])
                    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                        futures = [pool.submit(reader, i) for i in range(72)]
                        mutation = pool.submit(write, "ticket.create", "concurrent-ticket",
                                               ticket_id="concurrent",title="Published amid reads")
                        for future in futures:
                            future.result(timeout=30)
                        result = mutation.result(timeout=30)
                    self.assertEqual(result["data"]["ticket_id"], "concurrent")
                    # Retry the exact write after the reader wave; no duplicate mutation.
                    self.assertEqual(write("ticket.create", "concurrent-ticket",ticket_id="concurrent",
                                           title="Published amid reads"), result)
                    latest = call("session.get", workspace_id="history", session_id="session")
                    self.assertEqual(latest["data"]["through"], "61")
                    call("daemon.shutdown")
                    self.assertEqual(daemon.wait(timeout=15), 0)
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


unittest.main()
