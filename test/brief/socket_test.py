"""Explicit briefs preserve current fences, exact expansion and full read contracts."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
EXE = Path(sys.argv.pop(1)).resolve()
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('history_adapter', ROOT / 'skills/workgraph/scripts/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
class BriefTest(unittest.TestCase):
    def test_bounded_briefs_and_expansion(self):
        with tempfile.TemporaryDirectory(prefix='wg-brief-', dir='/tmp') as directory:
            root = Path(directory)
            socket = root / 'socket'
            daemon = None
            with (root / 'daemon.log').open('w+') as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), 'serve', str(root / 'registry'), str(socket)], stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic()+10
                    while not is_listening(socket):
                        if daemon.poll() is not None or time.monotonic()>deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                client = adapter.Workgraph(socket)
                def read(method, **params):
                    return client.call(method, {'workspace_id': 'brief', **params})
                serial = 0
                def write(method, **params):
                    nonlocal serial
                    serial += 1
                    return read(method, actor_id='agent', mutation_id='m'+str(serial), **params)
                try:
                    start()
                    write('workspace.create', name='Brief', root=str(root/'workspace'))
                    write('ticket.create', ticket_id='task', title='Task', description='é'*10000)
                    write('ticket.metadata', ticket_id='task', expected_revision='1', acceptance_criteria='criterion '*800)
                    claim = write('ticket.claim', ticket_id='task')['data']
                    write('handoff.set', ticket_id='task', expected_revision='0', token=claim['token'], summary='summary'*1000, next_steps='next'*1000, evidence='evidence', decisions='handoff-decisions'*1000, objective='objective'*1000, completed='completed'*1000, blockers='blockers'*1000)
                    for i in range(9):
                        write('comment.add', comment_id='note-'+str(i), target={'kind': 'ticket', 'id': 'task'}, kind='decision', body='decision '+str(i)+' é'*1000)
                    write('comment.edit', comment_id='note-0', expected_revision='1', body='newest decision')
                    write('comment.tombstone', comment_id='note-8', expected_revision='1')
                    for i in range(10):
                        write('resource.put_text', resource_id='asset-'+str(i), expected_revision='0', title='Asset '+str(i), text='content '+str(i))
                        write('resource.link', resource_id='asset-'+str(i), expected_revision='1', target={'kind': 'ticket', 'id': 'task'})
                    write('resource.update', resource_id='asset-0', expected_revision='2', description='resource-description'*3000)
                    full = read('ticket.context', ticket_id='task', max_bytes='1048576')
                    focused = read('ticket.read', ticket_id='task')
                    self.assertEqual(full['data']['ticket'], focused['data']['ticket'])
                    self.assertEqual('é'*10000, focused['data']['ticket']['description'])
                    self.assertEqual('criterion '*800, focused['data']['ticket']['acceptance_criteria'])
                    self.assertNotIn('activity_since_handoff', focused['data'])
                    self.assertFalse(focused['meta']['budget']['truncated'])
                    self.assertEqual('0', focused['meta']['budget']['omitted_fields'])
                    self.assertEqual(full['meta']['workspace_revision'], focused['meta']['workspace_revision'])
                    with self.assertRaisesRegex(RuntimeError, 'complete ticket exceeds max_bytes'):
                        read('ticket.read', ticket_id='task', max_bytes='4096')
                    with self.assertRaises(RuntimeError):
                        read('ticket.read', ticket_id='task', at_revision='0')
                    exact_context = client.call(focused['data']['expand_context']['method'], focused['data']['expand_context']['params'])
                    self.assertEqual(full['data'], exact_context['data'])
                    brief = read('ticket.brief', ticket_id='task', max_bytes='4096')
                    data = brief['data']
                    self.assertEqual(data['representation'], 'brief')
                    self.assertIsNotNone(data['observed_unix_ms'])
                    self.assertNotIn('attempts', data)
                    self.assertNotIn('activity_since_handoff', data)
                    self.assertLessEqual(len(adapter.canonical(brief).encode()), 4096)
                    self.assertEqual(data['ticket']['claim'], full['data']['ticket']['claim'])
                    self.assertEqual(data['ticket']['claim']['token'], claim['token'])
                    exact_ticket = client.call(data['expand_ticket']['method'], data['expand_ticket']['params'])
                    self.assertEqual(full['data']['ticket'], exact_ticket['data']['ticket'])
                    text = subprocess.run([str(EXE), 'ticket', 'brief', str(socket), '--workspace-id', 'brief',
                                           '--ticket-id', 'task', '--output', 'text'],
                                          capture_output=True, text=True, timeout=10)
                    self.assertEqual(0, text.returncode, text.stderr)
                    self.assertIn('PREVIEW:', text.stdout)
                    self.assertIn('expand_ticket:', text.stdout)
                    for field in ['ticket_id', 'revision', 'membership_revision', 'reopened_token']:
                        self.assertEqual(data['ticket'][field], full['data']['ticket'][field])
                    self.assertEqual(data['decision_comments']['total'], '8')
                    self.assertEqual(int(data['decision_comments']['omitted']), 8-len(data['decision_comments']['items']))
                    self.assertEqual(data['resources']['total'], '10')
                    self.assertEqual(int(data['resources']['omitted']), 10-len(data['resources']['items']))
                    excerpt = data['description']
                    self.assertEqual(int(excerpt['total_bytes']), len(('é'*10000).encode()))
                    self.assertEqual(int(excerpt['omitted_bytes'])+len(excerpt['text'].encode()), int(excerpt['total_bytes']))
                    for key in ['summary', 'next_steps', 'decisions', 'objective', 'completed', 'blockers', 'evidence']:
                        value = data['handoff'][key]
                        self.assertEqual(int(value['total_bytes']), len(full['data']['handoff'][key].encode()))
                        self.assertEqual(int(value['total_bytes']), len(value['text'].encode()) + int(value['omitted_bytes']))
                    larger = read('ticket.brief', ticket_id='task')['data']
                    self.assertEqual(larger['decision_comments']['items'][0]['comment_id'], 'note-0')
                    self.assertEqual(larger['decision_comments']['items'][0]['revision'], '2')
                    self.assertEqual(len(larger['decision_comments']['items']), 5)
                    expanded = client.call(data['expand']['method'], data['expand']['params'])
                    self.assertEqual(expanded['data']['ticket']['description'], 'é'*10000)
                    self.assertIn('attempts', expanded['data'])
                    resource = read('resource.brief', resource_id='asset-0', max_bytes='4096')['data']
                    self.assertEqual(resource['entity_revision'], '3')
                    self.assertEqual(resource['current_version']['revision'], '1')
                    self.assertEqual(resource['content_expand']['params']['version'], '1')
                    content = client.call(resource['content_expand']['method'], resource['content_expand']['params'])
                    self.assertEqual(base64.b64decode(content['data']['data_base64']), b'content 0')
                    meta = client.call(resource['expand']['method'], resource['expand']['params'])
                    self.assertEqual(meta['data']['metadata']['description'], 'resource-description'*3000)
                    # An immutable content selector keeps the old bytes after later publication.
                    write('resource.put_text', resource_id='asset-0', expected_revision='3', text='new content')
                    self.assertEqual(base64.b64decode(client.call(resource['content_expand']['method'], resource['content_expand']['params'])['data']['data_base64']), b'content 0')
                    self.assertEqual(read('resource.brief', resource_id='asset-0')['data']['current_version']['revision'], '2')
                    write('comment.add', comment_id='unrelated', target={'kind':'ticket','id':'task'}, kind='progress', body='changed capture')
                    with self.assertRaises(RuntimeError):
                        client.call(data['expand']['method'], data['expand']['params'])
                    # The expansion remains usable for arbitrary bytes exceeding the text-read cap.
                    payload = bytes(range(256)) * 300
                    read('upload.begin', actor_id='agent', upload_id='binary-upload', size_bytes=str(len(payload)), digest=hashlib.sha256(payload).hexdigest())
                    read('upload.chunk', actor_id='agent', upload_id='binary-upload', offset='0', data_base64=base64.b64encode(payload).decode())
                    write('resource.finish_upload', resource_id='binary', expected_revision='0', title='Binary', filename='binary.dat', mime_type='application/octet-stream', upload_id='binary-upload')
                    binary = read('resource.brief', resource_id='binary')['data']
                    first = client.call(binary['content_expand']['method'], binary['content_expand']['params'])['data']
                    self.assertEqual(first['next_offset'], '65536')
                    self.assertEqual(base64.b64decode(first['data_base64']), payload[:65536])
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    start()
                    after = read('ticket.brief', ticket_id='task')['data']
                    self.assertEqual([{k:v for k,v in n.items() if k!='expand'} for n in after['decision_comments']['items']], [{k:v for k,v in n.items() if k!='expand'} for n in larger['decision_comments']['items']])
                    self.assertEqual(after['ticket']['claim'], larger['ticket']['claim'])
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)
if __name__ == '__main__':
    unittest.main()
