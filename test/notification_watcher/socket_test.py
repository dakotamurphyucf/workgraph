"""Actual CLI callback data, durable ack uncertainty and daemon/watcher restart."""
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
SCRIPT = ROOT / 'examples/notification-watcher.py'

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

adapter = load('history_adapter', ROOT / 'examples/history-adapter.py')
watcher = load('watcher', SCRIPT)


class WatcherSocketTest(unittest.TestCase):
    def test_literal_callback_input_and_recovery_after_ack_loss(self):
        with tempfile.TemporaryDirectory(prefix='wg-watch-', dir='/tmp') as temporary:
            root = Path(temporary)
            address = root / 'socket'
            state_path = root / 'watcher.json'
            records = root / 'records'
            records.mkdir()
            callback = root / 'callback.py'
            callback.write_text('''import json,os,sys
from pathlib import Path
packet=json.load(sys.stdin)
root=Path(sys.argv[1])
with (root/'calls').open('a') as out:
    out.write(packet['delivery_id']+'\\n');out.flush();os.fsync(out.fileno())
with (root/(packet['delivery_id']+'.json')).open('w') as out:
    json.dump(packet,out);out.flush();os.fsync(out.fileno())
fd=os.open(root,os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)
''')
            command = [sys.executable, str(SCRIPT), '--socket', str(address), '--workspace-id', 'demo',
                       '--actor-id', 'agent', '--consumer-id', 'watcher', '--recipient-id', 'agent',
                       '--state', str(state_path), '--callback-cwd', str(root), '--timeout-ms', '5',
                       '--once', '--', sys.executable, str(callback), str(records)]
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
                def cli():
                    result = subprocess.run(command, text=True, capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    return json.loads(result.stdout)
                client = adapter.Workgraph(address)
                def send(number, body):
                    return client.call('message.send', {'workspace_id': 'demo', 'actor_id': 'sender',
                        'mutation_id': 'send-' + str(number), 'message_id': 'message-' + str(number),
                        'body': body, 'recipients': [{'kind': 'actor', 'id': 'agent'}]})
                try:
                    start()
                    client.call('workspace.create', {'workspace_id': 'demo', 'actor_id': 'agent',
                        'mutation_id': 'workspace', 'root': str(root / 'workspace'), 'name': 'Watcher'})
                    self.assertIs(cli()['delivered'], False)
                    marker = root / 'must-not-exist'
                    body = '$(touch ' + str(marker) + ')\n`touch ' + str(marker) + '`'
                    send(1, body)
                    self.assertIs(cli()['delivered'], True)
                    packets = list(records.glob('*.json'))
                    self.assertEqual(len(packets), 1)
                    packet = json.loads(packets[0].read_text())
                    self.assertEqual(packet['notification']['body_source']['body'], body)
                    self.assertFalse(marker.exists())
                    send(2, 'Wake up again')
                    identity = json.loads(state_path.read_text())['identity']
                    def invoke(packet):
                        subprocess.run(identity['callback_argv'], input=watcher.canonical(packet).encode(),
                                       cwd=identity['callback_cwd'], check=True)
                    class DropAck:
                        def call(self, method, params):
                            result = client.call(method, params)
                            if method == 'inbox.ack':
                                # The real daemon committed; the caller loses its response.
                                raise EOFError('lost committed acknowledgement')
                            return result
                    with watcher.checkpoint_lock(state_path):
                        instance = watcher.Watcher(DropAck(), state_path, identity, invoke)
                        with self.assertRaises(EOFError):
                            instance.step(timeout_ms=5)
                    pending = json.loads(state_path.read_text())['pending']
                    self.assertIs(pending['callback_completed'], True)
                    self.assertEqual(len((records / 'calls').read_text().splitlines()), 2)
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                    start()
                    self.assertIs(cli()['delivered'], True)
                    self.assertIsNone(json.loads(state_path.read_text())['pending'])
                    self.assertEqual(len((records / 'calls').read_text().splitlines()), 2)
                    self.assertIs(cli()['delivered'], False)
                    client.call('daemon.shutdown', {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon is not None and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
