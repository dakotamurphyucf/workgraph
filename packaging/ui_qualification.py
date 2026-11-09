#!/usr/bin/env python3
"""Qualify a fresh installed UI pair, owned lifecycle and same-version reinstall.

Browser tooling is an external driver only; native services receive a minimal
runtime environment. See the .pyi contract and --help. Never publishes artifacts.
"""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

import ui_smoke
from verify import decode, encode, extract, read_archive, sha, verify_pair


@dataclass(frozen=True)
class QualificationInputs:
    source_archive: Path
    core_archive: Path
    ui_archive: Path
    evidence: Path
    node: Path
    playwright_module: Path
    browser: Path


OWNED = b"workgraph-ui-owned-qualification-install-1\n"


def data_inventory(root, *, allow_owned_socket=False):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Expected a real owned data directory")
    result = {}
    for current, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(current) / name
            mode = path.lstat().st_mode
            relative = path.relative_to(root).as_posix()
            if stat.S_ISDIR(mode):
                continue
            if stat.S_ISSOCK(mode) and allow_owned_socket and relative == "s":
                # Only the exact owned daemon endpoint may remain after stop.
                continue
            if not stat.S_ISREG(mode):
                raise ValueError("Unexpected link/special data member: " + relative)
            result[relative] = sha(path.read_bytes())
    return result


def remove_owned_installation(installation, *, data, independent_core):
    if installation.is_symlink() or not installation.is_dir() \
            or (installation / ".ui-qualification-owned").is_symlink() \
            or not (installation / ".ui-qualification-owned").is_file() \
            or (installation / ".ui-qualification-owned").read_bytes() != OWNED:
        raise ValueError("Removal requires the exact owned qualification marker")
    for outside in (data, independent_core):
        if outside == installation or installation in outside.parents:
            raise ValueError("Data and independent core must be outside installation")
    # Reject links/special members before recursive deletion, including a changed marker.
    installed = data_inventory(installation)
    before_data, before_core = data_inventory(data, allow_owned_socket=True), data_inventory(independent_core)
    shutil.rmtree(installation)
    after_data, after_core = data_inventory(data, allow_owned_socket=True), data_inventory(independent_core)
    if before_data != after_data or before_core != after_core:
        raise ValueError("Removal changed external data or independent core")
    return {"removed_files": len(installed), "external_data": after_data,
            "independent_core": after_core, "installation_absent": not installation.exists()}


