"""Project completion is captured, guarded, durable, and free of side effects."""
import importlib.util
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location(
    'adapter', Path(__file__).resolve().parents[2] / 'skills/workgraph/scripts/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ProjectCompletionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-project-close-', dir='/tmp')
        self.root = Path(self.temporary.name)
        self.registry = self.root / 'registry'
        self.address = self.root / 'socket'
        self.log = (self.root / 'daemon.log').open('w+')
        self.daemon = None
        self.serial = 0
        self.start()
        self.write('workspace.create', name='Completion', root=str(self.root / 'workspace'))
        self.write('project.create', project_id='p', title='Project')

    def start(self):
        self.daemon = subprocess.Popen(
            [str(EXE), 'serve', str(self.registry), str(self.address)],
            stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic() > deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)
        self.client = adapter.Workgraph(self.address)

    def stop(self):
        self.client.call('daemon.shutdown', {})
        self.assertEqual(self.daemon.wait(timeout=10), 0)

    def tearDown(self):
        if self.daemon is not None and self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=10)
        self.log.close()
        self.temporary.cleanup()

    def read(self, method, **params):
        return self.client.call(method, {'workspace_id': 'completion', **params})

    def write(self, method, by='lead', identity=None, **params):
        self.serial += 1
        return self.read(method, actor_id=by,
                         mutation_id=identity or 'm' + str(self.serial), **params)

    def reject(self, method, kind, **params):
        with self.assertRaises(RuntimeError) as raised:
            self.write(method, **params)
        self.assertEqual(json.loads(str(raised.exception))['data']['kind'], kind)

    def project(self):
        return self.read('project.get', project_id='p')['data']

    def finishing(self, **patch):
        return dict(project_id='p', expected_revision=self.project()['revision'],
                    evidence='Project checked',
                    handoff=dict(summary='Complete', next_steps='Review', **patch))

    def test_lost_finish_reply_retry_restart_and_restore_preserve_exact_handoff(self):
        self.write('run.register', target_run_id='run', objective='Finish project')
        self.write('resource.put_text', resource_id='proof', expected_revision='0',
                   title='Proof', text='Checks passed')
        self.write('ticket.create', ticket_id='observed', project_id='p', title='Observed task')
        self.write('ticket.update', ticket_id='observed', expected_revision='1', status='canceled')
        self.write('request.ask', request_id='question', title='Follow-up',
                             body='Record a follow-up without blocking closure',
                             recipients=[{'kind': 'actor', 'id': 'reviewer'}],
                             resolver_id='reviewer',
                             ticket_id='observed')
        before_request = self.read('request.get', request_id='question')['data']
        readiness = self.read('project.readiness', project_id='p')
        self.assertTrue(readiness['data']['can_complete'])
        self.assertEqual(readiness['data']['counts']['open_requests'], '1')
        observed = readiness['meta']['workspace_revision']
        params = self.finishing(objective='Deliver', completed='All work',
                                decisions='Keep design', blockers='',
                                resource_ids=['proof'], covers_through=observed)
        envelope = {'jsonrpc': '2.0', 'workgraph_api': '0.7', 'id': 'lost',
                    'method': 'project.finish',
                    'params': {'workspace_id': 'completion', 'actor_id': 'lead',
                               'run_id': 'run', 'mutation_id': 'lost-finish', **params}}
        payload = adapter.canonical(envelope).encode()
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(10)
            connection.connect(str(self.address))
            connection.sendall(struct.pack('>I', len(payload)) + payload)
            header = bytearray()
            while len(header) < 4:
                part = connection.recv(4 - len(header))
                self.assertTrue(part)
                header.extend(part)
            # The acknowledged frame header follows durable publication. Drop body.
        completed = self.write('project.finish', identity='lost-finish', run_id='run', **params)
        handoff = completed['data']['handoff']
        self.assertEqual(completed['data']['status'], 'done')
        self.assertEqual(handoff['actor_id'], 'lead')
        self.assertEqual(handoff['run_id'], 'run')
        self.assertTrue(handoff['timestamp'])
        self.assertEqual(handoff['project_revision'], completed['data']['revision'])
        self.assertEqual(handoff['workspace_revision'], observed)
        self.assertEqual(handoff['content']['covers_through'], observed)
        self.assertEqual(handoff['content']['resource_ids'], ['proof'])
        self.assertEqual(handoff['evidence'], 'Project checked')
        self.assertEqual(self.read('request.get', request_id='question')['data'], before_request)
        self.assertEqual(self.read('run.get', target_run_id='run')['data']['status'], 'running')
        self.reject('project.finish', 'Conflict', identity='stale-finish', run_id='run', **params)
        self.stop()
        self.start()
        self.assertEqual(self.write('project.finish', identity='lost-finish', run_id='run', **params), completed)
        self.assertEqual(self.project()['handoff'], handoff)
        destination = self.root / 'export'
        exported = self.write('workspace.export', destination=str(destination))
        deadline = time.monotonic() + 10
        while True:
            job = self.client.call('export.get', {'job_id': exported['data']['job_id']})['data']
            if job['status'] == 'completed':
                break
            self.assertNotIn(job['status'], ['failed', 'canceled'])
            self.assertLess(time.monotonic(), deadline, job)
            time.sleep(.01)
        self.stop()
        self.registry = self.root / 'restored-registry'
        self.start()
        self.client.call('workspace.restore', {'actor_id': 'lead', 'mutation_id': 'restore',
                                             'directory': str(destination),
                                             'root': str(self.root / 'restored-workspace')})
        self.write('workspace.open')
        self.assertEqual(self.project()['handoff'], handoff)
        self.assertEqual(self.write('project.finish', identity='lost-finish', run_id='run', **params), completed)
        self.assertEqual(self.read('request.get', request_id='question')['data'], before_request)

    def test_public_guards_batch_invalidation_and_reopen_patch_semantics(self):
        self.write('ticket.create', ticket_id='t', project_id='p', title='Task')
        self.write('ticket.archive', ticket_id='t', expected_revision='1', archived=True)
        report = self.read('project.readiness', project_id='p')
        self.assertEqual(report['data']['counts']['archived_tickets'], '1')
        self.assertEqual(report['data']['counts']['unfinished_tickets'], '1')
        before = self.project()
        self.reject('project.finish', 'Blocked', **self.finishing())
        self.reject('project.update', 'Blocked', project_id='p',
                    expected_revision=before['revision'], status='done')
        self.assertEqual(self.project(), before)
        self.write('ticket.update', ticket_id='t', expected_revision='2', status='canceled')
        report = self.read('project.readiness', project_id='p')
        self.assertEqual(report['data']['counts']['canceled_tickets'], '1')
        self.assertTrue(report['data']['can_complete'])
        self.reject('transaction.apply', 'Blocked', operations=[
            {'method': 'project.finish', 'params': self.finishing(objective='Retain')},
            {'method': 'ticket.create', 'params': {'ticket_id': 'late', 'project_id': 'p', 'title': 'Late'}}])
        self.assertEqual(self.project(), before)
        completed = self.write('project.finish', **self.finishing(objective='Retain'))['data']
        self.reject('ticket.create', 'Blocked', ticket_id='late', project_id='p', title='Late')
        self.write('project.update', project_id='p', expected_revision=completed['revision'], status='todo')
        self.assertEqual(self.project()['handoff'], completed['handoff'])
        closed_again = self.write('project.finish', **self.finishing())['data']
        self.assertEqual(closed_again['handoff']['content']['objective'], 'Retain')
        self.write('transaction.apply', operations=[
            {'method': 'project.update', 'params': {'project_id': 'p', 'expected_revision': closed_again['revision'], 'status': 'todo'}},
            {'method': 'ticket.create', 'params': {'ticket_id': 'late', 'project_id': 'p', 'title': 'Late'}}])
        self.assertEqual(self.project()['status'], 'todo')
        self.assertFalse(self.read('project.readiness', project_id='p')['data']['can_complete'])
        with self.assertRaises(RuntimeError) as raised:
            self.read('project.readiness', project_id='p',
                      at_revision=report['meta']['workspace_revision'])
        self.assertEqual(json.loads(str(raised.exception))['data']['kind'], 'Conflict')


if __name__ == '__main__':
    unittest.main()
