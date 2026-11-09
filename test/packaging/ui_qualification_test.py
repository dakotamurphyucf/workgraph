#!/usr/bin/env python3
"""Owned uninstall boundary and exact stopped-data verification controls."""
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packaging"))
import ui_qualification as q


class InstalledLifecycle(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wg-native-test-", dir="/tmp")
        self.root = Path(self.temporary.name).resolve()
        self.install, self.data, self.core = (self.root / name for name in ("install", "data", "core"))
        for directory in (self.install, self.data, self.core):
            directory.mkdir()
        (self.install / ".ui-qualification-owned").write_bytes(q.OWNED)
        (self.install / "binary").write_bytes(b"owned installed bytes")
        (self.data / "journal").write_bytes(b"exact saved operation identity")
        (self.core / "binary").write_bytes(b"independent core bytes")

    def tearDown(self):
        self.temporary.cleanup()

    def remove(self):
        return q.remove_owned_installation(self.install, data=self.data, independent_core=self.core)

    def test_owned_removal_preserves_external_data_and_separate_core(self):
        before_data, before_core = q.data_inventory(self.data), q.data_inventory(self.core)
        result = self.remove()
        self.assertTrue(result["installation_absent"])
        self.assertEqual(result["external_data"], before_data)
        self.assertEqual(result["independent_core"], before_core)
        self.assertFalse(self.install.exists())

    def test_missing_or_linked_ownership_marker_never_authorizes_removal(self):
        marker = self.install / ".ui-qualification-owned"
        marker.unlink()
        with self.assertRaisesRegex(ValueError, "exact owned"):
            self.remove()
        target = self.data / "marker"
        target.write_bytes(q.OWNED)
        marker.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "exact owned"):
            self.remove()
        self.assertTrue((self.install / "binary").exists())

    def test_data_or_independent_core_inside_install_is_rejected(self):
        for label in ("data", "core"):
            inside = self.install / "outside-must-not-be-here"
            inside.mkdir(exist_ok=True)
            with self.assertRaisesRegex(ValueError, "outside installation"):
                q.remove_owned_installation(self.install,
                    data=inside if label == "data" else self.data,
                    independent_core=inside if label == "core" else self.core)
        self.assertTrue(self.install.exists())

    def test_regular_inventory_rejects_file_and_directory_links(self):
        link = self.install / "link"
        for destination in (self.data / "journal", self.data):
            link.symlink_to(destination)
            with self.assertRaisesRegex(ValueError, "link/special"):
                self.remove()
            self.assertTrue(self.install.exists())
            link.unlink()

    def test_only_explicit_exact_owned_endpoint_socket_is_omitted(self):
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(self.data / "s"))
            with self.assertRaisesRegex(ValueError, "link/special"):
                q.data_inventory(self.data)
            self.assertEqual(set(q.data_inventory(self.data, allow_owned_socket=True)), {"journal"})
        with socket.socket(socket.AF_UNIX) as other:
            other.bind(str(self.data / "foreign"))
            with self.assertRaisesRegex(ValueError, "link/special"):
                q.data_inventory(self.data, allow_owned_socket=True)

    def test_uninstall_detects_even_an_unexpected_external_change(self):
        real_remove = shutil.rmtree
        def changed(directory):
            real_remove(directory)
            (self.data / "journal").write_bytes(b"unexpected change")
        with patch.object(q.shutil, "rmtree", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "changed external data"):
                self.remove()
        self.assertTrue((self.data / "journal").exists())
        self.assertEqual((self.core / "binary").read_bytes(), b"independent core bytes")


if __name__ == "__main__":
    unittest.main()
