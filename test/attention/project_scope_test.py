"""Project-linked communication remains discoverable without consuming delivery."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location(
    'adapter', Path(__file__).resolve().parents[2] / 'examples/history-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
BOB = {'kind': 'actor', 'id': 'bob'}


class ProjectScopeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-project-scope-', dir='/tmp')
        self.root = Path(self.temporary.name)
        self.address = self.root / 'socket'
        self.log = (self.root / 'daemon.log').open('w+')
        self.daemon = None
        self.addCleanup(self.cleanup)
        self.serial = 0
        self.start()
        self.write('workspace.create', name='Scope', root=str(self.root / 'workspace'))
        for project in ['selected', 'other']:
            self.write('project.create', project_id=project, title=project)
            self.write('ticket.create', ticket_id='t-' + project, project_id=project, title=project)
            self.write('milestone.create', milestone_id='m-' + project, project_id=project, title=project)
        self.write('board.put', board_id='board', expected_revision='0',
                   scope={'kind': 'workspace'}, title='Workspace board')
        for kind, identifier in [('ticket', 't-selected'), ('milestone', 'm-selected'),
                                 ('project', 'selected'), ('milestone', 'm-other')]:
            self.question(identifier, [{'kind': kind, 'id': identifier}])
        self.question('unlinked', [])
        for project in ['selected', 'other']:
            self.write('board.put', board_id=project, expected_revision='0',
                       scope={'kind': 'project', 'id': project}, title=project)
        self.question('selected-board', [], board='selected')
        self.question('other-board', [{'kind': 'ticket', 'id': 't-selected'}], board='other')

    def start(self):
        self.daemon = subprocess.Popen(
            [str(EXE), 'serve', str(self.root / 'registry'), str(self.address)],
            stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not is_listening(self.address):
            if self.daemon.poll() is not None or time.monotonic() > deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.01)
        self.client = adapter.Workgraph(self.address)

    def cleanup(self):
        if self.daemon is not None and self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(timeout=10)
        self.log.close()
        self.temporary.cleanup()

    def read(self, method, **params):
        return self.client.call(method, {'workspace_id': 'scope', **params})['data']

    def write(self, method, **params):
        self.serial += 1
        return self.read(method, actor_id='alice', mutation_id='m-' + str(self.serial), **params)

    def question(self, identifier, links, board='board'):
        self.write('thread.put', thread_id=identifier, expected_revision='0',
                   board_id=board, title=identifier, state='open', links=links)
        target = {'kind': 'workspace'} if board == 'board' else {'kind': 'project', 'id': board}
        self.write('comment.add', comment_id=identifier, target=target, body='Question')
        self.write('thread.attach', thread_id=identifier, expected_revision='1', comment_id=identifier)
        self.write('request.create', request_id=identifier, thread_id=identifier, kind='review',
                   comment_id=identifier, resolver_id='bob', recipients=[BOB])

    def overview(self, **params):
        return self.read('actor.overview', actor_id='bob', consumer_id='reader',
                         project_id='selected', kinds=['request', 'notification'], **params)

    def test_overview_uses_same_project_membership_for_requests_and_notifications(self):
        self.write('message.send', message_id='linked-message', body='Selected',
                   ticket_id='t-selected', recipients=[BOB])
        self.write('message.send', message_id='unlinked-message', body='Workspace', recipients=[BOB])
        inbox_before = self.read('inbox.read', recipient=BOB, consumer_id='reader')['items']
        page = self.overview(limit='1')
        rows = list(page['items'])
        while page['has_more']:
            page = self.overview(limit='1', cursor=page['cursor'])
            rows.extend(page['items'])
        self.assertEqual({'t-selected', 'm-selected', 'selected', 'selected-board'},
                         {r['record']['request_id'] for r in rows if r['kind'] == 'request'})
        notifications = [r['record'] for r in rows if r['kind'] == 'notification']
        self.assertEqual(5, len(notifications))
        selected_ids = {n['notification_id'] for n in notifications}
        self.assertTrue(selected_ids < {n['notification_id'] for n in inbox_before})
        self.assertEqual(inbox_before, self.read('inbox.read', recipient=BOB, consumer_id='reader')['items'])
        self.write('ticket.move', ticket_id='t-selected', expected_revision='1',
                   project_id='other', milestone_id=None, parent_ticket_id=None)
        moved = self.overview()['items']
        self.assertEqual(3, sum(r['kind'] == 'request' for r in moved))
        self.assertEqual(3, sum(r['kind'] == 'notification' for r in moved))
        self.client.call('daemon.shutdown', {})
        self.assertEqual(0, self.daemon.wait(timeout=10))
        self.start()
        self.assertEqual(moved, self.overview()['items'])

    def test_attention_milestone_membership_uses_the_frozen_event_capture(self):
        filters = {'kinds': ['communication'], 'project_id': 'selected',
                   'recipient': BOB, 'consumer_id': 'reader'}
        expected = self.read('attention.read', filter=filters)
        self.assertEqual(4, len(expected['items']))
        first = self.read('attention.read', filter=filters, limit='1')
        self.assertTrue(first['has_more'])
        self.write('thread.put', thread_id='m-selected', expected_revision='2',
                   board_id='board', title='Moved link', state='open',
                   links=[{'kind': 'milestone', 'id': 'm-other'}])
        remainder = self.read('attention.read', filter=filters, cursor=first['cursor'])
        self.assertEqual(expected['through'], remainder['through'])
        self.assertEqual(expected['items'], first['items'] + remainder['items'])
        self.assertEqual(7, len(self.read('inbox.read', recipient=BOB, consumer_id='reader')['items']))


if __name__ == '__main__':
    unittest.main()
