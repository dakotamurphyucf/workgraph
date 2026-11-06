"""Derived run associations are bounded captured reads, never planning writes."""
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


class RunSessionsTest(unittest.TestCase):
    def test_derived_union_captures_large_pages_and_durable_receipts(self):
        with tempfile.TemporaryDirectory(prefix='wg-links-', dir='/tmp') as directory:
            root = Path(directory)
            address = root / 's'
            daemon = None
            with (root / 'daemon.log').open('w+') as log:
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([str(EXE), 'serve', str(root / 'registry'), str(address)],
                                              stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)

                def call(method, **params):
                    params = {'workspace_id': 'links', **params} if method != 'daemon.shutdown' else {}
                    result = subprocess.run([str(EXE), 'call', str(address), method, json.dumps(params)],
                                            capture_output=True, text=True, timeout=20)
                    self.assertTrue(result.stdout, result.stderr)
                    return json.loads(result.stdout)

                def ok(method, **params):
                    response = call(method, **params)
                    self.assertIn('result', response, response)
                    return response['result']

                def write(method, mutation, **params):
                    return ok(method, actor_id='agent', mutation_id=mutation, **params)

                def next_page(request):
                    return ok(request['method'], **request['params'])

                try:
                    start()
                    write('workspace.create', 'workspace', name='Links', root=str(root / 'workspace'))
                    registered = write('run.register', 'register', target_run_id='run', objective='Work')
                    write('run.register', 'other', target_run_id='other', objective='Other work')
                    write('session.create', 'auto', run_id='run', session_id='auto', title='Automatic')
                    write('session.create', 'explicit', run_id='other', session_id='explicit', title='Explicit')
                    write('session.create', 'unlinked', session_id='unlinked', title='Unlinked')
                    first = ok('run.get', target_run_id='run')
                    self.assertEqual(first['data']['session_ids'], ['auto'])
                    self.assertEqual(first['data']['revision'], '1')
                    self.assertEqual(first['data']['session_associations']['explicit_session_ids'], [])
                    self.assertNotIn('sessions', first['meta']['history_capture'])
                    self.assertEqual(first['data']['session_associations']['history_head'], first['meta']['history_capture']['head'])
                    linked = write('run.link_session', 'link', target_run_id='run', expected_revision='1', session_id='explicit')
                    self.assertEqual(linked['data']['session_ids'], ['explicit'])
                    write('run.link_session', 'link-auto', target_run_id='run', expected_revision='2', session_id='auto')
                    write('session.archive', 'archive', session_id='auto')
                    captured = ok('run.get', target_run_id='run')
                    self.assertEqual(captured['data']['session_ids'], ['auto', 'explicit'])
                    self.assertEqual(captured['data']['revision'], '3')
                    self.assertEqual(captured['data']['session_associations']['omitted'], '0')
                    self.assertEqual(write('run.register', 'register', target_run_id='run', objective='Work'), registered)
                    self.assertEqual(write('run.link_session', 'link', target_run_id='run', expected_revision='1', session_id='explicit'), linked)
                    listing = ok('run.list', limit='1')
                    continuation = dict(offset=listing['data']['next_offset'], expected_revision=listing['meta']['query_revision'],
                                        head=listing['meta']['history_capture']['head'], limit='1')
                    self.assertIn('session_associations', listing['data']['items'][0])
                    self.assertIn('session_associations', ok('run.list', **continuation)['data']['items'][0])
                    self.assertIn('error', call('run.list', offset='1', expected_revision=listing['meta']['query_revision']))
                    for i in range(105):
                        write('session.create', 'many-%d' % i, run_id='run', session_id='s%03d' % i, title='Session')
                    large = ok('run.get', target_run_id='run')['data']
                    self.assertEqual(len(large['session_ids']), 100)
                    self.assertEqual(large['session_associations']['total'], '107')
                    self.assertEqual(large['session_associations']['omitted'], '7')
                    tail = next_page(large['session_associations']['next_request'])
                    self.assertEqual(len(tail['data']['session_ids']), 7)
                    first = ok('run.sessions', target_run_id='run', limit='2', max_bytes='4096')
                    pinned_head = first['meta']['history_capture']['head']
                    write('session.create', 'late', run_id='run', session_id='late', title='Later session')
                    all_ids, page = [], first
                    while True:
                        self.assertLessEqual(len(json.dumps(page, sort_keys=True, separators=(',', ':')).encode()), 4096)
                        self.assertEqual(page['meta']['history_capture']['head'], pinned_head)
                        all_ids.extend(page['data']['session_ids'])
                        if page['data']['next_request'] is None:
                            break
                        page = next_page(page['data']['next_request'])
                    self.assertEqual(len(all_ids), 107)
                    self.assertEqual(all_ids, sorted(set(all_ids)))
                    self.assertNotIn('late', all_ids)
                    self.assertEqual(ok('run.sessions', target_run_id='run')['data']['total'], '108')
                    write('run.observe', 'observe', target_run_id='run', expected_revision='3', observed_unix_ms='0')
                    stale = first['data']['next_request']
                    self.assertIn('error', call(stale['method'], **stale['params']))
                    ok('daemon.shutdown')
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    start()
                    restarted = ok('run.get', target_run_id='run')['data']
                    self.assertEqual(restarted['revision'], '4')
                    self.assertEqual(restarted['session_associations']['total'], '108')
                    self.assertEqual(write('run.register', 'register', target_run_id='run', objective='Work'), registered)
                    ok('daemon.shutdown')
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
