"""Actual CLI parsing, server diagnostics and explicit JSON boundary checks."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = str(Path(sys.argv.pop(1)).resolve())

class DiagnosticsTest(unittest.TestCase):
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
                    params = root/'params.json'; params.write_text(json.dumps({'workspace_id':'w','ticket_id':'t','include_markdown':'true'}))
                    _, raw = invoke(['request', address,'ticket.resume','--params-file',str(params)])
                    self.assertEqual(raw['error']['data']['details']['path'], ['include_markdown'])
                    bad = write('transaction.apply', operations=[{'method':'ticket.update','params':{'ticket_id':'t','expected_revision':'oops','title':'true'}}])
                    path = bad['error']['data']['details']['path']
                    self.assertEqual(path, ['operations','0','params','expected_revision'])
                    _, created = invoke(['request',address,'ticket.create','--workspace-id','w','--actor-id','owner','--mutation-id','text','--ticket-id','literal','--title','true'])
                    self.assertEqual(created['result']['data']['title'],'true')
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)

if __name__ == '__main__':
    unittest.main()
