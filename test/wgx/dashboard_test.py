"""Interactive viewer regressions: actual reads, partial coverage, state and PTY."""
import dataclasses
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import unittest

import guide_test as guide
ROOT, EXE = guide.ROOT, guide.EXE
spec = importlib.util.spec_from_file_location('wgx_dashboard', ROOT/'skills/workgraph/scripts/wgx_dashboard.py')
dash = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dash
spec.loader.exec_module(dash)


class Dashboard(unittest.TestCase):
    setUp, stop, call, write = guide.Daemon.setUp, guide.Daemon.stop, guide.Daemon.call, guide.Daemon.write

    def client(self, run=None):
        client = dash.Client(EXE, str(self.context), run)
        self.addCleanup(client.close)
        return client

    def sample(self):
        self.write('ticket.create', ticket_id='upstream', title='Backend implementation')
        self.write('ticket.create', ticket_id='dependent', title='Integration with café 界面')
        self.write('dependency.add', ticket_id='dependent', prerequisite_id='upstream')
        self.write('request.ask', request_id='review', kind='review', title='Please review the contract', body='Does this cover retries?', resolver_id='lead', ticket_id='upstream', recipients=[{'kind':'actor','id':'lead'}])
        started = self.write('ticket.start', ticket_id='upstream')
        self.write('ticket.amendment.publish', ticket_id='upstream', amendment_id='instructions', expected_revision='0', title='Include retry coverage', require_ack=True, source={'kind':'text','body':'Test duplicate requests'})
        return started['data']['token']

    def test_real_snapshot_attention_exact_blockers_details_and_no_writes(self):
        self.sample()
        before = self.call('workspace.overview')
        inbox = self.call('inbox.read',recipient={'kind':'actor','id':'lead'},consumer_id='viewer')
        journals = list((self.root/'requests').iterdir())
        client = self.client()
        snapshot = client.snapshot()
        view = dash.View('w'); view.accept(snapshot)
        attention = '\n'.join(' '.join(item[:2]) for item in view.attention())
        self.assertIn('Review requested', attention)
        self.assertIn('Acknowledge updated instructions', attention)
        self.assertIn('lead', attention)
        view.switch_tab('Tasks')
        self.assertIn('Waiting for upstream', '\n'.join(row.text for row in view.rows()))
        data, warnings = client.detail(('ticket','upstream'), snapshot)
        self.assertFalse(warnings)
        self.assertIn('PENDING ACKNOWLEDGEMENTS', '\n'.join(r.text for r in dash.detail_rows(('ticket','upstream'),data,warnings)))
        data, warnings = client.detail(('request','review'), snapshot)
        self.assertIn('Does this cover retries?', json.dumps(data))
        view.actor='lead'
        self.assertEqual(len(view.attention()),1)
        view.query='nothing matches'
        self.assertEqual(view.attention(),[])
        self.assertEqual(self.call('workspace.overview'), before)
        self.assertEqual(self.call('inbox.read',recipient={'kind':'actor','id':'lead'},consumer_id='viewer'), inbox)
        self.assertEqual(list((self.root/'requests').iterdir()), journals)
        with self.assertRaises(ValueError):
            client.call('ticket.finish', ticket_id='upstream')

    def test_partial_enrichment_pause_highlights_and_nested_back(self):
        for n in range(10):
            self.write('ticket.create',ticket_id=f't{n}',title=f'Task {n}')
        client = self.client()
        first = client.snapshot()
        self.assertEqual(len(first.checks),8)
        view=dash.View('w');view.accept(first)
        self.assertIn('Exact checks: 8/10', '\n'.join(row.text for row in view.status_rows()))
        second = client.snapshot()
        self.assertEqual(len(second.checks),10)
        view.accept(second)
        self.assertEqual(view.changes,set())  # enrichment is not a workspace mutation
        view.toggle_pause()
        self.write('ticket.create',ticket_id='new',title='New while paused')
        latest=client.snapshot();view.accept(latest)
        self.assertEqual(len(view.snapshot.tickets),10)
        self.assertIn('1 records changed since pause', '\n'.join(row.text for row in view.header(120)))
        view.toggle_pause()
        self.assertEqual(len(view.snapshot.tickets),11)
        self.assertEqual(view.changes,{('ticket','new')})
        view.selected, view.offset=7,4
        view.open_overlay('tree',[dash.Row('tree')]);view.selected=2
        view.open_overlay('detail',[dash.Row('detail')]);view.back()
        self.assertEqual((view.overlay,view.selected),('tree',2))
        view.back()
        self.assertEqual((view.overlay,view.selected,view.offset),(None,7,4))

    def test_filters_collapse_and_paused_change_then_revert_are_visible(self):
        self.sample()
        view=dash.View('w');snapshot=self.client().snapshot();view.accept(snapshot)
        view.collapsed.add('work')
        self.assertFalse(any(row.section=='work' and row.entity==('ticket','upstream') for row in view.rows()))
        view.switch_tab('Questions')
        self.assertFalse(any(row.section=='blocked' for row in view.rows()))
        self.assertTrue(any(row.entity==('request','review') for row in view.rows()))
        view.switch_tab('Agents');view.hide_inactive=True
        view.snapshot=dataclasses.replace(snapshot,runs=[{'run_id':'finished','actor_id':'ci','status':'completed'}, {'run_id':'running','actor_id':'ci','status':'running'}])
        self.assertFalse(any(row.entity==('run','finished') for row in view.rows()))
        self.assertTrue(any(row.entity==('run','running') for row in view.rows()))
        view.snapshot=snapshot
        view.toggle_pause()
        changed=dataclasses.replace(snapshot,tickets=[{**t,'title':'Changed'} if t['ticket_id']=='upstream' else t for t in snapshot.tickets])
        view.accept(changed);view.accept(snapshot)
        self.assertEqual(view.pause_changes,{('ticket','upstream')})
        view.toggle_pause()
        self.assertEqual(view.changes,{('ticket','upstream')})

    def test_quit_during_slow_read_is_responsive_and_restores_terminal(self):
        proxy=self.root/'slow-proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n')
        proxy.chmod(0o755)
        process,master,slave,before=self.start_ui(str(proxy))
        self.until(process,master,b'Connecting to Workgraph')
        started=time.monotonic();os.write(master,b'q')
        deadline=started+4
        while process.poll() is None and time.monotonic()<deadline:
            if select.select([master],[],[],.1)[0]: guide.read_pty(master)
        process.wait(timeout=max(.01,deadline-time.monotonic()))
        self.assertEqual(process.returncode,0)
        self.assertLess(time.monotonic()-started,4)
        self.assertEqual(guide.terminal_modes(master),before)

    def test_calm_overview_tabs_and_stable_item_selection_after_wrap_and_insert(self):
        self.sample()
        snapshot=self.client().snapshot();view=dash.View('w');view.accept(snapshot)
        header='\n'.join(row.text for row in view.header(100))
        self.assertNotIn('capture',header)
        self.assertNotIn('Exact checks',header)
        self.assertNotIn('Please review the contract',header)
        overview='\n'.join(row.text for row in view.rows())
        self.assertEqual(overview.count('Please review the contract'),1)
        for noise in ['token', 'STORAGE', 'FILE RESERVATIONS', 'working 1', 'RUNS']:
            self.assertNotIn(noise,overview)
        rows=dash.physical_rows(view.rows(),35);view.layout(rows,12)
        first=rows[view.selected].entity
        view.navigate('j',rows,12)
        selected=rows[view.selected].entity
        self.assertNotEqual(selected,first)
        self.assertEqual(selected,('ticket','upstream'))
        anchor=view.anchor
        changed=dataclasses.replace(snapshot,threads={key:{**value,'title':'A much longer question with enough words to wrap onto several lines'} for key,value in snapshot.threads.items()})
        view.accept(changed)
        resized=dash.physical_rows(view.rows(),22);view.layout(resized,10)
        self.assertEqual(view.anchor,anchor)
        self.assertEqual(resized[view.selected].entity,selected)
        # Restoring a tab preserves the same item, not its old wrapped line number.
        view.switch_tab('Agents');view.layout(dash.physical_rows(view.rows(),22),10)
        view.switch_tab('Overview');view.layout(resized,10)
        self.assertEqual(view.anchor,anchor)
        view.switch_tab('Tasks')
        self.assertIn('Waiting for upstream','\n'.join(row.text for row in view.rows()))
        view.switch_tab('Questions')
        self.assertIn('Review requested','\n'.join(row.text for row in view.rows()))
        self.assertNotIn('IN PROGRESS','\n'.join(row.text for row in view.rows()))

    def test_graph_shared_nodes_missing_nodes_cycles_and_terminal_cells(self):
        tickets=[{'ticket_id':key,'status':'todo','prerequisite_ticket_ids':prereqs} for key,prereqs in [('root',['a','b','missing']),('a',['shared']),('b',['shared']),('shared',['root'])]]
        rows=dash.graph_rows(tickets,'root')
        text='\n'.join(r.text for r in rows)
        self.assertIn('already shown',text)
        self.assertIn('not in this capture',text)
        self.assertIn('3 downstream tickets',text)
        self.assertLess(len(rows),12)
        self.assertIn('limited to',dash.graph_rows(tickets,'root',limit=3)[-1].text)
        wrapped=dash.wrap('café 界面 e\u0301\x1b[2J\u202e',8)
        self.assertTrue(all(sum(dash.cell_width(c) for c in row)<=8 for row in wrapped))
        self.assertNotIn('\x1b',''.join(wrapped));self.assertIn('\\u001b',''.join(wrapped))
        self.assertEqual(dash.wrap('e\u0301',1),['e\u0301'])

    def start_ui(self, executable=EXE, width=90):
        master,slave=pty.openpty()
        self.addCleanup(os.close,master);self.addCleanup(os.close,slave)
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,width,0,0))
        before=guide.terminal_modes(master)
        process=subprocess.Popen(['/bin/bash',str(ROOT/'skills/workgraph/scripts/wgx.sh'),'--context',str(self.context),'dash'],stdin=slave,stdout=slave,stderr=slave,preexec_fn=guide.foreground_session,
                                 env={**os.environ,'WG':executable,'TERM':'xterm','NO_COLOR':'','WGX_COLOR':'auto'})
        self.addCleanup(guide.stop_pty_job,process)
        return process,master,slave,before

    def until(self, process, master, needle, timeout=15):
        data=b'';deadline=time.monotonic()+timeout
        needles = (needle,) if isinstance(needle,bytes) else needle
        while any(marker not in data for marker in needles):
            self.assertIsNone(process.poll(),data[-2000:])
            self.assertLess(time.monotonic(),deadline,data[-2000:])
            if select.select([master],[],[],.1)[0]:
                data+=guide.read_pty(master)
        return data

    def test_pty_navigation_pause_resize_and_reconnect_keep_last_data(self):
        self.sample()
        flag=self.root/'unavailable';proxy=self.root/'proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport os,sys\nfrom pathlib import Path\nif Path('+repr(str(flag))+').exists():\n print("temporarily unavailable",file=sys.stderr);sys.exit(1)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        process,master,slave,before=self.start_ui(str(proxy))
        first=self.until(process,master,b'Review requested')
        self.assertIn(b'\x1b[48;5;234m',first)  # charcoal canvas stays inside the dashboard
        self.assertIn(b'\x1b[38;5;104m',first)  # indigo request status on charcoal
        os.write(master,b'\t')
        self.until(process,master,(b'[Tasks]', b'Waiting for upstream'))
        os.write(master,b'\x1b[Z')
        self.until(process,master,b'[Overview]')
        os.write(master,b'i')
        self.until(process,master,(b'VIEW STATUS', b'Planning capture:'))
        os.write(master,b'\x1b')
        self.until(process,master,b'NEEDS YOUR ATTENTION')
        os.write(master,b'/Backend\r')
        self.until(process,master,b'Search: Backend')
        os.write(master,b'\r')
        self.until(process,master,b'START REQUIREMENTS')
        os.write(master,b'\x1b')
        self.until(process,master,b'IN PROGRESS')
        os.write(master,b'p')
        self.until(process,master,b'Paused')
        self.write('ticket.create',ticket_id='paused-new',title='Added while paused')
        self.until(process,master,b'1 records changed since pause')
        os.write(master,b'p')
        self.until(process,master,b'Connected')
        flag.touch();os.write(master,b'r')
        stale=self.until(process,master,b'STALE / RECONNECTING')
        self.assertIn(b'Backend',stale)
        flag.unlink();os.write(master,b'r')
        self.until(process,master,b'Connected',timeout=20)
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',18,40,0,0))
        os.killpg(process.pid,signal.SIGWINCH)
        self.until(process,master,b'\x1b[18;1H')
        os.write(master,b'q')
        deadline=time.monotonic()+5
        while process.poll() is None and time.monotonic()<deadline:
            if select.select([master],[],[],.1)[0]: guide.read_pty(master)
        process.wait(timeout=max(.01,deadline-time.monotonic()))
        self.assertEqual(process.returncode,0)
        self.assertEqual(guide.terminal_modes(master),before)


if __name__=='__main__':
    unittest.main()
