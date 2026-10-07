"""Linux POSIX syscall failure qualification, not a power-loss simulator.
Usage: python3 fault_matrix.py EXECUTABLE SHIM_SO NEW_ABSOLUTE_DIRECTORY
Each case proves interception fired, checks the acknowledged/error outcome and
restarts/retries the exact mutation against its authoritative head.
"""
import errno
import itertools
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time

exe, shim, root = (Path(value).resolve() for value in sys.argv[1:])
root.mkdir(mode=0o700)


def request(address, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "fault", "method": method, "params": params}).encode()
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(10)
        client.connect(address)
        client.sendall(struct.pack(">I", len(body)) + body)
        def exact(length):
            data = bytearray()
            while len(data) < length:
                part = client.recv(length - len(data))
                if not part:
                    raise EOFError("daemon stopped")
                data.extend(part)
            return data
        return json.loads(exact(struct.unpack(">I", exact(4))[0]))


def check(response):
    if "error" in response:
        raise AssertionError(response)
    return response["result"]


# Destination match for writes/sync includes private temporary filenames. Directory
# matches are exact, so syncing transactions cannot accidentally trigger HEAD sync.
boundaries = [
    ("blob_write", "write", "/blobs/", False, False, 1),
    ("blob_file_sync", "file_sync", "/blobs/", False, False, 1),
    ("blob_rename", "rename", "/blobs/", False, False, 1),
    ("blob_temp_directory_sync", "directory_sync", "/blobs", True, False, 1),
    ("blob_publish_directory_sync", "directory_sync", "/blobs", True, False, 2),
    ("transaction_write", "write", "/transactions/", False, False, 1),
    ("transaction_file_sync", "file_sync", "/transactions/", False, False, 1),
    ("transaction_rename", "rename", "/transactions/", False, False, 1),
    ("transaction_temp_directory_sync", "directory_sync", "/transactions", True, False, 1),
    ("transaction_publish_directory_sync", "directory_sync", "/transactions", True, False, 2),
    ("head_write", "write", "/HEAD.json.tmp-", False, True, 1),
    ("head_file_sync", "file_sync", "/HEAD.json.tmp-", False, True, 1),
    ("head_rename", "rename", "/HEAD.json", True, True, 1),
    ("head_temp_directory_sync", "directory_sync", "", True, True, 1),
    ("head_publish_directory_sync", "directory_sync", "", True, True, 2),
]
results = []
for index, (boundary, when, action) in enumerate(itertools.product(boundaries, ["before", "after"], ["error", "exit"])):
    name, phase, suffix, exact, uncertain, occurrence = boundary
    case = root / ("%02d-%s-%s-%s" % (index, name, when, action))
    case.mkdir()
    workspace = case / "workspace"
    arm = case / "arm"
    number = errno.ENOSPC if phase == "write" else errno.EIO
    env = {**os.environ, "LD_PRELOAD": str(shim), "EIO_BACKEND": "posix",
           "WG_FAULT_ARM": str(arm), "WG_FAULT_MATCH": str(workspace) + suffix,
           "WG_FAULT_PHASE": phase, "WG_FAULT_WHEN": when, "WG_FAULT_ACTION": action,
           "WG_FAULT_ERRNO": str(number), "WG_FAULT_N": str(occurrence)}
    if exact:
        env["WG_FAULT_EXACT"] = "1"
    process = None
    with tempfile.TemporaryDirectory(prefix="wg-fault-") as sockets, (case / "daemon.log").open("ab") as log:
        address = str(Path(sockets) / "s")
        def start():
            global process
            process = subprocess.Popen([str(exe), "serve", str(case / "registry"), address], env=env, stdout=log, stderr=log)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError((case / "daemon.log").read_text())
                try:
                    check(request(address, "initialize", {}))
                    return
                except (OSError, EOFError):
                    time.sleep(.01)
            raise AssertionError("startup timeout")
        try:
            start()
            check(request(address, "workspace.create", {"workspace_id": "demo", "name": "Fault fixture", "root": str(workspace), "actor_id": "operator", "mutation_id": "create"}))
            params = {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "commit",
                      "resource_id": "r", "expected_revision": "0", "title": "Resource", "text": "durable bytes"}
            arm.touch()
            if action == "exit":
                try:
                    response = request(address, "resource.put_text", params)
                    raise AssertionError("exit boundary did not stop response: " + repr(response))
                except (OSError, EOFError):
                    pass
                process.wait(timeout=10)
                assert process.returncode == 86, process.returncode
            else:
                response = request(address, "resource.put_text", params)
                expected = "Outcome_unknown" if uncertain else "Storage_unavailable"
                assert response["error"]["data"]["kind"] == expected, response
                # Known failures leave published memory at revision zero; uncertain
                # failures fence until recovery instead of guessing from memory.
                if not uncertain:
                    state = check(request(address, "workspace.get", {"workspace_id": "demo"}))
                    assert state["workspace_revision"] == "0", state
            assert Path(str(arm) + ".fired").exists(), "intended boundary was not intercepted"
            arm.unlink()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            start()
            prior = check(request(address, "workspace.receipt", {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "commit"}))
            should_commit = name == "head_publish_directory_sync" or (name == "head_rename" and when == "after")
            assert prior["status"] == ("committed" if should_commit else "absent"), prior
            result = check(request(address, "resource.put_text", params))
            assert result["workspace_revision"] == "1", result
            assert result == check(request(address, "resource.put_text", params))
            check(request(address, "daemon.shutdown", {}))
            process.wait(timeout=10)
            assert process.returncode == 0, process.returncode
            item = {"boundary": name, "when": when, "action": action, "errno": number, "recovered_before_retry": prior["status"], "result": "passed"}
            results.append(item)
            print(json.dumps(item), flush=True)
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=10)
(root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps({"passed": len(results), "backend": "posix", "power_loss_simulated": False}), flush=True)
