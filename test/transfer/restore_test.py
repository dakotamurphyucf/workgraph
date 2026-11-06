"""Real daemon publication, exact retry and portable restore retain omitted titles."""
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

binary = str(Path(sys.argv[1]).resolve())


def receive(stream, size):
    chunks = []
    while size:
        data = stream.recv(size)
        assert data
        chunks.append(data)
        size -= len(data)
    return b"".join(chunks)


with tempfile.TemporaryDirectory(prefix="wg-title-", dir="/tmp") as temporary:
    root = Path(temporary)
    address = root / "s"
    log = (root / "daemon.log").open("w+")
    daemon = subprocess.Popen([binary, "serve", str(root / "registry"), str(address)], stdout=log, stderr=log)
    serial = 0

    def call(method, params):
        with socket.socket(socket.AF_UNIX) as stream:
            stream.settimeout(10)
            stream.connect(str(address))
            body = json.dumps({"jsonrpc": "2.0", "workgraph_api": "0.7", "id": "test", "method": method, "params": params}).encode()
            stream.sendall(struct.pack(">I", len(body)) + body)
            return json.loads(receive(stream, struct.unpack(">I", receive(stream, 4))[0]))

    def ok(method, params):
        result = call(method, params)
        assert "result" in result, result
        return result["result"]

    def write(method, **params):
        global serial
        serial += 1
        return ok(method, {"actor_id": "worker", "mutation_id": "write-" + str(serial), **params})

    def read(method, **params):
        return ok(method, {"workspace_id": "demo", **params})["data"]

    try:
        deadline = time.monotonic() + 10
        while not is_listening(address):
            assert daemon.poll() is None and time.monotonic() < deadline
            time.sleep(.01)
        write("workspace.create", workspace_id="demo", name="Text IO", root=str(root / "workspace"))
        write("resource.put_text", workspace_id="demo", resource_id="note", expected_revision="0", title="Initial", text="one\n")
        write("resource.update", workspace_id="demo", resource_id="note", expected_revision="1", title="Retained title", description="Retained description")
        identity = {"workspace_id": "demo", "actor_id": "worker", "mutation_id": "content-only", "resource_id": "note", "expected_revision": "2", "text": "two\r\n\n"}
        receipt = ok("resource.put_text", identity)
        assert receipt["data"]["revision"] == "3" and receipt["data"]["version"]["revision"] == "2"
        assert ok("resource.put_text", identity) == receipt
        current = read("resource.get", resource_id="note")
        assert current["metadata"]["title"] == "Retained title"
        assert current["metadata"]["description"] == "Retained description"
        assert read("resource.read", resource_id="note", version="2")["text"] == "two\r\n\n"
        rejected = call("resource.put_text", {**identity, "mutation_id": "stale"})
        assert rejected["error"]["data"]["kind"] == "Conflict"
        rejected = call("resource.put_text", {**identity, "resource_id": "missing", "expected_revision": "0", "mutation_id": "no-title"})
        assert rejected["error"]["data"]["kind"] == "Invalid_argument"
        destination = root / "export"
        job = write("workspace.export", workspace_id="demo", destination=str(destination))["data"]
        deadline = time.monotonic() + 10
        while True:
            job = ok("export.get", {"job_id": job["job_id"]})["data"]
            if job["status"] != "running": break
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert job["status"] == "completed", job
        assert ok("export.verify", {"directory": str(destination)})["data"]["verified"]
        write("workspace.close", workspace_id="demo")
        write("workspace.unregister", workspace_id="demo")
        write("workspace.restore", directory=str(destination), root=str(root / "restored"))
        write("workspace.open", workspace_id="demo")
        assert read("resource.get", resource_id="note") == current
        assert read("resource.read", resource_id="note", version="2")["text"] == "two\r\n\n"
        assert ok("resource.put_text", identity) == receipt
    finally:
        if daemon.poll() is None:
            try: ok("daemon.shutdown", {})
            finally:
                try: daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    daemon.terminate()
                    daemon.wait(timeout=5)
        log.close()
print("Omitted resource title survives exact retry, verified export and portable restore")
