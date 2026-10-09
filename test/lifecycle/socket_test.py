"""Independent real socket/restart exact-retry tests for lifecycle composites."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()

class LifecycleSocketTest(unittest.TestCase):
    def test_composite_retry_and_failed_preparation(self):
        with tempfile.TemporaryDirectory(prefix='wg-life-', dir='/tmp') as directory:
            root = Path(directory)
            address = root / 's'
            daemon = None
            with (root / 'daemon.log').open('w+') as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), 'serve', str(root / 'registry'), str(address)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not address.exists():
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                def call(method, **params):
                    params = {'workspace_id': 'lifecycle', **params} if method != 'daemon.shutdown' else {}
                    response = subprocess.run([str(EXE), 'call', str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                    self.assertTrue(response.stdout, response.stderr)
                    return json.loads(response.stdout)
                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn('result', response, response)
                    return response['result']
                def write(method, mutation, **params):
                    return ok(method, mutation_id=mutation, actor_id='agent', **params)
                def stop():
                    ok('daemon.shutdown')
                    daemon.wait(timeout=10)
                try:
                    start()
                    write('workspace.create', 'create', name='Lifecycle', root=str(root / 'workspace'))
                    write('ticket.create', 'ticket', ticket_id='task', title='Task')
                    before = ok('workspace.get')['meta']['workspace_revision']
                    bad = call('ticket.start', mutation_id='bad-start', actor_id='agent', ticket_id='task', initial_note='must not appear', attempt_id='no-run')
                    self.assertEqual('Invalid_argument', bad['error']['data']['kind'])
                    self.assertEqual(before, ok('workspace.get')['meta']['workspace_revision'])
                    initial = write('ticket.start', 'start', ticket_id='task', initial_note='initial note')
                    self.assertEqual({'ticket_id': 'task', 'token': '1'}, initial['data'])
                    self.assertEqual(initial, write('ticket.start', 'start', ticket_id='task', initial_note='initial note'))
                    changed = call('ticket.start', mutation_id='start', actor_id='agent', ticket_id='task', initial_note='different note')
                    self.assertEqual('Idempotency_conflict', changed['error']['data']['kind'])
                    before_finish = ok('workspace.get')['meta']['workspace_revision']
                    failed = call('ticket.finish', mutation_id='bad-finish', actor_id='agent', ticket_id='task', token='1', evidence='', handoff={'summary':'not published','next_steps':'none'})
                    self.assertEqual('Invalid_argument', failed['error']['data']['kind'])
                    self.assertEqual(before_finish, ok('workspace.get')['meta']['workspace_revision'])
                    final = write('ticket.finish', 'finish', ticket_id='task', token='1', evidence='verified', handoff={'summary':'implemented','next_steps':'review'})
                    self.assertEqual({'completed': True}, final['data'])
                    stop()
                    start()
                    self.assertEqual(final, write('ticket.finish', 'finish', ticket_id='task', token='1', evidence='verified', handoff={'summary':'implemented','next_steps':'review'}))
                    context = ok('ticket.context', ticket_id='task')['data']
                    self.assertEqual('done', context['ticket']['status'])
                    self.assertEqual('1', context['handoff']['revision'])
                    self.assertEqual('0', context['handoff']['covers_through'])
                    self.assertEqual(2, len(context['updates']['items']))
                finally:
                    if daemon is not None and daemon.poll() is None:
                        stop()

if __name__ == '__main__':
    unittest.main()
