#!/usr/bin/env python3
"""Optional UI source/paired archive admission and installed isolation controls."""
import json
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import tarfile
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packaging"))
sys.path.insert(0, str(ROOT / "tools"))
import package
import source_inputs
import source_version
import ui_bundle as ui
import ui_inputs
import ui_smoke
import verify


class UiPackages(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = {name: b"source" for name in verify.NATIVE_SOURCE_FILES | ui.UI_SOURCE_FILES}
        self.source.update({
            "ui/frontend/package.json": verify.encode({"version": "1.2.3"}),
            "ui/frontend/package-lock.json": verify.encode({"version": "1.2.3", "packages": {
                "": {"version": "1.2.3"}, "node_modules/vite": {"version": "1", "license": "MIT"}}}),
            "ui/frontend/index.html": b"source bootstrap", "ui/frontend/tsconfig.json": b"{}",
            "ui/frontend/vite.config.ts": b"source", "ui/frontend/src/main.ts": b"source",
            "ui/tools/toolchain.json": verify.encode({"node": "22.14.0", "npm": "10.9.2"})})
        self.notices = b"Vite fixture notice"
        self.manifest = {"schema_version": 1, "package_version": "1.2.3",
            "input_sha256": ui.frontend_input_hash(self.source),
            "lock_sha256": verify.sha(self.source["ui/frontend/package-lock.json"]),
            "generator_runtime": {"node": "22.14.0"}, "required_toolchain": {"node": "22.14.0", "npm": "10.9.2"},
            "runtime_dependencies": [{"name": "vite", "version": "1", "license": "MIT"}],
            "assets": [{"path": name, "content_type": mime, "size_bytes": str(len(data)), "sha256": verify.sha(data)}
                for name, mime, data in [("/index.html", "text/html; charset=utf-8", b"bootstrap"),
                                          ("/frontend-notices.txt", "text/plain; charset=utf-8", self.notices)]]}

    def tearDown(self):
        self.temporary.cleanup()

    def inputs(self):
        return ui.UiInputs(b"ui executable fixture", verify.encode(self.manifest), self.notices)

    def test_stale_source_lock_version_and_tampered_notices_rejected(self):
        ui.validate_assets(self.inputs(), source=self.source, version="1.2.3")
        for field, value in [("input_sha256", "0" * 64), ("lock_sha256", "0" * 64),
                             ("package_version", "0.7.0")]:
            with self.subTest(field=field):
                saved = self.manifest[field]
                self.manifest[field] = value
                with self.assertRaises(ValueError):
                    ui.validate_assets(self.inputs(), source=self.source, version="1.2.3")
                self.manifest[field] = saved
        inputs = self.inputs()
        with self.assertRaisesRegex(ValueError, "notices"):
            ui.validate_assets(ui.UiInputs(inputs.binary, inputs.manifest, b"wrong"), source=self.source, version="1.2.3")

    def test_manifest_closed_duplicate_path_bounds_and_dependency_identity(self):
        for mutation in [lambda: self.manifest.update(unrecognized=True),
                         lambda: self.manifest.update(schema_version=True),
                         lambda: self.manifest["assets"].append(self.manifest["assets"][0]),
                         lambda: self.manifest["assets"][0].update(size_bytes="8388609"),
                         lambda: self.manifest["assets"][0].update(path="/../outside.js"),
                         lambda: self.manifest["runtime_dependencies"][0].update(version="wrong")]:
            original = json.loads(json.dumps(self.manifest))
            mutation()
            with self.assertRaises(ValueError):
                ui.validate_assets(self.inputs(), source=self.source, version="1.2.3")
            self.manifest = original

    def test_release_version_rejects_stale_generated_opam_and_compiler_identity(self):
        (self.root / "dune-project").write_text('(version 1.2.3)\n')
        (self.root / "lib").mkdir()
        (self.root / "lib/version.ml").write_text('let value = "1.2.3"\n')
        (self.root / "workgraph.opam").write_text('version: "1.2.3"\n')
        self.assertEqual(source_version.source_version(self.root), "1.2.3")
        (self.root / "workgraph-ui.opam").write_text('version: "0.7.0"\n')
        with self.assertRaisesRegex(ValueError, "Generated package version"):
            source_version.source_version(self.root)
        (self.root / "workgraph-ui.opam").unlink()
        (self.root / "lib/version.ml").write_text('let value = "0.7.0"\n')
        with self.assertRaisesRegex(ValueError, "CLI and package"):
            source_version.source_version(self.root)

    def test_partial_ui_cli_group_fails_before_writing_or_running_binary(self):
        output = self.root / "not-created"
        result = subprocess.run([sys.executable, str(ROOT / "tools/package.py"), str(output),
                                 "--ui-binary", "/not-an-executable"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("optional UI packaging requires", result.stderr)
        self.assertFalse(output.exists())

    def test_locked_runtime_closure_keeps_nested_versions_and_rejects_omissions(self):
        package = {"dependencies": {"a": "1", "dep": "2"}}
        lock = {"packages": {"node_modules/a": {"version": "1", "license": "MIT", "dependencies": {"dep": "1"}},
            "node_modules/dep": {"version": "2", "license": "ISC"},
            "node_modules/a/node_modules/dep": {"version": "1", "license": "MIT"},
            "node_modules/vite": {"version": "3", "license": "MIT", "dependencies": {"build-only": "9"}}}}
        inventory = ui.runtime_dependencies(package, lock)
        self.assertEqual([(item["name"], item["version"]) for item in inventory],
                         [("a", "1"), ("dep", "1"), ("dep", "2"), ("vite", "3")])
        del lock["packages"]["node_modules/a"]
        with self.assertRaisesRegex(ValueError, "Missing locked"):
            ui.runtime_dependencies(package, lock)

    def upstream(self, entries):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            root = tarfile.TarInfo("upstream")
            root.type, root.mode = tarfile.DIRTYPE, 0o755
            archive.addfile(root)
            for name, data, target in entries:
                member = tarfile.TarInfo(name)
                member.mode = 0o644
                if target:
                    member.type, member.linkname = tarfile.SYMTYPE, target
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        data = output.getvalue()
        return data, {"root": "upstream", "algorithm": "sha256", "digest": hashlib.sha256(data).hexdigest()}

    def test_upstream_checksum_before_extract_and_escaping_links_traversal(self):
        data, record = self.upstream([("upstream/LICENSE", b"license", None)])
        destination = self.root / "upstream-input"
        destination.mkdir()
        with self.assertRaisesRegex(ValueError, "checksum"):
            ui_inputs.extract_verified(data + b"tampered", destination, record)
        self.assertEqual(list(destination.iterdir()), [])
        for name, target in [("upstream/../../escape", None), ("/absolute", None), ("upstream/link", "../../escape")]:
            data, record = self.upstream([(name, b"bad", target)])
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Unsafe|escapes"):
                ui_inputs.extract_verified(data, destination, record)
        self.assertEqual(list(destination.iterdir()), [])

    def test_upstream_internal_node_launcher_link_and_recorded_licenses(self):
        data, record = self.upstream([("upstream/lib/npm-cli.js", b"npm", None),
                                      ("upstream/bin/npm", None, "../lib/npm-cli.js"),
                                      ("upstream/LICENSE", b"license", None)])
        destination = self.root / "verified"
        destination.mkdir()
        extracted = ui_inputs.extract_verified(data, destination, record)
        self.assertEqual((extracted / "bin/npm").read_bytes(), b"npm")
        recorded = json.loads((destination / "upstream.json").read_bytes())
        self.assertEqual(recorded["members"]["upstream/LICENSE"]["sha256"], verify.sha(b"license"))

    def test_complete_readiness_deadline_includes_partial_line_and_retains_exact_bytes(self):
        source = "import os,time; os.write(1,b'{partial'); time.sleep(30)"
        process = subprocess.Popen([sys.executable, "-c", source], stdout=subprocess.PIPE)
        observed = self.root / "readiness-partial.json"
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(TimeoutError, "complete readiness deadline"):
                ui_smoke.read_ready(process.stdout, observed, timeout_seconds=0.15)
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(observed.read_bytes(), b"{partial")
        finally:
            process.kill()
            process.wait(timeout=3)
            process.stdout.close()

    def test_fragmented_readiness_and_early_eof_are_distinct(self):
        for source, expected, failure in [
            ("import os,time;os.write(1,b'{fragment');time.sleep(.02);os.write(1,b'}\\n')", b"{fragment}\n", False),
            ("import os;os.write(1,b'{eof')", b"{eof", True)]:
            process = subprocess.Popen([sys.executable, "-c", source], stdout=subprocess.PIPE)
            observed = self.root / "readiness-fragment.json"
            try:
                if failure:
                    with self.assertRaisesRegex(ValueError, "ended before complete"):
                        ui_smoke.read_ready(process.stdout, observed, timeout_seconds=2)
                else:
                    self.assertEqual(ui_smoke.read_ready(process.stdout, observed, timeout_seconds=2), expected)
                self.assertEqual(observed.read_bytes(), expected)
            finally:
                process.wait(timeout=3)
                process.stdout.close()

    def test_history_failure_retains_evidence_and_status_without_socket_or_link_copy(self):
        script = (ROOT / "packaging/macos/qualify.sh").read_text()
        fragment = script[script.index("history_work=$(mktemp"):script.index("/usr/bin/sw_vers")]
        installation = self.root / "installation"
        helper = installation / "skills/workgraph/scripts/history-recovery-demo.py"
        helper.parent.mkdir(parents=True)
        helper.write_text("""import pathlib,socket,sys
root=pathlib.Path(sys.argv[-1])
(root/'daemon.log').write_text('retained failure diagnostic')
with socket.socket(socket.AF_UNIX) as sock: sock.bind(str(root/'daemon.sock'))
if pathlib.Path(sys.argv[1]).name == 'symlink': (root/'unsafe').symlink_to('/etc/passwd')
print(root)
sys.exit(7)
""")
        for linked in (False, True):
            evidence = self.root / ("linked" if linked else "regular")
            (evidence / "home").mkdir(parents=True)
            # This executes the maintained lifecycle block, with a controlled
            # stopped helper, rather than promoting its failure to success.
            invoked = fragment.replace('"$installation/bin/workgraph"',
                                       '"$installation/bin/symlink"') if linked else fragment
            environment = {**os.environ, "installation": str(installation),
                           "evidence": str(evidence), "python": sys.executable}
            result = subprocess.run(["/bin/bash", "-euc", invoked], env=environment,
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 7)
            original = Path((evidence / "history-smoke.json").read_text().strip())
            self.assertFalse(original.exists())
            self.assertFalse((evidence / "history/daemon.sock").exists())
            self.assertFalse((evidence / "history/unsafe").exists())
            if linked:
                self.assertIn(b'Unexpected link/special', result.stderr)
            else:
                self.assertEqual((evidence / "history/daemon.log").read_text(), 'retained failure diagnostic')
                relocation = json.loads((evidence / "history/qualification-relocation.json").read_bytes())
                self.assertEqual(relocation['helper_exit_status'], 7)
                self.assertEqual(relocation['skipped_owned_sockets'], ['daemon.sock'])

    def test_source_boundary_excludes_generated_private_reports_and_rejects_links(self):
        for name in source_inputs.FIXED + source_inputs.UI_FIXED + tuple("ui/frontend/" + n for n in source_inputs.UI_FRONTEND):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"source")
        for name in ["ui/tools/embedded/dune", "ui/tools/embedded/workgraph_ui_assets.mli", "ui/companion/lib/main.ml", "ui/frontend/src/main.ts",
                     "ui/tests/qualification/example.browser.ts", "ui/frontend/node_modules/private/secret",
                     "ui/frontend/dist/index.html", "ui/tools/embedded/generated_assets.ml",
                     "ui/tests/qualification/recovery/playwright-report/index.html",
                     "ui/tests/qualification/recovery/test-results/private.json",
                     "ui/tests/qualification/.env.local", "ui/frontend/src/.DS_Store",
                     "ui/companion/_build-candidate/private",
                     "scratch/private.json", "ui/companion/_build/private"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture")
        admitted = source_inputs.collect(self.root)
        self.assertIn("dev-ui", admitted)
        self.assertEqual(admitted["dev-ui"][1], 0o755)
        self.assertIn("ui/tools/embedded/dune", admitted)
        self.assertIn("ui/tools/embedded/workgraph_ui_assets.mli", admitted)
        self.assertIn("ui/tests/qualification/example.browser.ts", admitted)
        self.assertFalse(any("private" in name or "playwright-report" in name or "test-results" in name
                             or ".env" in name or ".DS_Store" in name
                             or "generated_assets" in name or "/dist/" in name for name in admitted))
        (self.root / "ui/frontend/src/link").symlink_to(self.root / "scratch/private.json")
        with self.assertRaisesRegex(ValueError, "links"):
            source_inputs.collect(self.root)

    def test_deterministic_pair_extract_and_rpm_does_not_own_core_or_data(self):
        source_files = {name: (data, 0o755 if source_inputs.executable(name) else 0o644)
                        for name, data in self.source.items()}
        identity = verify.sha(verify.encode({name: verify.sha(data) for name, data in self.source.items()}))
        native_files = {name: value for name, value in source_files.items()
                        if name in verify.NATIVE_SOURCE_FILES | ui.UI_SOURCE_FILES}
        native_files["bin/workgraph"] = (b"core executable fixture", 0o755)
        native_files["QUALIFICATION.json"] = (verify.encode({"schema": 1, "status": "inspection-only", "platform": "macos-arm64",
            "source_identity": identity, "executable_sha256": verify.sha(b"core executable fixture"), "inspection": {}}), 0o644)
        native_files.update(ui.ui_files(self.inputs(), source=self.source, version="1.2.3", source_identity=identity,
                                       core_binary=b"core executable fixture", inspection={}))
        license = b"upstream license"
        native_files.update({"THIRD_PARTY_NOTICES/README.md": (b"scope", 0o644),
            "THIRD_PARTY_NOTICES/example/1/LICENSE": (license, 0o644),
            "THIRD_PARTY_NOTICES/INVENTORY.json": (verify.encode({"schema": 1, "packages": [{"name": "example", "version": "1",
                "source_url_opam": "https://example.invalid", "license_files": {"LICENSE": verify.sha(license)}}]}), 0o644)})
        source_path, native_path = self.root / "source.tar.gz", self.root / "native.tar.gz"
        source_metadata = {"version": "1.2.3", "kind": "source", "source_identity": identity}
        native_metadata = {**source_metadata, "kind": "ui-native", "platform": "macos-arm64"}
        package.archive(source_path, "workgraph-1.2.3", source_files, source_metadata)
        package.archive(native_path, "workgraph-ui-1.2.3-macos-arm64", native_files, native_metadata)
        copy = self.root / "copy.tar.gz"
        package.archive(copy, "workgraph-ui-1.2.3-macos-arm64", native_files, native_metadata)
        self.assertEqual(native_path.read_bytes(), copy.read_bytes())
        source, native = verify.read_archive(source_path), verify.read_archive(native_path)
        self.assertEqual(verify.verify_pair(source, native)["status"], "passed")
        extraction = self.root / "installation"
        extraction.mkdir()
        verify.extract(native, extraction)
        verify.verify_installation(native, extraction / native.root)
        rpm = self.root / "rpm"
        for name, data in {**native.files, "MANIFEST.json": verify.encode(native.manifest)}.items():
            if name.startswith("bin/"):
                destination = rpm / "usr" / name
            elif name in {"LICENSE", "ui-package/frontend-notices.txt"} or name.startswith("THIRD_PARTY_NOTICES/"):
                destination = rpm / "usr/share/licenses/workgraph-ui" / name
            else:
                destination = rpm / "usr/share/doc/workgraph-ui" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(native.modes.get(name, 0o644))
        data = rpm / "var/lib/workgraph/user-data"
        data.parent.mkdir(parents=True)
        data.write_bytes(b"must remain untouched")
        verify.verify_installation(native, rpm, rpm=True)
        self.assertEqual(data.read_bytes(), b"must remain untouched")
        native.files["ui-package/asset-manifest.json"] += b" "
        with self.assertRaisesRegex(ValueError, "record disagrees"):
            verify.verify_pair(source, native)


if __name__ == "__main__":
    unittest.main()
