"""Atomic mixed-family operations, literal fact data, typed receipts and exact retry."""
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
spec = importlib.util.spec_from_file_location('adapter', Path(__file__).resolve().parents[2] / 'skills/workgraph/scripts/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class TransactionTest(unittest.TestCase):
    def test_aliases_complete_receipts_rejected_batches_and_restart(self):
        schema = json.loads(subprocess.check_output([str(EXE), 'schema', 'transaction.apply']))
        self.assertIn('fact.put', json.dumps(schema))
        self.assertIn('prerequisite_id', json.dumps(schema))
        operations_schema = next(part['properties']['operations']
                                 for part in schema['methods'][0]['params']['allOf']
                                 if 'operations' in part['properties'])
        self.assertEqual(128, operations_schema['allOf'][0]['maxItems'])
        with tempfile.TemporaryDirectory(prefix='wg-txn-', dir='/tmp') as temporary:
            root = Path(temporary)
            socket = root / 'socket'
            client = adapter.Workgraph(socket)
            process = None
            with (root / 'daemon.log').open('w+') as log:
                def start():
                    nonlocal process
                    process = subprocess.Popen([str(EXE), 'serve', str(root / 'registry'), str(socket)],
                                               stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 10
                    while not is_listening(socket):
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                def batch(operations, mutation):
                    return client.call('transaction.apply', {'workspace_id': 'demo', 'actor_id': 'agent',
                                                             'mutation_id': mutation, 'operations': operations})
                try:
                    start()
                    client.call('workspace.create', {'workspace_id': 'demo', 'actor_id': 'agent',
                        'mutation_id': 'workspace', 'name': 'Transaction', 'root': str(root / 'workspace')})
                    literal = {'ticket_id': '$task', 'scope': {'kind': 'ticket', 'id': '$absent'}}
                    operations = [
                        {'method': 'ticket.create', 'as': 'task', 'params': {'ticket_id': 'task', 'title': 'Task'}},
                        {'method': 'fact.put', 'params': {'scope': {'kind': 'ticket', 'id': '$task'},
                            'key': 'decision', 'expected_revision': '0', 'value': literal}},
                        {'method': 'comment.add', 'params': {'comment_id': 'comment',
                            'target': {'kind': 'ticket', 'id': '$task'}, 'body': 'Atomic evidence', 'kind': 'decision'}}]
                    receipt = batch(operations, 'original')
                    self.assertIs(receipt['meta']['durable'], True)
                    results = receipt['data']['results']
                    self.assertEqual([item['method'] for item in results], [op['method'] for op in operations])
                    self.assertTrue(all(set(item) == {'method', 'data'} for item in results))
                    self.assertEqual(results[1]['data']['value'], literal)
                    self.assertEqual(results[1]['data']['scope'], {'kind': 'ticket', 'id': 'task'})
                    # The full public bound supports setup in one commit and one receipt.
                    large_ops = [{'method': 'ticket.create', 'as': 'setup-' + str(i),
                                  'params': {'title': 'Setup ' + str(i)}} for i in range(128)]
                    before = receipt['meta']['workspace_revision']
                    preview = client.call('transaction.preflight', {'workspace_id': 'demo',
                        'actor_id': 'agent', 'operations': large_ops})
                    self.assertEqual('128', preview['data']['operation_count'])
                    self.assertEqual(128, len(preview['data']['generated_ids']))
                    self.assertEqual(before, client.call('workspace.get', {'workspace_id': 'demo'})['meta']['workspace_revision'])
                    large_receipt = batch(large_ops, 'large')
                    self.assertIs(large_receipt['meta']['durable'], True)
                    self.assertEqual(128, len(large_receipt['data']['results']))
                    self.assertEqual(int(before) + 1, int(large_receipt['meta']['workspace_revision']))
                    self.assertEqual(large_receipt, batch(large_ops, 'large'))
                    with self.assertRaises(RuntimeError):
                        batch(large_ops[:-1], 'large')
                    revision = large_receipt['meta']['workspace_revision']
                    # Failure at operation128 rolls back all earlier creates.
                    rollback_ops = [{'method': 'ticket.create', 'params': {
                        'ticket_id': 'rollback-' + str(i), 'title': 'Rollback'}} for i in range(127)]
                    rollback_ops.append({'method': 'dependency.add', 'params': {
                        'ticket_id': 'rollback-0', 'prerequisite_id': 'absent'}})
                    invalid = [[], large_ops + [{'method': 'ticket.create', 'params': {'title': 'Too many'}}],
                               rollback_ops, [{'method': 'workspace.get', 'params': {}}],
                               [{'method': 'transaction.apply', 'params': {'operations': operations}}],
                               [operations[0], operations[0]],
                               [{'method': 'fact.put', 'params': {**operations[1]['params'], 'unexpected': True}}],
                               [{'method': 'ticket.create', 'params': {'ticket_id': 'rollback', 'title': 'Rollback'}},
                                {'method': 'dependency.add', 'params': {'ticket_id': 'rollback', 'prerequisite_id': 'absent'}}]]
                    for index, operations_bad in enumerate(invalid):
                        with self.assertRaises(RuntimeError):
                            batch(operations_bad, 'invalid-' + str(index))
                        current = client.call('workspace.get', {'workspace_id': 'demo'})
                        self.assertEqual(current['meta']['workspace_revision'], revision)
                    with self.assertRaises(RuntimeError):
                        client.call('ticket.read', {'workspace_id': 'demo', 'ticket_id': 'rollback-0'})
                    client.call('daemon.shutdown', {})
                    self.assertEqual(process.wait(timeout=10), 0)
                    start()
                    self.assertEqual(batch(operations, 'original'), receipt)
                    self.assertEqual(batch(large_ops, 'large'), large_receipt)
                    current = client.call('workspace.get', {'workspace_id': 'demo'})
                    self.assertEqual(current['meta']['workspace_revision'], revision)
                    client.call('daemon.shutdown', {})
                    self.assertEqual(process.wait(timeout=10), 0)
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
