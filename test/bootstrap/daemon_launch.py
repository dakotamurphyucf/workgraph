#!/usr/bin/env python3
"""Owned real-process fixtures for the optional companion's fixed local launch helper."""
import contextlib
import http.client
import json
import os
import pathlib
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

ui = pathlib.Path(sys.argv[1]).resolve()
core = pathlib.Path(sys.argv[2]).resolve()
checks = 0
owned_group_id = None


def check(condition, label):
    global checks
    if not condition:
        raise AssertionError(label)
    checks += 1


def bounded_line(stream, timeout, maximum=16384):
    """A readable prefix is not a complete line; deadline covers every byte."""
    deadline = time.monotonic() + timeout
    data = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise AssertionError("readiness deadline expired before a complete record")
            chunk = os.read(stream.fileno(), min(4096, maximum + 1 - len(data)))
            if not chunk:
                raise AssertionError("owned child closed stdout before a complete record")
            data.extend(chunk)
            if len(data) > maximum:
                raise AssertionError("readiness record exceeds byte bound")
    return bytes(data).split(b"\n", 1)[0].decode("utf8")


def stop_child(process, grace=3):
    """Retain the direct child handle until TERM/KILL exit is confirmed and reaped."""
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


@contextlib.contextmanager
def owned_process_group():
    """A live keeper prevents group-ID reuse until every owned member is killed.

    The test runner remains in a different group in its inherited session.
    Companions and their detached children join only this keeper's group. Thus
    cleanup covers late/unbound children without selecting by socket or guessed PID.
    """
    global owned_group_id
    keeper = subprocess.Popen(
        [sys.executable, "-c", "import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('keeper-ready', flush=True); signal.pause()"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        process_group=0,
    )
    try:
        if bounded_line(keeper.stdout, 3) != "keeper-ready":
            raise AssertionError("owned group keeper failed")
        owned_group_id = keeper.pid
        yield
    finally:
        if keeper.poll() is None:
            os.killpg(keeper.pid, signal.SIGTERM)
            # Keeper ignores TERM, retaining the exact group identity for KILL.
            time.sleep(0.05)
            os.killpg(keeper.pid, signal.SIGKILL)
        keeper.wait(timeout=3)
        keeper.stdout.close()
        owned_group_id = None


@contextlib.contextmanager
def companion(root, command=None, cwd=None, env=None, executable=None):
    pathlib.Path(root).mkdir(mode=0o700, parents=True, exist_ok=True)
    state = pathlib.Path(root) / "state"
    args = [str(ui)] if command is None else command
    args = args + ["--state-root", str(state), "--no-open"]
    if executable is not None:
        args += ["--daemon-executable", str(executable)]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=False, cwd=cwd, env=env, process_group=owned_group_id)
    try:
        line = bounded_line(process.stdout, 8)
        ready = json.loads(line)
        check(ready["event"] == "ready", "machine readiness")
        address = urlsplit(ready["url"])
        connection = http.client.HTTPConnection(address.hostname, address.port, timeout=8)
        connection.request("GET", "/")
        response = connection.getresponse()
        html = response.read().decode()
        check(response.status == 200, "bootstrap HTTP")
        token = re.search(r'name="workgraph-capability" content="([a-f0-9]{64})"', html)
        if token is None:
            raise AssertionError("capability marker absent")
        connection.close()

        def request(method, path, body=None):
            client = http.client.HTTPConnection(address.hostname, address.port, timeout=8)
            headers = {"X-Workgraph-UI-Capability": token.group(1)}
            wire = None
            if body is not None:
                headers.update({"Origin": ready["url"].rstrip("/"), "Content-Type": "application/json"})
                wire = json.dumps(body, separators=(",", ":"))
            client.request(method, "/ui-api/v1" + path, body=wire, headers=headers)
            response = client.getresponse()
            payload = json.loads(response.read())
            status = response.status
            client.close()
            return status, payload

        yield request, ready
    finally:
        stop_child(process)
        process.stdout.close()
        process.stderr.close()


def success(result):
    status, payload = result
    check(status in (200, 202) and payload.get("ok") is True, "typed HTTP success")
    return payload["data"]


def settle(request, intention):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        launch = success(request("GET", "/daemon-launches/" + intention))
        if launch["state"]["status"] != "starting":
            return launch
        time.sleep(0.025)
    raise AssertionError("local launch did not settle")


