#!/usr/bin/env python3
"""Independent malformed archive and installed-package qualification fixtures."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packaging"))
sys.path.insert(0, str(ROOT / "tools"))
import verify
import package


class PackageQualification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.source_files = {name: (b"source:" + name.encode(), 0o644)
                             for name in verify.NATIVE_SOURCE_FILES}
        self.source_files["docs/example.md"] = (b"offline documentation", 0o644)
        self.source_files["examples/example.sh"] = (b"#!/bin/sh\n", 0o755)
        self.identity = verify.sha(verify.encode({name: verify.sha(data)
                                                for name, (data, _) in self.source_files.items()}))
        self.source_metadata = {"version": "0.2.0", "kind": "source", "source_identity": self.identity}
        self.native_metadata = {**self.source_metadata, "kind": "native", "platform": "macos-arm64"}
        self.native_files = dict(self.source_files)
        self.native_files["bin/workgraph"] = (b"independent fixture executable", 0o755)
        notice = b"Example upstream license\n"
        inventory = {"schema": 1, "packages": [{"name": "example", "version": "1.0",
                     "source_url_opam": "https://example.invalid/source", "license_files": {
                         "source/LICENSE": hashlib.sha256(notice).hexdigest()}}]}
        self.native_files["THIRD_PARTY_NOTICES/INVENTORY.json"] = (verify.encode(inventory), 0o644)
        self.native_files["THIRD_PARTY_NOTICES/README.md"] = (b"notice scope", 0o644)
        self.native_files["THIRD_PARTY_NOTICES/example/1.0/source/LICENSE"] = (notice, 0o644)
        record = {"schema": 1, "status": "inspection-only", "platform": "macos-arm64",
                  "source_identity": self.identity,
                  "executable_sha256": verify.sha(self.native_files["bin/workgraph"][0]),
                  "inspection": {"architecture": "arm64"}}
        self.native_files["QUALIFICATION.json"] = (verify.encode(record), 0o644)
        self.source_path = self.directory / "source.tar.gz"
        self.native_path = self.directory / "native.tar.gz"
        self.write_archives()

    def tearDown(self):
        self.temporary.cleanup()

    def write_archives(self):
        self.source_path.unlink(missing_ok=True)
        self.native_path.unlink(missing_ok=True)
        package.archive(self.source_path, "workgraph-0.2.0", self.source_files, self.source_metadata)
        package.archive(self.native_path, "workgraph-0.2.0-macos-arm64", self.native_files, self.native_metadata)

    def pair(self):
        return verify.read_archive(self.source_path), verify.read_archive(self.native_path)

    def rewrite_member(self, mutation):
        destination = self.directory / "malformed.tar.gz"
        with tarfile.open(self.native_path, "r:gz") as original, tarfile.open(destination, "w:gz") as out:
            for member in original:
                data = original.extractfile(member).read() if member.isfile() else None
                mutation(out, member, data)
        return destination

    def test_complete_pair_and_installed_copy_then_tampering(self):
        source, native = self.pair()
        self.assertEqual(verify.verify_pair(source, native)["status"], "passed")
        installation = self.directory / "installation"
        installation.mkdir()
        verify.extract(native, installation)
        installed = installation / native.root
        verify.verify_installation(native, installed)
        (installed / "extra.txt").write_text("undeclared")
        with self.assertRaisesRegex(ValueError, "inventory"):
            verify.verify_installation(native, installed)
        (installed / "extra.txt").unlink()
        (installed / "docs/example.md").write_text("changed")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            verify.verify_installation(native, installed)

    def test_native_package_keeps_offline_documentation_links(self):
        # Stage source files explicitly: Dune's build tree can contain compiled
        # outputs and is not itself the source tree the packager should consume.
        project = self.directory / "source"
        for name in ["README.md", "AGENTS.md", "AGENT_GUIDE.md", "engineering-standards.md",
                     "LICENSE", ".gitignore", ".gitattributes", ".dockerignore", ".ocamlformat",
                     "dune", "dune-project", "dev", "workgraph.opam", "lib/version.ml"]:
            path = project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, path)
        for directory in ["docs", "examples", "tools", "packaging"]:
            shutil.copytree(ROOT / directory, project / directory,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        executable = self.directory / "workgraph"
        executable.write_bytes(self.native_files["bin/workgraph"][0])
        notices = self.directory / "notices"
        for name, (data, _) in self.native_files.items():
            if name.startswith("THIRD_PARTY_NOTICES/"):
                path = notices / name.removeprefix("THIRD_PARTY_NOTICES/")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        output = self.directory / "packages"
        subprocess.run([sys.executable, str(project / "tools/package.py"), str(output),
                        "--binary", str(executable), "--platform", "macos-arm64",
                        "--notices", str(notices)], check=True, capture_output=True, timeout=30)
        source = verify.read_archive(next(output.glob("*-source.tar.gz")))
        native = verify.read_archive(next(output.glob("*-macos-arm64.tar.gz")))
        verify.verify_pair(source, native)
        self.assertEqual(native.files["AGENTS.md"], (ROOT / "AGENTS.md").read_bytes())
        checked = 0
        for name, data in native.files.items():
            if not name.endswith(".md"):
                continue
            for markdown, xml in re.findall(r'\]\(([^)\n]+)\)|href="([^"]+)"',
                                            data.decode("utf-8")):
                target = (markdown or xml).strip("<>").split("#", 1)[0]
                if not target or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", target):
                    continue
                resolved = posixpath.normpath(str(PurePosixPath(name).parent / target))
                with self.subTest(document=name, target=target):
                    self.assertFalse(resolved.startswith(("../", "/")))
                    self.assertTrue(resolved in native.files or
                                    any(path.startswith(resolved.rstrip("/") + "/")
                                        for path in native.files),
                                    "native package omits offline link target: " + resolved)
                checked += 1
        self.assertGreater(checked, 100)

    def test_rpm_exact_mapping_includes_inspection_and_licenses(self):
        _, native = self.pair()
        installation = self.directory / "rpm"
        for name, data in {**native.files, "MANIFEST.json": verify.encode(native.manifest)}.items():
            if name == "bin/workgraph":
                path = installation / "usr/bin/workgraph"
            elif name == "LICENSE" or name.startswith("THIRD_PARTY_NOTICES/"):
                path = installation / "usr/share/licenses/workgraph" / name
            else:
                path = installation / "usr/share/doc/workgraph" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(native.modes[name])
        verify.verify_installation(native, installation, rpm=True)
        (installation / "usr/share/doc/workgraph/QUALIFICATION.json").unlink()
        with self.assertRaisesRegex(ValueError, "inventory"):
            verify.verify_installation(native, installation, rpm=True)

    def test_path_traversal_duplicate_and_symlink_reject_before_extraction(self):
        for case in ["traversal", "duplicate", "symlink", "setuid", "file_parent", "directory_parent"]:
            def mutation(out, member, data):
                if member.name.endswith("bin/workgraph"):
                    if case == "traversal":
                        member.name = "workgraph-0.2.0-macos-arm64/../escape"
                    elif case == "symlink":
                        member.type, member.linkname = tarfile.SYMTYPE, "/tmp/escape"
                    elif case == "setuid":
                        member.mode = 0o4755
                    elif case == "duplicate":
                        out.addfile(member, io.BytesIO(data))
                    elif case in {"file_parent", "directory_parent"}:
                        child = tarfile.TarInfo(member.name + "/child")
                        if case == "file_parent":
                            child.mode, child.size = 0o644, 1
                            out.addfile(child, io.BytesIO(b"x"))
                        else:
                            child.mode, child.type = 0o755, tarfile.DIRTYPE
                            out.addfile(child)
                out.addfile(member, io.BytesIO(data) if data is not None else None)
            with self.subTest(case=case), self.assertRaises(ValueError):
                verify.read_archive(self.rewrite_member(mutation))

    def test_exact_file_inventory_and_hash(self):
        def mutation(out, member, data):
            if member.name.endswith("MANIFEST.json"):
                manifest = json.loads(data)
                manifest["files"].pop("docs/example.md")
                data = verify.encode(manifest)
                member.size = len(data)
            out.addfile(member, io.BytesIO(data) if data is not None else None)
        with self.assertRaisesRegex(ValueError, "inventory"):
            verify.read_archive(self.rewrite_member(mutation))
        self.native_files["docs/example.md"] = (b"tampered bytes with valid own hash", 0o644)
        self.write_archives()
        with self.assertRaisesRegex(ValueError, "content mismatch"):
            verify.verify_pair(*self.pair())

    def test_source_identity_recomputed(self):
        self.source_metadata["source_identity"] = "a" * 64
        self.write_archives()
        with self.assertRaisesRegex(ValueError, "identity"):
            verify.read_archive(self.source_path)

    def test_notice_inventory_hash_and_missing_text(self):
        self.native_files["THIRD_PARTY_NOTICES/example/1.0/source/LICENSE"] = (b"wrong license", 0o644)
        self.write_archives()
        with self.assertRaisesRegex(ValueError, "notice hash"):
            verify.verify_pair(*self.pair())
        self.native_files.pop("THIRD_PARTY_NOTICES/example/1.0/source/LICENSE")
        self.write_archives()
        with self.assertRaises(KeyError):
            verify.verify_pair(*self.pair())

    def test_provenance_bound_to_actual_executable_not_claimed_result(self):
        record = json.loads(self.native_files["QUALIFICATION.json"][0])
        for field, value in [("executable_sha256", "0" * 64), ("source_identity", "0" * 64),
                             ("platform", "almalinux-10-x86_64"), ("status", "passed")]:
            self.native_files["QUALIFICATION.json"] = (verify.encode({**record, field: value}), 0o644)
            self.write_archives()
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "inspection record"):
                verify.verify_pair(*self.pair())

    def test_duplicate_json_keys_and_nonempty_extraction_reject(self):
        with self.assertRaisesRegex(ValueError, "Duplicate JSON"):
            verify.decode(b'{"files":{},"files":{}}')
        _, native = self.pair()
        destination = self.directory / "nonempty"
        destination.mkdir()
        (destination / "prior").mkdir()
        with self.assertRaisesRegex(ValueError, "empty"):
            verify.extract(native, destination)


if __name__ == "__main__":
    unittest.main()
