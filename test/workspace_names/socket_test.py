"""Current versus lifecycle-checkpoint names without hidden workspace opening."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

BINARY = str(Path(sys.argv.pop(1)).resolve())


class WorkspaceNames(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-names-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.address = self.root / 's'
        self.workspace = self.root / 'workspace'
        self.registry = self.root / 'registry' / 'registry.json'
        self.log = (self.root / 'daemon.log').open('w+')
        self.addCleanup(self.log.close)
        self.serial = 0
        self.daemon = None
        self.addCleanup(self.stop)
        self.start()
        self.write('workspace.create', name='Initial 💖', root=str(self.workspace))

    def start(self):
        self.daemon = subprocess.Popen([BINARY, 'serve', str(self.root / 'registry'), str(self.address)],
                                       stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic() > deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)

    def stop(self):
        if self.daemon and self.daemon.poll() is None:
            self.read('daemon.shutdown')
            self.daemon.wait(timeout=5)

    def call(self, method, **params):
        result = subprocess.run([BINARY, 'call', str(self.address), method, json.dumps(params)],
                                capture_output=True, text=True, timeout=15)
        return json.loads(result.stdout or result.stderr)

    def read(self, method, **params):
        response = self.call(method, **params)
        self.assertIn('result', response, response)
        return response['result']['data']

    def write(self, method, **params):
        self.serial += 1
        params = dict(workspace_id='demo', actor_id='worker', mutation_id='write-' + str(self.serial), **params)
        return self.read(method, **params)

    def listing(self):
        result = self.read('workspace.list')
        self.assertEqual(self.read('daemon.health'), result)
        return {entry['workspace_id']: entry for entry in result['workspaces']}

    def assert_name(self, expected, source, *, open, error=None):
        entry = self.listing()['demo']
        self.assertEqual((entry['name'], entry['name_source'], entry['open']), (expected, source, open))
        if error is None:
            self.assertIsNone(entry['error'])
        else:
            self.assertIsNotNone(entry['error'])
        return entry

    def test_rename_close_restart_and_missing_closed_root_do_not_auto_open(self):
        self.assert_name('Initial 💖', 'current', open=True)
        before = self.registry.read_bytes()
        # A separate registry CAS would fail on these externally changed bytes.
        # The durable workspace rename must not depend on that advisory cache.
        self.registry.write_bytes(before + b'\n')
        self.write('workspace.update', expected_revision='0', name='Renamed é')
        self.assert_name('Renamed é', 'current', open=True)
        self.assertEqual(self.registry.read_bytes(), before + b'\n')
        self.registry.write_bytes(before)  # Restore the fixture before lifecycle CAS.
        close = dict(workspace_id='demo', actor_id='worker', mutation_id='close')
        receipt = self.call('workspace.close', **close)
        self.assertIn('result', receipt)
        self.assertEqual(self.call('workspace.close', **close), receipt)
        entry = self.assert_name('Renamed é', 'last_known', open=False)
        self.assertIsNone(entry['archived'])
        self.assertEqual(json.loads(self.registry.read_text())['workspaces']['demo']['known_name'], 'Renamed é')
        self.stop()
        hidden = self.root / 'hidden'
        self.workspace.rename(hidden)
        before = self.registry.read_bytes()
        self.start()
        self.assert_name('Renamed é', 'last_known', open=False)
        self.assertFalse(self.workspace.exists())
        self.assertEqual(self.registry.read_bytes(), before)
        response = self.call('workspace.get', workspace_id='demo')
        self.assertEqual(response['error']['data']['kind'], 'Workspace_closed')
        self.assertFalse(self.workspace.exists())
        hidden.rename(self.workspace)
        self.write('workspace.open')
        self.assert_name('Renamed é', 'current', open=True)
        self.write('workspace.archive', expected_revision='1', archived=True, name='Archived display')
        self.assertTrue(self.assert_name('Archived display', 'current', open=True)['archived'])
        self.write('workspace.close')
        self.stop()
        self.start()
        self.assert_name('Archived display', 'last_known', open=False)

    def test_unavailable_open_intent_exposes_explicit_checkpoint_until_recovery(self):
        self.write('workspace.update', expected_revision='0', name='Newest name')
        self.assert_name('Newest name', 'current', open=True)
        self.stop()
        hidden = self.root / 'hidden'
        self.workspace.rename(hidden)
        self.start()
        entry = self.assert_name('Initial 💖', 'last_known', open=False, error=True)
        self.assertTrue(entry['open_intent'])
        self.assertFalse(self.workspace.exists())
        # A successful open replays the authoritative rename and checkpoints it.
        hidden.rename(self.workspace)
        self.write('workspace.open')
        self.assert_name('Newest name', 'current', open=True)
        self.assertEqual(json.loads(self.registry.read_text())['workspaces']['demo']['known_name'], 'Newest name')
        self.write('workspace.close')
        self.stop()
        self.workspace.rename(hidden)
        self.start()
        self.assert_name('Newest name', 'last_known', open=False)

    def test_verified_restore_and_registration_use_replayed_renamed_name(self):
        self.write('transaction.apply', operations=[
            {'method': 'workspace.update', 'params': {'expected_revision': '0', 'name': 'Exported rename'}}])
        export = self.write('workspace.export', destination=str(self.root / 'export'))
        deadline = time.monotonic() + 10
        while True:
            job = self.read('export.get', job_id=export['job_id'])
            if job['status'] != 'running':
                self.assertEqual(job['status'], 'completed', job)
                break
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        self.write('workspace.unregister')
        restored = self.root / 'restored'
        params = dict(actor_id='worker', mutation_id='restore', directory=str(self.root / 'export'), root=str(restored))
        receipt = self.call('workspace.restore', **params)
        self.assertIn('result', receipt, receipt)
        self.assertEqual(self.call('workspace.restore', **params), receipt)
        self.assert_name('Exported rename', 'last_known', open=False)
        self.stop()
        self.start()
        self.assert_name('Exported rename', 'last_known', open=False)
        self.write('workspace.open')
        self.assert_name('Exported rename', 'current', open=True)
        self.write('workspace.update', expected_revision='1', name='Registered rename')
        self.write('workspace.unregister')
        self.read('workspace.register', actor_id='worker', mutation_id='register', root=str(restored))
        self.assert_name('Registered rename', 'current', open=True)
        self.write('workspace.close')
        self.assert_name('Registered rename', 'last_known', open=False)


if __name__ == '__main__':
    unittest.main()
