import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watcher', sys.argv.pop(1))
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)
IDENTITY = {'workspace_id': 'demo', 'actor_id': 'agent', 'run_id': None,
            'consumer_id': 'harness', 'recipient': {'kind': 'actor', 'id': 'agent'},
            'kinds': None, 'ticket_id': None, 'callback_argv': ['/callback'],
            'callback_cwd': '/workspace', 'socket': '/socket'}


class Client:
    def __init__(self):
        self.calls = []
        self.lost_ack = False
        self.acked = False

    def call(self, method, params):
        self.calls.append((method, json.loads(json.dumps(params))))
        if method == 'inbox.wait':
            return {'meta': {'budget': {'clipped': False}}, 'data': {
                'consumer_id': 'harness', 'recipient': IDENTITY['recipient'], 'remaining': '0',
                'items': [] if self.acked else [{'notification_id': '3', 'body_source': {'body': '$(touch /do-not-run)'}}]}}
        assert method == 'inbox.ack'
        self.acked = True
        if self.lost_ack:
            self.lost_ack = False
            raise EOFError('committed but reply lost')
        return {'meta': {'durable': True}, 'data': {k: params[k] for k in ['consumer_id', 'recipient', 'notification_ids']}}


class WatcherTest(unittest.TestCase):
    def test_lost_ack_retry_preserves_exact_request_without_callback_reexecution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            client = Client()
            delivered = []
            client.lost_ack = True
            first = watcher.Watcher(client, path, IDENTITY, delivered.append)
            with self.assertRaises(EOFError):
                first.step()
            pending = json.loads(path.read_text())['pending']
            self.assertIs(pending['callback_completed'], True)
            second = watcher.Watcher(client, path, IDENTITY, delivered.append)
            self.assertTrue(second.step())
            self.assertEqual(len(delivered), 1)
            self.assertEqual(client.calls[-1], client.calls[-2])
            self.assertEqual(second.state['last_notification_id'], '3')
            self.assertIsNone(second.state['pending'])
            self.assertFalse(second.step())

    def test_callback_failure_and_success_before_checkpoint_crash_redeliver_same_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            client = Client()
            delivered = []
            def failed(packet):
                delivered.append(packet)
                raise RuntimeError('callback failed before its durable completion')
            first = watcher.Watcher(client, path, IDENTITY, failed)
            with self.assertRaises(RuntimeError):
                first.step()
            self.assertFalse(client.acked)
            self.assertFalse(json.loads(path.read_text())['pending']['callback_completed'])
            second = watcher.Watcher(client, path, IDENTITY, delivered.append)
            with patch.object(watcher, 'save', side_effect=OSError('sync failed after callback')):
                with self.assertRaises(OSError):
                    second.step()
            self.assertFalse(client.acked)
            third = watcher.Watcher(client, path, IDENTITY, delivered.append)
            self.assertTrue(third.step())
            self.assertEqual(len(delivered), 3)
            self.assertEqual(len({p['delivery_id'] for p in delivered}), 1)

    def test_identity_tampering_and_single_owner_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            client = Client()
            with watcher.checkpoint_lock(path):
                with self.assertRaises(RuntimeError):
                    with watcher.checkpoint_lock(path):
                        self.fail('second lock acquired')
                first = watcher.Watcher(client, path, IDENTITY, lambda _: None)
                client.lost_ack = True
                with self.assertRaises(EOFError):
                    first.step()
            with self.assertRaises(ValueError):
                watcher.Watcher(client, path, {**IDENTITY, 'kinds': ['message_received']}, lambda _: None)
            state = json.loads(path.read_text())
            state['pending']['ack']['params']['notification_ids'] = ['4']
            path.write_text(json.dumps(state))
            with self.assertRaises(ValueError):
                watcher.Watcher(client, path, IDENTITY, lambda _: None)

    def test_callback_mutation_does_not_change_receipt_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Client()
            def callback(packet):
                packet['notification']['notification_id'] = '99'
            instance = watcher.Watcher(client, Path(directory) / 'state.json', IDENTITY, callback)
            self.assertTrue(instance.step())
            self.assertEqual(client.calls[-1][1]['notification_ids'], ['3'])
            self.assertEqual(client.calls[0][1]['after'], '0')


if __name__ == '__main__':
    unittest.main()
