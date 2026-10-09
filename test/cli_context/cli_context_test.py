"""Real socket checks for explicit setup, agent-local defaults and exact retry."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import socket as sockets
import struct
import threading
import sys
import tempfile
import unittest

EXE = Path(sys.argv.pop(1)).resolve()


class ContextTest(unittest.TestCase):
    def test_unknown_method_rejects_before_journal_or_connection(self):
        with tempfile.TemporaryDirectory(prefix='wg-cli-unknown-', dir='/tmp') as directory:
            root = Path(directory)
            for method in ['ticket.get', 'ticket.unknown', 'unknown.read']:
                for command in ['call', 'request']:
                    saved = root / (method + '-' + command + '.json')
                    args = [str(EXE), command, str(root / 'absent-socket'), method]
                    if command == 'call':
                        args.append('{}')
                    args.extend(['--save-request', str(saved)])
                    result = subprocess.run(args, capture_output=True, text=True, timeout=5)
                    self.assertNotEqual(0, result.returncode)
                    problem = json.loads(result.stderr)
                    self.assertEqual('Invalid_argument', problem['kind'])
                    self.assertIn('unknown method: ' + method, problem['message'])
                    self.assertFalse(saved.exists())
                    self.assertEqual('', result.stdout)

    def test_bootstrap_concurrency_context_and_journal(self):
        with tempfile.TemporaryDirectory(prefix='wg-cli-', dir='/tmp') as directory:
            root = Path(directory)
            socket = root / 's'
            registry = root / 'registry'
            def cli(*args):
                return subprocess.run([str(EXE), *map(str, args)], capture_output=True, text=True, timeout=15)
            def body(result):
                self.assertEqual(0, result.returncode, result.stderr + result.stdout)
                return json.loads(result.stdout.splitlines()[-1])
            def init(actor):
                return cli('init', '--context', root / (actor + '.json'), '--socket', socket,
                           '--workspace-id', actor, '--actor-id', actor, '--name', actor,
                           '--root', root / actor, '--request-directory', root / (actor + '-requests'),
                           '--start-daemon', 'true', '--registry', registry,
                           '--daemon-log', root / 'daemon.log')
            try:
                for context_path, start in [(root / 'invalid.json', 'typo'), ('relative.json', 'true')]:
                    invalid = cli('init', '--context', context_path, '--socket', socket,
                                  '--workspace-id', 'invalid', '--actor-id', 'invalid',
                                  '--name', 'Invalid', '--root', root / 'invalid-workspace',
                                  '--start-daemon', start, '--registry', registry,
                                  '--daemon-log', root / 'invalid.log')
                    self.assertNotEqual(0, invalid.returncode)
                    self.assertFalse(registry.exists())
                    self.assertFalse((root / 'invalid-workspace').exists())
                    self.assertFalse((root / 'invalid.log').exists())
                invalid_directory = root / 'not-a-directory'
                invalid_directory.write_text('ordinary file')
                invalid = cli('init', '--context', root / 'invalid.json', '--socket', socket,
                              '--workspace-id', 'invalid', '--actor-id', 'invalid',
                              '--name', 'Invalid', '--root', root / 'invalid-workspace',
                              '--request-directory', invalid_directory, '--start-daemon', 'true',
                              '--registry', registry, '--daemon-log', root / 'invalid.log')
                self.assertNotEqual(0, invalid.returncode)
                self.assertFalse(registry.exists())
                self.assertFalse((root / 'invalid-workspace').exists())
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(init, ['a', 'b']))
                for result in results:
                    body(result)
                body(init('a'))
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    for result in pool.map(init, ['c', 'c']):
                        body(result)
                body(cli('init', '--context', root / 'a.json'))
                mismatch = cli('init', '--context', root / 'a.json', '--workspace-id', 'different', '--actor-id', 'a', '--name', 'Different', '--root', root / 'different')
                self.assertNotEqual(0, mismatch.returncode)
                self.assertFalse((root / 'different').exists())
                context = root / 'a.json'
                def create(index):
                    return cli('--context', context, 'ticket', 'create', '--title', 'Ticket ' + str(index))
                with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                    results = list(pool.map(create, range(12)))
                for result in results:
                    body(result)
                    self.assertIn('saved_request: ', result.stderr)
                requests = list((root / 'a-requests').glob('*.json'))
                self.assertEqual(12, len(requests))
                identities = {json.loads(path.read_text())['params']['mutation_id'] for path in requests}
                self.assertEqual(12, len(identities))
                saved = requests[0]
                original = json.loads(saved.read_text())
                first = body(cli('--context', root / 'b.json', 'retry', saved))
                second = body(cli('--context', context, 'retry', saved))
                self.assertEqual(first['result'], second['result'])
                self.assertEqual(original, json.loads(saved.read_text()))
                self.assertEqual(12, len(list((root / 'a-requests').glob('*.json'))))
                a = body(cli('--context', context, 'ticket', 'list'))['result']['data']
                b = body(cli('--context', root / 'b.json', 'ticket', 'list'))['result']['data']
                self.assertEqual(12, len(a['items']))
                self.assertEqual([], b['items'])
                body(cli('--context', context, 'coordinator', 'overview', '--actor-id', 'a'))
                override = body(cli('--context', context, 'ticket', 'list', '--workspace-id', 'b'))
                self.assertEqual([], override['result']['data']['items'])
                # A proxy drops the response only after the daemon has committed.
                proxy_path = root / 'drop-response'
                listener = sockets.socket(sockets.AF_UNIX)
                listener.bind(str(proxy_path))
                listener.listen(1)
                errors = []
                def exact(flow, count):
                    chunks = bytearray()
                    while len(chunks) < count:
                        part = flow.recv(count - len(chunks))
                        if not part:
                            raise RuntimeError('unexpected EOF')
                        chunks.extend(part)
                    return bytes(chunks)
                def drop_response():
                    try:
                        with listener.accept()[0] as incoming, sockets.socket(sockets.AF_UNIX) as upstream:
                            upstream.connect(str(socket))
                            header = exact(incoming, 4)
                            upstream.sendall(header + exact(incoming, struct.unpack('>I', header)[0]))
                            header = exact(upstream, 4)
                            response = json.loads(exact(upstream, struct.unpack('>I', header)[0]))
                            if 'result' not in response:
                                raise RuntimeError(str(response))
                    except Exception as error:
                        errors.append(error)
                    finally:
                        listener.close()
                worker = threading.Thread(target=drop_response)
                worker.start()
                lost = cli('--context', context, '--socket', proxy_path, 'ticket', 'create', '--title', 'Lost response')
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive())
                self.assertEqual([], errors)
                self.assertNotEqual(0, lost.returncode)
                self.assertIn('Outcome_unknown', lost.stderr)
                saved_lost = Path(lost.stderr.split('saved_request: ', 1)[1].splitlines()[0])
                before = body(cli('--context', context, 'ticket', 'list'))['result']['data']['items']
                body(cli('--context', context, 'retry', saved_lost))
                after = body(cli('--context', context, 'ticket', 'list'))['result']['data']['items']
                self.assertEqual(before, after)
                self.assertEqual(13, len(after))
                bad = cli('--context', root / 'missing.json', 'ticket', 'create', '--title', 'No implicit setup')
                self.assertNotEqual(0, bad.returncode)
                body(cli('--context', context, 'resource', 'put_text', '--resource-id', 'literal', '--expected-revision', '0', '--title', 'Literal', '--text', 'Literal text'))
                body(cli('--context', context, 'resource', 'put_text', '--resource-id', 'context-literal', '--expected-revision', '0', '--title', '--socket', '--text', '--context'))
                literal = body(cli('--context', context, 'resource', 'get', '--resource-id', 'context-literal'))
                self.assertEqual('--socket', literal['result']['data']['metadata']['title'])
                downloaded = root / 'literal-output'
                body(cli('--context', context, 'resource', 'download', '--resource-id', 'context-literal', '--destination', downloaded))
                self.assertEqual('--context', downloaded.read_text())
                payload_file = root / 'body.txt'
                payload_file.write_text('From file')
                body(cli('--context', context, 'resource', 'put_text', '--resource-id', 'file-literal', '--expected-revision', '0', '--field-file', 'text', payload_file, '--title', '--context'))
                body(cli('--context', context, 'resource', 'put_text', '--resource-id', 'typed-literal', '--expected-revision', '0', '--json-field', 'title', '"--socket"', '--text', '--socket'))

                self.assertNotEqual(0, cli('--context', context, 'retry', saved, '--actor-id', 'different').returncode)
            finally:
                cli('request', socket, 'daemon.shutdown')


if __name__ == '__main__':
    unittest.main()
