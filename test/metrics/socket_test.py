"""Real metrics distinguish durable commits, retries, queries and private uploads."""
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
spec = importlib.util.spec_from_file_location('history_adapter', ROOT / 'examples/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class MetricsTest(unittest.TestCase):
    def test_independent_counters_and_restart(self):
        with tempfile.TemporaryDirectory(prefix='wg-metrics-', dir='/tmp') as directory:
            root = Path(directory)
            address = root / 'socket'
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
                client = adapter.Workgraph(address)
                def call(method, **params):
                    return client.call(method, {'workspace_id': 'demo', **params})
                def metrics():
                    response = call('workspace.metrics', max_bytes='4096')
                    self.assertLessEqual(len(adapter.canonical(response).encode()), 4096)
                    value = response['data']
                    self.assertEqual(response['meta']['workspace_revision'], value['planning_commits'])
                    meters = value['planning_admission'] + value['storage_admission']
                    self.assertEqual(len(meters), 14)
                    for meter in meters:
                        self.assertEqual(int(meter['remaining']), int(meter['limit']) - int(meter['used']))
                    return value, {m['name']: int(m['used']) for m in meters}
                try:
                    start()
                    call('workspace.create', actor_id='agent', mutation_id='create', name='Metrics', root=str(root / 'workspace'))
                    empty, first = metrics()
                    self.assertEqual(empty['planning_commits'], '0')
                    self.assertEqual(empty['history_commits'], '0')
                    self.assertIsNone(empty['history_head'])
                    ticket = dict(actor_id='agent', mutation_id='ticket', ticket_id='task', title='Task')
                    receipt = call('ticket.create', **ticket)
                    self.assertEqual(call('ticket.create', **ticket), receipt)
                    after, planning = metrics()
                    self.assertEqual(after['planning_commits'], '1')
                    self.assertEqual(planning['tickets'], 1)
                    self.assertGreater(planning['planning_transaction_bytes'], first['planning_transaction_bytes'])
                    self.assertEqual(metrics()[1], planning)  # reads create no committed event
                    with self.assertRaises(RuntimeError):
                        call('workspace.metrics', at_revision='0')
                    self.assertEqual(metrics()[1], planning)
                    history_args = dict(actor_id='agent', mutation_id='session', session_id='session', title='Session')
                    call('session.create', **history_args)
                    call('session.create', **history_args)
                    with_history, history = metrics()
                    self.assertEqual(with_history['planning_commits'], '1')
                    self.assertEqual(with_history['history_commits'], '1')
                    self.assertEqual(len(with_history['history_head']), 64)
                    self.assertGreater(history['history_batch_bytes'], 0)
                    call('upload.begin', actor_id='agent', upload_id='upload', size_bytes='16', digest=hashlib.sha256(b'x' * 16).hexdigest())
                    _, staged = metrics()
                    self.assertEqual(staged['active_uploads'], 1)
                    self.assertEqual(staged['reserved_upload_bytes'], 16)
                    self.assertEqual(staged['planning_commits'], 1)
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    start()
                    restarted, durable = metrics()
                    self.assertEqual(restarted['history_head'], with_history['history_head'])
                    self.assertEqual(durable, history)  # only private upload staging resets
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
