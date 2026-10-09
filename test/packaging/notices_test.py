#!/usr/bin/env python3
"""Exercise the notice collector through an independent installed-opam fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "packaging/almalinux/collect_notices.py"
FAKE_OPAM = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

configuration = json.loads(Path(os.environ["NOTICE_FIXTURE"]).read_text())
arguments = [argument for argument in sys.argv[1:] if argument != "--color=never"]
with Path(os.environ["NOTICE_CALLS"]).open("a") as log:
    log.write(json.dumps(arguments) + "\n")
installed = configuration["installed"]
command = arguments[0]
if command == "show" and "--just-file" in arguments:
    manifest = Path(arguments[arguments.index("--just-file") + 1])
    assert manifest.name == "workgraph.opam" and manifest.is_file(), manifest
    assert "--field=depends" in arguments and "--strict" in arguments
    print(configuration["depends"])
elif command == "list":
    assert "--installed" in arguments and "--columns=name,version" in arguments
    requested = next((argument.split("=", 1)[1] for argument in arguments
                      if argument.startswith("--required-by=")), None)
    if requested is None:
        selected = {argument for argument in arguments[1:] if not argument.startswith("--")}
        assert selected, "query must name the manifest roots"
    else:
        assert "--recursive" in arguments and "--depopts" in arguments
        roots = set()
        for identity in requested.split(","):
            name, version = identity.split(".", 1)
            assert installed[name] == version
            roots.add(name)
        seen, pending = set(), list(roots)
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            pending.extend(dependency for dependency in
                           configuration["dependencies"].get(name, []) +
                           configuration["depopts"].get(name, [])
                           if dependency in installed)
        # Deliberately omit roots to exercise the collector's explicit union.
        selected = seen - roots
    print("# name version")
    for name in sorted(selected & installed.keys()):
        print(name, installed[name])
elif command == "var":
    assert arguments == ["var", "doc"]
    print(os.environ["NOTICE_DOC"])
elif command == "show":
    identity = arguments[-1]
    name, version = identity.split(".", 1)
    assert installed[name] == version
    field = next(argument for argument in arguments if argument.startswith("--field="))
    print({"--field=license": '"MIT"', "--field=url.src": '"https://example.invalid/source"',
           "--field=url.checksum": '"sha256=fixture"'}[field])
elif command == "source":
    name = arguments[-1].split(".", 1)[0]
    destination = Path(arguments[arguments.index("--dir") + 1])
    destination.mkdir()
    if name not in configuration["missing_licenses"]:
        (destination / "LICENSE").write_text(name + " upstream license\n")
else:
    raise AssertionError(arguments)
'''


class NoticeCollection(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.fake_opam = self.directory / "opam"
        self.fake_opam.write_text(FAKE_OPAM)
        self.fake_opam.chmod(0o755)
        self.configuration_path = self.directory / "fixture.json"
        self.calls_path = self.directory / "calls.jsonl"
        self.destination = self.directory / "notices"
        self.configuration = {
            "depends": '\n'.join(['"core" {= "1.0"}', '"dune" {build}',
                                  '"test-helper" {with-test}', '"odoc" {with-doc}']),
            "installed": {"core": "1.0", "dune": "3.0", "test-helper": "1.0",
                          "base": "1.0", "optional": "1.0", "nested-optional": "1.0",
                          "odoc": "2.0", "doc-helper": "1.0", "trace": "0.11",
                          "trace-tef": "0.11", "dowsing-lib": "1.0"},
            "dependencies": {"core": ["base"], "odoc": ["doc-helper"],
                             "dowsing-lib": ["trace"], "trace-tef": ["trace"]},
            "depopts": {"core": ["optional", "absent-optional"],
                        "optional": ["nested-optional"]},
            "missing_licenses": ["trace"],
        }

    def tearDown(self):
        self.temporary.cleanup()

    def collect(self):
        self.configuration_path.write_text(json.dumps(self.configuration))
        environment = {**os.environ, "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
                       "NOTICE_FIXTURE": str(self.configuration_path),
                       "NOTICE_CALLS": str(self.calls_path),
                       "NOTICE_DOC": str(self.directory / "doc")}
        return subprocess.run([sys.executable, str(COLLECTOR), str(self.destination)],
                              cwd=self.directory, env=environment, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def calls(self):
        return [json.loads(line) for line in self.calls_path.read_text().splitlines()]

    def test_roots_transitive_and_recursive_installed_optional_dependencies(self):
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        inventory = json.loads((self.destination / "INVENTORY.json").read_text())
        self.assertEqual([entry["name"] for entry in inventory["packages"]],
                         ["base", "core", "doc-helper", "dune", "nested-optional",
                          "odoc", "optional", "test-helper"])
        for entry in inventory["packages"]:
            self.assertEqual(entry["scope"], inventory["scope"])
            self.assertIn("source/LICENSE", entry["license_files"])
        self.assertIn("manifest roots", inventory["scope"])
        self.assertIn("installed optional dependencies",
                      (self.destination / "README.md").read_text())
        identities = [call[-1] for call in self.calls() if call[0] == "source"]
        self.assertNotIn("trace.0.11", identities)
        self.assertNotIn("trace-tef.0.11", identities)
        self.assertNotIn("dowsing-lib.1.0", identities)

    def test_uninstalled_documentation_root_is_optional(self):
        del self.configuration["installed"]["odoc"]
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        inventory = json.loads((self.destination / "INVENTORY.json").read_text())
        self.assertNotIn("odoc", [entry["name"] for entry in inventory["packages"]])
        self.assertNotIn("doc-helper", [entry["name"] for entry in inventory["packages"]])

    def test_missing_runtime_build_or_test_root_fails_before_collection(self):
        for name in ["core", "dune", "test-helper"]:
            with self.subTest(name=name):
                version = self.configuration["installed"].pop(name)
                result = self.collect()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Required Workgraph dependencies are not installed: " + name,
                              result.stderr)
                self.assertFalse(self.destination.exists())
                self.configuration["installed"][name] = version
        self.assertFalse(any(call[0] == "source" for call in self.calls()))

    def test_required_source_license_still_fails_closed(self):
        self.configuration["missing_licenses"].append("base")
        result = self.collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No license text found for source package base.1.0", result.stderr)
        self.assertFalse((self.destination / "INVENTORY.json").exists())

    def test_unsupported_manifest_syntax_fails_before_selection(self):
        for depends in ['"core" | "other"', '"core" "dune"',
                        '"core" {os = "linux"}', '"core"\n"core"', ""]:
            with self.subTest(depends=depends):
                self.configuration["depends"] = depends
                result = self.collect()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr, "Unsupported Workgraph|Duplicate Workgraph|no dependencies")
                self.assertFalse(self.destination.exists())
        self.assertTrue(all(call[0] == "show" for call in self.calls()))


if __name__ == "__main__":
    unittest.main()