def qualify(inputs):
    source, core_bundle, ui_bundle = map(read_archive, (
        inputs.source_archive, inputs.core_archive, inputs.ui_archive))
    pair_reports = {"core": verify_pair(source, core_bundle), "ui": verify_pair(source, ui_bundle)}
    evidence = inputs.evidence.absolute()
    evidence.mkdir(mode=0o700)
    (evidence / "verified-pairs.json").write_bytes(encode(pair_reports))
    # This existing helper checks exact versions, all served assets and attach.
    install_parent = evidence / "installation"
    independent_parent = evidence / "independent-core"
    install_parent.mkdir()
    independent_parent.mkdir()
    extract(ui_bundle, install_parent)
    extract(core_bundle, independent_parent)
    installation = install_parent / ui_bundle.root
    independent = independent_parent / core_bundle.root
    (installation / ".ui-qualification-owned").write_bytes(OWNED)
    smoke = ui_smoke.qualify(installation, evidence / "http-smoke")
    version = source.manifest["version"]
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(evidence / "runtime-home"), "TMPDIR": "/tmp"}
    Path(environment["HOME"]).mkdir()
    (evidence / "runtime-environment.json").write_bytes(encode({
        "native_environment": environment,
        "external_browser_driver": {"node": str(inputs.node), "playwright": str(inputs.playwright_module),
                                    "browser": str(inputs.browser)},
        "scope": "Browser driver uses build-time tools; native services do not inherit them",
    }))
    processes = []
    browser_results = []
    exchanges = []
    record = None
    saved_operation = None
    with tempfile.TemporaryDirectory(prefix="wg-native-", dir="/tmp") as temporary:
        root = Path(temporary).resolve(strict=True)
        socket, registry, state = root / "s", root / "registry", root / "ui"
        (root / "preserve-user-data.txt").write_text("Owned synthetic external data — preserve 雪\n")
        core = installation / "bin/workgraph"
        companion = installation / "bin/workgraph-ui"

        def call(method, params):
            result = subprocess.run([str(core), "call", str(socket), method, json.dumps(params)],
                                    env=environment, capture_output=True, timeout=10)
            reply = decode(result.stdout)
            exchanges.append({"method": method, "params": params, "response": reply,
                              "exit_code": result.returncode})
            (evidence / "native-exchanges.json").write_bytes(encode(exchanges))
            if result.returncode != 0 or "error" in reply:
                raise RuntimeError("Installed native call failed: " + method + " " + result.stdout.decode())
            return reply["result"]["data"]

        def stop(owned):
            for item in reversed(owned):
                process = item["process"]
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()
                item["exit"] = process.returncode
            (evidence / "owned-processes.json").write_bytes(encode([
                {k: v for k, v in item.items() if k != "process"} for item in processes]))

        def start(phase, explicit_pair):
            owned = []
            try:
                with (evidence / (phase + "-daemon.log")).open("wb") as log:
                    process = subprocess.Popen([str(core), "serve", str(registry), str(socket)],
                                               env=environment, stdout=log, stderr=log)
                item = {"phase": phase, "name": "daemon", "pid": process.pid,
                        "binary_sha256": sha(core.read_bytes()), "process": process}
                owned.append(item)
                processes.append(item)
                deadline = time.monotonic() + 15
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("Installed owned daemon exited during start")
                    probe = subprocess.run([str(core), "call", str(socket), "initialize", "{}"],
                                           env=environment, capture_output=True, timeout=3)
                    if probe.returncode == 0:
                        if decode(probe.stdout)["result"]["data"]["version"] != version:
                            raise ValueError("Installed daemon version differs from independent source")
                        break
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Installed owned daemon start deadline")
                    time.sleep(0.02)
                command = [str(companion), "--state-root", str(state), "--no-open"]
                if explicit_pair:
                    command.extend(["--daemon-executable", str(core)])
                with (evidence / (phase + "-companion.log")).open("wb") as log:
                    process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=log)
                item = {"phase": phase, "name": "companion", "pid": process.pid,
                        "binary_sha256": sha(companion.read_bytes()), "command": command, "process": process}
                owned.append(item)
                processes.append(item)
                ready = decode(ui_smoke.read_ready(process.stdout, evidence / (phase + "-ready.json")))
                manifest_hash = sha((installation / "ui-package/asset-manifest.json").read_bytes())
                if set(ready) != {"format", "event", "url", "state_root", "asset_manifest_sha256", "api_prefix", "host", "port"} \
                        or ready["format"] != "workgraph-ui-ready-1" or ready["event"] != "ready" \
                        or ready["state_root"] != str(state) or ready["host"] != "127.0.0.1" \
                        or ready["url"] != "http://127.0.0.1:" + ready["port"] + "/" \
                        or ready["api_prefix"] != "/ui-api/v1" or ready["asset_manifest_sha256"] != manifest_hash:
                    raise ValueError("Installed exact readiness fields differ")
                base = ready["url"].rstrip("/")
                with urlopen(base, timeout=10) as response:
                    html = response.read(1024 * 1024)
                token = re.search(rb'name="workgraph-capability" content="([a-f0-9]{64})"', html)
                if token is None:
                    raise ValueError("Installed bootstrap capability missing")

                def api(path, data=None):
                    headers = {"Origin": base, "X-Workgraph-UI-Capability": token[1].decode()}
                    body = encode(data) if data is not None else None
                    if body is not None:
                        headers["Content-Type"] = "application/json"
                    with urlopen(Request(base + "/ui-api/v1" + path, data=body, headers=headers), timeout=10) as reply:
                        raw = reply.read(16 * 1024 * 1024 + 1)
                    if len(raw) > 16 * 1024 * 1024:
                        raise ValueError("Qualification API reply exceeds supported bound")
                    result = decode(raw)
                    exchanges.append({"phase": phase, "path": path, "request": data, "response": result})
                    (evidence / "native-exchanges.json").write_bytes(encode(exchanges))
                    if result.get("ok") is not True:
                        raise ValueError("Installed API request failed: " + path)
                    return result["data"]
                return owned, ready, api
            except BaseException:
                stop(owned)
                raise

        try:
            for phase in ("create", "restart", "reinstall"):
                owned, ready, api = start(phase, phase == "create")
                try:
                    if phase == "create":
                        call("workspace.create", {"workspace_id": "demo", "actor_id": "installed-author",
                             "mutation_id": "installed-workspace", "name": "Owned installed qualification",
                             "root": str(root / "workspace")})
                        call("project.create", {"workspace_id": "demo", "actor_id": "installed-author",
                             "mutation_id": "installed-project", "project_id": "release", "title": "Installed package"})
                        api("/connections", {"id": "installed", "label": "Installed qualification", "socket": str(socket)})
                    profiles = api("/connections")
                    (evidence / (phase + "-profiles.json")).write_bytes(encode(profiles))
                    api("/connections/installed/attach", {"generation": "1"})
                    output = evidence / (phase + "-browser")
                    command = [str(inputs.node), str(Path(__file__).with_name("ui_qualification.browser.mjs")),
                               str(inputs.playwright_module), str(inputs.browser), ready["url"], phase, str(output)]
                    # The driver owns and closes its BrowserServer on TERM; retain a
                    # bounded fallback for a crashed/stalled driver and its process group.
                    driver = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              start_new_session=True)
                    try:
                        stdout, stderr = driver.communicate(timeout=90)
                    except BaseException:
                        try:
                            os.killpg(driver.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            stdout, stderr = driver.communicate(timeout=5)
                        except subprocess.TimeoutExpired:
                            try:
                                os.killpg(driver.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            stdout, stderr = driver.communicate(timeout=5)
                        (evidence / (phase + "-browser.stdout")).write_bytes(stdout)
                        (evidence / (phase + "-browser.stderr")).write_bytes(stderr)
                        raise
                    (evidence / (phase + "-browser.stdout")).write_bytes(stdout)
                    (evidence / (phase + "-browser.stderr")).write_bytes(stderr)
                    if driver.returncode != 0:
                        raise RuntimeError("Installed browser driver failed: " + stderr.decode(errors="replace"))
                    result = decode(stdout)
                    if result["phase"] != phase or result["failures"] or result["observedTicketId"] != "installed-browser-ticket":
                        raise ValueError("Installed graphical browser proof incomplete")
                    browser_results.append(result)
                    ticket = call("ticket.read", {"workspace_id": "demo", "ticket_id": "installed-browser-ticket"})["ticket"]
                    if ticket["title"] != "Installed browser publication" or ticket["revision"] != "1" \
                            or ticket["description"] != "Installed exact Unicode 雪\nTrailing LF preserved.\n":
                        raise ValueError("Installed browser transaction/readback changed after lifecycle boundary")
                    operations = api("/operations")
                    (evidence / (phase + "-operations.json")).write_bytes(encode(operations))
                    if operations["remaining"] != "0" or operations["next_offset"] is not None or len(operations["items"]) != 1:
                        raise ValueError("Expected one complete installed saved operation")
                    summary = operations["items"][0]
                    if summary["method"] != "ticket.create" or summary["actor_id"] != "installed-author" \
                            or summary["state_kind"] != "committed":
                        raise ValueError("Installed saved operation attribution/state differs")
                    operation = api("/operations/" + summary["operation_id"])
                    if operation["request"]["params"]["ticket_id"] != "installed-browser-ticket":
                        raise ValueError("Saved request no longer identifies exact created ticket")
                    if saved_operation is None:
                        saved_operation = encode(operation)
                    elif encode(operation) != saved_operation:
                        raise ValueError("Restart/reinstall changed saved request, receipt or journal identity")
                    (evidence / (phase + "-saved-operation.json")).write_bytes(encode(operation))
                finally:
                    stop(owned)
                if phase == "restart":
                    before = data_inventory(root, allow_owned_socket=True)
                    # Real remove/reextract of the same verified version, while stopped.
                    remove_owned_installation(installation, data=root, independent_core=independent)
                    extract(ui_bundle, install_parent)
                    (installation / ".ui-qualification-owned").write_bytes(OWNED)
                    if data_inventory(root, allow_owned_socket=True) != before:
                        raise ValueError("Reinstall changed stopped external data")
                    (evidence / "reinstall-data.json").write_bytes(encode(before))
            removal = remove_owned_installation(installation, data=root, independent_core=independent)
            # Retain hashes and semantic replies, never copy live/private daemon state.
            record = {"status": "passed", "version": version, "http_smoke": smoke,
                      "browser": browser_results, "removal": removal,
                      "artifacts": {"source": sha(inputs.source_archive.read_bytes()),
                                    "core": sha(inputs.core_archive.read_bytes()),
                                    "ui": sha(inputs.ui_archive.read_bytes())},
                      "checks": ["fresh-verified-extraction", "minimal-runtime-environment", "all-embedded-assets",
                                 "installed-browser-transaction-native-readback", "explicit-and-sibling-pair-path",
                                 "stop-restart-profile-and-operation-inventory", "same-version-reinstall-data",
                                 "removal-preserves-external-data-and-independent-core"],
                      "limits": ["Actual host/browser only; not a toolchain-free machine or Gatekeeper qualification",
                                 "Same-version reinstall, not cross-release migration", "No Alma/RPM/WSL/Safari result inferred"]}
        finally:
            stop(processes)
    (evidence / "result.json").write_bytes(encode(record))
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source_archive", "core_archive", "ui_archive", "evidence", "node", "playwright_module", "browser"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    print(json.dumps(qualify(QualificationInputs(**vars(args))), sort_keys=True))
