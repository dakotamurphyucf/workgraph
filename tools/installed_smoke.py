#!/usr/bin/env python3
"""CLI-only fresh-runtime qualification. EXE NEW_ABSOLUTE_DIRECTORY.

Uses installed executable with a minimal environment, ordinary Git, and no OCaml
toolchain at runtime. Keeps evidence/artifacts; stops only daemons it created.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

exe = Path(sys.argv[1]).resolve(strict=True)
root = Path(sys.argv[2])
if not root.is_absolute():
    raise SystemExit("fresh absolute runtime directory required")
root.mkdir(mode=0o700)
environment = {key: value for key, value in os.environ.items() if key in {"HOME", "TMPDIR"}}
environment["PATH"] = "/usr/bin:/bin"
socket_directory = tempfile.TemporaryDirectory(prefix="wg-install-")
address = str(Path(socket_directory.name) / "s")
process = None
daemon_log = (root / "daemon.log").open("ab")
evidence = (root / "walkthrough.jsonl").open("w")
counter = 0


def run(arguments):
    return subprocess.run(arguments, env=environment, capture_output=True, text=True, check=True)


def call(method, params):
    completed = run([str(exe), "call", address, method, json.dumps(params)])
    response = json.loads(completed.stdout)
    evidence.write(json.dumps({"method": method, "params": params, "response": response}) + "\n")
    evidence.flush()
    return response["result"]


def admin(method, **params):
    global counter
    counter += 1
    return call(method, {"actor_id": "operator", "mutation_id": "admin-" + str(counter), **params})


def mutate(method, **params):
    global counter
    counter += 1
    return call(method, {"workspace_id": "smoke", "actor_id": "agent", "run_id": "installed",
                         "mutation_id": "work-" + str(counter), **params})


def start(registry):
    global process
    process = subprocess.Popen([str(exe), "serve", str(root / registry), address],
                               env=environment, stdout=daemon_log, stderr=daemon_log)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("daemon exited: " + (root / "daemon.log").read_text())
        try:
            assert call("initialize", {})["version"] == "0.1.0"
            return
        except subprocess.CalledProcessError:
            time.sleep(0.02)
    raise RuntimeError("startup timeout")


def stop():
    call("daemon.shutdown", {})
    process.wait(timeout=30)


def context(ticket):
    return call("ticket.context", {"workspace_id": "smoke", "ticket_id": ticket})["data"]


def complete(ticket):
    observed = context(ticket)["ticket"]["revision"]
    claim = mutate("ticket.claim", ticket_id=ticket, expected_revision=observed)
    token = claim["result"]["token"]
    mutate("ticket.progress", ticket_id=ticket, token=token, body="Installed binary validation passed")
    mutate("handoff.set", ticket_id=ticket, token=token, expected_revision="0",
           summary="Validated from a fresh runtime", next_steps="Read the next ready ticket",
           evidence="CLI workflow and durable receipt", resource_ids=["notes"])
    mutate("ticket.complete", ticket_id=ticket, token=token, evidence="Installed CLI smoke passed")
    assert context(ticket)["ticket"]["status"] == "done"


def git(directory, *args):
    return run(["git", "-C", str(directory), *args])


try:
    assert run([str(exe), "--version"]).stdout.strip() == "0.1.0"
    start("registry-1")
    admin("workspace.create", workspace_id="smoke", name="Installed workflow", root=str(root / "workspace"))
    mutate("project.create", project_id="project", title="Standalone qualification")
    for ticket in ["first", "second"]:
        mutate("ticket.create", ticket_id=ticket, title=ticket, project_id="project")
    mutate("dependency.add", ticket_id="second", prerequisite_id="first")
    mutate("resource.put_text", resource_id="notes", expected_revision="0", title="Evidence", text="Installed CLI only")
    complete("first")
    job = admin("workspace.export", workspace_id="smoke", destination=str(root / "export"))
    deadline = time.monotonic() + 60
    while True:
        current = call("export.get", {"job_id": job["job_id"]})
        if current["status"] != "running":
            assert current["status"] == "completed", current
            break
        if time.monotonic() > deadline:
            raise RuntimeError("export timeout")
        time.sleep(0.02)
    call("export.verify", {"directory": str(root / "export")})
    admin("workspace.close", workspace_id="smoke")
    stop()
    source, clone = root / "workspace", root / "clone"
    git(source, "init", "-q")
    git(source, "add", ".")
    assert ".local/" not in git(source, "ls-files").stdout
    git(source, "-c", "user.name=Workgraph qualification", "-c", "user.email=fixture@localhost",
        "-c", "commit.gpgsign=false", "commit", "-qm", "Closed writer handoff")
    run(["git", "clone", "-q", str(source), str(clone)])
    start("registry-2")
    admin("workspace.register", root=str(clone))
    assert context("first")["ticket"]["status"] == "done"
    complete("second")
    admin("workspace.close", workspace_id="smoke")
    stop()
    start("registry-3")
    admin("workspace.restore", directory=str(root / "export"), root=str(root / "restored"))
    assert not call("daemon.health", {})["workspaces"][0]["open"]
    admin("workspace.open", workspace_id="smoke")
    assert context("first")["ticket"]["status"] == "done"
    assert context("second")["ticket"]["status"] == "todo"
    assert context("first")["handoff"]["summary"] == "Validated from a fresh runtime"
    stop()
    print(json.dumps({"result": "passed", "executable": str(exe), "runtime": str(root),
                      "checks": ["version", "create", "claim", "progress", "handoff", "complete",
                                 "resource", "export", "verify", "git-clone-resume", "restore"]}))
finally:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    evidence.close()
    daemon_log.close()
    socket_directory.cleanup()
