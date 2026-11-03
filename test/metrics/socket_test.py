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
                    call('run.register', actor_id='agent', mutation_id='run', target_run_id='run', objective='Work')
                    call('project.create', actor_id='agent', mutation_id='project', project_id='project', title='Project')
                    call('ticket.move', actor_id='agent', mutation_id='assign', ticket_id='task', expected_revision='1', project_id='project', milestone_id=None, parent_ticket_id=None)
                    claim = call('ticket.claim', actor_id='agent', run_id='run', mutation_id='claim', ticket_id='task')
                    call('attempt.start', actor_id='agent', run_id='run', mutation_id='attempt', attempt_id='attempt', ticket_id='task', target_run_id='run', token=claim['data']['token'])
                    samples = [{'name': 'spend', 'unit': 'microUSD', 'value': '9'}, {'name': 'calls', 'unit': 'count', 'value': '2'}]
                    usage = dict(actor_id='agent', usage_id='run-sample', scope={'kind': 'run', 'run_id': 'run'}, reported_actor_id='agent', tokens='3', elapsed_ms='5', metrics=samples, provenance='caller', timestamp='2026-11-03T00:00:00Z')
                    reported = call('usage.report', mutation_id='report', **usage)
                    self.assertTrue(call('usage.report', mutation_id='report-again', **{**usage, 'metrics': list(reversed(samples))})['data']['duplicate'])
                    with self.assertRaises(RuntimeError):
                        call('usage.report', mutation_id='changed-report', **{**usage, 'metrics': [dict(samples[0], value='10')]})
                    attempt_usage = {**usage, 'usage_id': 'attempt-sample', 'scope': {'kind': 'attempt', 'attempt_id': 'attempt'}, 'tokens': '7', 'metrics': [{'name': 'spend', 'unit': 'centEUR', 'value': '4'}]}
                    call('usage.report', mutation_id='attempt-report', **attempt_usage)
                    aggregate = call('usage.aggregate', group_by='project')['data']
                    self.assertEqual(aggregate['totals']['tokens'], '10')
                    self.assertEqual(aggregate['totals']['observations'], '2')
                    self.assertEqual(aggregate['totals']['metric_series'], '3')
                    self.assertTrue(aggregate['unassigned_in_totals'])
                    self.assertEqual(aggregate['unassigned_run_usage']['tokens'], '3')
                    self.assertEqual({r['group']['kind'] for r in aggregate['items']}, {'project', 'unassigned'})
                    project = call('usage.aggregate', project_id='project')['data']
                    self.assertEqual(project['totals']['tokens'], '7')
                    self.assertFalse(project['unassigned_in_totals'])
                    self.assertEqual(project['unassigned_scope'], 'run_and_actor_filters')
                    self.assertEqual(project['unassigned_run_usage']['tokens'], '3')
                    self.assertEqual(call('usage.aggregate', attempt_id='attempt')['data']['totals']['tokens'], '7')
                    self.assertEqual(call('usage.aggregate', run_id='run', actor_id='agent')['data']['totals']['tokens'], '10')
                    self.assertEqual(call('usage.aggregate', actor_id='other')['data']['totals']['observations'], '0')
                    self.assertEqual(call('usage.aggregate', run_id='other', attempt_id='attempt')['data']['totals']['observations'], '0')
                    for group_by in ['workspace', 'project', 'milestone', 'ticket', 'run', 'attempt']:
                        whole = call('usage.aggregate', group_by=group_by)['data']
                        rows, cursor = [], None
                        while True:
                            page = call('usage.aggregate', group_by=group_by, limit='1', max_bytes='4096', **({'cursor': cursor} if cursor else {}))
                            self.assertLessEqual(len(adapter.canonical(page).encode()), 4096)
                            rows.extend(page['data']['items'])
                            cursor = page['data']['cursor']
                            if cursor is None:
                                break
                        self.assertEqual(rows, whole['items'])
                    stale = call('usage.aggregate', group_by='ticket', limit='1')['data']['cursor']
                    with self.assertRaises(RuntimeError):
                        call('usage.aggregate', group_by='run', cursor=stale)
                    call('ticket.move', actor_id='agent', mutation_id='unassign', ticket_id='task', expected_revision='3', project_id=None, milestone_id=None, parent_ticket_id=None)
                    with self.assertRaises(RuntimeError):
                        call('usage.aggregate', group_by='ticket', cursor=stale)
                    self.assertEqual(call('usage.aggregate', project_id='project')['data']['totals']['observations'], '0')
                    # Workspace preview is bounded even across many independently named sources.
                    for batch in range(2):
                        call('usage.report', mutation_id='many-'+str(batch), **{**usage, 'usage_id': 'many-'+str(batch), 'tokens': '0', 'metrics': [{'name': 'm%02d' % (batch*10+i), 'unit': 'count', 'value': '1'} for i in range(10)]})
                    preview = call('workspace.metrics')['data']['reported_usage']
                    self.assertEqual(len(preview['metrics']), 16)
                    self.assertEqual(preview['metric_series'], '23')
                    self.assertEqual(preview['omitted_metric_series'], '7')
                    small_preview = metrics()[0]['reported_usage']
                    self.assertEqual(int(small_preview['metric_series']), len(small_preview['metrics']) + int(small_preview['omitted_metric_series']))
                    before_history, _ = metrics()
                    history_args = dict(actor_id='agent', mutation_id='session', session_id='session', title='Session')
                    call('session.create', **history_args)
                    call('session.create', **history_args)
                    with_history, history = metrics()
                    self.assertEqual(with_history['planning_commits'], before_history['planning_commits'])
                    self.assertEqual(with_history['history_commits'], '1')
                    self.assertEqual(len(with_history['history_head']), 64)
                    self.assertGreater(history['history_batch_bytes'], 0)
                    call('upload.begin', actor_id='agent', upload_id='upload', size_bytes='16', digest=hashlib.sha256(b'x' * 16).hexdigest())
                    _, staged = metrics()
                    self.assertEqual(staged['active_uploads'], 1)
                    self.assertEqual(staged['reserved_upload_bytes'], 16)
                    self.assertEqual(staged['planning_commits'], history['planning_commits'])
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    start()
                    restarted, durable = metrics()
                    self.assertEqual(restarted['history_head'], with_history['history_head'])
                    self.assertEqual(durable, history)  # only private upload staging resets
                    self.assertEqual(call('usage.report', mutation_id='report', **usage), reported)
                    self.assertTrue(call('usage.report', mutation_id='retry-after-restart', **usage)['data']['duplicate'])
                    self.assertEqual(call('usage.aggregate')['data']['totals']['observations'], '4')
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
