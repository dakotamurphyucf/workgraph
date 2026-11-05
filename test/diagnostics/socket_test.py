"""Actual CLI parsing, server diagnostics and explicit JSON boundary checks."""
import json
from pathlib import Path
import subprocess
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = str(Path(sys.argv.pop(1)).resolve())

class DiagnosticsTest(unittest.TestCase):
    def test_json_local_failures_share_the_daemon_error_envelope(self):
        with tempfile.TemporaryDirectory(prefix='wg-output-', dir='/tmp') as directory:
            root = Path(directory)
            missing = str(root / 'missing')
            cases = [
                (['ticket.list'], 'Invalid_argument'),
                (['--context', 'relative', 'ticket.list'], 'Invalid_argument'),
                (['--context', missing, 'ticket.list'], 'Invalid_argument'),
                (['request', missing, 'ticket.list', '--json-field', 'limit', '{'], 'Invalid_argument'),
                (['request', missing, 'ticket.list', '--workspace-id', 'w'], 'Storage_unavailable'),
                # A literal field value is never an output switch.
                (['request', missing, 'ticket.create', '--title', '--output'], 'Invalid_argument'),
            ]
            for arguments, kind in cases:
                with self.subTest(arguments=arguments):
                    result = subprocess.run([EXE, *arguments], capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stderr, '')
                    envelope = json.loads(result.stdout)
                    self.assertEqual(set(envelope), {'jsonrpc', 'id', 'error'})
                    self.assertEqual(envelope['jsonrpc'], '2.0')
                    self.assertEqual(envelope['id'], 'cli')
                    self.assertEqual(envelope['error']['code'], -32000)
                    self.assertEqual(envelope['error']['data']['kind'], kind)
                    self.assertEqual(envelope['error']['message'], envelope['error']['data']['message'])

    def test_text_and_byte_stdout_remain_clean_on_early_errors(self):
        cases = [
            ['ticket.list', '--output', 'text'],
            ['--context', 'relative', 'ticket.list', '--output', 'text'],
            ['resource', 'download', '--destination', '-'],
            ['request', '/missing', 'resource.download', '--json-field', 'destination', '"-"'],
            ['call', '/missing', 'resource.download', '{"destination":"-"}'],
            ['--socket', '/missing', 'call', 'resource.download', '{"destination":"-"}'],
            ['request', '/missing', 'resource', 'download', '--destination', '-'],
            ['evidence-show', '--stage', 'relative', '--output', 'bytes'],
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = subprocess.run([EXE, *arguments], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(json.loads(result.stderr)['kind'], 'Invalid_argument')
        with tempfile.TemporaryDirectory(prefix='wg-raw-options-', dir='/tmp') as directory:
            params = Path(directory) / 'params.json'
            params.write_text('{"destination":"-"}')
            result = subprocess.run([EXE, 'resource.download', '/missing',
                '--params-file', str(params), '--timeout', 'invalid'],
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertEqual(json.loads(result.stderr)['kind'], 'Invalid_argument')
        # Literal child argv after -- cannot change the parent JSON mode.
        literal = subprocess.run([EXE, 'evidence-run', '--stage', 'relative', '--',
                                  '/bin/echo', '--output', 'text'],
                                 capture_output=True, text=True, timeout=5)
        self.assertEqual(literal.stderr, '')
        self.assertEqual(json.loads(literal.stdout)['error']['data']['kind'], 'Invalid_argument')

    def test_retry_local_failure_preserves_saved_request_id(self):
        with tempfile.TemporaryDirectory(prefix='wg-output-id-', dir='/tmp') as directory:
            root = Path(directory)
            saved = root / 'saved.json'
            for request_id in ['original-identity', 'raw\\"\\nidentity', 12.5]:
                saved.write_text(json.dumps({'jsonrpc': '2.0', 'workgraph_api': '0.5',
                    'id': request_id, 'method': 'ticket.list', 'params': {}}))
                before = saved.read_bytes()
                result = subprocess.run([EXE, 'retry', str(root / 'missing'), str(saved)],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, '')
                envelope = json.loads(result.stdout)
                self.assertEqual(envelope['id'], request_id)
                self.assertEqual(envelope['error']['data']['kind'], 'Unsupported_version')
                self.assertEqual(saved.read_bytes(), before)

    def test_old_peer_reply_preserves_uncertain_write_and_saved_identity(self):
        with tempfile.TemporaryDirectory(prefix='wg-old-peer-', dir='/tmp') as d:
            root = Path(d)
            address = str(root / 's')
            saved = root / 'request.json'
            observed = []
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(address)
                listener.listen()
                listener.settimeout(10)
                def peer():
                    with listener.accept()[0] as conn:
                        conn.settimeout(10)
                        def exact(n):
                            result = b''
                            while len(result) < n:
                                part = conn.recv(n - len(result))
                                if not part:
                                    raise EOFError()
                                result += part
                            return result
                        request = json.loads(exact(struct.unpack('!I', exact(4))[0]))
                        observed.append(request)
                        reply = json.dumps({'jsonrpc':'2.0', 'id':request['id'],
                            'error':{'code':-32601, 'message':'Method not found'}}).encode()
                        conn.sendall(struct.pack('!I', len(reply)) + reply)
                thread = threading.Thread(target=peer, daemon=True)
                thread.start()
                result = subprocess.run([EXE, 'request', address, 'ticket.create',
                    '--workspace-id','w','--actor-id','a','--ticket-id','t','--title','Task',
                    '--save-request',str(saved)], capture_output=True, text=True, timeout=10)
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive())
            self.assertNotEqual(result.returncode, 0)
            problem = json.loads(result.stdout)
            self.assertEqual(problem['error']['data']['kind'], 'Outcome_unknown')
            self.assertIn('initialize', problem['error']['data']['message'])
            self.assertIn('identical saved request', problem['error']['data']['message'])
            self.assertEqual(json.loads(saved.read_text()), observed[0])

    def test_actionable_claim_revision_collision_and_blocker_diagnostics(self):
        with tempfile.TemporaryDirectory(prefix='wg-diag-cases-', dir='/tmp') as d:
            root = Path(d)
            address = str(root / 's')
            with (root / 'log').open('w+') as log:
                daemon = subprocess.Popen([EXE, 'serve', str(root/'registry'), address], stdout=log, stderr=log)
                counter = 0
                def call(method, **fields):
                    p = subprocess.run([EXE,'call',address,method,json.dumps(fields)], capture_output=True, text=True, timeout=10)
                    return json.loads(p.stdout or p.stderr.splitlines()[-1])
                def write(method, **fields):
                    nonlocal counter
                    counter += 1
                    return call(method, **{'workspace_id':'w', 'actor_id':'owner', 'mutation_id':f'm{counter}', **fields})
                def good(reply):
                    self.assertIn('result',reply)
                    return reply['result']['data']
                def detail(reply, kind):
                    self.assertEqual(reply['error']['data']['kind'],kind)
                    return reply['error']['data']['details']
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0); self.fail(log.read())
                        time.sleep(.01)
                    good(write('workspace.create',name='Cases',root=str(root/'workspace')))
                    good(write('run.register',target_run_id='r',objective='Claim owner'))
                    good(write('ticket.create',ticket_id='t',title='Owned'))
                    started = good(write('ticket.start',ticket_id='t',run_id='r'))
                    token = started['token']
                    for actor,run,provided,expected in [('owner',None,token,'run'),('other','r',token,'actor'),('owner','r','999','token')]:
                        params = dict(ticket_id='t',actor_id=actor,token=provided,evidence='Must not finish')
                        if run is not None: params['run_id'] = run
                        diagnostic = detail(write('ticket.finish',**params),'Stale_claim')
                        self.assertEqual(diagnostic,{'type':'claim','ticket_id':'t','status':'mismatch','field':expected,'actor_id':'owner','run_id':'r'})
                    good(write('ticket.release',ticket_id='t',run_id='r',token=token))
                    self.assertEqual(detail(write('ticket.finish',ticket_id='t',run_id='r',token=token,evidence='Stale'),'Stale_claim'),
                        {'type':'claim','ticket_id':'t','status':'unclaimed'})
                    question = dict(request_id='q',title='Question',body='What now?',resolver_id='owner',recipients=[{'kind':'actor','id':'owner'}])
                    good(write('request.ask',**question))
                    self.assertEqual(detail(write('request.ask',**question),'Conflict'),{'type':'identity_collision','entity':'request','entity_id':'q'})
                    self.assertEqual(detail(write('request.accept',request_id='q',expected_revision='0',recipient={'kind':'actor','id':'owner'}),'Conflict'),
                        {'type':'entity_revision','entity':'request','entity_id':'q','expected':'0','actual':'1'})
                    message = dict(message_id='m',body='Hello',recipients=[{'kind':'actor','id':'owner'}])
                    good(write('message.send',**message))
                    self.assertEqual(detail(write('message.send',**message),'Conflict'),{'type':'identity_collision','entity':'message','entity_id':'m'})
                    # Both preparation and transport bounds must retain the true total.
                    for start in range(0,125,25):
                        good(write('transaction.apply',operations=[{'method':'ticket.create','params':{'ticket_id':f'dep{i:03}','title':'Prerequisite'}} for i in range(start,start+25)]))
                    good(write('ticket.create',ticket_id='blocked',title='Blocked'))
                    for start in range(0,125,25):
                        good(write('transaction.apply',operations=[{'method':'dependency.add','params':{'ticket_id':'blocked','prerequisite_id':f'dep{i:03}'}} for i in range(start,start+25)]))
                    blockers = detail(write('ticket.start',ticket_id='blocked'),'Blocked')
                    self.assertEqual(len(blockers['blockers']),16)
                    self.assertEqual(blockers['omitted_blockers'],'109')
                    self.assertTrue(all(b.startswith('prerequisite:') for b in blockers['blockers']))
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)

    def test_cli_and_server_boundaries(self):
        with tempfile.TemporaryDirectory(prefix='wg-diag-', dir='/tmp') as d:
            root = Path(d)
            address = str(root / 's')
            with (root / 'log').open('w+') as log:
                daemon = subprocess.Popen([EXE, 'serve', str(root/'registry'), address], stdout=log, stderr=log)
                def invoke(args):
                    p = subprocess.run([EXE, *args], capture_output=True, text=True, timeout=10)
                    return p, json.loads(p.stdout or p.stderr.splitlines()[-1])
                def rpc(method, **fields):
                    return invoke(['call', address, method, json.dumps(fields)])[1]
                def write(method, **fields):
                    return rpc(method, workspace_id='w', actor_id='owner', mutation_id=method.replace('.','-'), **fields)
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() > deadline:
                            log.seek(0); self.fail(log.read())
                        time.sleep(.01)
                    self.assertIn('result', write('workspace.create', name='Diagnostics', root=str(root/'workspace')))
                    self.assertIn('result', write('ticket.create', ticket_id='t', title='true'))
                    self.assertIn('result', write('ticket.start', ticket_id='t'))
                    blocked = rpc('ticket.start', workspace_id='w', actor_id='other', mutation_id='other', ticket_id='t')
                    detail = blocked['error']['data']['details']
                    self.assertEqual(detail, {'type':'ownership','actor_id':'owner','run_id':None})
                    self.assertNotIn('token', blocked['error']['message'])
                    _, result = invoke(['request', address, 'ticket.list','--workspace-id','w','--include-archived','true'])
                    self.assertIn('result', result)
                    # A boolean beyond the former four-name hardcoded list.
                    _, result = invoke(['request', address, 'ticket.resume','--workspace-id','w','--ticket-id','t','--include-markdown','true'])
                    self.assertIn('result', result)
                    raw = rpc('ticket.resume', workspace_id='w', ticket_id='t', include_markdown='true')
                    self.assertEqual(raw['error']['data']['details']['path'], ['include_markdown'])
                    text = subprocess.run([EXE, 'request', address, 'ticket.resume',
                        '--workspace-id', 'w', '--ticket-id', 'absent', '--output', 'text'],
                        capture_output=True, text=True, timeout=10)
                    self.assertEqual(text.returncode, 1)
                    self.assertEqual(text.stdout, '')
                    self.assertEqual(json.loads(text.stderr)['kind'], 'Not_found')
                    params = root/'params.json'; params.write_text(json.dumps({'workspace_id':'w','ticket_id':'t','include_markdown':'true'}))
                    saved = root/'invalid-saved.json'
                    rejected, local = invoke(['request', address,'ticket.resume','--params-file',str(params),'--save-request',str(saved)])
                    self.assertEqual(rejected.returncode, 1)
                    self.assertEqual(rejected.stderr, '')
                    self.assertEqual(local['error']['data']['kind'], 'Invalid_argument')
                    self.assertEqual(local['error']['data']['details']['path'], ['include_markdown'])
                    self.assertFalse(saved.exists())
                    bad = write('transaction.apply', operations=[{'method':'ticket.update','params':{'ticket_id':'t','expected_revision':'oops','title':'true'}}])
                    path = bad['error']['data']['details']['path']
                    self.assertEqual(path, ['operations','0','params','expected_revision'])
                    _, created = invoke(['request',address,'ticket.create','--workspace-id','w','--actor-id','owner','--mutation-id','text','--ticket-id','literal','--title','true'])
                    self.assertEqual(created['result']['data']['title'],'true')
                    # Structured named flags explain the remedy before journaling or connecting.
                    rejected, local = invoke(['request', '/absent-workgraph-socket', 'transaction.preflight',
                                              '--workspace-id', 'w', '--actor-id', 'owner', '--operations', '[]'])
                    self.assertEqual(1, rejected.returncode)
                    self.assertEqual('', rejected.stderr)
                    self.assertEqual(['operations'], local['error']['data']['details']['path'])
                    self.assertIn('--json-field operations JSON', local['error']['data']['details']['suggestion'])
                    # W35: direct raw and parsed CLI errors are structured, never a bare null.
                    oversized = [{'method': 'fact.put', 'params': {'scope': {'kind': 'workspace'},
                                  'key': 'oversize', 'expected_revision': '0', 'value': 'x' * 5000}}]
                    for method in ['transaction.preflight', 'transaction.apply']:
                        fields = dict(workspace_id='w', actor_id='owner', operations=oversized)
                        if method == 'transaction.apply':
                            fields['mutation_id'] = 'oversize-apply'
                        raw, envelope = invoke(['call', address, method, json.dumps(fields)])
                        self.assertEqual(1, raw.returncode)
                        self.assertIn('error', envelope)
                        self.assertEqual('Invalid_argument', envelope['error']['data']['kind'])
                        self.assertIn('4096', envelope['error']['message'])
                        params.write_text(json.dumps(fields))
                        parsed, problem = invoke(['request', address, method, '--params-file', str(params)])
                        self.assertEqual(1, parsed.returncode)
                        self.assertEqual('', parsed.stderr)
                        self.assertEqual('Invalid_argument', problem['error']['data']['kind'])
                        self.assertIn('4096', problem['error']['data']['message'])
                    self.assertIn('result', write('fact.put', scope={'kind': 'workspace'}, key='nullable',
                                                 expected_revision='0', value=None))
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)

if __name__ == '__main__':
    unittest.main()
