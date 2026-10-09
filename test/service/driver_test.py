"""External scripted harnesses against the real service with in-memory transport.

Only socket accept/connect is substituted. JSON framing, serialization, dispatcher,
worker domains, durable storage, indexing and lifecycle are production code.
"""
import importlib.util
import json
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import unittest

DRIVER = Path(sys.argv.pop(1)).resolve()
EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), EXAMPLES / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    def __init__(self, registry, directory):
        self.calls = self.response_bytes = 0
        self.log = (directory / 'driver.log').open('w+')
        self.process = subprocess.Popen([str(DRIVER), str(registry)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True)

    def call(self, method, params):
        self.calls += 1
        request = {'jsonrpc': '2.0', 'workgraph_api': '0.3', 'id': str(self.calls), 'method': method, 'params': params}
        self.process.stdin.write(json.dumps(request, separators=(',', ':')) + '\n')
        self.process.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=15):
                raise TimeoutError('service driver did not respond to ' + method)
        line = self.process.stdout.readline()
        self.response_bytes += len(line.encode())
        if not line:
            self.log.flush()
            self.log.seek(0)
            raise RuntimeError('service driver closed: ' + self.log.read())
        response = json.loads(line)
        if 'error' in response:
            raise RuntimeError(method + ': ' + json.dumps(response['error']))
        return response['result']

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise
        self.process.stdout.close()
        self.log.close()
        if self.process.returncode:
            raise RuntimeError('service driver exited ' + str(self.process.returncode))


class HarnessTest(unittest.TestCase):
    def test_history_resets_and_coordination(self):
        with tempfile.TemporaryDirectory(prefix='workgraph-driver-') as temporary:
            directory = Path(temporary)
            client = Client(directory / 'registry', directory)
            try:
                history = load('history-recovery-demo')
                history_dir = directory / 'history'
                history_dir.mkdir()
                history.run(None, history_dir, client=client)
                runner = load('coordination-runner')
                state_dir = directory / 'runner'
                state_dir.mkdir()
                result = runner.run(client, workspace='coordination', root=directory / 'workspace', state_dir=state_dir)
                self.assertIsNotNone(result)
            finally:
                client.close()


if __name__ == '__main__':
    unittest.main()
