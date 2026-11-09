#!/usr/bin/env python3
"""Installed optional UI smoke: INSTALLATION NEW_EVIDENCE [--core PAIRED_CORE]."""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

from verify import decode, encode, sha


def read_ready(stream, destination, *, timeout_seconds=15):
    """Bound the complete readiness line, including partial writes and EOF."""
    deadline = time.monotonic() + timeout_seconds
    received = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(stream, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("Installed companion complete readiness deadline")
                chunk = os.read(stream.fileno(), 65537 - len(received))
                if not chunk:
                    raise ValueError("Installed companion ended before complete readiness")
                received.extend(chunk)
                if len(received) > 65536:
                    raise ValueError("Installed companion readiness exceeds 64KiB")
                if b"\n" in received:
                    if received.count(b"\n") != 1 or not received.endswith(b"\n"):
                        raise ValueError("Installed companion emitted extra readiness output")
                    return bytes(received)
    finally:
        destination.write_bytes(received)


def qualify(installation, evidence, *, core=None, companion=None):
    installation = installation.resolve(strict=True)
    evidence = evidence.absolute()
    evidence.mkdir(mode=0o700)
    companion = companion.resolve(strict=True) if companion else installation / "bin/workgraph-ui"
    core = core.resolve(strict=True) if core else installation / "bin/workgraph"
    manifest_bytes = (installation / "ui-package/asset-manifest.json").read_bytes()
    manifest = decode(manifest_bytes)
    expected = manifest["package_version"]
    package = decode((installation / "MANIFEST.json").read_bytes())
    if package["version"] != expected or package["files"]["bin/workgraph"] != sha(core.read_bytes()) \
            or package["files"]["bin/workgraph-ui"] != sha(companion.read_bytes()) \
            or package["files"]["ui-package/asset-manifest.json"] != sha(manifest_bytes):
        raise ValueError("Installed UI/core/asset bytes differ from independent package manifest")
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(evidence / "home"), "TMPDIR": "/tmp"}
    (evidence / "home").mkdir()
    for binary in (core, companion):
        version = subprocess.run([str(binary), "--version"], env=environment, capture_output=True,
                                 text=True, check=True, timeout=10).stdout.strip()
        if version != expected:
            raise ValueError("Installed paired executable version mismatch")
    processes = []
    records = []
    with tempfile.TemporaryDirectory(prefix="wg-ui-package-") as private:
        # State_root.path reports the physical path (macOS /tmp is a symlink).
        # Derive every owned path from that same root, retaining exact equality.
        root = Path(private).resolve(strict=True)
        socket = root / "s"
        try:
            with (evidence / "daemon.log").open("wb") as daemon_log, \
                    (evidence / "ui.stderr.log").open("wb") as ui_log:
                daemon = subprocess.Popen([str(core), "serve", str(root / "registry"), str(socket)],
                                          env=environment, stdout=daemon_log, stderr=daemon_log)
                processes.append(("daemon", daemon))
                deadline = time.monotonic() + 15
                while True:
                    if daemon.poll() is not None:
                        raise RuntimeError("Owned installed daemon exited during startup")
                    probe = subprocess.run([str(core), "call", str(socket), "initialize", "{}"],
                                           env=environment, capture_output=True, timeout=3)
                    if probe.returncode == 0:
                        initialized = decode(probe.stdout)["result"]["data"]
                        if initialized["version"] != expected:
                            raise ValueError("Paired daemon initialize version mismatch")
                        break
                    if time.monotonic() > deadline:
                        raise TimeoutError("Owned installed daemon readiness deadline")
                    time.sleep(0.02)
                state = root / "ui"
                ui = subprocess.Popen([str(companion), "--state-root", str(state), "--host", "127.0.0.1", "--no-open",
                                       "--daemon-executable", str(core)],
                                      env=environment, stdout=subprocess.PIPE, stderr=ui_log)
                processes.append(("companion", ui))
                ready_bytes = read_ready(ui.stdout, evidence / "readiness.json")
                ready = decode(ready_bytes)
                if set(ready) != {"format", "event", "url", "state_root", "asset_manifest_sha256", "api_prefix", "host", "port"} \
                        or ready["format"] != "workgraph-ui-ready-1" or ready["event"] != "ready" \
                        or ready["state_root"] != str(state) or ready["host"] != "127.0.0.1" \
                        or ready["url"] != "http://127.0.0.1:" + ready["port"] + "/" \
                        or ready["api_prefix"] != "/ui-api/v1" \
                        or ready["asset_manifest_sha256"] != sha(manifest_bytes):
                    raise ValueError("Installed companion readiness/manifest mismatch")
                base = ready["url"].rstrip("/")

                def request(path, body=None, capability=None):
                    headers = {"Origin": base}
                    if capability:
                        headers["X-Workgraph-UI-Capability"] = capability
                    data = encode(body) if body is not None else None
                    if data is not None:
                        headers["Content-Type"] = "application/json"
                    with urlopen(Request(base + path, data=data, headers=headers), timeout=10) as response:
                        return response.read(16 * 1024 * 1024 + 1), response.headers.get("Content-Type")

                capability = None
                for asset in manifest["assets"]:
                    body, content_type = request(asset["path"])
                    if content_type != asset["content_type"]:
                        raise ValueError("Installed asset content type mismatch: " + asset["path"])
                    if asset["path"] == "/index.html":
                        match = re.search(rb'<meta name="workgraph-capability" content="([a-f0-9]{64})"', body)
                        if not match:
                            raise ValueError("Installed bootstrap launch capability missing")
                        capability = match[1].decode()
                        body = body.replace(match[1], b"__WORKGRAPH_UI_CAPABILITY__", 1)
                    if sha(body) != asset["sha256"] or len(body) != int(asset["size_bytes"]):
                        raise ValueError("Installed embedded asset hash/size mismatch: " + asset["path"])
                    records.append({"path": asset["path"], "sha256": sha(body), "size_bytes": str(len(body))})
                if capability is None:
                    raise ValueError("Bootstrap asset not checked")

                def api(path, body):
                    raw, _ = request("/ui-api/v1" + path, body, capability)
                    name = "attach-response.json" if path.endswith("/attach") else "profile-response.json"
                    (evidence / name).write_bytes(raw)
                    response = decode(raw)
                    if response.get("ok") is not True:
                        raise ValueError("Installed companion API failure")
                    return response["data"]

                profile = api("/connections", {"id": "installed", "label": "Owned package smoke", "socket": str(socket)})
                attached = api("/connections/installed/attach", {"generation": profile["generation"]})
                if attached["connection"] != profile or attached["initialize"]["data"]["version"] != expected:
                    raise ValueError("Installed companion failed paired daemon qualification/attach")
                result = {"status": "passed", "version": expected, "assets": records,
                          "core_sha256": sha(core.read_bytes()), "ui_sha256": sha(companion.read_bytes()),
                          "asset_manifest_sha256": sha(manifest_bytes),
                          "checks": ["paired-versions", "readiness-manifest", "all-embedded-bytes-and-types", "owned-daemon-attach"],
                          "isolation": "env -i equivalent; PATH=/usr/bin:/bin; no Node/opam/compiler needed at runtime",
                          "limits": ["No graphical browser or platform signing qualification", "Only owned fresh daemon and companion"]}
        finally:
            exits = []
            for name, process in reversed(processes):
                before = process.poll()
                if before is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()
                exits.append({"name": name, "pid": process.pid, "before_cleanup": before, "exit": process.returncode})
            (evidence / "processes.json").write_bytes(encode(exits))
    (evidence / "result.json").write_bytes(encode(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installation", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--core", type=Path)
    parser.add_argument("--companion", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(qualify(arguments.installation, arguments.evidence, core=arguments.core,
                             companion=arguments.companion), sort_keys=True))