def lifecycle_regressions():
    with tempfile.TemporaryDirectory(prefix="wg-launch-owner-", dir="/tmp") as temporary:
        late_marker = pathlib.Path(temporary) / "late-effect"
        with owned_process_group():
            partial = subprocess.Popen([sys.executable,"-c","import os,time;os.write(1,b'{');time.sleep(30)"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,process_group=owned_group_id)
            try:
                try:
                    bounded_line(partial.stdout,0.05)
                    raise AssertionError("partial readiness was accepted")
                except AssertionError as error:
                    check("deadline" in str(error),"partial readiness bytes remain deadline bounded")
            finally:
                stop_child(partial,grace=0.05)
                partial.stdout.close()
            stubborn=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(30)"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,process_group=owned_group_id)
            try:
                bounded_line(stubborn.stdout,3)
                stop_child(stubborn,grace=0.05)
                check(stubborn.returncode == -signal.SIGKILL,"TERM-resistant owned child is killed and reaped")
            finally:
                stop_child(stubborn,grace=0.05)
                stubborn.stdout.close()
            late=subprocess.Popen([sys.executable,"-c","import pathlib,sys,time;time.sleep(.2);pathlib.Path(sys.argv[1]).write_text('late')",str(late_marker)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,process_group=owned_group_id)
        late.wait(timeout=3)
        check(late.returncode < 0 and not late_marker.exists(),"private process group cleans an unbound late child before temporary root removal")


lifecycle_regressions()


with tempfile.TemporaryDirectory(prefix="wg-launch-", dir="/tmp") as temporary, owned_process_group():
    root = pathlib.Path(temporary)
    install = root / "bin"
    install.mkdir()
    (install / "workgraph-ui").symlink_to(ui)
    (install / "workgraph").symlink_to(core)
    environment = {**os.environ, "PATH": str(install) + ":/usr/bin:/bin"}
    with companion(root / "path", ["workgraph-ui"], env=environment) as (request, _):
        capabilities = success(request("GET", "/daemon-capabilities"))
        check(capabilities["available"] is True and capabilities["executable"] == str(install.resolve() / "workgraph"), "actual PATH invocation selects paired logical install directory")
    with companion(root / "relative", ["./workgraph-ui"], cwd=install, env=environment) as (request, _):
        capabilities = success(request("GET", "/daemon-capabilities"))
        check(capabilities["available"] is True and capabilities["executable"] == str(install.resolve() / "workgraph"), "actual relative invocation canonical cwd")
    physical = root / "physical"
    physical.mkdir()
    shutil.copyfile(ui, physical / "workgraph-ui")
    (physical / "workgraph-ui").chmod(0o700)
    (physical / "workgraph").symlink_to(core)
    links = root / "links"
    links.mkdir()
    (links / "ui-link").symlink_to(physical / "workgraph-ui")
    with companion(root / "symlink", [str(links / "ui-link")]) as (request, _):
        capabilities = success(request("GET", "/daemon-capabilities"))
        check(capabilities["available"] is True and capabilities["executable"] == str(physical.resolve() / "workgraph"), "actual symlink invocation resolves physical paired directory")
    with companion(root / "default") as (request, _):
        capabilities = success(request("GET", "/daemon-capabilities"))
        check(capabilities["available"] is False, "missing Dune sibling disables startup only")
        check(success(request("GET", "/connections"))["items"] == [], "profile read survives unavailable core")
    wrong = root / "wrong-core"
    wrong.write_text("#!/bin/sh\nprintf 'wrong-version\\n'\n")
    wrong.chmod(0o700)
    with companion(root / "wrong", executable=wrong) as (request, _):
        capabilities = success(request("GET", "/daemon-capabilities"))
        check(capabilities["available"] is False and capabilities["problem"]["kind"] == "Unsupported_version", "wrong-version pairing is typed and does not stop service")
        success(request("GET", "/connections"))

    local = root / "local"
    local.mkdir()
    socket = local / "daemon.sock"
    registry = local / "registry"
    intention = "process-fixture"
    observed = None
    try:
        with companion(local, executable=core) as (request, _):
            profile = success(request("POST", "/connections", {"id": "fixture", "label": "Owned fixture", "socket": str(socket)}))
            plan = {"intention_id": intention, "connection_id": "fixture", "generation": profile["generation"], "context": {"workspace_id": None, "project_id": None, "writer": None}, "registry": str(registry), "log": str(local / "startup.log"), "timeout_seconds": "4"}
            prepared = success(request("POST", "/daemon-launches/prepare", plan))
            check(prepared["state"]["status"] == "prepared_unsent" and not socket.exists(), "saved observer plan never implicitly starts")
            changed = {**plan, "context": {"workspace_id": "changed", "project_id": None, "writer": None}}
            code, payload = request("POST", "/daemon-launches/prepare", changed)
            check(code == 409 and payload["error"]["kind"] == "Idempotency_conflict", "changed context cannot reuse intention")
            success(request("POST", "/daemon-launches/" + intention + "/start", {}))
            observed = settle(request, intention)
            check(observed["state"]["status"] == "ready" and observed["state"]["ownership"] == "unknown", "real detached startup readiness never asserts process ownership")
            attached = success(request("POST", "/connections/fixture/attach", {"generation": profile["generation"]}))
            check(attached["connection"] == profile and "initialize" in attached and "health" in attached, "full current daemon attach handshake")
            code, _ = request("POST", "/daemon-launches/" + intention + "/start", {})
            check(code == 409, "known ready launch does not execute again")
            competing = {**plan, "intention_id": "existing-fixture", "registry": str(local / "unused-registry")}
            success(request("POST", "/daemon-launches/prepare", competing))
            success(request("POST", "/daemon-launches/existing-fixture/start", {}))
            existing = settle(request, "existing-fixture")
            check(existing["state"]["observation"] == "existing_endpoint" and not (local / "unused-registry").exists(), "occupied live endpoint does not spawn or initialize another registry")
        with companion(local, executable=core) as (request, _):
            recovered = success(request("GET", "/daemon-launches/" + intention))
            check(recovered == observed, "successful Ready-save survives actual service restart exactly")
            success(request("POST", "/connections/fixture/attach", {"generation": "1"}))
    finally:
        if socket.exists():
            stopped = subprocess.run([str(core), "--socket", str(socket), "daemon", "shutdown"], capture_output=True, text=True, timeout=8)
            if stopped.returncode != 0:
                raise AssertionError("owned daemon shutdown failed: " + stopped.stdout + stopped.stderr)
            deadline = time.monotonic() + 8
            while socket.exists() and time.monotonic() < deadline:
                time.sleep(0.025)
            check(not socket.exists(), "owned daemon cleaned up its socket after explicit shutdown")

print(f"daemon launch process fixtures: {checks} checks passed")
