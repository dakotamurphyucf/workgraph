#!/usr/bin/env python3
"""Collect Workgraph dependency license texts from the selected opam switch.

Sources are fetched by opam using its repository's source checksums. The
inventory includes direct manifest dependencies and their installed recursive
dependencies, including build tools and optional dependencies. It is not a claim
that every listed package is linked.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import sys
import tarfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ui_inputs import INPUTS


LICENSE_NAME = re.compile(r"^(licen[sc]e|copying|copyright|notice)([-_.].*)?$", re.I)
DEPENDENCY_LINE = re.compile(r'"([a-zA-Z0-9_+-]+)"(?:\s+\{([^{}]*)\})?')
VERSION_FILTER = re.compile(r'(?:=|!=|>=|<=|>|<)\s+"[^"\\]*"')
SCOPE = "Workgraph manifest roots and installed recursive build/runtime dependencies, including optional dependencies"


def opam(*arguments):
    return subprocess.run(["opam", *arguments, "--color=never"], check=True,
                          text=True, stdout=subprocess.PIPE).stdout.strip()


def manifest_roots(manifest):
    """Accept the current Dune-generated depends shape, never omit unknown forms."""
    depends = opam("show", "--just-file", str(manifest), "--field=depends", "--strict")
    roots = {}
    for line in depends.splitlines():
        match = DEPENDENCY_LINE.fullmatch(line.strip())
        if not match:
            raise ValueError("Unsupported Workgraph dependency syntax: " + line)
        name, condition = match.groups()
        condition = condition.strip() if condition is not None else None
        if condition is not None and condition not in {"build", "with-test", "with-doc"} \
                and not VERSION_FILTER.fullmatch(condition) \
                and not (name == "workgraph" and condition == "= version"):
            raise ValueError("Unsupported Workgraph dependency filter: " + line)
        if name in roots:
            raise ValueError("Duplicate Workgraph dependency: " + name)
        roots[name] = condition != "with-doc"
    if not roots:
        raise ValueError("Workgraph manifest has no dependencies")
    return roots


def package_versions(output):
    packages = {}
    for line in output.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        name, version = line.split()
        if name in packages or version == "--":
            raise ValueError("Invalid installed package identity: " + line)
        packages[name] = version
    return packages


def dependency_packages(manifest, *, first_party=()):
    roots = manifest_roots(manifest)
    roots = {name: required for name, required in roots.items() if name not in first_party}
    installed_roots = package_versions(opam("list", "--installed", "--columns=name,version",
                                           *sorted(roots)))
    missing = sorted(name for name, required in roots.items()
                     if required and name not in installed_roots)
    if missing:
        raise ValueError("Required Workgraph dependencies are not installed: " + ", ".join(missing))
    if not installed_roots:
        raise ValueError("No Workgraph dependencies are installed")
    declarations = opam("show", "--just-file", str(manifest), "--field=depends", "--strict")
    for line in declarations.splitlines():
        name, condition = DEPENDENCY_LINE.fullmatch(line.strip()).groups()
        exact = re.fullmatch(r'=\s+"([^"\\]*)"', condition.strip()) if condition else None
        if exact and name not in first_party and installed_roots.get(name) != exact[1]:
            raise ValueError("Installed dependency differs from required source version: " + name)
    identities = ",".join(name + "." + version for name, version in sorted(installed_roots.items()))
    closure = package_versions(opam("list", "--installed", "--recursive", "--depopts",
                                    "--required-by=" + identities, "--columns=name,version"))
    # Keep the roots explicitly even when opam's required-by query omits them.
    closure.update(installed_roots)
    return sorted((name, version) for name, version in closure.items() if name not in first_party)


def copy_licenses(directory, destination):
    files = {}
    if not directory.exists():
        return files
    for source in sorted(directory.rglob("*")):
        if not LICENSE_NAME.fullmatch(source.name) or not source.is_file():
            continue
        # Keep the notice name but never copy an external symlink's content.
        if not source.resolve().is_relative_to(directory.resolve()):
            raise ValueError("License path escapes its source directory: " + str(source))
        relative = source.relative_to(directory)
        data = source.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[relative.as_posix()] = hashlib.sha256(data).hexdigest()
    return files


def collect_package(name, version, destination, doc_root, verified_source=None):
    identity = name + "." + version
    package_root = destination / name / version
    declared_license = opam("show", "--field=license", "--raw", identity)
    source_url = opam("show", "--field=url.src", "--raw", identity)
    source_checksums = opam("show", "--field=url.checksum", "--raw", identity)
    files = {"doc/" + path: digest for path, digest in
             copy_licenses(doc_root / name, package_root / "doc").items()}
    if verified_source:
        source_root, record = verified_source
        if record["packages"].get(name) != version:
            raise ValueError("Verified source version differs from installed package: " + identity)
        files.update({"source/" + path: digest for path, digest in
                      copy_licenses(source_root, package_root / "source").items()})
        if not files:
            raise ValueError("Verified upstream source has no license texts: " + identity)
    elif source_url:
        with tempfile.TemporaryDirectory(prefix="workgraph-notices-") as temporary:
            source_root = Path(temporary) / "source"
            subprocess.run(["opam", "source", "--yes", "--color=never", "--dir",
                            str(source_root), identity], check=True)
            files.update({"source/" + path: digest for path, digest in
                          copy_licenses(source_root, package_root / "source").items()})
        if not files:
            raise ValueError("No license text found for source package " + identity)
    result = {"name": name, "version": version,
            "declared_license_opam": declared_license or None,
            "source_url_opam": source_url or None,
            "source_checksums_opam": source_checksums or None,
            "license_files": files,
            "scope": SCOPE}
    if verified_source:
        result["verified_upstream"] = {field: verified_source[1][field]
                                       for field in ("url", "algorithm", "digest", "packages")}
    return result


def verified_cohttp(directory):
    record = json.loads((directory / "upstream.json").read_bytes())
    expected = INPUTS["cohttp"]
    if {key: record.get(key) for key in expected} != expected:
        raise ValueError("Unexpected pinned Cohttp source provenance")
    if hashlib.new(expected["algorithm"], (directory / "upstream.tar.gz").read_bytes()).hexdigest() != expected["digest"]:
        raise ValueError("Pinned Cohttp archive checksum mismatch")
    members = {}
    with tarfile.open(directory / "upstream.tar.gz", "r:gz") as archive:
        for member in archive:
            if member.isfile():
                members[member.name] = {"sha256": hashlib.sha256(archive.extractfile(member).read()).hexdigest()}
            elif member.issym() or member.islnk():
                members[member.name] = {"link": member.linkname}
    if record["members"] != members:
        raise ValueError("Pinned Cohttp member inventory differs from verified archive")
    for name, identity in members.items():
        path = directory / name
        if not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError("Pinned source member escapes root")
        if "sha256" in identity and (path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != identity["sha256"]):
            raise ValueError("Pinned Cohttp source changed before notice collection: " + name)
    return directory / expected["root"], record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--ui", action="store_true", help="include exact optional UI opam dependency closure")
    parser.add_argument("--cohttp-source", type=Path, help="verified ui_inputs cohttp directory used for isolated pins")
    args = parser.parse_args()
    manifest = Path(__file__).resolve().parents[2] / "workgraph.opam"
    selected_packages = dependency_packages(manifest)
    sources = {}
    if args.ui:
        if not args.cohttp_source:
            parser.error("--ui requires --cohttp-source for the actual verified source pins")
        source = verified_cohttp(args.cohttp_source)
        sources = {name: source for name in INPUTS["cohttp"]["packages"]}
        ui_manifest = manifest.with_name("workgraph-ui.opam")
        selected_packages = sorted(set(selected_packages) | set(dependency_packages(ui_manifest, first_party={"workgraph"})))
        if len({name for name, _ in selected_packages}) != len(selected_packages):
            raise ValueError("Core/UI dependency closures disagree on installed versions")
    elif args.cohttp_source:
        parser.error("--cohttp-source requires --ui")
    args.destination.mkdir(mode=0o755)
    doc_root = Path(opam("var", "doc"))
    packages = []
    for name, version in selected_packages:
        packages.append(collect_package(name, version, args.destination, doc_root, sources.get(name)))
    inventory = {"schema": 1,
                 "scope": SCOPE,
                 "method": "Installed docs plus recursively discovered license/notice files in checksum-verified opam source archives",
                 "packages": packages}
    (args.destination / "INVENTORY.json").write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n")
    (args.destination / "README.md").write_text(
        "# Third-party notices\n\n"
        "Workgraph's executable contains third-party OCaml runtime and library code.\n"
        "This directory preserves upstream license and notice files, including\n"
        "vendored components such as liburing. INVENTORY.json records exact opam\n"
        "versions, declared licenses, source checksums and notice-file hashes.\n\n"
        "The inventory starts with the selected first-party opam manifests' exact installed direct dependencies,\n"
        "including build and test tools and documentation tools when installed.\n"
        "It follows opam's recursive dependencies and installed optional dependencies.\n"
        "This build-tool closure is a conservative superset;\n"
        "it does not imply that every listed package is part of the executable.\n"
        "System shared libraries are supplied by AlmaLinux packages rather than\n"
        "bundled here; qualification evidence records their versions.\n")
    empty = [entry for entry in packages if not entry["license_files"]]
    if empty:
        with (args.destination / "README.md").open("a") as readme:
            readme.write("\n## Entries without separate notice text\n\n"
                         "The following installed metadata entries supply no separate source/doc\n"
                         "notice text. No substitute license text has been invented. Virtual/compiler\n"
                         "aliases may refer to compiler implementation already covered elsewhere;\n"
                         "build-only configuration wrappers are not independently linked runtime code.\n"
                         "The qualification record distinguishes those cases from actual compiled\n"
                         "artifact owners; an empty entry alone does not establish runtime coverage.\n\n")
            for entry in empty:
                readme.write("- " + entry["name"] + "." + entry["version"]
                             + "; declared license metadata: " + str(entry["declared_license_opam"]) + "\n")
    print(json.dumps({"packages": len(packages), "destination": str(args.destination)}, sort_keys=True))


if __name__ == "__main__":
    main()
