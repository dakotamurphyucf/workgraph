"""Copied standalone cache helper: exact source identity, bytes, races and real IO."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

BINARY = Path(sys.argv.pop(1)).resolve()
SOURCE = Path(__file__).resolve().parents[2] / 'skills/workgraph/scripts/input-cache.py'
spec = importlib.util.spec_from_file_location('input_cache', SOURCE)
cache = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cache
spec.loader.exec_module(cache)


class InputCache(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-input-cache-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.worktree = self.root / 'checkout'
        self.worktree.mkdir()
        # Only the one script is copied: no checkout modules or imports beside it.
        self.helper = self.root / 'input-cache.py'
        shutil.copyfile(SOURCE, self.helper)
        self.directory = self.root / 'cache'
        self.payload = b'\xff\x00 immutable input\n'
        self.config = self.root / 'fake.json'
        self.counter = self.root / 'downloads'
        self.fake = self.root / 'workgraph'
        self.fake.write_text('''#!/usr/bin/env python3
import hashlib,json,os,pathlib,sys,time
config=json.loads(pathlib.Path(%r).read_text())
with open(%r,'a') as calls: calls.write('download\\n')
flags=dict(zip(sys.argv[4::2],sys.argv[5::2]))
if config.get('barrier'):
 barrier=pathlib.Path(config['barrier']); (barrier/str(os.getpid())).touch()
 deadline=time.monotonic()+10
 while len(list(barrier.iterdir()))<2:
  if time.monotonic()>deadline: raise RuntimeError('barrier timed out')
  time.sleep(.01)
payload=bytes.fromhex(config['hex'])
destination=pathlib.Path(flags['--destination'])
with destination.open('xb') as output: output.write(payload)
if config.get('fail'):
 print(json.dumps({'kind':'Outcome_unknown','message':'injected download failure'}),file=sys.stderr)
 sys.exit(1)
data={'resource_id':flags['--resource-id'],'version':flags['--version'],
 'digest':hashlib.sha256(payload).hexdigest(),'size_bytes':str(len(payload)),
 'destination':str(destination)}
data.update(config.get('receipt',{}))
print(json.dumps({'jsonrpc':'2.0','id':'cli','result':{'data':data,'meta':{}}}))
''' % (str(self.config), str(self.counter)))
        self.fake.chmod(0o700)
        self.configure()

    def configure(self, **extra):
        self.config.write_text(json.dumps({'hex': self.payload.hex(), **extra}))

    def pin(self, **changes):
        fields = dict(socket=str(self.root / 'source.sock'), workspace_id='demo', resource_id='input',
                      version='1', digest=hashlib.sha256(self.payload).hexdigest(), size_bytes=str(len(self.payload)))
        fields.update(changes)
        return cache.Pin.create(**fields)

    def argv(self, pin=None, **changes):
        pin = pin or self.pin()
        fields = dict(workgraph=str(self.fake), socket=pin.socket, workspace_id=pin.workspace_id,
                      resource_id=pin.resource_id, version=pin.version, digest=pin.digest,
                      size_bytes=str(pin.size_bytes), cache_directory=str(self.directory), worktree=str(self.worktree))
        fields.update(changes)
        return [sys.executable, str(self.helper), *[item for key, value in fields.items()
                    for item in ('--' + key.replace('_', '-'), str(value))]]

    def invoke(self, pin=None, expected=0, **changes):
        result = subprocess.run(self.argv(pin, **changes), cwd=self.root, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, expected, (result.stdout, result.stderr))
        return json.loads(result.stdout if expected == 0 else result.stderr)

    def calls(self):
        return len(self.counter.read_text().splitlines()) if self.counter.exists() else 0

    def test_reuse_changed_pins_and_clean_checkout(self):
        first = self.invoke()
        self.assertEqual(first['status'], 'stored')
        path = Path(first['path'])
        self.assertEqual(path.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
        self.assertEqual(self.invoke()['status'], 'hit')
        self.assertEqual(self.calls(), 1)
        for changes in [dict(workspace_id='other'), dict(resource_id='other'), dict(version='2'),
                        dict(socket=str(self.root / 'other.sock'))]:
            changed = self.invoke(self.pin(**changes))
            self.assertEqual(changed['status'], 'stored')
            self.assertNotEqual(changed['path'], first['path'])
        old_payload = self.payload
        self.payload += b' changed'
        self.configure()
        changed = self.invoke()
        self.assertNotEqual(changed['path'], first['path'])
        self.assertEqual(path.read_bytes(), old_payload)
        self.assertEqual(list(self.worktree.iterdir()), [])
        self.assertEqual(first['pin'], self.pin(digest=hashlib.sha256(old_payload).hexdigest(),
                                               size_bytes=str(len(old_payload))).as_json())

    def test_corruption_symlink_and_nonregular_hits_reject_without_overwrite(self):
        first = self.invoke()
        path = Path(first['path'])
        path.chmod(0o600)
        path.write_bytes(b'x' * len(self.payload))
        self.assertEqual(self.invoke(expected=1)['kind'], 'Corrupt_cache')
        self.assertEqual(self.calls(), 1)
        self.assertEqual(path.read_bytes(), b'x' * len(self.payload))
        path.unlink()
        outside = self.root / 'outside'
        outside.write_bytes(self.payload)
        path.symlink_to(outside)
        self.assertEqual(self.invoke(expected=1)['kind'], 'Local_io')
        self.assertEqual(outside.read_bytes(), self.payload)
        path.unlink()
        os.mkfifo(path)
        self.assertEqual(self.invoke(expected=1)['kind'], 'Unsafe_path')
        self.assertEqual(self.calls(), 1)

    def test_bad_receipt_and_corrupt_success_never_install(self):
        for field, value in [('resource_id', 'other'), ('version', '2'), ('digest', '0' * 64),
                             ('size_bytes', '1'), ('destination', '/elsewhere')]:
            self.configure(receipt={field: value})
            self.assertEqual(self.invoke(expected=1)['kind'], 'Invalid_receipt')
            self.assertFalse((self.directory / self.pin().cache_name()).exists())
        self.configure(hex=(b'x' * len(self.payload)).hex(), receipt={
            'digest': self.pin().digest, 'size_bytes': str(len(self.payload))})
        self.assertEqual(self.invoke(expected=1)['kind'], 'Corrupt_cache')
        self.configure(fail=True)
        failed = self.invoke(expected=1)
        self.assertEqual(failed['kind'], 'Download_failed')
        self.assertIn('Outcome_unknown', failed['details']['stderr'])
        self.assertTrue((Path(failed['details']['stage']) / 'content').is_file())
        self.assertFalse((self.directory / self.pin().cache_name()).exists())

    def test_invalid_scope_paths_and_private_cache(self):
        for name, value in [('version', '01'), ('digest', '0' * 63), ('size_bytes', '01'),
                            ('resource_id', '../other'), ('version', '9' * 5000), ('size_bytes', '9' * 5000)]:
            self.assertEqual(self.invoke(expected=1, **{name: value})['kind'], 'Invalid_argument')
        inside = self.worktree / 'cache'
        self.assertEqual(self.invoke(expected=1, cache_directory=inside)['kind'], 'Invalid_argument')
        self.assertFalse(inside.exists())
        self.directory.mkdir(mode=0o755)
        self.assertEqual(self.invoke(expected=1)['kind'], 'Unsafe_path')
        self.directory.rmdir()
        real = self.root / 'real'
        real.mkdir(mode=0o700)
        self.directory.symlink_to(real)
        self.assertEqual(self.invoke(expected=1)['kind'], 'Unsafe_path')
        self.assertEqual(self.calls(), 0)

    def test_concurrent_save_verifies_the_no_replace_winner(self):
        barrier = self.root / 'barrier'
        barrier.mkdir()
        self.configure(barrier=str(barrier))
        processes = [subprocess.Popen(self.argv(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for _ in range(2)]
        try:
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr)
                results.append(json.loads(stdout))
            self.assertEqual({result['status'] for result in results}, {'stored', 'race_hit'})
            self.assertEqual(results[0]['path'], results[1]['path'])
            self.assertEqual(Path(results[0]['path']).read_bytes(), self.payload)
            self.assertEqual(self.calls(), 2)
            self.assertEqual(self.invoke()['status'], 'hit')
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=10)

    def test_corrupt_concurrent_winner_is_retained_and_rejected(self):
        def collision(source, destination, **options):
            Path(destination).write_bytes(b'x' * len(self.payload))
            raise FileExistsError('injected competing publication')
        with mock.patch.object(cache.os, 'link', side_effect=collision):
            with self.assertRaises(cache.CacheError) as raised:
                cache.resolve(self.pin(), directory=self.directory, worktree=self.worktree,
                              workgraph=self.fake, timeout=30)
        self.assertEqual(raised.exception.kind, 'Corrupt_cache')
        self.assertEqual((self.directory / self.pin().cache_name()).read_bytes(), b'x' * len(self.payload))

    def test_cancellation_propagates_and_retains_only_private_stage(self):
        with mock.patch.object(cache.subprocess, 'run', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                cache.resolve(self.pin(), directory=self.directory, worktree=self.worktree,
                              workgraph=self.fake, timeout=30)
        self.assertEqual(len(list(self.directory.glob('.input-*'))), 1)
        self.assertFalse((self.directory / self.pin().cache_name()).exists())

    def test_post_publish_sync_uncertainty_preserves_installed_bytes(self):
        original = os.fsync
        def sync(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError('injected directory sync failure')
            original(descriptor)
        with mock.patch.object(cache.os, 'fsync', side_effect=sync):
            with self.assertRaises(cache.CacheError) as raised:
                cache.resolve(self.pin(), directory=self.directory, worktree=self.worktree,
                              workgraph=self.fake, timeout=30)
        self.assertEqual(raised.exception.kind, 'Outcome_unknown')
        self.assertEqual(Path(raised.exception.details['path']).read_bytes(), self.payload)
        self.assertEqual(self.invoke()['status'], 'hit')

    def test_real_daemon_verified_download_then_offline_hit_and_new_pin(self):
        address = self.root / 'daemon.sock'
        log = (self.root / 'daemon.log').open('w+')
        daemon = subprocess.Popen([str(BINARY), 'serve', str(self.root / 'registry'), str(address)],
                                  stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 10
            while not is_listening(address):
                if daemon.poll() is not None or time.monotonic() >= deadline:
                    log.seek(0)
                    self.fail(log.read())
                time.sleep(.01)
            def call(method, **params):
                result = subprocess.run([str(BINARY), 'call', str(address), method, json.dumps(params)],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
                return json.loads(result.stdout)['result']['data']
            call('workspace.create', workspace_id='demo', actor_id='a', mutation_id='create',
                 name='Cache', root=str(self.root / 'workspace'))
            for index, text in enumerate(['original bytes', 'new bytes']):
                publication = call('resource.put_text', workspace_id='demo', actor_id='a', mutation_id='put-' + str(index),
                                   resource_id='input', expected_revision=str(index), title='Input', text=text)
                pin = self.pin(socket=str(address), version=publication['version']['revision'],
                               digest=publication['version']['digest'], size_bytes=publication['version']['size_bytes'])
                output = self.invoke(pin, workgraph=BINARY)
                self.assertEqual(output['status'], 'stored')
                self.assertEqual(Path(output['path']).read_bytes(), text.encode())
            call('daemon.shutdown')
            self.assertEqual(daemon.wait(timeout=10), 0)
            # No daemon is available: the supplied exact pin is enough for a rehashed hit.
            self.assertEqual(self.invoke(pin, workgraph=BINARY)['status'], 'hit')
        finally:
            if daemon.poll() is None:
                daemon.terminate()
                daemon.wait(timeout=10)
            log.close()


if __name__ == '__main__':
    unittest.main()
