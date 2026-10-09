"""Actual ENOSPC and unprivileged permission failures in a disposable container.
Requires the Linux binary at /home/opam/workgraph and a fresh 2MiB tmpfs /limited
owned by container uid1000. The daemon registry stays outside the full filesystem.
Usage: python3 container_storage.py TASK_OWNED_CONTAINER_NAME
"""
import json
import subprocess
import sys
import time

container = sys.argv[1]
exe = "/home/opam/workgraph"
address = "/home/opam/wg.sock"


def execute(*args, expected=0):
    result = subprocess.run(["docker", "exec", container, *args], text=True, capture_output=True, timeout=15)
    if expected is not None:
        assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
    return result


def call(method, params):
    result = execute(exe, "call", address, method, json.dumps(params), expected=None)
    assert result.stdout, (result.returncode, result.stderr)
    return json.loads(result.stdout)


def ok(method, params):
    response = call(method, params)
    assert "result" in response, response
    return response["result"]


def start():
    subprocess.run(["docker", "exec", "-d", container, "/bin/sh", "-c",
                    "exec /home/opam/workgraph serve /home/opam/registry /home/opam/wg.sock >> /home/opam/daemon.log 2>&1"], check=True)
    for _ in range(100):
        probe = execute(exe, "call", address, "initialize", "{}", expected=None)
        if probe.returncode == 0:
            return
        time.sleep(.01)
    raise AssertionError(execute("cat", "/home/opam/daemon.log").stdout)


def stop():
    ok("daemon.shutdown", {})
    execute("/bin/sh", "-c", "while test -S /home/opam/wg.sock; do sleep 0.01; done")


def mutation(key):
    return {"workspace_id": "demo", "actor_id": "agent", "mutation_id": key,
            "target": {"kind": "ticket", "id": "a"}, "body": key}


started = False
try:
    start()
    started = True
    ok("workspace.create", {"workspace_id": "demo", "name": "Storage fixture", "root": "/limited/workspace", "actor_id": "operator", "mutation_id": "create"})
    ok("ticket.create", {"workspace_id": "demo", "actor_id": "agent", "mutation_id": "ticket", "ticket_id": "a", "title": "A"})
    filled = execute("dd", "if=/dev/zero", "of=/limited/filler", "bs=1024", "count=4096", expected=None)
    assert filled.returncode != 0 and "No space left on device" in filled.stderr, filled.stderr
    failed = call("comment.add", mutation("full"))
    assert failed["error"]["data"]["kind"] == "Storage_unavailable", failed
    assert ok("ticket.context", {"workspace_id": "demo", "ticket_id": "a"})["meta"]["workspace_revision"] == "1"
    execute("rm", "/limited/filler")
    committed = ok("comment.add", mutation("full"))
    assert committed["meta"]["workspace_revision"] == "2", committed
    stop()
    start()
    assert committed == ok("comment.add", mutation("full"))
    print(json.dumps({"case": "actual_full_tmpfs", "result": "passed", "recovered_revision": "2"}), flush=True)
    execute("chmod", "500", "/limited/workspace/transactions")
    failed = call("comment.add", mutation("permission"))
    assert failed["error"]["data"]["kind"] == "Storage_unavailable", failed
    execute("chmod", "700", "/limited/workspace/transactions")
    assert ok("comment.add", mutation("permission"))["meta"]["workspace_revision"] == "3"
    execute("chmod", "500", "/limited/workspace")
    failed = call("comment.add", mutation("head-permission"))
    assert failed["error"]["data"]["kind"] == "Outcome_unknown", failed
    execute("chmod", "700", "/limited/workspace")
    stop()
    start()
    assert ok("comment.add", mutation("head-permission"))["meta"]["workspace_revision"] == "4"
    print(json.dumps({"case": "unprivileged_permissions", "result": "passed", "recovered_revision": "4"}), flush=True)
finally:
    if started:
        # Restore only task-owned fixture modes if an assertion failed midway.
        execute("chmod", "700", "/limited/workspace", "/limited/workspace/transactions", expected=None)
        stop()
