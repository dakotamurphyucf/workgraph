"""Durable inbox consumption and parked waits through independent socket frames."""
import concurrent.futures
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

EXE = Path(sys.argv.pop(1)).resolve()


class InboxWaitTest(unittest.TestCase):
    def test_wait_filter_budget_and_durable_consumer_acknowledgement(self):
        with tempfile.TemporaryDirectory(prefix="wg-inbox-", dir="/tmp") as directory:
            root = Path(directory)
            address = root / "s"
            log = (root / "daemon.log").open("w+")
            daemon = None
            mutation = 0

            def start():
                nonlocal daemon
                daemon = subprocess.Popen(
                    [str(EXE), "serve", str(root / "registry"), str(address)],
                    stdout=log, stderr=subprocess.STDOUT,
                )
                deadline = time.monotonic() + 10
                while not address.exists():
                    if daemon.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        self.fail(log.read())
                    time.sleep(0.01)

            def send(method, params, *, discard=False, started=None):
                payload = json.dumps({
                    "jsonrpc": "2.0", "id": "test", "method": method, "params": params,
                }).encode()
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(10)
                    connection.connect(str(address))
                    connection.sendall(struct.pack(">I", len(payload)) + payload)
                    if started is not None:
                        started.set()
                    if discard:
                        return None

                    def exact(size):
                        result = bytearray()
                        while len(result) < size:
                            block = connection.recv(size - len(result))
                            if not block:
                                self.fail("daemon closed before replying")
                            result.extend(block)
                        return bytes(result)

                    return json.loads(exact(struct.unpack(">I", exact(4))[0]))

            def ok(method, **params):
                response = send(method, {"workspace_id": "demo", **params})
                self.assertIn("result", response, response)
                return response["result"]

            def write(method, **params):
                nonlocal mutation
                mutation += 1
                return ok(method, actor_id="sender", mutation_id=f"m-{mutation}", **params)

            recipient = {"kind": "actor", "id": "receiver"}
            inbox = {"consumer_id": "driver", "recipient": recipient}

            def message(identity, body, ticket="selected"):
                return write(
                    "message.send", message_id=identity, body=body, ticket_id=ticket,
                    recipients=[recipient],
                )["data"]

            def read(**params):
                return ok("inbox.read", **{**inbox, **params})["data"]

            try:
                start()
                write("workspace.create", name="Inbox acceptance", root=str(root / "workspace"))
                for ticket in ("selected", "other"):
                    write("ticket.create", ticket_id=ticket, title=ticket)

                # An empty bounded wait is a read, and exposes the same captured shape.
                empty = ok("inbox.wait", **inbox, timeout_ms="1")["data"]
                self.assertEqual([], empty["items"])
                self.assertEqual("0", empty["remaining"])

                # Keep one request parked while the same dispatcher accepts writes.
                started = threading.Event()
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    waiter = pool.submit(
                        send, "inbox.wait", {
                            "workspace_id": "demo", **inbox, "ticket_id": "selected",
                            "timeout_ms": "5000",
                        }, started=started,
                    )
                    self.assertTrue(started.wait(timeout=5))
                    message("unrelated", "Keep this unread", ticket="other")
                    message("welcome", "Original delivered body")
                    waited = waiter.result(timeout=8)
                    self.assertIn("result", waited, waited)
                    delivered = waited["result"]["data"]
                self.assertEqual(["welcome"], [item["source"]["id"] for item in delivered["items"]])
                self.assertEqual("initial", delivered["items"][0]["body_source"]["version_kind"])
                self.assertEqual("Original delivered body", delivered["items"][0]["body_source"]["body"])
                first_id = delivered["items"][0]["notification_id"]
                self.assertEqual(["unrelated", "welcome"], [item["source"]["id"] for item in read()["items"]])
                send("inbox.wait", {"workspace_id": "demo", **inbox, "timeout_ms": "10"}, discard=True)
                self.assertEqual(["unrelated", "welcome"], [item["source"]["id"] for item in read()["items"]])

                # A response loss cannot consume messages. Explicit acknowledgement
                # is attributed, durable, independently retryable, and consumer-local.
                ack = {
                    "workspace_id": "demo", "actor_id": "receiver",
                    "mutation_id": "ack-welcome", **inbox, "notification_ids": [first_id],
                }
                send("inbox.ack", ack, discard=True)
                acknowledged = send("inbox.ack", ack)
                self.assertIn("result", acknowledged, acknowledged)
                self.assertTrue(acknowledged["result"]["meta"]["durable"])
                self.assertEqual(["unrelated"], [item["source"]["id"] for item in read()["items"]])
                self.assertEqual(
                    ["unrelated", "welcome"],
                    [item["source"]["id"] for item in read(consumer_id="other-driver")["items"]],
                )
                daemon.kill()
                daemon.wait(timeout=5)
                address.unlink(missing_ok=True)
                start()
                self.assertEqual(acknowledged["result"], send("inbox.ack", ack)["result"])
                self.assertEqual(["unrelated"], [item["source"]["id"] for item in read()["items"]])

                # Fitting may reduce bodies/items, but never move the cursor beyond
                # the final returned notification. The fixed capture remains pageable.
                for index in range(5):
                    message(f"large-{index}", "x" * 50000)
                after = "0"
                through = None
                seen = []
                for _ in range(10):
                    params = {"consumer_id": "budget-driver", "max_bytes": "4096", "after": after}
                    if through is not None:
                        params["through"] = through
                    response = ok("inbox.read", **{**inbox, **params})
                    page = response["data"]
                    self.assertLessEqual(
                        len(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode()), 4096
                    )
                    if through is None:
                        through = page["through"]
                    self.assertEqual(through, page["through"])
                    ids = [item["notification_id"] for item in page["items"]]
                    self.assertEqual(ids[-1] if ids else after, page["next_after"])
                    seen.extend(item["source"]["id"] for item in page["items"])
                    if page["remaining"] == "0":
                        break
                    self.assertTrue(ids, "bounded notification metadata cannot fit one item")
                    after = page["next_after"]
                self.assertEqual(["unrelated", "welcome"] + [f"large-{i}" for i in range(5)], seen)
                self.assertEqual(len(seen), len(set(seen)))
            finally:
                if daemon is not None and daemon.poll() is None:
                    daemon.terminate()
                    try:
                        daemon.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait(timeout=5)
                log.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
