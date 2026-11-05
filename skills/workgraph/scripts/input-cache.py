#!/usr/bin/env python3
"""Reuse exact immutable resource inputs outside a checkout (Python stdlib only).

Every hit verifies bytes again. Misses use the matching Workgraph downloader,
verify its exact receipt and actual bytes, and publish without replacement.
No daemon writes, implicit latest-version lookup, credentials or mutation journals.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


class CacheError(Exception):
    def __init__(self, kind, message, **details):
        super().__init__(message)
        self.kind, self.message, self.details = kind, message, details

    def as_json(self):
        return {"kind": self.kind, "message": self.message, "details": self.details}


def absolute(value, name):
    path = Path(value)
    if not path.is_absolute() or "\x00" in str(path):
        raise CacheError("Invalid_argument", name + " must be an absolute non-NUL path")
    return path


@dataclass(frozen=True)
class Pin:
    """Validated source and immutable byte identity; metadata revisions are excluded."""
    socket: str
    workspace_id: str
    resource_id: str
    version: str
    digest: str
    size_bytes: int

    @classmethod
    def create(cls, socket, workspace_id, resource_id, version, digest, size_bytes):
        socket = str(absolute(socket, "socket").resolve())
        for name, value in [("workspace_id", workspace_id), ("resource_id", resource_id)]:
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,96}", value):
                raise CacheError("Invalid_argument", name + " must be a validated Workgraph ID")
        if len(version) > 19 or not re.fullmatch(r"[1-9][0-9]*", version) or int(version) > (1 << 62) - 1:
            raise CacheError("Invalid_argument", "version must be a positive canonical content version")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise CacheError("Invalid_argument", "digest must be 64 lowercase SHA-256 characters")
        if len(size_bytes) > 8 or not re.fullmatch(r"0|[1-9][0-9]*", size_bytes) or int(size_bytes) > 64 * 1024 * 1024:
            raise CacheError("Invalid_argument", "size_bytes must be canonical 0..67108864 bytes")
        return cls(socket, workspace_id, resource_id, version, digest, int(size_bytes))

    def as_json(self):
        return {"socket": self.socket, "workspace_id": self.workspace_id,
                "resource_id": self.resource_id, "version": self.version,
                "digest": self.digest, "size_bytes": str(self.size_bytes)}

    def cache_name(self):
        encoded = json.dumps({"cache_format": 1, "pin": self.as_json()},
                             sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest() + ".blob"


def verify(path, pin, missing_ok=False):
    """Open a regular owned leaf without following links; hash every returned hit."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if missing_ok:
            return False
        raise
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise CacheError("Unsafe_path", "cache content must be an owned regular file", path=str(path))
        if metadata.st_size != pin.size_bytes:
            raise CacheError("Corrupt_cache", "cached input size differs from pin", path=str(path))
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = source.read(262144)
            if not chunk:
                break
            size += len(chunk)
            if size > pin.size_bytes:
                raise CacheError("Corrupt_cache", "cached input grew while verifying", path=str(path))
            digest.update(chunk)
        if size != pin.size_bytes or digest.hexdigest() != pin.digest:
            raise CacheError("Corrupt_cache", "cached input SHA-256 differs from pin", path=str(path))
    return True


def cache_directory(path, worktree):
    """Create one private cache leaf, with an existing parent, outside the checkout."""
    path = absolute(path, "cache-directory")
    worktree = absolute(worktree, "worktree").resolve(strict=True)
    if not worktree.is_dir():
        raise CacheError("Invalid_argument", "worktree must be an existing directory")
    if path.is_symlink():
        raise CacheError("Unsafe_path", "cache-directory must not be a symlink")
    path = path.resolve()
    if path == worktree or worktree in path.parents:
        raise CacheError("Invalid_argument", "cache-directory must be outside the worktree")
    # Existing ancestor identity also covers case aliases on insensitive filesystems.
    for ancestor in (path, *path.parents):
        try:
            inside = ancestor.samefile(worktree)
        except FileNotFoundError:
            continue
        if inside:
            raise CacheError("Invalid_argument", "cache-directory must be outside the worktree")
    path.mkdir(mode=0o700, exist_ok=True)
    metadata = path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077):
        raise CacheError("Unsafe_path", "cache-directory must be an owned private directory (0700)",
                         path=str(path))
    return path


