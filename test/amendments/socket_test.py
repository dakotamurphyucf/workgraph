"""Immutable instructions, distinct delivery/acceptance, and exact durable retries."""
import importlib.util
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening
EXE = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location('adapter', Path(__file__).resolve().parents[2]/'skills/workgraph/scripts/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class AmendmentTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-amendment-', dir='/tmp')
        self.root = Path(self.temporary.name)
        self.registry = self.root/'registry'
        self.address = self.root/'socket'
        self.log = (self.root/'daemon.log').open('w+')
        self.daemon = None
        self.serial = 0
        self.start()
        self.write('workspace.create', name='Amendments', root=str(self.root/'workspace'))
        self.write('ticket.create', ticket_id='task', title='Task')
        self.write('ticket.claim', by='worker', ticket_id='task', expected_revision='1')
    def start(self):
        self.daemon = subprocess.Popen([str(EXE), 'serve', str(self.registry), str(self.address)], stdout=self.log, stderr=self.log)
        deadline = time.monotonic()+10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic()>deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)
        self.client = adapter.Workgraph(self.address)
    def stop(self):
        self.client.call('daemon.shutdown', {})
        self.assertEqual(self.daemon.wait(timeout=10), 0)
    def tearDown(self):
        if self.daemon is not None and self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=10)
        self.log.close()
        self.temporary.cleanup()
    def read(self, method, **params):
        return self.client.call(method, {'workspace_id':'amendments', **params})
    def write(self, method, by='lead', identity=None, **params):
        self.serial += 1
        return self.read(method, actor_id=by, mutation_id=identity or 'm'+str(self.serial), **params)
    def reject(self, method, kind, **params):
        with self.assertRaises(RuntimeError) as raised:
            self.write(method, **params)
        self.assertEqual(json.loads(str(raised.exception))['data']['kind'], kind)
    def publication(self, identity, body, **extra):
        return dict(amendment_id=identity, ticket_id='task', expected_revision='0', title='Instruction', source={'kind':'text','body':body}, require_ack=True, **extra)
    def test_lost_publication_ack_restart_and_delivery_is_not_acceptance(self):
        body='Z'*65536
        params=self.publication('instruction', body)
        request={'jsonrpc':'2.0','workgraph_api':'0.7','id':'lost','method':'ticket.amendment.publish',
                 'params':{'workspace_id':'amendments','actor_id':'lead','mutation_id':'lost-publication',**params}}
        payload=adapter.canonical(request).encode()
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(10)
            connection.connect(str(self.address))
            connection.sendall(struct.pack('>I',len(payload))+payload)
            self.assertEqual(len(connection.recv(4)),4)
            # Durable publication preceded the header; discard the unread result.
        published=self.write('ticket.amendment.publish', identity='lost-publication', **params)
        small=self.read('ticket.amendment.get', amendment_id='instruction', max_bytes='4096')['data']
        self.assertIsNone(small['item'])
        self.assertTrue(small['needs_larger_budget'])
        full=self.read('ticket.amendment.get', amendment_id='instruction', max_bytes=small['required_bytes'])['data']
        self.assertEqual(full['item']['content']['publication']['source']['body'],body)
        recipient={'kind':'actor','id':'worker'}
        inbox=self.read('inbox.read', consumer_id='worker-inbox', recipient=recipient)['data']['items']
        packet=next(item for item in inbox if item.get('body_source') and json.loads(item['body_source']['body']).get('kind')=='ticket_amendment_announcement')
        announcement=packet['body_source']['body']
        self.assertLess(len(announcement.encode()),8192)
        self.assertNotIn(body,announcement)
        self.assertEqual(json.loads(announcement)['changes'][0]['source'],{'amendment_id':'instruction','revision':'1'})
        comment=packet['causal_body']['comment_id']
        self.write('comment.edit', comment_id=comment, expected_revision='1', body='Edited announcement display')
        pinned=next(item for item in self.read('inbox.read', consumer_id='worker-inbox', recipient=recipient)['data']['items'] if item['notification_id']==packet['notification_id'])
        self.assertEqual(pinned['body_source']['body'],announcement)
        self.write('inbox.ack', by='worker', consumer_id='worker-inbox', recipient=recipient, notification_ids=[packet['notification_id']])
        self.reject('ticket.finish','Blocked',by='worker',ticket_id='task',token='1',evidence='Checked')
        self.reject('ticket.amendment.acknowledge','Stale_claim',amendment_id='instruction',expected_revision='1',ticket_id='task',token='1')
        accepted=self.write('ticket.amendment.acknowledge',by='worker',identity='ack',amendment_id='instruction',expected_revision='1',ticket_id='task',token='1')
        duplicate=self.write('ticket.amendment.acknowledge',by='worker',identity='fresh-duplicate',amendment_id='instruction',expected_revision='1',ticket_id='task',token='1')
        self.assertTrue(duplicate['data']['duplicate'])
        self.assertEqual(len(self.read('ticket.amendment.acknowledgements',amendment_id='instruction',revision='1')['data']['items']),1)
        self.write('ticket.progress',by='worker',ticket_id='task',token='1',body='Progress retains exact ack')
        self.stop();self.start()
        self.assertEqual(self.write('ticket.amendment.publish', identity='lost-publication', **params),published)
        self.assertEqual(self.write('ticket.amendment.acknowledge',by='worker',identity='ack',amendment_id='instruction',expected_revision='1',ticket_id='task',token='1'),accepted)
        self.assertFalse(self.read('ticket.amendment.get',amendment_id='instruction',max_bytes='1048576')['data']['pending_acknowledgement'])
        self.write('ticket.finish',by='worker',ticket_id='task',token='1',evidence='Checked')
        context=self.read('ticket.context',ticket_id='task')['data']
        self.assertTrue(context['completion_readiness']['can_complete'])
        self.assertIn('amendment_acknowledgements',[c['kind'] for c in context['completion_readiness']['checks']])
        destination=self.root/'export'
        exported=self.write('workspace.export',destination=str(destination))
        deadline=time.monotonic()+10
        while True:
            job=self.client.call('export.get',{'job_id':exported['data']['job_id']})['data']
            if job['status']=='completed':
                break
            self.assertLess(time.monotonic(),deadline,job)
            time.sleep(.01)
        self.stop()
        self.registry=self.root/'restored-registry'
        self.start()
        self.client.call('workspace.restore',{'actor_id':'lead','mutation_id':'restore','directory':str(destination),'root':str(self.root/'restored-workspace')})
        self.write('workspace.open')
        self.assertEqual(self.write('ticket.amendment.publish',identity='lost-publication',**params),published)
        retained=self.read('ticket.amendment.get',amendment_id='instruction',revision='1',max_bytes='1048576')['data']['item']
        self.assertEqual(retained['content']['publication']['source']['body'],body)
        self.assertEqual(len(self.read('ticket.amendment.acknowledgements',amendment_id='instruction',revision='1')['data']['items']),1)
    def test_amendment_evidence_pins_public_requests_retry_and_restart(self):
        self.write('ticket.amendment.publish', **self.publication('instruction-pin', 'Exact instruction'))
        pin = {'kind': 'amendment', 'amendment_id': 'instruction-pin', 'revision': '1'}
        decision = dict(decision_id='instruction-decision', expected_revision='0',
                        scope={'kind': 'ticket', 'ticket_id': 'task'},
                        title='Decision from exact instructions', rationale=pin,
                        evidence=[pin], affected=[{'kind': 'ticket', 'ticket_id': 'task'}],
                        supersedes=[])
        operations = [{'method': 'decision.put', 'params': decision}]
        committed = self.write('transaction.apply', identity='amendment-decision', operations=operations)
        self.assertTrue(committed['meta']['durable'])
        recorded = self.read('decision.get', decision_id='instruction-decision')['data']
        self.assertEqual(recorded['rationale'], pin)
        self.assertEqual(recorded['evidence'], [pin])
        condition = dict(condition_id='instruction-condition', expected_revision='0',
                         ticket_id='task', label='Exact instruction approval',
                         operation_id='instruction-review', artifact=pin, required=False)
        declared = self.write('condition.put', identity='amendment-condition', **condition)
        self.assertEqual(declared['data']['condition']['artifact'], pin)
        self.write('ticket.amendment.withdraw', amendment_id='instruction-pin',
                   expected_revision='1', reason='Newer instructions will follow')
        self.stop(); self.start()
        self.assertEqual(self.write('transaction.apply', identity='amendment-decision',
                                    operations=operations), committed)
        self.assertEqual(self.write('condition.put', identity='amendment-condition', **condition), declared)
        self.assertEqual(self.read('decision.get', decision_id='instruction-decision')['data'], recorded)
        historical = self.read('ticket.amendment.get', amendment_id='instruction-pin', revision='1')['data']
        self.assertEqual(historical['item']['content']['publication']['source']['body'], 'Exact instruction')
        for method in ['acceptance.assert', 'manifest.publish', 'decision.put', 'input.changed',
                       'condition.put', 'condition.signal', 'ticket.recover',
                       'reservation.recover', 'reservation.path.recover']:
            schema = json.loads(subprocess.check_output([str(EXE), 'schema', method]))
            self.assertIn('amendment_id', json.dumps(schema['methods'][0]['params']), method)

    def test_supersede_withdraw_resource_pin_and_new_owner(self):
        source=self.write('resource.put_text',resource_id='source',expected_revision='0',title='Source',text='original')['data']
        params=self.publication('old','temporary')
        params['source']={'kind':'resource','pin':{'resource_id':'source','revision':source['version']['revision'],'digest':source['version']['digest']}}
        self.write('ticket.amendment.publish',**params)
        self.write('resource.put_text',resource_id='source',expected_revision=source['revision'],text='changed later')
        current=self.read('ticket.amendment.get',amendment_id='old')['data']['item']
        self.assertEqual(current['content']['publication']['source'],params['source'])
        self.write('ticket.amendment.acknowledge',by='worker',amendment_id='old',expected_revision='1',ticket_id='task',token='1')
        ticket=self.read('ticket.context',ticket_id='task')['data']['ticket']
        self.write('ticket.reassign',ticket_id='task',expected_revision=ticket['revision'],claimant_id='worker',reason='new invocation')
        self.reject('ticket.finish','Blocked',by='worker',ticket_id='task',token='2',evidence='Checked')
        self.write('ticket.amendment.publish',**self.publication('replacement','new',supersedes=[{'amendment_id':'old','revision':'1'}]))
        old=self.read('ticket.amendment.get',amendment_id='old')['data']
        self.assertFalse(old['active'])
        self.assertEqual(old['item']['content']['kind'],'superseded')
        self.write('ticket.amendment.withdraw',amendment_id='replacement',expected_revision='1',reason='explicitly withdrawn')
        self.assertFalse(self.read('ticket.amendment.get',amendment_id='old')['data']['active'])
        self.write('ticket.finish',by='worker',ticket_id='task',token='2',evidence='Checked after withdrawal')
        self.stop();self.start()
        self.assertEqual(len(self.read('ticket.amendment.history',amendment_id='old')['data']['items']),2)
        self.assertEqual(self.read('ticket.amendment.get',amendment_id='old',revision='1')['data']['item']['content']['publication']['source'],params['source'])

if __name__=='__main__':
    unittest.main()
