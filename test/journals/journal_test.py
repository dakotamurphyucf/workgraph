"""Offline receipt namespaces, immutable concurrent saves and exact replay."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
BINARY = str(Path(sys.argv.pop(1)).resolve())


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


class Journals(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-journal-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.address = self.root / 'absent'
        self.directory = self.root / 'requests'
        self.directory.mkdir()

    def cli(self, *args, expected=0):
        result = subprocess.run([BINARY, *map(str, args)], capture_output=True, text=True, timeout=20)
        if expected is not None:
            self.assertEqual(result.returncode, expected, (result.stdout, result.stderr))
        return result

    def inspect(self, path, **flags):
        args = [item for key, value in flags.items() for item in ('--' + key.replace('_', '-'), str(value))]
        return json.loads(self.cli('journal', 'inspect', path, *args).stdout)

    def request(self, method='ticket.create', *, id='cli', **params):
        return dict(jsonrpc='2.0', workgraph_api='0.7', id=id, method=method,
                    params=dict(workspace_id='demo', actor_id='worker', mutation_id='identity', **params))

    def store(self, name, request):
        path = self.directory / (name + '.json')
        path.write_bytes(canonical(request))
        return path

    def save(self, path, request, *, directory=False):
        args = ['call', str(self.address), request['method'], json.dumps(request['params']),
                '--request-directory' if directory else '--save-request', str(path)]
        return self.cli(*args, expected=1)  # Missing transport, after durable local save.

    def test_namespace_hashes_omissions_run_and_aliases_are_exact(self):
        request = self.request(title='Task', run_id='run')
        path = self.store('planning', request)
        entry = self.inspect(path)
        mutation = entry['mutation']
        self.assertEqual(mutation['namespace'], dict(kind='planning', workspace_id='demo'))
        self.assertEqual(mutation['request_hash'], digest(dict(method='ticket.create', params=dict(title='Task'), run_id='run')))
        self.assertEqual(entry['envelope_hash'], digest(request))
        self.assertEqual(entry['commit_status'], 'unchecked')
        self.assertEqual(entry['transmission_status'], 'unknown')
        registry = self.request('workspace.close')
        self.assertEqual(self.inspect(self.store('registry', registry))['mutation']['request_hash'],
                         digest(dict(method='workspace.close', params=registry['params'])))
        history = self.request('session.create', session_id='chat', title='Chat')
        historic = self.inspect(self.store('history', history))['mutation']
        self.assertEqual(historic['namespace'], dict(kind='history', workspace_id='demo'))
        self.assertEqual(historic['request_hash'], digest(dict(method='session.create', params=history['params'])))
        self.assertNotEqual(historic['request_hash'], mutation['request_hash'])
        before = path.read_bytes()
        request['id'] = 'another-envelope'
        same = self.inspect(self.store('other-id', request))
        self.assertEqual(same['mutation']['request_hash'], mutation['request_hash'])
        self.assertNotEqual(same['envelope_hash'], entry['envelope_hash'])
        self.assertEqual(path.read_bytes(), before)
        operations = [{'method': 'ticket.create', 'as': 'task', 'params': {'title': 'New'}},
                      {'method': 'ticket.update', 'params': {'ticket_id': '$task', 'expected_revision': '1', 'description': 'Details'}}]
        transaction = self.request('transaction.apply', operations=operations)
        parsed = self.inspect(self.store('aliases', transaction))
        self.assertEqual(parsed['mutation']['request_hash'], digest(dict(method='transaction.apply', params=dict(operations=operations))))
        self.assertEqual(json.loads((self.directory / 'aliases.json').read_text()), transaction)

    def test_sorted_bounded_pages_group_only_returned_entries(self):
        original = self.request(title='Task')
        self.store('a', original)
        self.store('b', original)
        self.store('c', self.request(title='Changed'))
        self.store('d', self.request('workspace.close'))
        (self.directory / 'e.json').write_text('{')
        (self.directory / 'ignored.stage').write_text('partial stage')
        page = json.loads(self.cli('journal.list', self.directory, '--limit', '2').stdout)
        self.assertFalse(page['complete'])
        self.assertEqual(page['next_after'], 'b.json')
        self.assertEqual(page['groups'][0]['kind'], 'same_request_hash')
        self.assertEqual(page['group_scope'], 'returned_entries_only')
        page = json.loads(self.cli('journal', 'list', self.directory).stdout)
        self.assertTrue(page['complete'])
        self.assertEqual([row['filename'] for row in page['items']], ['a.json', 'b.json', 'c.json', 'd.json', 'e.json'])
        self.assertEqual(page['groups'][0]['kind'], 'conflicting_request_hashes')
        self.assertEqual(page['items'][-1]['problem']['kind'], 'Invalid_argument')
        resumed = json.loads(self.cli('journal', 'list', self.directory, '--after', 'b.json').stdout)
        self.assertEqual([row['filename'] for row in resumed['items']], ['c.json', 'd.json', 'e.json'])
        self.assertEqual(resumed['groups'], [])
        self.assertLessEqual(len(canonical(page)), 1024 * 1024)
        self.cli('journal', 'list', self.directory, '--after', '../escape', expected=1)

    def test_links_special_files_and_bad_profiles_never_become_commit_evidence(self):
        valid = self.store('original', self.request(title='Task'))
        linked = self.directory / 'hardlink.json'
        os.link(valid, linked)
        self.assertEqual(self.inspect(linked), self.inspect(valid))
        self.assertIn('saved_request:', self.save(linked, self.request(title='Task')).stderr)
        (self.directory / 'symlink.json').symlink_to(valid)
        os.mkfifo(self.directory / 'fifo.json')
        before = valid.read_bytes()
        self.assertNotIn('saved_request:', self.save(self.directory / 'symlink.json', self.request(title='Task')).stderr)
        self.assertNotIn('saved_request:', self.save(self.directory / 'fifo.json', self.request(title='Task')).stderr)
        self.assertEqual(valid.read_bytes(), before)
        old = self.request(title='Old')
        old['workgraph_api'] = 'obsolete'
        self.store('obsolete', old)
        page = json.loads(self.cli('journal.list', self.directory).stdout)
        errors = {row['filename']: row['problem']['kind'] for row in page['items'] if row['problem']}
        self.assertEqual(errors, {'symlink.json': 'Invalid_argument', 'fifo.json': 'Invalid_argument', 'obsolete.json': 'Unsupported_version'})
        self.assertEqual(page['commit_status'], 'unchecked')
        # No daemon or valid context exists; offline commands must ignore both.
        result = self.cli('--context', self.root / 'nonexistent.json', '--socket', self.address,
                          'journal.inspect', valid)
        self.assertEqual(json.loads(result.stdout)['commit_status'], 'unchecked')

    def test_same_path_concurrent_saves_and_different_bytes_never_overwrite(self):
        original = self.request(title='Task', description='x' * 50000)
        destination = self.directory / 'same.json'
        barrier = threading.Barrier(2)
        def save(request):
            barrier.wait()
            return self.save(destination, request)
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(save, [original, original]))
        self.assertTrue(all('saved_request:' in result.stderr for result in results))
        self.assertEqual(destination.read_bytes(), canonical(original))
        self.assertEqual(list(self.directory.glob('*.stage')), [])
        different = self.request(title='Changed')
        before = destination.read_bytes()
        result = self.save(destination, different)
        self.assertNotIn('saved_request:', result.stderr)
        self.assertEqual(destination.read_bytes(), before)
        destination.unlink()
        barrier = threading.Barrier(2)
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(save, [original, different]))
        self.assertEqual(sum('saved_request:' in result.stderr for result in results), 1)
        self.assertIn(destination.read_bytes(), [canonical(original), canonical(different)])
        destination.write_text('{"partial":')
        before = destination.read_bytes()
        self.assertNotIn('saved_request:', self.save(destination, original).stderr)
        self.assertEqual(destination.read_bytes(), before)
        long_destination = self.directory / ('x' * 240 + '.json')
        self.assertIn('saved_request:', self.save(long_destination, original).stderr)
        self.assertEqual(long_destination.read_bytes(), canonical(original))

    def test_escaped_directory_and_filenames_respect_exact_output_limit(self):
        escaped = self.directory / ('\n"\t\\' * 30)
        escaped.mkdir()
        request = canonical(self.request(title='Task'))
        for number in range(1000):
            (escaped / (f'{number:04d}-' + '"\\' * 85 + '.json')).write_bytes(request)
        page = json.loads(self.cli('journal.list', escaped, '--limit', '1000').stdout)
        self.assertFalse(page['complete'])
        self.assertEqual(page['stop'], 'output_byte_limit')
        self.assertLessEqual(len(canonical(page)), 1024 * 1024)
        self.assertEqual(page['next_after'], page['items'][-1]['filename'])
        resumed = json.loads(self.cli('journal.list', escaped, '--after', page['next_after'], '--limit', '1000').stdout)
        self.assertLessEqual(len(canonical(resumed)), 1024 * 1024)
        self.assertGreater(resumed['items'][0]['filename'], page['next_after'])

    def test_automatic_exact_reuse_retains_changed_identity_payloads_and_new_operations(self):
        first = self.request(title='Task')
        self.assertIn('saved_request:', self.save(self.directory, first, directory=True).stderr)
        self.assertIn('saved_request:', self.save(self.directory, first, directory=True).stderr)
        files = list(self.directory.glob('*.json'))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].name, digest(first) + '.json')
        self.save(self.directory, self.request(title='Changed'), directory=True)
        page = json.loads(self.cli('journal.list', self.directory).stdout)
        self.assertEqual(page['groups'][0]['kind'], 'conflicting_request_hashes')
        for _ in range(2):
            params = dict(workspace_id='demo', actor_id='worker', title='Fresh')
            self.cli('call', self.address, 'ticket.create', json.dumps(params), '--request-directory', self.directory, expected=1)
        self.assertEqual(len(list(self.directory.glob('*.json'))), 4)
        explicit = self.directory / 'explicit.json'
        self.save(explicit, first)
        before = explicit.read_bytes()
        self.cli('call', self.address, 'ticket.create', json.dumps(params), '--save-request', explicit, expected=1)
        self.assertEqual(explicit.read_bytes(), before)

    def test_complete_upload_plan_inspection_does_not_read_deleted_source(self):
        source = self.root / 'source.bin'
        source.write_bytes(b'bytes\xff')
        saved = self.directory / 'upload.json'
        self.cli('resource', 'upload', self.address, '--workspace-id', 'demo', '--actor-id', 'worker',
                 '--mutation-id', 'upload', '--resource-id', 'file', '--title', 'File', '--expected-revision', '0',
                 '--ticket-id', 'task', '--file', source, '--save-request', saved, expected=1)
        before = saved.read_bytes()
        source.unlink()
        entry = self.inspect(saved)
        self.assertEqual(entry['kind'], 'upload_plan')
        self.assertEqual(entry['mutation']['method'], 'resource.finish_upload')
        self.assertEqual(entry['ticket_link'], 'task')
        params = json.loads(before)['params']
        self.assertEqual(params['transfer_version'], '2')
        body = {k: params[k] for k in ['upload_id', 'resource_id', 'expected_revision', 'title', 'filename', 'mime_type']}
        self.assertEqual(entry['mutation']['request_hash'], digest(dict(method='resource.finish_upload', params=body)))
        self.assertNotEqual(entry['mutation']['request_hash'], entry['envelope_hash'])
        self.assertEqual(saved.read_bytes(), before)
        self.assertFalse(source.exists())
        del params['digest']
        incomplete = self.store('incomplete', dict(jsonrpc='2.0', workgraph_api='0.7', id='cli', method='resource.upload', params=params))
        self.cli('journal.inspect', incomplete, expected=1)

    def test_input_budget_and_alias_scope_do_not_hide_incomplete_scans(self):
        first = self.request(title='Same')
        self.store('a', first)
        other = json.loads(json.dumps(first))
        other['params']['workspace_id'] = 'another'
        self.store('b', other)
        (self.directory / 'c.json').write_bytes(b'x' * (4 * 1024 * 1024))
        page = json.loads(self.cli('journal.list', self.directory, '--max-bytes', str(4 * 1024 * 1024)).stdout)
        self.assertFalse(page['complete'])
        self.assertEqual(page['stop'], 'input_byte_limit')
        self.assertEqual(page['next_after'], 'b.json')
        self.assertEqual(page['groups'], [])
        self.assertEqual(page['items'][0]['entry']['mutation']['request_hash'], page['items'][1]['entry']['mutation']['request_hash'])
        page = json.loads(self.cli('journal.list', self.directory, '--after', 'b.json').stdout)
        self.assertTrue(page['complete'])
        self.assertEqual(page['items'][0]['problem']['kind'], 'Invalid_argument')
        old_alias = self.request('ticket.get', ticket_id='task')
        self.cli('journal.inspect', self.store('alias', old_alias), expected=1)

    def test_actual_receipt_hashes_and_nondurable_observation_remain_distinct(self):
        self.address = self.root / 'daemon.sock'
        log = (self.root / 'daemon.log').open('w+')
        self.addCleanup(log.close)
        daemon = subprocess.Popen([BINARY, 'serve', str(self.root / 'registry'), str(self.address)], stdout=log, stderr=log)
        self.addCleanup(lambda: daemon.poll() is None and (daemon.terminate(), daemon.wait(timeout=5)))
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            self.assertIsNone(daemon.poll())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        def call(method, **params):
            return json.loads(self.cli('call', self.address, method, json.dumps(params)).stdout)['result']
        create = self.request('workspace.create', name='Journals', root=str(self.root / 'workspace'))
        saved = self.directory / 'create.json'
        self.cli('call', self.address, create['method'], json.dumps(create['params']), '--save-request', saved)
        receipt = call('registry.receipt', actor_id='worker', mutation_id='identity')['data']
        self.assertEqual(receipt['request_hash'], self.inspect(saved)['mutation']['request_hash'])
        register = self.request('run.register', target_run_id='run', objective='Work')
        saved = self.directory / 'run.json'
        self.cli('call', self.address, register['method'], json.dumps(register['params']), '--save-request', saved)
        receipt = call('workspace.receipt', workspace_id='demo', actor_id='worker', mutation_id='identity')['data']
        self.assertEqual(receipt['request_hash'], self.inspect(saved)['mutation']['request_hash'])
        history = self.request('session.create', session_id='chat', title='Chat')
        saved = self.directory / 'history.json'
        self.cli('call', self.address, history['method'], json.dumps(history['params']), '--save-request', saved)
        batches = list((self.root / 'workspace' / 'history' / 'batches').glob('*.json'))
        self.assertEqual(len(batches), 1)
        self.assertEqual(json.loads(batches[0].read_text())['request_hash'], self.inspect(saved)['mutation']['request_hash'])
        empty = self.request('ticket.claim_next', target_run_id='run', run_id='run', attempt_id='empty')
        empty['params']['mutation_id'] = 'empty'
        saved = self.directory / 'empty.json'
        reply = json.loads(self.cli('call', self.address, empty['method'], json.dumps(empty['params']), '--save-request', saved).stdout)['result']
        self.assertFalse(reply['meta']['durable'])
        self.assertEqual(call('workspace.receipt', workspace_id='demo', actor_id='worker', mutation_id='empty')['data']['status'], 'absent')
        self.assertEqual(self.inspect(saved)['commit_status'], 'unchecked')
        self.assertEqual(json.loads(self.cli('retry', self.address, saved).stdout)['result']['meta']['durable'], False)
        call('daemon.shutdown')
        daemon.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
