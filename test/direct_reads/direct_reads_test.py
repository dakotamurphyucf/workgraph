"""Independent JSON/socket cases for convenient resource and related reads."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

EXE = Path(sys.argv.pop(1)).resolve()


class DirectReadTest(unittest.TestCase):
    def test_exact_resource_versions_and_bounded_current_discussions(self):
        with tempfile.TemporaryDirectory(prefix='wg-direct-', dir='/tmp') as directory:
            root = Path(directory)
            address = root / 's'
            daemon = None
            serial = 0
            log = (root / 'daemon.log').open('w+')
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
                params = {'workspace_id': 'demo', **params}
                if method in {'daemon.health', 'daemon.shutdown'}:
                    params = {}
                result = subprocess.run([str(EXE), 'call', str(address), method, json.dumps(params)], capture_output=True, text=True, timeout=10)
                if result.stdout:
                    return json.loads(result.stdout)
                self.fail(result.stderr)
            def ok(method, **params):
                response = call(method, **params)
                self.assertIn('result', response, response)
                return response['result']
            def mutate(method, **params):
                nonlocal serial
                serial += 1
                return ok(method, actor_id='agent', mutation_id='write-' + str(serial), **params)
            def rejected(method, kind='Invalid_argument', **params):
                response = call(method, **params)
                self.assertEqual(kind, response['error']['data']['kind'])
            try:
                start()
                mutate('workspace.create', name='Direct reads', root=str(root / 'workspace'))
                mutate('resource.put_text', resource_id='note', expected_revision='0', title='Note', text='first version')
                mutate('resource.put_text', resource_id='note', expected_revision='1', title='Note', text='second version')
                latest = ok('resource.read', resource_id='note')['data']
                self.assertEqual({'resource_id': 'note', 'version': '2', 'digest': hashlib.sha256(b'second version').hexdigest(), 'size_bytes': '14', 'text': 'second version'}, latest)
                original = ok('resource.read', resource_id='note', version='1')['data']
                self.assertEqual('first version', original['text'])
                self.assertEqual('1', original['version'])
                chunk = ok('resource.read_chunk', resource_id='note', version='1', offset='0', length='5')['data']
                self.assertEqual(b'first', base64.b64decode(chunk['data_base64']))
                self.assertEqual(original['digest'], chunk['digest'])
                self.assertEqual('5', chunk['next_offset'])
                rejected('resource.read', digest=latest['digest'])
                rejected('resource.read', resource_id='note', version='0')
                rejected('resource.read', resource_id='note', version=1)
                rejected('resource.read', resource_id='missing', kind='Not_found')
                rejected('resource.read_chunk', resource_id='note', length='0')
                rejected('resource.read_chunk', resource_id='note', length='262145')
                mutate('board.put', board_id='board', expected_revision='0', scope={'kind': 'workspace'}, title='Board')
                mutate('thread.put', thread_id='thread', expected_revision='0', board_id='board', title='Thread', participants=['agent'], mentions=[], links=[], state='open', pinned=False)
                mutate('comment.add', comment_id='source', target={'kind': 'workspace'}, body='Original question')
                mutate('thread.attach', thread_id='thread', expected_revision='1', comment_id='source')
                mutate('request.create', request_id='request', thread_id='thread', kind='review', comment_id='source', recipients=[{'kind': 'actor', 'id': 'reviewer'}], teams=[], resolver_id='reviewer')
                mutate('thread.reply', thread_id='thread', expected_revision='2', comment_id='long', body='x' * 50000)
                mutate('thread.reply', thread_id='thread', expected_revision='3', comment_id='tombstone', body='Delete this')
                mutate('comment.tombstone', comment_id='tombstone', expected_revision='1')
                plain = ok('request.get', request_id='request')['data']
                self.assertNotIn('related', plain)
                expanded = ok('request.get', request_id='request', include_messages=True, message_limit='1')
                related = expanded['data']['related']
                self.assertEqual('Original question', related['source_message']['body'])
                self.assertEqual('current', related['source_message_version'])
                self.assertEqual({'comment_id': 'source', 'revision': None}, related['source_message_reference'])
                self.assertEqual('1', related['messages']['next_offset'])
                captures = {'revision': expanded['meta']['query_revision'], 'discussion_serial': related['discussion_serial']}
                second = ok('thread.get', thread_id='thread', include_messages=True, message_offset='1', message_limit='2', **captures)['data']['related']['messages']
                self.assertEqual(['long', 'tombstone'], [item['comment_id'] for item in second['items']])
                self.assertTrue(second['items'][1]['tombstone'])
                self.assertEqual('', second['items'][1]['body'])
                self.assertEqual('2', second['items'][1]['revision'])
                self.assertIsNone(second['next_offset'])
                rejected('thread.get', thread_id='thread', include_messages=True, message_offset='1')
                mutate('comment.edit', comment_id='source', expected_revision='1', body='Corrected question')
                rejected('thread.get', thread_id='thread', include_messages=True, message_offset='1', kind='Conflict', **captures)
                current = ok('request.get', request_id='request', include_messages=True)
                self.assertEqual('Corrected question', current['data']['related']['source_message']['body'])
                self.assertEqual('2', current['data']['related']['source_message']['revision'])
                captures = {'revision': current['meta']['query_revision'], 'discussion_serial': current['data']['related']['discussion_serial']}
                mutate('board.put', board_id='board', expected_revision='1', scope={'kind': 'workspace'}, title='Changed board')
                rejected('thread.get', thread_id='thread', include_messages=True, message_offset='1', kind='Conflict', **captures)
                bounded = ok('thread.get', thread_id='thread', include_messages=True, max_bytes='4096')
                self.assertTrue(bounded['meta']['budget']['truncated'])
                self.assertTrue(any(item['path'].endswith('/body') for item in bounded['meta']['budget']['details']))
                ok('daemon.shutdown')
                daemon.wait(timeout=10)
                start()
                self.assertEqual(latest, ok('resource.read', resource_id='note')['data'])
                restored = ok('request.get', request_id='request', include_messages=True)['data']['related']
                self.assertEqual('Corrected question', restored['source_message']['body'])
                self.assertEqual('2', restored['source_message']['revision'])
                self.assertTrue(restored['messages']['items'][-1]['tombstone'])
            finally:
                if daemon is not None and daemon.poll() is None:
                    daemon.terminate()
                    daemon.wait(timeout=10)
                log.close()


if __name__ == '__main__':
    unittest.main()
