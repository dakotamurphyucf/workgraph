"""Reproducible local daemon workload; writes only to a fresh explicit directory.

Run: python3 bench/workload.py EXECUTABLE NEW_ABSOLUTE_DIRECTORY
Outputs progress/measurements as JSON lines. Keeps canonical data for inspection.
No retries, hidden batching, dependency installation or Git operations.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import time

exe = Path(sys.argv[1]).resolve(strict=True)
root = Path(sys.argv[2])
if not root.is_absolute():
    raise SystemExit("benchmark directory must be absolute")
root.mkdir(mode=0o700)  # Exclusive: never reuse or overwrite an existing fixture.
socket_dir = tempfile.TemporaryDirectory(prefix="wg-bench-")
address = str(Path(socket_dir.name) / "s")
process = None
log = (root / "daemon.log").open("ab")
report_file = (root / "measurements.jsonl").open("a")


def emit(event, **fields):
    line = json.dumps({"event": event, **fields}, sort_keys=True)
    print(line, flush=True)
    report_file.write(line + "\n")
    report_file.flush()


def call(method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": "bench", "method": method,
                          "params": params}, separators=(",", ":")).encode()
    started = time.perf_counter()
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(300)
        client.connect(address)
        client.sendall(struct.pack(">I", len(payload)) + payload)
        def exact(count):
            result = bytearray()
            while len(result) < count:
                data = client.recv(count - len(result))
                if not data:
                    raise RuntimeError("incomplete daemon response")
                result.extend(data)
            return bytes(result)
        response = json.loads(exact(struct.unpack(">I", exact(4))[0]))
    if "error" in response:
        raise RuntimeError(json.dumps(response))
    return response["result"], (time.perf_counter() - started) * 1000


def rss():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(process.pid)], text=True).strip()) * 1024


def start():
    global process
    began = time.perf_counter()
    process = subprocess.Popen([str(exe), "serve", str(root / "registry"), address], stdout=log, stderr=log)
    while time.perf_counter() - began < 300:
        if process.poll() is not None:
            raise RuntimeError((root / "daemon.log").read_text())
        try:
            call("initialize", {})
            return (time.perf_counter() - began) * 1000
        except (OSError, EOFError):
            time.sleep(0.01)
    raise RuntimeError("startup timed out")


def summarize(samples):
    ordered = sorted(samples)
    return {"count": len(samples), "median_ms": statistics.median(samples),
            "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
            "max_ms": max(samples)}


def mutate(method, params, key):
    return call(method, {"workspace_id": "bench", "actor_id": "bench",
                         "mutation_id": key, **params})


try:
    emit("environment", platform=platform.platform(), machine=platform.machine(),
         python=sys.version, cpus=os.cpu_count(), executable=str(exe),
         tickets=10000, updates=100000, batch_operations=32)
    emit("empty_start", elapsed_ms=start(), rss_bytes=rss())
    call("workspace.create", {"workspace_id": "bench", "name": "Qualification fixture",
         "root": str(root / "workspace"), "actor_id": "bench", "mutation_id": "create"})
    for phase, count in [("tickets", 10000), ("updates", 100000)]:
        began = time.perf_counter()
        samples = []
        for offset in range(0, count, 32):
            operations = []
            for i in range(offset, min(offset + 32, count)):
                if phase == "tickets":
                    method = "ticket.create"
                    params = {"ticket_id": "t%05d" % i, "title": "Implementation task %d" % i,
                              "description": "Task context " + "x" * 240}
                else:
                    method = "comment.add"
                    params = {"ticket_id": "t%05d" % (i % 10000), "comment_id": "c%06d" % i,
                              "body": "Progress evidence %06d " % i + "x" * 100}
                operations.append({"method": method, "params": params})
            _, elapsed = mutate("transaction.apply", {"operations": operations}, "%s-%d" % (phase, offset))
            samples.append(elapsed)
            if offset % 3200 == 0:
                emit("progress", phase=phase, completed=offset + len(operations),
                     elapsed_seconds=time.perf_counter() - began, batch_ms=elapsed, rss_bytes=rss())
        emit(phase, elapsed_seconds=time.perf_counter() - began, rss_bytes=rss(), **summarize(samples))
    call("daemon.shutdown", {})
    process.wait(timeout=30)
    emit("restart", elapsed_ms=start(), rss_bytes=rss())
    for method, params in [("ticket.context", {"ticket_id": "t05000"}),
                           ("workspace.overview", {}),
                           ("search.query", {"text": "evidence"})]:
        samples = [call(method, {"workspace_id": "bench", **params})[1] for _ in range(20)]
        emit("query", method=method, **summarize(samples))
    samples = [mutate("comment.add", {"ticket_id": "t05000", "body": "Measured steady state write"}, "latency-%d" % i)[1] for i in range(20)]
    emit("individual_write", **summarize(samples))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        samples = list(pool.map(lambda i: mutate("comment.add", {"ticket_id": "t05000", "body": "Concurrent progress"}, "parallel-%d" % i)[1], range(64)))
    emit("eight_clients", **summarize(samples))
    began = time.perf_counter()
    job, admission = call("workspace.export", {"workspace_id": "bench", "destination": str(root / "export"), "actor_id": "bench", "mutation_id": "export"})
    while True:
        current, _ = call("export.get", {"job_id": job["job_id"]})
        if current["status"] != "running":
            break
        time.sleep(0.1)
    if current["status"] != "completed":
        raise RuntimeError(json.dumps(current))
    emit("export", elapsed_seconds=time.perf_counter() - began, admission_ms=admission, rss_bytes=rss())
    for name in ["workspace", "export"]:
        files = [p for p in (root / name).rglob("*") if p.is_file()]
        emit("disk", tree=name, files=len(files), logical_bytes=sum(p.stat().st_size for p in files),
             allocated_bytes=sum(p.stat().st_blocks * 512 for p in files))
    emit("completed", rss_bytes=rss())
except BaseException as error:
    emit("failed", error=repr(error))
    raise
finally:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    report_file.close()
    log.close()
    socket_dir.cleanup()
