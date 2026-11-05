"""Real atomic text publication, link rollback and saved immutable input replay."""
import hashlib
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


class Publication(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-text-link-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.address = self.root / 's'
        self.log = (self.root / 'daemon.log').open('w+')
        self.addCleanup(self.log.close)
        self.serial = 0
        self.daemon = None
        self.addCleanup(self.stop)
        self.start()
        self.write('workspace.create', name='Text links', root=str(self.root / 'workspace'))
        self.write('project.create', project_id='p', title='Project')
        for ticket in ['task', 'other']:
            self.write('ticket.create', ticket_id=ticket, project_id='p', title=ticket)
        self.write('run.register', target_run_id='run', objective='Text publication')
        self.context = self.root / 'context.json'
        self.context.write_text(json.dumps(dict(socket=str(self.address), workspace_id='demo',
                                               actor_id='worker', run_id='run')))

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
            self.call('daemon.shutdown')
            self.daemon.wait(timeout=5)

    def invoke(self, args, expected=0, input=None):
        result = subprocess.run([BINARY, *args], input=input, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, expected, (result.stdout, result.stderr))
        return json.loads(result.stdout or result.stderr)

    def call(self, method, **params):
        if method != 'daemon.shutdown':
            params = dict(workspace_id='demo', **params)
        result = subprocess.run([BINARY, 'call', str(self.address), method, json.dumps(params)],
                                capture_output=True, text=True, timeout=15)
        return json.loads(result.stdout or result.stderr)

    def read(self, method, **params):
        response = self.call(method, **params)
        self.assertIn('result', response, response)
        return response['result']['data']

    def write(self, method, **params):
        self.serial += 1
        return self.read(method, actor_id='worker', mutation_id='write-' + str(self.serial), **params)

    def publish(self, expected=0, stdin=None, **params):
        args = ['--context', str(self.context), 'resource', 'publish_text']
        for field, value in params.items():
            args.extend(['--json-field', field, json.dumps(value)])
        if stdin is not None:
            args.extend(['--field-file', 'text', '-'])
        return self.invoke(args, expected=expected, input=stdin)

    def test_saved_materialized_text_and_generated_identity_replay_after_restart(self):
        text = 'Findings 💖\r\n\n'
        source = self.root / 'findings.txt'
        source.write_bytes(text.encode())
        saved = self.root / 'request.json'
        first = self.invoke(['--context', str(self.context), 'resource', 'publish_text',
                             '--ticket-id', 'task', '--expected-revision', '0', '--title', 'Findings',
                             '--field-file', 'text', str(source), '--save-request', str(saved)])
        transaction = json.loads(saved.read_text())
        self.assertEqual(transaction['method'], 'transaction.apply')
        params = transaction['params']
        self.assertEqual({k: params[k] for k in ['workspace_id', 'actor_id', 'run_id']},
                         dict(workspace_id='demo', actor_id='worker', run_id='run'))
        self.assertTrue(params['mutation_id'])
        operations = params['operations']
        self.assertEqual([op['method'] for op in operations], ['resource.put_text', 'resource.link'])
        self.assertEqual(operations[0]['params']['text'], text)
        self.assertNotIn('resource_id', operations[0]['params'])
        self.assertEqual(operations[1]['params']['resource_id'], '$published')
        results = first['result']['data']['results']
        self.assertEqual([item['method'] for item in results], ['resource.put_text', 'resource.link'])
        published = results[0]['data']
        resource = published['resource_id']
        self.assertEqual(published['revision'], '1')
        self.assertEqual(results[1]['data'], {'revision': '2'})
        self.assertEqual(published['version']['digest'], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(self.read('resource.get', resource_id=resource)['metadata']['targets'],
                         [{'kind': 'ticket', 'id': 'task'}])
        source.unlink()
        self.context.write_text('{}')  # Exact retry needs no original context/defaults.
        self.assertEqual(self.invoke(['retry', str(self.address), str(saved)]), first)
        self.stop()
        self.start()
        self.assertEqual(self.invoke(['retry', str(self.address), str(saved)]), first)
        self.assertEqual(self.read('resource.read', resource_id=resource, version='1')['text'], text)
        self.assertEqual(self.read('resource.get', resource_id=resource)['current_version']['revision'], '1')
        altered = json.loads(saved.read_text())['params']
        del altered['workspace_id']
        altered['operations'][0]['params']['text'] = 'changed identity payload'
        self.assertEqual(self.call('transaction.apply', **altered)['error']['data']['kind'], 'Idempotency_conflict')

    def test_missing_target_and_stale_guards_leave_no_publication(self):
        failed = self.publish(expected=1, resource_id='missing-link', expected_revision='0', title='Note',
                              text='new bytes', ticket_id='missing', mutation_id='missing-target')
        self.assertEqual(failed['error']['data']['kind'], 'Not_found')
        self.assertEqual(self.call('resource.get', resource_id='missing-link')['error']['data']['kind'], 'Not_found')
        self.write('resource.put_text', resource_id='existing', expected_revision='0', title='Retained', text='original')
        original = self.read('resource.get', resource_id='existing')
        failed = self.publish(expected=1, resource_id='existing', expected_revision='1', text='replacement',
                              ticket_id='missing', mutation_id='missing-update')
        self.assertEqual(failed['error']['data']['kind'], 'Not_found')
        self.assertEqual(self.read('resource.get', resource_id='existing'), original)
        failed = self.publish(expected=1, resource_id='existing', expected_revision='0', title='Wrong', text='replacement',
                              ticket_id='task', mutation_id='stale')
        self.assertEqual(failed['error']['data']['kind'], 'Conflict')
        self.assertEqual(self.read('resource.read', resource_id='existing')['text'], 'original')
        self.stop()
        self.start()
        self.assertEqual(self.read('resource.get', resource_id='existing'), original)
        self.assertEqual(self.call('resource.get', resource_id='missing-link')['error']['data']['kind'], 'Not_found')

    def test_existing_link_rolls_back_update_and_success_preserves_metadata(self):
        self.publish(resource_id='note', expected_revision='0', title='Original', text='first',
                     ticket_id='task', mutation_id='first')
        original = self.read('resource.get', resource_id='note')
        failed = self.publish(expected=1, resource_id='note', expected_revision='2', text='discarded',
                              ticket_id='task', mutation_id='duplicate-link')
        self.assertEqual(failed['error']['data']['kind'], 'Conflict')
        self.assertEqual(self.read('resource.get', resource_id='note'), original)
        response = self.publish(resource_id='note', expected_revision='2', ticket_id='other',
                                mutation_id='second', stdin='second 💖\n')
        self.assertEqual(response['result']['data']['results'][1]['data']['revision'], '4')
        current = self.read('resource.get', resource_id='note')
        self.assertEqual(current['metadata']['title'], 'Original')
        self.assertEqual(current['current_version']['revision'], '2')
        self.assertEqual(self.read('resource.read', resource_id='note')['text'], 'second 💖\n')
        self.assertEqual(self.read('resource.read', resource_id='note', version='1')['text'], 'first')

    def test_invalid_local_input_rejects_before_journaling_and_helper_is_discoverable(self):
        saved = self.root / 'bad.json'
        response = self.invoke(['--context', str(self.context), 'resource.publish_text', '--ticket-id', 'task',
                                '--expected-revision', '0', '--title', 'Too big', '--text', 'é' * 32769,
                                '--save-request', str(saved)], expected=1)
        self.assertEqual(response['kind'], 'Invalid_argument')
        self.assertFalse(saved.exists())
        boundary = self.publish(resource_id='boundary', expected_revision='0', ticket_id='task',
                                title='UTF8 boundary', mutation_id='boundary', stdin='é' * 32768)
        self.assertEqual(boundary['result']['data']['results'][0]['data']['version']['size_bytes'], '65536')
        result = subprocess.run([BINARY, 'help', 'resource.publish_text'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('results[1].data', result.stdout)
        result = subprocess.run([BINARY, 'methods'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('resource.publish_text', result.stdout)


if __name__ == '__main__':
    unittest.main()
