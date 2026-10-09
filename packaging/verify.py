#!/usr/bin/env python3
"""Validate complete source/native bundles before extraction or installed execution.

Hashes establish agreement between the supplied archives, not publisher identity.
The embedded native record describes inspection; runtime qualification is separate.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


DIGEST = re.compile(r"[0-9a-f]{64}")
NATIVE_SOURCE_FILES = frozenset({
    "README.md", "AGENT_GUIDE.md", "engineering-standards.md", "LICENSE",
    "tools/check_agent_guide.py", "tools/generate_api_reference.py",
    "tools/installed_smoke.py", "packaging/macos/inspect.py", "packaging/verify.py",
})


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate JSON field: " + name)
        result[name] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object)


def safe_name(name):
    if (not isinstance(name, str) or not name or "\\" in name or "\x00" in name
            or name.startswith("/") or any(part in {"", ".", ".."} for part in name.split("/"))):
        raise ValueError("Unsafe archive-relative path: " + str(name))
    return name


def validate_notices(files):
    """Check the collector's actual inventory against every declared license text."""
    prefix = "THIRD_PARTY_NOTICES/"
    inventory = decode(files[prefix + "INVENTORY.json"])
    if inventory["schema"] != 1 or not inventory["packages"]:
        raise ValueError("Missing dependency notice package inventory")
    identities = set()
    declared = {prefix + "INVENTORY.json", prefix + "README.md"}
    for package in inventory["packages"]:
        name, version = safe_name(package["name"]), safe_name(package["version"])
        if "/" in name or "/" in version or (name, version) in identities:
            raise ValueError("Invalid or duplicate dependency identity")
        identities.add((name, version))
        licenses = package["license_files"]
        if package["source_url_opam"] and not licenses:
            raise ValueError("Dependency source has no license texts: " + name)
        for relative, digest in licenses.items():
            path = prefix + name + "/" + version + "/" + safe_name(relative)
            if not isinstance(digest, str) or not DIGEST.fullmatch(digest) or sha(files[path]) != digest:
                raise ValueError("Dependency notice hash mismatch: " + path)
            declared.add(path)
    actual = {name for name in files if name.startswith(prefix)}
    if actual != declared:
        raise ValueError("Dependency notice files disagree with inventory")


@dataclass(frozen=True)
class Bundle:
    root: str
    manifest: dict
    files: dict
    modes: dict


def read_archive(path):
    """Read one root of regular files, validating exact inventory and all hashes."""
    files, modes, roots, directories, names = {}, {}, set(), set(), set()
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = safe_name(member.name.rstrip("/") if member.isdir() else member.name)
            if name in names:
                raise ValueError("Duplicate archive member: " + name)
            names.add(name)
            parts = PurePosixPath(name).parts
            roots.add(parts[0])
            if member.isdir():
                if member.mode != 0o755:
                    raise ValueError("Archive directory mode must be0755: " + name)
                directories.add(name)
            elif member.isfile() and len(parts) > 1:
                relative = "/".join(parts[1:])
                expected_mode = 0o755 if relative in {"dev", "bin/workgraph"} or relative.endswith(".sh") else 0o644
                if member.mode != expected_mode:
                    raise ValueError("Unexpected archive file mode: " + name)
                files[relative] = archive.extractfile(member).read()
                modes[relative] = member.mode
            else:
                raise ValueError("Archive contains a link, special file or root file: " + name)
    if len(roots) != 1:
        raise ValueError("Expected exactly one archive root")
    root = roots.pop()
    full_files = {root + "/" + name for name in files}
    for name in full_files | directories:
        if any(str(parent) in full_files for parent in PurePosixPath(name).parents):
            raise ValueError("Archive file is also a parent directory: " + name)
    for directory in directories:
        if directory != root and not any((root + "/" + name).startswith(directory + "/") for name in files):
            raise ValueError("Unreferenced archive directory: " + directory)
    manifest = decode(files.pop("MANIFEST.json"))
    declared = manifest["files"]
    if set(files) != set(declared):
        raise ValueError("Archive file inventory disagrees with manifest")
    for name, digest in declared.items():
        safe_name(name)
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest) or sha(files[name]) != digest:
            raise ValueError("Archive file hash mismatch: " + name)
    identity = manifest["source_identity"]
    if not isinstance(identity, str) or not DIGEST.fullmatch(identity):
        raise ValueError("Invalid source identity")
    if manifest["kind"] == "source":
        if root != "workgraph-" + manifest["version"] or identity != sha(encode(declared)):
            raise ValueError("Source root or identity disagrees with source contents")
    elif manifest["kind"] == "native":
        if root != "workgraph-" + manifest["version"] + "-" + manifest["platform"]:
            raise ValueError("Native root disagrees with target")
        if modes.get("bin/workgraph") != 0o755:
            raise ValueError("Native executable must have mode0755")
    else:
        raise ValueError("Unknown archive kind")
    return Bundle(root, manifest, files, modes)


