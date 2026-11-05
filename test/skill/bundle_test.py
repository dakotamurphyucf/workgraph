"""A skill must work as a copied folder without its source repository beside it."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location('check_skill', ROOT / 'tools/check_skill.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class SkillBundle(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.skill = Path(self.temporary.name) / 'workgraph'
        shutil.copytree(ROOT / 'skills/workgraph', self.skill,
                        copy_function=shutil.copyfile,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))

    def test_copied_skill_has_complete_api_and_runnable_helpers(self):
        report = checker.check(self.skill, BINARY)
        self.assertEqual(report['status'], 'passed')
        catalog = json.loads(subprocess.check_output([str(BINARY), 'schema']))
        self.assertEqual(report['methods'], len(catalog['methods']))
        for name in ['history-adapter.py', 'transcript-converter.py', 'evaluation.py',
                     'notification-watcher.py', 'codex-hooks/workgraph-hook.py', 'input-cache.py']:
            subprocess.run([sys.executable, str(self.skill / 'scripts' / name), '--help'],
                           cwd=self.temporary.name, check=True, capture_output=True, timeout=15)

    def test_missing_or_escaping_reference_rejects(self):
        entry = self.skill / 'SKILL.md'
        original = entry.read_text()
        for target in ['references/missing.md', '../outside.md']:
            entry.write_text(original + '\n[Required reference](' + target + ')\n')
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'reference escapes or is missing'):
                checker.check(self.skill)

    def test_api_drift_and_missing_companion_reject(self):
        target = self.skill / 'references/api/ticket.create.md'
        original = target.read_bytes()
        target.write_bytes(original + b'\nchanged schema\n')
        with self.assertRaisesRegex(ValueError, 'content mismatch'):
            checker.check(self.skill)
        target.write_bytes(original)
        target.unlink()
        with self.assertRaises(ValueError):
            checker.check(self.skill)

    def test_symlinks_and_missing_metadata_reject(self):
        (self.skill / 'shortcut').symlink_to(self.skill / 'SKILL.md')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            checker.check(self.skill)
        (self.skill / 'shortcut').unlink()
        (self.skill / 'SKILL.md').write_text('# Missing metadata\n')
        with self.assertRaisesRegex(ValueError, 'frontmatter'):
            checker.check(self.skill)


if __name__ == '__main__':
    unittest.main()
