#!/usr/bin/env python3
"""Fetch one fixed optional UI build input into a fresh caller-owned directory."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import tarfile
from urllib.request import urlopen

INPUTS = {
    "cohttp": {"url": "https://github.com/mirage/ocaml-cohttp/archive/refs/tags/v6.3.0.tar.gz",
               "algorithm": "sha256", "digest": "375003e60f2a8e068cda750a926f0551b18112d714550f7ddc4c126af47fceeb",
               "root": "ocaml-cohttp-6.3.0", "packages": {"http": "6.3.0", "cohttp": "6.3.0", "cohttp-eio": "6.3.0"}},
    "core-unix": {"url": "https://github.com/janestreet/core_unix/archive/refs/tags/v0.17.1.tar.gz",
                  "algorithm": "sha512", "digest": "c4e8ce9d5885ac8fa8d554a97e1857f3a1c933e0eb5dfd4fe874412b9d09e6d0a2973b644733855553f33f5c859719228f0e6aaf3a2b7eb5befb46fc513750de",
                  "root": "core_unix-0.17.1", "packages": {"core_unix": "v0.17.1"}},
    "node-macos-arm64": {"url": "https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz",
                         "algorithm": "sha256", "digest": "e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42",
                         "root": "node-v22.14.0-darwin-arm64", "packages": {"node": "22.14.0", "npm": "10.9.2"}},
    "node-almalinux-10-x86_64": {"url": "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz",
                               "algorithm": "sha256", "digest": "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
                               "root": "node-v22.14.0-linux-x64", "packages": {"node": "22.14.0", "npm": "10.9.2"}},
}


def extract_verified(data, destination, record):
    if not hasattr(tarfile, "data_filter"):
        raise RuntimeError("Safe upstream extraction requires Python3.12+ or a security-maintained tarfile data_filter backport")
    if hashlib.new(record["algorithm"], data).hexdigest() != record["digest"]:
        raise ValueError("Upstream checksum mismatch; nothing extracted")
    members, identities, seen = [], {}, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = member.name.rstrip("/")
            path = PurePosixPath(name)
            if name in seen or "\\" in name or "\0" in name or path.is_absolute() \
                    or any(part in {"", ".", ".."} for part in name.split("/")) \
                    or path.parts[0] != record["root"]:
                raise ValueError("Unsafe or duplicate upstream archive member")
            seen.add(name)
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname)
                                            if member.issym() else member.linkname)
                if PurePosixPath(member.linkname).is_absolute() or "\\" in member.linkname \
                        or not target.startswith(record["root"] + "/"):
                    raise ValueError("Upstream link escapes source root")
                identities[name] = {"link": member.linkname}
            elif member.isfile():
                identities[name] = {"sha256": hashlib.sha256(archive.extractfile(member).read()).hexdigest()}
            elif not member.isdir():
                raise ValueError("Upstream contains a special file")
            if member.mode & 0o7000:
                raise ValueError("Upstream has privileged file modes")
            members.append(member)
        # data_filter also rejects paths routed through prior escaping symlinks.
        archive.extractall(destination, members=members, filter="data")
    if not (destination / record["root"]).is_dir():
        raise ValueError("Upstream archive lacks expected source root")
    (destination / "upstream.json").write_text(json.dumps({**record, "members": identities}, sort_keys=True, indent=2) + "\n")
    return destination / record["root"]


def fetch(kind, destination):
    record = INPUTS[kind]
    if not destination.is_absolute():
        raise ValueError("Fresh absolute upstream directory required")
    destination.mkdir(mode=0o700)
    with urlopen(record["url"], timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise ValueError("Upstream archive exceeds 128MiB bound")
    root = extract_verified(data, destination, record)
    (destination / "upstream.tar.gz").write_bytes(data)
    return root


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=INPUTS)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    print(fetch(arguments.kind, arguments.destination))
