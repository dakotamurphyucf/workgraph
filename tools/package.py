#!/usr/bin/env python3
"""Create local source/native preview bundles; never builds, installs or publishes.

Usage: python3 tools/package.py NEW_ABSOLUTE_DIRECTORY
       [--binary ABS_EXECUTABLE --platform PLATFORM]
Only explicit source directories are included, never _build, local data or notes.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def archive(destination, root_name, files, metadata):
    manifest = {**metadata, "files": {name: sha(data) for name, (data, _) in sorted(files.items())}}
    files = {**files, "MANIFEST.json": (encode(manifest), 0o644)}
    with destination.open("xb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as bundle:
                directory = tarfile.TarInfo(root_name)
                directory.type, directory.mode = tarfile.DIRTYPE, 0o755
                bundle.addfile(directory)
                for name, (data, mode) in sorted(files.items()):
                    entry = tarfile.TarInfo(root_name + "/" + name)
                    entry.size, entry.mode = len(data), mode
                    bundle.addfile(entry, io.BytesIO(data))
    return sha(destination.read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--platform", choices=["macos-arm64", "linux-aarch64", "almalinux-10-x86_64"])
    args = parser.parse_args()
    if bool(args.binary) != bool(args.platform):
        parser.error("--binary and --platform must be provided together")
    if not args.destination.is_absolute():
        parser.error("destination must be absolute and fresh")
    root = Path(__file__).resolve().parent.parent
    version = re.search(r'\(version ([0-9.]+)\)', (root / "dune-project").read_text())[1]
    if (root / "lib/version.ml").read_text().strip() != f'let value = "{version}"':
        raise SystemExit("CLI and package versions disagree")
    names = ["README.md", "AGENTS.md", "AGENT_GUIDE.md", "engineering-standards.md", "LICENSE", ".gitignore", ".gitattributes", ".dockerignore", ".ocamlformat", "dune", "dune-project", "dev", "workgraph.opam"]
    for directory in ["bin", "lib", "test", "examples", "bench", "docs", "tools", "packaging", ".github"]:
        for path in sorted((root / directory).rglob("*")):
            if (path.is_file() and "__pycache__" not in path.parts
                    and not path.name.startswith("._")
                    and not path.name.endswith((".corrected", ".pyc"))):
                names.append(path.relative_to(root).as_posix())
    files = {}
    for name in names:
        path = root / name
        if path.is_symlink():
            raise SystemExit("source symlinks are not permitted: " + name)
        files[name] = (path.read_bytes(), 0o755 if name == "dev" or name.endswith(".sh") else 0o644)
    source_identity = sha(encode({name: sha(data) for name, (data, _) in sorted(files.items())}))
    binary = args.binary.resolve(strict=True).read_bytes() if args.binary else None
    args.destination.mkdir(mode=0o700)
    checksums = {}
    stem = "workgraph-" + version
    name = stem + "-source.tar.gz"
    checksums[name] = archive(args.destination / name, stem, files,
                              {"version": version, "kind": "source", "source_identity": source_identity})
    if binary is not None:
        name = stem + "-" + args.platform + ".tar.gz"
        native_files = {name: value for name, value in files.items()
                        if name in {"README.md", "AGENT_GUIDE.md", "engineering-standards.md", "LICENSE"}
                        or name.startswith(("docs/", "examples/"))}
        native_files["bin/workgraph"] = (binary, 0o755)
        checksums[name] = archive(args.destination / name, stem + "-" + args.platform, native_files,
                                  {"version": version, "kind": "native", "platform": args.platform,
                                   "source_identity": source_identity})
    (args.destination / "SHA256SUMS").write_text("".join(f"{digest}  {name}\n" for name, digest in sorted(checksums.items())))
    print(json.dumps({"directory": str(args.destination), "source_identity": source_identity, "archives": checksums}, sort_keys=True))


if __name__ == "__main__":
    main()
