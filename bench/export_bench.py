#!/usr/bin/env python3
"""Requalify recovery and full export of an existing closed workload fixture.

EXE CLOSED_WORKSPACE NEW_ABSOLUTE_DIRECTORY. Keeps registry, export, logs and JSONL.
Samples process RSS every 250ms; does not claim an exact instantaneous peak.
"""
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import threading
import time

exe = Path(sys.argv[1]).resolve(strict=True)
workspace = Path(sys.argv[2]).resolve(strict=True)
root = Path(sys.argv[3])
if not root.is_absolute():
    raise SystemExit("fresh absolute benchmark directory required")
root.mkdir(mode=0o700)
sockets = tempfile.TemporaryDirectory(prefix="wg-export-")
address = str(Path(sockets.name) / "s")
log = (root / "daemon.log").open("ab")
report = (root / "measurements.jsonl").open("w")
process = subprocess.Popen([str(exe), "serve", str(root / "registry"), address], stdout=log, stderr=log)
finished = threading.Event()
peak = 0


def rss():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(process.pid)], text=True).strip()) * 1024


def sample():
    global peak
    while not finished.wait(0.25):
        try:
            peak = max(peak, rss())
        except (subprocess.CalledProcessError, ValueError):
            return


def emit(event, **fields):
    line = json.dumps({"event": event, **fields}, sort_keys=True)
    print(line, flush=True)
    report.write(line + "\n")
    report.flush()


def call(method, **params):
    arguments = [str(exe), "request", address, method, "--timeout", "300"]
    for key, value in params.items():
        arguments += ["--json-field", key, json.dumps(value)]
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=330, check=True)
    return json.loads(result.stdout)["result"]["data"]


sampler = threading.Thread(target=sample)
sampler.start()
try:
    deadline = time.monotonic() + 30
    while True:
        if process.poll() is not None:
            raise RuntimeError((root / "daemon.log").read_text())
        try:
            call("initialize")
            break
        except subprocess.CalledProcessError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.01)
    emit("environment", platform=platform.platform(), executable=str(exe), workspace=str(workspace))
    began = time.perf_counter()
    identity = call("workspace.register", actor_id="bench", mutation_id="register", root=str(workspace))
    emit("recovery", elapsed_seconds=time.perf_counter() - began, rss_bytes=rss(), sampled_peak_rss_bytes=peak)
    peak = rss()
    began = time.perf_counter()
    job = call("workspace.export", actor_id="bench", mutation_id="export",
               workspace_id=identity["workspace_id"], destination=str(root / "export"))
    while True:
        current = call("export.get", job_id=job["job_id"])
        if current["status"] != "running":
            if current["status"] != "completed":
                raise RuntimeError(json.dumps(current))
            break
        time.sleep(0.25)
    emit("export", elapsed_seconds=time.perf_counter() - began, rss_bytes=rss(), sampled_peak_rss_bytes=peak)
    call("workspace.close", actor_id="bench", mutation_id="close", workspace_id=identity["workspace_id"])
    call("daemon.shutdown")
    process.wait(timeout=30)
    emit("completed")
finally:
    finished.set()
    sampler.join(timeout=5)
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    log.close()
    report.close()
    sockets.cleanup()
