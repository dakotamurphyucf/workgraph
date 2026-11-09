"""Canonical template publication and atomic placement, actor and role gates."""
import hashlib
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


class Templates(unittest.TestCase):
    def test_publication_graph_gates_exact_retry_and_restart(self):
        with tempfile.TemporaryDirectory(prefix='wg-template-', dir='/tmp') as directory:
            root = Path(directory)
            address = root / 's'
            with (root / 'daemon.log').open('w') as log:
                daemon = None
                def start():
                    nonlocal daemon
                    daemon = subprocess.Popen([EXE, 'serve', str(root / 'registry'), str(address)], stdout=log, stderr=log)
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        self.assertIsNone(daemon.poll())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(.01)
                def stop():
                    if daemon and daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(10)
                start()
                counter = 0
                def cli(*args, expected=0):
                    result = subprocess.run([EXE, *map(str,args)], capture_output=True, timeout=15)
                    self.assertEqual(expected, result.returncode, (args,result.stdout,result.stderr))
                    return json.loads(result.stdout)
                def read(method, **params):
                    return cli('call', address, method, json.dumps(dict(workspace_id='w', **params)))['result']
                def write(method, actor='lead', **params):
                    nonlocal counter
                    counter += 1
                    return cli('call', address, method, json.dumps(dict(workspace_id='w', actor_id=actor, mutation_id='m'+str(counter), **params)))['result']
                def publish(spec, revision, path):
                    return cli('request', address, 'template.publish', '--workspace-id','w','--actor-id','lead','--template-id','plan','--title','Plan','--expected-revision',str(revision),'--json-field','spec',json.dumps(spec),'--save-request',path)['result']
                def ticket(alias, identity='tree'):
                    return 'wi_' + hashlib.sha256((identity + ':' + alias).encode()).hexdigest()[:24]
                try:
                    write('workspace.create', name='Templates', root=str(root/'workspace'))
                    for identifier in ['lead', 'other', 'reviewer']:
                        write('actor.put', target_actor_id=identifier, expected_revision='0', name=identifier, kind='agent')
                    for identifier in ['p','q']:
                        write('project.create', project_id=identifier, title=identifier)
                    write('milestone.create', milestone_id='m', project_id='p', title='Milestone')
                    write('ticket.create', ticket_id='root', project_id='p', title='External parent')
                    write('acceptance.policy.put', scope={'kind':'project','project_id':'p'}, expected_revision='0', enabled=True, reviewers=[{'kind':'actor','actor_id':'other'}], separate_actor=False, validators=[], criteria=[])
                    parent = dict(alias='z-parent', title='Build {{topic}}', description='', depends_on=[], parent=None, capabilities=[], allowed_actor_ids=['lead'], reviewers=[{'kind':'role','name':'review','member_ids':['reviewer']}], separate_actor=True)
                    child = dict(parent, alias='a-child', title='Child', parent='z-parent', depends_on=['z-parent'], allowed_actor_ids=None, reviewers=[], separate_actor=False, capabilities=['ocaml'])
                    spec = dict(parameters=['topic'], nodes=[child,parent])
                    saved = root/'publish.json'
                    first = publish(spec, 0, saved)
                    request = json.loads(saved.read_text())
                    self.assertEqual('transaction.apply', request['method'])
                    operations = request['params']['operations']
                    self.assertEqual(['resource.put_text','template.register'], [op['method'] for op in operations])
                    text = operations[0]['params']['text']
                    self.assertEqual(json.loads(text), operations[1]['params']['spec'])
                    self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), operations[1]['params']['digest'])
                    self.assertEqual('1', operations[1]['params']['template_revision'])
                    self.assertEqual(first, cli('retry',address,saved)['result'])
                    write('resource.update', resource_id='plan', expected_revision='1', title='Metadata edit')
                    second = publish(spec, 2, root/'publish-next.json')
                    self.assertEqual('2', second['data']['results'][0]['data']['version']['revision'])
                    self.assertEqual('2', json.loads((root/'publish-next.json').read_text())['params']['operations'][1]['params']['template_revision'])
                    self.assertEqual('2', read('template.get', template_id='plan', template_revision='2')['data']['template_revision'])
                    args = dict(template_id='plan', template_revision='2', instance_id='tree', parameters={'topic':'parser'}, project_id='p', milestone_id='m', parent_ticket_id='root')
                    def preflight(operations):
                        return read('transaction.preflight', actor_id='lead', operations=operations)['data']
                    before_preview = read('workspace.get')['meta']['workspace_revision']
                    self.assertEqual('7', preflight([dict(method='template.instantiate', params=args)])['operation_count'])
                    self.assertEqual('8', preflight([
                        dict(method='ticket.create', params=dict(ticket_id='preview-only', title='Preview only')),
                        dict(method='template.instantiate', params=args)])['operation_count'])
                    # Earlier publication in the same staged batch must feed actual expansion.
                    inline_publication = [
                        dict(operations[0], params={**operations[0]['params'], 'resource_id':'inline'}),
                        dict(operations[1], params={**operations[1]['params'], 'template_id':'inline'})]
                    self.assertEqual('9', preflight(inline_publication + [dict(
                        method='template.instantiate', params={**args, 'template_id':'inline',
                                                              'template_revision':'1', 'instance_id':'inline'})])['operation_count'])
                    self.assertEqual(before_preview, read('workspace.get')['meta']['workspace_revision'])
                    created = write('template.instantiate', **args)['data']
                    instance = created['instance']
                    self.assertEqual('1', preflight([dict(method='template.instantiate', params=args)])['operation_count'])
                    self.assertEqual('2', preflight([dict(method='template.instantiate', params=args)] * 2)['operation_count'])
                    self.assertEqual(['z-parent','a-child'], [node['alias'] for node in instance['tickets']])
                    self.assertEqual(dict(project_id='p', milestone_id='m', parent_ticket_id='root'), instance['bindings'])
                    for alias, parent_id in [('z-parent','root'),('a-child',ticket('z-parent'))]:
                        current = read('ticket.read', ticket_id=ticket(alias))['data']['ticket']
                        self.assertEqual(('p','m',parent_id), (current['project_id'],current['milestone_id'],current['parent_ticket_id']))
                    policy = next(policy for policy in read('allocation.ticket_policies')['data']['items'] if policy['ticket_id'] == ticket('z-parent'))
                    self.assertEqual([], policy['required_capabilities'])
                    self.assertEqual(['lead'], policy['allowed_actor_ids'])
                    local = read('review.policy.get', ticket_id=ticket('z-parent'))['data']
                    self.assertEqual(parent['reviewers'], local['reviewers'])
                    self.assertTrue(local['separate_actor'])
                    write('run.register', actor='other', target_run_id='other-run', objective='Rejected actor')
                    counter += 1
                    error = cli('call',address,'ticket.claim',json.dumps(dict(workspace_id='w',actor_id='other',run_id='other-run',mutation_id='m'+str(counter),ticket_id=ticket('z-parent'))),expected=1)
                    self.assertEqual('Blocked',error['error']['data']['kind'])
                    # Same instance identity cannot be rebound to another project.
                    counter += 1
                    error = cli('call',address,'template.instantiate',json.dumps(dict(workspace_id='w',actor_id='lead',mutation_id='m'+str(counter),**{**{key:value for key,value in args.items() if key not in ['milestone_id','parent_ticket_id']},'project_id':'q'})),expected=1)
                    self.assertEqual('Idempotency_conflict',error['error']['data']['kind'])
                    # A later normal edit is independent from initial registration.
                    current = read('ticket.read',ticket_id=ticket('z-parent'))['data']['ticket']
                    write('ticket.update', ticket_id=ticket('z-parent'), expected_revision=current['revision'], title='Later edit')
                    write('allocation.ticket_policy_put', ticket_id=ticket('z-parent'), expected_revision='1', required_capabilities=[], pools=[], allowed_actor_ids=None)
                    self.assertEqual('Later edit',read('ticket.read',ticket_id=ticket('z-parent'))['data']['ticket']['title'])
                    #127 plain nodes plus instance registration exactly fill the128-operation cap.
                    large_nodes = [dict(parent, alias='bulk-' + str(i), title='Bulk ' + str(i),
                                        depends_on=[], parent=None, capabilities=[], allowed_actor_ids=None,
                                        reviewers=[], separate_actor=False) for i in range(127)]
                    publish(dict(parameters=[], nodes=large_nodes), 3, root/'publish-large.json')
                    bulk_args = dict(template_id='plan', template_revision='3', instance_id='bulk', parameters={})
                    revision = read('workspace.get')['meta']['workspace_revision']
                    self.assertEqual('128', preflight([dict(method='template.instantiate', params=bulk_args)])['operation_count'])
                    counter += 1
                    rejected_preview = cli('call', address, 'transaction.preflight', json.dumps(dict(
                        workspace_id='w', actor_id='lead', operations=[
                            dict(method='template.instantiate', params=bulk_args),
                            dict(method='ticket.create', params=dict(ticket_id='preview-too-many', title='Too many'))])), expected=1)
                    self.assertEqual('Invalid_argument', rejected_preview['error']['data']['kind'])
                    self.assertEqual(revision, read('workspace.get')['meta']['workspace_revision'])
                    # An extra operation beside a full expansion must reject atomically.
                    counter += 1
                    rejected = cli('call', address, 'transaction.apply', json.dumps(dict(
                        workspace_id='w', actor_id='lead', mutation_id='m'+str(counter), operations=[
                            dict(method='template.instantiate', params=bulk_args),
                            dict(method='ticket.create', params=dict(ticket_id='too-many', title='Too many'))])), expected=1)
                    self.assertEqual('Invalid_argument', rejected['error']['data']['kind'])
                    self.assertEqual(revision, read('workspace.get')['meta']['workspace_revision'])
                    bulk = write('template.instantiate', **bulk_args)['data']
                    self.assertEqual(127, len(bulk['instance']['tickets']))
                    self.assertEqual(128, len(bulk['results']))
                    stop()
                    start()
                    self.assertEqual(bulk['instance'], read('template.instance_get', instance_id='bulk')['data'])
                    self.assertEqual(instance,read('template.instance_get',instance_id='tree')['data'])
                    self.assertEqual('Later edit',read('ticket.read',ticket_id=ticket('z-parent'))['data']['ticket']['title'])
                    self.assertIn(b'exact native expanded operation count',subprocess.check_output([EXE,'help','transaction.preflight']))
                    self.assertIn(b'CONTENT version',subprocess.check_output([EXE,'help','template.register']))
                    self.assertIn(b'single read-only',subprocess.check_output([EXE,'help','template.publish']))
                    self.assertIn(b'template.publish',subprocess.check_output([EXE,'help','template']))
                finally:
                    stop()


if __name__ == '__main__': unittest.main()
