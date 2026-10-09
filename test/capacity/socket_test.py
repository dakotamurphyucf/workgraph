"""Actual cached health, authoritative upload refusal, export and selected rollover."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

BINARY = Path(sys.argv.pop(1)).resolve()
RECIPE = Path(sys.argv.pop(1)).resolve()


class CapacityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-capacity-', dir='/tmp')
        self.root = Path(self.temporary.name)
        self.socket = self.root / 'socket'
        self.log = (self.root / 'daemon.log').open('w+')
        self.daemon = subprocess.Popen([str(BINARY), 'serve', str(self.root / 'registry'), str(self.socket)],
                                       stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 10
        while not self.socket.exists():
            if self.daemon.poll() is not None or time.monotonic() >= deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)
        self.sequence = 0

    def tearDown(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=10)
        self.log.close()
        self.temporary.cleanup()

    def call(self, method, params, *, failure=False):
        result = subprocess.run([str(BINARY), 'call', str(self.socket), method, json.dumps(params)],
                                capture_output=True, text=True)
        if failure:
            self.assertEqual(result.returncode, 1, result.stdout)
            return json.loads(result.stdout)['error']['data']
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)['result']

    def write(self, method, workspace='predecessor', **params):
        self.sequence += 1
        params = {'workspace_id': workspace, 'actor_id': 'operator', **params}
        if not method.startswith('upload.'):
            params['mutation_id'] = 'write-' + str(self.sequence)
        return self.call(method, params)

    def create(self, workspace='predecessor'):
        return self.write('workspace.create', workspace, name=workspace, root=str(self.root / workspace))

    def health(self, workspace='predecessor'):
        return next(row for row in self.call('daemon.health', {})['data']['workspaces'] if row['workspace_id'] == workspace)

    def test_bands_refusal_cached_health_and_export(self):
        self.create()
        self.write('ticket.create', ticket_id='task', title='Task')
        workspace = self.root / 'predecessor'
        original = workspace / 'HEAD.json'
        hidden = workspace / 'temporarily-hidden-head'
        original.rename(hidden)
        try:
            # Health is a last-committed advisory capture, not a disk integrity probe.
            self.assertIsNotNone(self.health()['capacity'])
        finally:
            hidden.rename(original)
        for index in range(8):
            self.write('upload.begin', upload_id='upload-' + str(index), size_bytes='1', digest=hashlib.sha256(b'x').hexdigest())
            if index in {3, 6, 7}:
                summary = self.health()['capacity']
                self.assertEqual(summary['highest_severity'], {3: 'notice', 6: 'warning', 7: 'critical'}[index])
                self.assertEqual(len(summary['meters']), 3)
                self.assertEqual(summary['omitted_meters'], '11')
                meter = next(row for row in summary['meters'] if row['name'] == 'active_uploads')
                self.assertEqual(meter['lifetime'], 'temporary')
        before = self.call('workspace.metrics', {'workspace_id': 'predecessor', 'max_bytes': '8192'})['data']
        rejected = self.call('upload.begin', {'workspace_id': 'predecessor', 'actor_id': 'operator',
                             'upload_id': 'ninth', 'size_bytes': '1', 'digest': hashlib.sha256(b'x').hexdigest()}, failure=True)
        self.assertIn('details', rejected, rejected)
        details = rejected['details']
        self.assertEqual(details['type'], 'capacity')
        self.assertEqual((details['meter'], details['used'], details['attempted'], details['limit']),
                         ('active_uploads', '8', '9', '8'))
        self.assertIn('temporary-upload-occupancy', details['operator_action'])
        after = self.call('workspace.metrics', {'workspace_id': 'predecessor', 'max_bytes': '8192'})['data']
        # Wall-clock observation time may advance; authoritative counters must not.
        for capture in [before, after]:
            capture.pop('observed_unix_ms')
            for status in capture['statuses']:
                status.pop('elapsed_ms')
        self.assertEqual(after, before)
        export = self.write('workspace.export', destination=str(self.root / 'export'))['data']
        deadline = time.monotonic() + 10
        while self.call('export.get', {'job_id': export['job_id']})['data']['status'] != 'completed':
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.02)
        self.assertEqual(self.call('export.verify', {'directory': str(self.root / 'export')})['data']['workspace_id'], 'predecessor')
        self.write('upload.abort', upload_id='upload-0')
        self.assertEqual(self.health()['capacity']['highest_severity'], 'warning')
        self.create('bytes')
        for index in range(4):
            self.write('upload.begin', 'bytes', upload_id='large-' + str(index), size_bytes=str(64 * 1024 * 1024),
                       digest=hashlib.sha256(b'x').hexdigest())
        rejected = self.call('upload.begin', {'workspace_id': 'bytes', 'actor_id': 'operator', 'upload_id': 'extra',
                                             'size_bytes': '1', 'digest': hashlib.sha256(b'x').hexdigest()}, failure=True)
        self.assertEqual(rejected['details']['meter'], 'reserved_upload_bytes')
        self.assertEqual(rejected['details']['attempted'], str(256 * 1024 * 1024 + 1))

    def test_selected_rollover_preserves_context_without_inherited_authority(self):
        self.create()
        self.write('project.create', project_id='project', title='Project', description='Shared instructions')
        self.write('ticket.create', ticket_id='parent', project_id='project', title='Parent')
        self.write('ticket.create', ticket_id='child', project_id='project', parent_ticket_id='parent', title='Child', description='Recoverable task')
        self.write('ticket.create', ticket_id='outside', project_id='project', title='Historical dependency')
        claim = self.write('ticket.claim', ticket_id='child')['data']
        self.write('dependency.add', ticket_id='child', prerequisite_id='parent')
        self.write('dependency.add', ticket_id='parent', prerequisite_id='outside')
        publication = self.write('resource.put_text', resource_id='notes', expected_revision='0', title='Notes',
                                 text='Exact resource bytes', filename='notes.txt', mime_type='text/plain')['data']
        self.write('resource.link', resource_id='notes', expected_revision=publication['revision'], target={'kind': 'ticket', 'id': 'child'})
        self.write('fact.put', scope={'kind': 'workspace'}, key='decision', expected_revision='0', value={'choice': 'keep'})
        self.write('fact.put', scope={'kind': 'ticket', 'id': 'child'}, key='next', expected_revision='0', value='Continue here')
        evidence = 'é' * 32768  # Exact valid 65536 UTF-8 byte boundary; no prefix may be added.
        self.write('handoff.set', ticket_id='child', expected_revision='0', token=claim['token'], summary='Work in progress',
                   next_steps='Review retained notes', evidence=evidence, objective='Finish child', resource_ids=['notes'])
        # Export active run/attempt and a genuinely approved current submission.
        self.write('run.register', target_run_id='run', objective='Review source work')
        schema = self.write('resource.put_text', resource_id='schema', expected_revision='0', title='Schema', text='{}')['data']
        self.write('contract.put', contract_id='contract', expected_revision='0', schema_version='1',
                   schema={'resource_id': 'schema', 'revision': schema['version']['revision'], 'digest': schema['version']['digest']},
                   required_inputs=[], required_outputs=[])
        self.write('ticket.create', ticket_id='reviewed', title='Approved predecessor work')
        self.write('ticket.start', ticket_id='reviewed', run_id='run', attempt_id='attempt')
        self.write('review.policy.put', ticket_id='reviewed', expected_revision='0', enabled=True,
                   reviewers=[], separate_actor=False, validators=[])
        manifest = {'manifest_id': 'manifest', 'revision': '1'}
        self.write('manifest.publish', manifest_id='manifest', expected_revision='0', schema_version='1',
                   attempt_id='attempt', ticket_id='reviewed', run_id='run',
                   contract={'contract_id': 'contract', 'revision': '1'}, inputs=[], outputs=[])
        self.write('review.submit', ticket_id='reviewed', expected_revision='0', manifest=manifest, run_id='run')
        self.write('review.accept', ticket_id='reviewed', expected_revision='1', run_id='run')
        self.assertTrue(self.call('review.gate', {'workspace_id': 'predecessor', 'ticket_id': 'reviewed'})['data']['allowed'])
        selection = self.root / 'selection.json'
        selection.write_text(json.dumps({'tickets': ['parent', 'child', 'reviewed'], 'resources': ['notes'], 'handoffs': ['child'],
                                        'facts': [{'scope': {'kind': 'workspace'}, 'key': 'decision'},
                                                  {'scope': {'kind': 'ticket', 'id': 'child'}, 'key': 'next'}]}))
        command = [sys.executable, str(RECIPE), '--binary', str(BINARY), '--socket', str(self.socket),
                   '--actor', 'operator', '--predecessor', 'predecessor', '--successor', 'successor',
                   '--successor-root', str(self.root / 'successor'), '--export-directory', str(self.root / 'rollover-export'),
                   '--state-directory', str(self.root / 'rollover-private'), '--selection', str(selection), '--writers-quiesced']
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr)
        outcome = json.loads(result.stdout)
        mapping = outcome['id_mapping']
        child, parent = mapping['ticket']['child'], mapping['ticket']['parent']
        current = self.call('ticket.context', {'workspace_id': 'successor', 'ticket_id': child, 'max_bytes': '1048576'})['data']
        self.assertIsNone(current['ticket']['claim'])
        self.assertEqual(current['attempts']['items'], [])
        self.assertEqual(current['ticket']['parent_ticket_id'], parent)
        self.assertEqual(current['ticket']['prerequisite_ticket_ids'], [parent])
        self.assertIsNotNone(current['ticket']['hold'])
        self.assertEqual(current['handoff']['evidence'], evidence)
        reviewed = self.call('ticket.context', {'workspace_id': 'successor', 'ticket_id': mapping['ticket']['reviewed']})['data']
        self.assertIsNone(reviewed['ticket']['claim'])
        self.assertEqual(reviewed['attempts']['items'], [])
        self.assertEqual(self.call('run.list', {'workspace_id': 'successor'})['data']['items'], [])
        missing = self.call('review.submission.get', {'workspace_id': 'successor', 'ticket_id': mapping['ticket']['reviewed']}, failure=True)
        self.assertEqual(missing['kind'], 'Not_found')
        value = self.call('fact.get', {'workspace_id': 'successor', 'scope': {'kind': 'ticket', 'id': child}, 'key': 'next'})['data']
        self.assertEqual(value['value'], 'Continue here')
        recovered = self.call('resource.read', {'workspace_id': 'successor', 'resource_id': mapping['resource']['notes']})['data']
        self.assertEqual(recovered['text'], 'Exact resource bytes')
        record = json.loads((self.root / 'rollover-private' / 'mapping.json').read_text())
        self.assertEqual(record['predecessor']['workspace_id'], 'predecessor')
        self.assertEqual(len(record['predecessor']['export_manifest_sha256']), 64)
        self.assertIn('satisfied_gates', record['omitted']['authority'])
        self.assertIn('no successor completion or approval', record['handoffs'][0]['treatment'])
        self.assertIn({'ticket': 'parent', 'kind': 'prerequisite', 'target': 'outside'}, record['omitted']['graph_edges'])
        self.assertFalse(self.health()['open'])
        # Repeating the same intent replays saved writes rather than creating copies.
        repeated = subprocess.run(command, capture_output=True, text=True, timeout=90)
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)['id_mapping'], mapping)
        # Historical source remains explicitly reopenable, with its original claim.
        self.write('workspace.open')
        historical = self.call('ticket.context', {'workspace_id': 'predecessor', 'ticket_id': 'child', 'max_bytes': '1048576'})['data']
        self.assertEqual(historical['ticket']['claim']['token'], claim['token'])
        self.assertTrue(self.call('review.gate', {'workspace_id': 'predecessor', 'ticket_id': 'reviewed'})['data']['allowed'])


if __name__ == '__main__':
    unittest.main()
