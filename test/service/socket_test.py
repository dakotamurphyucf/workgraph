"""Real Unix endpoint qualification for committed feed waits and cancellation."""
import concurrent.futures
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
ADAPTER = Path(__file__).resolve().parents[2] / 'examples/history-adapter.py'
spec = importlib.util.spec_from_file_location('history_adapter', ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class SocketTest(unittest.TestCase):
    def test_feed_sources_disconnect_timeout_and_shutdown(self):
        with tempfile.TemporaryDirectory(prefix='wg-feed-', dir='/tmp') as temporary:
            root = Path(temporary)
            address = root / 's'
            with (root / 'daemon.log').open('w+') as log:
                daemon = subprocess.Popen([str(EXE), 'serve', str(root / 'registry'), str(address)],
                                          stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None:
                            log.seek(0)
                            self.fail(log.read())
                        if time.monotonic() >= deadline:
                            self.fail('daemon startup timed out')
                        time.sleep(.01)
                    def call(method, **params):
                        return adapter.body(adapter.Workgraph(address).call(method, params))
                    scope = {'workspace_id': 'feeds'}
                    def mutate(method, mutation, **params):
                        return call(method, **scope, actor_id='agent', mutation_id=mutation, **params)
                    mutate('workspace.create', 'create', name='Feeds', root=str(root / 'workspace'))
                    planning = call('changes.read', **scope)
                    history = call('changes.read', **scope, source='history')
                    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                        planning_wait = pool.submit(call, 'changes.wait', **scope, cursor=planning['cursor'], timeout_ms='2000')
                        history_wait = pool.submit(call, 'changes.wait', **scope, source='history', cursor=history['cursor'], timeout_ms='2000')
                        mutate('ticket.create', 'ticket', ticket_id='task', title='Task')
                        changed = planning_wait.result(timeout=5)
                        self.assertTrue(changed['items'])
                        mutate('session.create', 'session', session_id='conversation', title='Conversation')
                        history_changed = history_wait.result(timeout=5)
                        self.assertTrue(history_changed['items'])
                    def park(cursor):
                        flow = socket.socket(socket.AF_UNIX)
                        flow.settimeout(5)
                        flow.connect(str(address))
                        payload = json.dumps({'jsonrpc': '2.0', 'workgraph_api': '0.4', 'id': 'wait', 'method': 'changes.wait',
                                              'params': {**scope, 'cursor': cursor, 'timeout_ms': '25000'}}).encode()
                        flow.sendall(struct.pack('>I', len(payload)) + payload)
                        return flow
                    # More than the 64 connection cap catches leaked registrations.
                    for _ in range(70):
                        park(changed['cursor']).close()
                        call('daemon.health')
                    timed = call('changes.wait', **scope, cursor=changed['cursor'], timeout_ms='100')
                    self.assertEqual(timed['items'], [])
                    with park(timed['cursor']) as waiting:
                        call('daemon.shutdown')
                        self.assertEqual(waiting.recv(1), b'')
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            daemon.wait()


if __name__ == '__main__':
    unittest.main()
