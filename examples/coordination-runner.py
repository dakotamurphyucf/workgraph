#!/usr/bin/env python3
"""External deterministic fork/join runner; injectable public-protocol transport.

Worker routines are scripted. The runner owns failure/replacement and stopping
children; Workgraph records their claims, artifacts, review and cancellation.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location('history_adapter', Path(__file__).with_name('history-adapter.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Runner:
    def __init__(self, client, workspace, state_dir):
        self.client = client
        self.workspace = workspace
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def read(self, method, **params):
        response = adapter.body(self.client.call(method, {'workspace_id': self.workspace, **params}))
        return response.get('record', response)

    def write(self, step, method, *, actor='orchestrator', attribution=None, workspace_scope=True, **params):
        envelope = {'workspace_id': self.workspace} if workspace_scope else {}
        request = {'method': method, 'params': {**envelope,
                   'actor_id': actor, 'mutation_id': 'runner-' + step, **params}}
        if attribution is not None:
            request['params']['run_id'] = attribution
        path = self.state_dir / (step + '.request.json')
        if path.exists():
            if json.loads(path.read_text()) != request:
                raise ValueError('saved step changed: ' + step + '; use a fresh workspace/state directory')
        else:
            adapter.synced_save(path, request)
        response = self.client.call(request['method'], request['params'])
        return response.get('result', adapter.body(response))

    def register(self, actor, run, capability, *, parent=None, cancel=False):
        return self.write('register-' + run, 'run.register', actor=actor,
                          id=run, objective='Scripted ' + capability,
                          capabilities=[capability], **({'parent': parent} if parent is not None else {}),
                          parent_stop_policy=['Request_cancel' if cancel else 'Continue'])

    def claim(self, actor, run, attempt, ticket):
        selected = self.write('claim-' + attempt, 'ticket.claim_next', actor=actor,
                              attribution=run, attempt_id=attempt, run=run)
        assert selected['kind'] == 'selected' and selected['claim']['ticket_id'] == ticket, selected
        return selected['claim']['token']

    def resource(self, name, text, *, revision='0', actor='orchestrator', run=None):
        self.write('resource-' + name + '-' + revision, 'resource.put_text', actor=actor,
                   attribution=run, resource_id=name, expected_revision=revision, title=name, text=text)
        return {'id': name, 'revision': str(int(revision) + 1), 'digest': digest(text)}

    def transition(self, actor, run, status):
        record = self.read('run.get', id=run)
        self.write('transition-' + run + '-' + status, 'run.transition', actor=actor, attribution=run,
                   id=run, expected_revision=record['revision'], status=[status],
                   evidence='Scripted runner observed ' + status)

    def complete(self, actor, run, ticket, token, evidence):
        self.write('complete-' + ticket, 'ticket.complete', actor=actor, attribution=run,
                   ticket_id=ticket, token=token, evidence=evidence)
        self.transition(actor, run, 'Completed')


def run(client, *, workspace, root, state_dir):
    """Create a fresh workspace and execute the deterministic external workflow."""
    runner = Runner(client, workspace, state_dir)
    w = runner.write
    w('workspace', 'workspace.create', name='External fork/join fixture', root=str(Path(root).resolve()))
    nodes = []
    for alias, dependencies in [('left', []), ('right', []), ('join', ['left', 'right'])]:
        nodes.append({'alias': alias, 'title': '{{name}} ' + alias, 'description': 'Deterministic worker routine',
                      'depends_on': dependencies, 'parent': None, 'capabilities': [alias],
                      'reviewers': ['reviewer'] if alias == 'join' else [],
                      'separate_actor': alias == 'join'})
    template = {'parameters': ['name'], 'nodes': nodes}
    text = adapter.canonical(template)
    runner.resource('fork-join-template', text)
    w('template', 'template.register', resource='fork-join-template', resource_revision='1',
      digest=digest(text), spec=template)
    w('instantiate', 'template.instantiate', template='fork-join-template', template_revision='1',
      id='fork-join', parameters={'name': 'fixture'})
    instance = runner.read('template.instance_get', id='fork-join')
    tickets = {node['alias']: node['ticket'] for node in instance['tickets']}
    runner.register('orchestrator', 'parent', 'join')
    w('session', 'session.create', actor='orchestrator', attribution='parent', session_id='runner-conversation',
      title='Fork join instructions', scopes=[{'kind': 'workspace'}])
    event = adapter.event_from_line(adapter.canonical({'source_id': 'join-requirement', 'role': 'user',
                                      'payload': {'text': 'Combine LEFT and RIGHT'},
                                      'searchable_text': 'Combine LEFT and RIGHT'}), 0)
    w('record-requirement', 'session.append', actor='orchestrator', attribution='parent',
      session_id='runner-conversation', events=[event])
    w('link-session', 'run.link_session', actor='orchestrator', attribution='parent',
      id='parent', expected_revision='1', session='runner-conversation')
    runner.register('left-worker', 'left-run', 'left', parent='parent')
    runner.register('right-worker', 'right-failed', 'right', parent='parent')
    left = runner.claim('left-worker', 'left-run', 'left-attempt', tickets['left'])
    right = runner.claim('right-worker', 'right-failed', 'right-failed-attempt', tickets['right'])
    blocked_join = w('join-before-ready', 'ticket.claim_next', actor='orchestrator', attribution='parent',
                     attempt_id='premature-join', run='parent')
    assert blocked_join['kind'] == 'empty', blocked_join
    # Both child routines hold claims before either finishes. Inject failure,
    # record it, release ownership, and invoke the replacement routine.
    attempt = runner.read('attempt.get', id='right-failed-attempt')
    w('failed-attempt', 'attempt.finish', actor='right-worker', attribution='right-failed',
      id='right-failed-attempt', expected_revision=attempt['revision'], state=['Failed'],
      evidence='External runner injected a child failure before publishing output')
    runner.transition('right-worker', 'right-failed', 'Failed')
    w('release-failed', 'ticket.release', actor='right-worker', attribution='right-failed',
      ticket_id=tickets['right'], token=right)
    runner.register('replacement', 'right-replacement', 'right', parent='parent')
    replaced = runner.claim('replacement', 'right-replacement', 'right-attempt', tickets['right'])
    assert int(replaced) > int(right), (right, replaced)
    left_pin = runner.resource('left-output', 'LEFT', actor='left-worker', run='left-run')
    right_pin = runner.resource('right-output', 'RIGHT', actor='replacement', run='right-replacement')
    child_schema = runner.resource('child-schema', 'A child produces one exact output')
    w('child-contract', 'contract.put', id='child-contract', expected_revision='0', schema_version='1',
      schema=child_schema, required_inputs=[], required_outputs=['output'])
    for alias, actor, run_id, attempt_id, pin in [
            ('left', 'left-worker', 'left-run', 'left-attempt', left_pin),
            ('right', 'replacement', 'right-replacement', 'right-attempt', right_pin)]:
        w(alias + '-manifest', 'manifest.publish', actor=actor, attribution=run_id,
          id=alias + '-manifest', expected_revision='0', schema_version='1', attempt=attempt_id,
          ticket=tickets[alias], contract={'id': 'child-contract', 'revision': '1'}, inputs=[],
          outputs=[{'name': 'output', 'pin': ['Resource', pin]}])
    runner.complete('left-worker', 'left-run', tickets['left'], left, 'Published exact left-output v1')
    runner.complete('replacement', 'right-replacement', tickets['right'], replaced, 'Published exact right-output v1')
    joined = runner.claim('orchestrator', 'parent', 'join-attempt', tickets['join'])
    schema = runner.resource('artifact-schema', 'Join requires left and right inputs and one combined output')
    w('contract', 'contract.put', id='join-contract', expected_revision='0', schema_version='1',
      schema=schema, required_inputs=['left', 'right', 'conversation'], required_outputs=['combined'])
    output = runner.resource('join-output', 'LEFT+WRONG', actor='orchestrator', run='parent')
    w('board', 'board.put', board_id='runner-board', expected_revision='0', scope={'kind': 'workspace'}, title='Runner review')
    w('thread', 'thread.put', thread_id='join-thread', expected_revision='0', board_id='runner-board',
      title='Join review', participants=[], mentions=[], links=[{'kind': 'ticket', 'id': tickets['join']}],
      state='open', pinned=False)
    w('review-message', 'thread.reply', thread_id='join-thread', expected_revision='1',
      comment_id='review-message', kind='comment', body='Review exact join artifact; reject WRONG and approve corrected output')
    w('review-request', 'request.create', request_id='join-review', thread_id='join-thread', kind='review',
      comment_id='review-message', recipients=[{'kind': 'actor', 'id': 'reviewer'}], teams=[], resolver_id='reviewer')
    runner.register('reviewer', 'reviewer-run', 'review', parent='parent')
    w('accept-review', 'request.accept', actor='reviewer', attribution='reviewer-run', request_id='join-review',
      expected_revision='1', recipient={'kind': 'actor', 'id': 'reviewer'})
    inputs = [{'name': 'left', 'pin': ['Resource', left_pin]}, {'name': 'right', 'pin': ['Resource', right_pin]},
              {'name': 'conversation', 'pin': ['Event', {'session_id': 'runner-conversation', 'sequence': '1'}]}]
    def publish(revision, output_pin):
        w('manifest-' + revision, 'manifest.publish', actor='orchestrator', attribution='parent',
          id='join-manifest', expected_revision=revision, schema_version='1', attempt='join-attempt',
          ticket=tickets['join'], contract={'id': 'join-contract', 'revision': '1'}, inputs=inputs,
          outputs=[{'name': 'combined', 'pin': ['Resource', output_pin]}])
    def submit(step, manifest_revision):
        expected = '0' if manifest_revision == '1' else runner.read('review.submission.get', ticket_id=tickets['join'])['revision']
        w(step, 'review.submit', actor='orchestrator', attribution='parent', ticket=tickets['join'],
          expected_revision=expected, manifest={'id': 'join-manifest', 'revision': manifest_revision}, review_request='join-review')
        return runner.read('review.submission.get', ticket_id=tickets['join'])
    publish('0', output)
    submission = submit('submit-first', '1')
    reviewed = runner.read('resource.read_chunk', resource_id=output['id'], version=output['revision'], offset='0', length='4096')
    assert reviewed['digest'] == output['digest'] and base64.b64decode(reviewed['data_base64']) == b'LEFT+WRONG', reviewed
    w('reject', 'review.record', actor='reviewer', attribution='reviewer-run', id='rejected-review',
      ticket=tickets['join'], generation=submission['generation'], verdict=['Request_changes'],
      evidence='Pinned output is LEFT+WRONG, expected LEFT+RIGHT', comment=None)
    output = runner.resource('join-output', 'LEFT+RIGHT', revision='1', actor='orchestrator', run='parent')
    publish('1', output)
    submission = submit('submit-corrected', '2')
    assert int(submission['generation']) == 2, submission
    reviewed = runner.read('resource.read_chunk', resource_id=output['id'], version=output['revision'], offset='0', length='4096')
    assert reviewed['digest'] == output['digest'] and base64.b64decode(reviewed['data_base64']) == b'LEFT+RIGHT', reviewed
    w('approve', 'review.record', actor='reviewer', attribution='reviewer-run', id='approved-review',
      ticket=tickets['join'], generation=submission['generation'], verdict=['Approve'],
      evidence='Reviewed exact join-output v2 digest ' + output['digest'], comment=None)
    submission = runner.read('review.submission.get', ticket_id=tickets['join'])
    w('accept-join', 'review.accept', actor='orchestrator', attribution='parent', ticket=tickets['join'], expected_revision=submission['revision'])
    request = runner.read('request.get', request_id='join-review')
    w('resolve-review', 'request.resolve', actor='reviewer', attribution='reviewer-run', request_id='join-review', expected_revision=request['revision'])
    runner.transition('reviewer', 'reviewer-run', 'Completed')
    runner.complete('orchestrator', 'parent', tickets['join'], joined, 'Accepted manifest v2 with exact left/right inputs and reviewed output')
    # The service requests cancellation; the external runner stops the child
    # routine and acknowledges that action. It does not imply forced termination.
    runner.register('canceller', 'cancel-parent', 'cancel')
    runner.register('cancel-child', 'cancel-child', 'cancel', parent='cancel-parent', cancel=True)
    runner.transition('canceller', 'cancel-parent', 'Cancelled')
    actions = runner.read('run.actions')['items']
    action = next(action for action in actions if action['child'] == 'cancel-child')
    assert action['policy'] == ['Request_cancel'], action
    runner.transition('cancel-child', 'cancel-child', 'Cancelled')
    w('ack-cancel', 'run.action_acknowledge', actor='cancel-child', attribution='cancel-child',
      child='cancel-child', evidence='External runner stopped the deterministic child routine')
    assert not any(action['child'] == 'cancel-child' for action in runner.read('run.actions')['items'])
    def retained_state():
        return {'parent': runner.read('run.get', id='parent'),
                'attempt': runner.read('attempt.get', id='join-attempt'),
                'failed_attempt': runner.read('attempt.get', id='right-failed-attempt'),
                'manifest': runner.read('manifest.get', id='join-manifest'),
                'submission': runner.read('review.submission.get', ticket_id=tickets['join']),
                'reviews': runner.read('review.list', ticket_id=tickets['join']),
                'request': runner.read('request.get', request_id='join-review'),
                'thread': runner.read('thread.get', thread_id='join-thread'),
                'history': runner.read('history.get', ref={'session_id': 'runner-conversation', 'sequence': '1'}),
                'output': runner.read('resource.read_chunk', resource_id=output['id'], version=output['revision'], offset='0', length='4096')}
    before = retained_state()
    w('close-before-reopen', 'workspace.close')
    w('reopen', 'workspace.open')
    assert retained_state() == before, 'reopen changed retained coordination/history state'
    destination = Path(root).resolve().parent / 'coordination-export'
    exported = w('export', 'workspace.export', destination=str(destination))
    deadline = time.monotonic() + 15
    while exported['status'] == 'running':
        if time.monotonic() > deadline:
            raise TimeoutError('coordination export did not finish')
        time.sleep(0.01)
        exported = client.call('export.get', {'job_id': exported['job_id']})
    assert exported['status'] == 'completed', exported
    w('close-before-restore', 'workspace.close')
    w('unregister', 'workspace.unregister')
    w('restore', 'workspace.restore', workspace_scope=False, directory=str(destination),
      root=str(Path(root).resolve().parent / 'coordination-restored'))
    w('open-restored', 'workspace.open')
    assert retained_state() == before, 'portable restore changed retained coordination/history state'
    return {'forked_children': 2, 'join_waited_for_both': True, 'failed_child_replaced': True,
            'review_rejected_then_approved_generation': 2, 'accepted_output': output,
            'runner_cancelled_child_and_acknowledged': True, 'reopen_export_restore_preserved_state': True,
            'tickets': tickets}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('socket')
    parser.add_argument('--workspace', default='fork-join-demo')
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    args = parser.parse_args()
    print(adapter.canonical(run(adapter.Workgraph(args.socket), workspace=args.workspace,
                                root=args.root, state_dir=args.state_dir)))


if __name__ == '__main__':
    main()
