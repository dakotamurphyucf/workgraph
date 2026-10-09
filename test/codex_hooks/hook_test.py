"""Official command-hook payload shapes; no model or Codex configuration writes."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hook', sys.argv.pop(1))
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class Client:
    def __init__(self):
        self.calls = []
        self.response = {'data': {'ticket_id': 'task'}, 'meta': {'durable': True}}
        self.failure = None

    def call(self, method, params):
        self.calls.append((method, json.loads(json.dumps(params))))
        if self.failure is not None:
            raise self.failure
        return self.response


class HookTest(unittest.TestCase):
    def binding(self, root):
        return {'socket': str(root / 'socket'), 'workspace_id': 'demo', 'actor_id': 'agent',
                'ticket_id': 'task', 'handoff_request': str(root / 'request.json'),
                'handoff_receipt': str(root / 'receipt.json')}

    def request(self, config):
        request = {'method': 'handoff.set', 'params': {
            'workspace_id': 'demo', 'actor_id': 'agent', 'ticket_id': 'task',
            'mutation_id': 'saved', 'expected_revision': '0', 'covers_through': '3',
            'summary': 'Explicit decision', 'next_steps': 'Run the remaining check', 'evidence': 'Build passed'}}
        Path(config['handoff_request']).write_text(json.dumps(request))
        return request

    def test_resume_preserves_sources_and_does_not_open_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.binding(Path(directory))
            config['run_id'] = 'run'
            client = Client()
            client.response = {'data': {'source': {'ticket_id': 'task'}, 'omissions': ['history']},
                               'meta': {'workspace_revision': '3'}}
            result = hook.handle({'hook_event_name': 'SessionStart', 'source': 'compact',
                                  'transcript_path': '/must/not/be/read'}, config, client)
            output = result['hookSpecificOutput']
            self.assertEqual(output['hookEventName'], 'SessionStart')
            self.assertTrue(output['additionalContext'].endswith(hook.adapter.canonical(client.response)))
            self.assertEqual(client.calls, [('ticket.resume', {'workspace_id': 'demo', 'ticket_id': 'task',
                                                               'max_bytes': '8192', 'run_id': 'run'})])
            self.assertFalse(Path(config['handoff_receipt']).exists())
            client.response = {'data': 'é' * 8192}
            with self.assertRaises(ValueError):
                hook.handle({'hook_event_name': 'SessionStart'}, config, client)

    def test_compaction_never_invents_notes_and_lost_reply_retries_exact_request(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.binding(Path(directory))
            client = Client()
            event = {'hook_event_name': 'PreCompact', 'trigger': 'auto', 'turn_id': 'turn'}
            self.assertIn('no handoff was invented', hook.handle(event, config, client)['systemMessage'])
            self.assertEqual(client.calls, [])
            request = self.request(config)
            client.failure = EOFError('durable write but lost response')
            with self.assertRaises(EOFError):
                hook.handle(event, config, client)
            self.assertFalse(Path(config['handoff_receipt']).exists())
            client.failure = None
            result = hook.handle({'hook_event_name': 'Stop', 'stop_hook_active': False}, config, client)
            self.assertNotIn('decision', result)
            self.assertEqual(client.calls[0], client.calls[1])
            self.assertEqual(json.loads(Path(config['handoff_request']).read_text()), request)
            receipt = json.loads(Path(config['handoff_receipt']).read_text())
            self.assertIs(receipt['response']['meta']['durable'], True)
            self.assertEqual(len(receipt['request_sha256']), 64)

    def test_rejects_wrong_binding_missing_coverage_and_non_durable_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.binding(Path(directory))
            client = Client()
            event = {'hook_event_name': 'PreCompact'}
            for field, value in [('actor_id', 'other'), ('run_id', 'other'), ('ticket_id', 'other')]:
                request = self.request(config)
                request['params'][field] = value
                Path(config['handoff_request']).write_text(json.dumps(request))
                with self.assertRaises(ValueError):
                    hook.handle(event, config, client)
            request = self.request(config)
            del request['params']['covers_through']
            Path(config['handoff_request']).write_text(json.dumps(request))
            with self.assertRaises(ValueError):
                hook.handle(event, config, client)
            self.assertEqual(client.calls, [])
            self.request(config)
            client.response['meta']['durable'] = False
            with self.assertRaises(RuntimeError):
                hook.handle(event, config, client)
            self.assertFalse(Path(config['handoff_receipt']).exists())

    def test_paths_and_shapes_are_validated_before_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.binding(Path(directory))
            client = Client()
            for change in [{'socket': 'relative.sock'}, {'handoff_receipt': config['handoff_request']},
                           {'run_id': 5}, {'actor_id': ''}]:
                with self.assertRaises(ValueError):
                    hook.handle({'hook_event_name': 'SessionStart'}, {**config, **change}, client)
            with self.assertRaises(ValueError):
                hook.handle([], config, client)
            Path(config['handoff_request']).write_text('[]')
            with self.assertRaises(ValueError):
                hook.handle({'hook_event_name': 'Stop'}, config, client)
            self.assertEqual(client.calls, [])


if __name__ == '__main__':
    unittest.main()