def verify_pair(source, native):
    """Validate source agreement, complete installed guides, notices and provenance."""
    if source.manifest["kind"] != "source" or native.manifest["kind"] != "native":
        raise ValueError("Expected source and native archives")
    for field in ("version", "source_identity"):
        if source.manifest[field] != native.manifest[field]:
            raise ValueError("Source/native mismatch: " + field)
    expected = {name for name in source.files
                if name in NATIVE_SOURCE_FILES or name.startswith(("docs/", "examples/"))}
    extras = {name for name in native.files
              if name not in expected and name not in {"bin/workgraph", "QUALIFICATION.json"}
              and not name.startswith("THIRD_PARTY_NOTICES/")}
    if extras or not expected.issubset(native.files):
        raise ValueError("Native package source file inventory is incomplete or unexpected")
    for name in expected:
        if source.files[name] != native.files[name]:
            raise ValueError("Native/source content mismatch: " + name)
    validate_notices(native.files)
    record = decode(native.files["QUALIFICATION.json"])
    if (record["schema"] != 1 or record["status"] != "inspection-only"
            or record["platform"] != native.manifest["platform"]
            or record["source_identity"] != native.manifest["source_identity"]
            or record["executable_sha256"] != sha(native.files["bin/workgraph"])
            or not isinstance(record["inspection"], dict)):
        raise ValueError("Native inspection record disagrees with executable/source/target")
    return {"status": "passed", "files": len(native.files),
            "source_identity": native.manifest["source_identity"],
            "executable_sha256": record["executable_sha256"]}


def regular_files(directory):
    paths = set()
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Expected real installed directory: " + str(directory))
    for path in directory.rglob("*"):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Installed link or special file: " + str(path))
        if path.is_file():
            paths.add(path.relative_to(directory).as_posix())
    return paths


def verify_installation(native, directory, *, rpm=False):
    """Check exact installed inventory; RPM uses the spec's explicit path mapping."""
    if rpm:
        doc = directory / "usr/share/doc/workgraph"
        licenses = directory / "usr/share/licenses/workgraph"
        def location(name):
            if name == "bin/workgraph":
                return directory / "usr/bin/workgraph"
            if name == "LICENSE" or name.startswith("THIRD_PARTY_NOTICES/"):
                return licenses / name
            return doc / name
        expected_doc = {name for name in native.files if location(name).is_relative_to(doc)} | {"MANIFEST.json"}
        expected_licenses = {name for name in native.files if location(name).is_relative_to(licenses)}
        if regular_files(doc) != expected_doc or regular_files(licenses) != expected_licenses:
            raise ValueError("Installed RPM inventory differs from native archive")
        manifest_path = doc / "MANIFEST.json"
    else:
        if regular_files(directory) != set(native.files) | {"MANIFEST.json"}:
            raise ValueError("Installed native inventory differs from native archive")
        def location(name):
            return directory / name
        manifest_path = directory / "MANIFEST.json"
    if decode(manifest_path.read_bytes()) != native.manifest:
        raise ValueError("Installed manifest differs from archive")
    for name, data in native.files.items():
        path = location(name)
        if (path.is_symlink() or not path.is_file() or sha(path.read_bytes()) != sha(data)
                or path.stat().st_mode & 0o7777 != native.modes[name]):
            raise ValueError("Installed native hash mismatch: " + name)


def extract(native, directory):
    """Write validated in-memory files into an existing empty real directory."""
    if regular_files(directory) or any(directory.iterdir()):
        raise ValueError("Extraction directory must be empty")
    root = directory / native.root
    root.mkdir(mode=0o755)
    for name, data in {**native.files, "MANIFEST.json": encode(native.manifest)}.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(data)
        path.chmod(native.modes[name])
    verify_installation(native, root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native", type=Path)
    parser.add_argument("source", type=Path)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--extract", type=Path)
    action.add_argument("--installation", type=Path)
    parser.add_argument("--rpm", action="store_true")
    args = parser.parse_args()
    if args.rpm and not args.installation:
        parser.error("--rpm requires --installation filesystem root")
    native, source = read_archive(args.native), read_archive(args.source)
    report = verify_pair(source, native)
    if args.extract:
        extract(native, args.extract)
    if args.installation:
        verify_installation(native, args.installation, rpm=args.rpm)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