def validate_receipt(output, pin, destination):
    try:
        envelope = json.loads(output)
        data = envelope["result"]["data"]
        expected = {"resource_id": pin.resource_id, "version": pin.version,
                    "digest": pin.digest, "size_bytes": str(pin.size_bytes),
                    "destination": str(destination)}
        if data != expected or "error" in envelope:
            raise ValueError("identity differs")
    except (ValueError, KeyError, TypeError) as error:
        raise CacheError("Invalid_receipt", "download receipt differs from exact source pin",
                         destination=str(destination)) from error


def resolve(pin, *, directory, worktree, workgraph, timeout):
    """Return provenance/path/status only after verified hit or no-replace publication.

    Failures/cancellation retain their private stage for inspection. A post-link
    sync failure reports Outcome_unknown with the complete installed path retained;
    rerun this exact pin to reverify it. Same-user cache consumers cooperate: the
    caller owns eviction and must not edit files while other tickets use them.
    """
    directory = cache_directory(directory, worktree)
    workgraph = absolute(workgraph, "workgraph").resolve(strict=True)
    destination = directory / pin.cache_name()
    if verify(destination, pin, missing_ok=True):
        return {"pin": pin.as_json(), "path": str(destination), "status": "hit"}
    stage = Path(tempfile.mkdtemp(prefix=".input-", dir=directory))
    incoming = stage / "content"
    published = False
    try:
        result = subprocess.run(
            [str(workgraph), "resource", "download", pin.socket,
             "--workspace-id", pin.workspace_id, "--resource-id", pin.resource_id,
             "--version", pin.version, "--destination", str(incoming),
             "--timeout", str(timeout)], capture_output=True, text=True, check=False)
        if result.returncode:
            raise CacheError("Download_failed", "resource download failed; private stage retained",
                             exit_code=result.returncode, stage=str(stage),
                             stdout=result.stdout, stderr=result.stderr)
        validate_receipt(result.stdout, pin, incoming)
        verify(incoming, pin)
        descriptor = os.open(incoming, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fchmod(descriptor, 0o400)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.link(incoming, destination, follow_symlinks=False)
            published = True
            status = "stored"
        except FileExistsError:
            verify(destination, pin)
            status = "race_hit"
        directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError as error:
        raise CacheError("Outcome_unknown" if published else "Local_io", str(error),
                         stage=str(stage), path=str(destination)) from error
    # Only remove our private stage after success. Never replace/delete a winner.
    try:
        shutil.rmtree(stage)
    except OSError:
        pass
    return {"pin": pin.as_json(), "path": str(destination), "status": status}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["workgraph", "socket", "workspace-id", "resource-id", "version", "digest",
                 "size-bytes", "cache-directory", "worktree"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--timeout", type=float, default=30,
                        help="per downloader wire operation, seconds (default30)")
    args = parser.parse_args()
    try:
        if not math.isfinite(args.timeout) or not 0 < args.timeout <= 3600:
            raise CacheError("Invalid_argument", "timeout must be finite, positive and at most3600 seconds")
        pin = Pin.create(args.socket, args.workspace_id, args.resource_id,
                         args.version, args.digest, args.size_bytes)
        result = resolve(pin, directory=args.cache_directory, worktree=args.worktree,
                         workgraph=args.workgraph, timeout=args.timeout)
        print(json.dumps(result, sort_keys=True))
        return 0
    except CacheError as error:
        print(json.dumps(error.as_json(), sort_keys=True), file=sys.stderr)
        return 1
    except OSError as error:
        print(json.dumps(CacheError("Local_io", str(error)).as_json(), sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
