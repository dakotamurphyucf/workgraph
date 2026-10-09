"""Hook process over the real Workgraph socket, without transcript or model access."""
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
HOOK = ROOT / 'examples/codex-hooks/workgraph-hook.py'
spec = importlib.util.spec_from_file_location('adapter', ROOT / 'examples/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class HookSocketTest(unittest.TestCase):
    def test_explicit_handoff_and_context_recovery_after_daemon_restart(self):
        with tempfile.TemporaryDirectory(prefix='wg-hook-', dir='/tmp') as temporary:
            root = Path(temporary)
            address = root / 'socket'
            config = {'socket': str(address), 'workspace_id': 'demo', 'actor_id': 'agent',
                      'ticket_id': 'task', 'max_bytes': 16384,
                      'handoff_request': str(root / 'request.json'),
                      'handoff_receipt': str(root / 'receipt.json')}
            config_path = root / 'binding.json'
            config_path.write_text(json.dumps(config))
            client = adapter.Workgraph(address)
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

                def invoke(name):
                    event = {'hook_event_name': name, 'session_id': 'external-session',
                             'cwd': str(root), 'transcript_path': '/not-available-after-reset'}
                    if name == 'SessionStart':
                        event['source'] = 'compact'
                    elif name == 'PreCompact':
                        event.update(trigger='auto', turn_id='external-turn')
                    else:
                        event.update(turn_id='external-turn', stop_hook_active=False)
                    result = subprocess.run([sys.executable, str(HOOK), '--config', str(config_path)],
                                            input=json.dumps(event), capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return json.loads(result.stdout)

                try:
                    start()
                    client.call('workspace.create', {'workspace_id': 'demo', 'actor_id': 'agent',
                        'mutation_id': 'workspace', 'root': str(root / 'workspace'), 'name': 'Hook fixture'})
                    created = client.call('ticket.create', {'workspace_id': 'demo', 'actor_id': 'agent',
                        'mutation_id': 'ticket', 'ticket_id': 'task', 'title': 'Recover this decision'})
                    self.assertIn('no handoff was invented', invoke('PreCompact')['systemMessage'])
                    request = {'method': 'handoff.set', 'params': {'workspace_id': 'demo', 'actor_id': 'agent',
                        'mutation_id': 'handoff-exact', 'ticket_id': 'task', 'expected_revision': '0',
                        'covers_through': created['meta']['workspace_revision'],
                        'summary': 'Decision: retain the exact input digest.', 'next_steps': 'Run the independent check.',
                        'evidence': 'Fixture command succeeded.'}}
                    Path(config['handoff_request']).write_text(json.dumps(request))
                    self.assertIn('durably acknowledged', invoke('PreCompact')['systemMessage'])
                    first_receipt = json.loads(Path(config['handoff_receipt']).read_text())
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    start()
                    # Stop reuses the saved mutation; no transcript or previous process state.
                    self.assertIn('durably acknowledged', invoke('Stop')['systemMessage'])
                    self.assertEqual(json.loads(Path(config['handoff_receipt']).read_text()), first_receipt)
                    result = invoke('SessionStart')['hookSpecificOutput']
                    self.assertEqual(result['hookEventName'], 'SessionStart')
                    recovered = json.loads(result['additionalContext'].split('\n', 1)[1])
                    rendered = json.dumps(recovered)
                    self.assertIn('Decision: retain the exact input digest.', rendered)
                    self.assertIn('Run the independent check.', rendered)
                    self.assertIn('workspace_revision', recovered['meta'])
                    self.assertLessEqual(len(adapter.canonical(recovered).encode()), 16384)
                    self.assertEqual(json.loads(Path(config['handoff_request']).read_text()), request)
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
