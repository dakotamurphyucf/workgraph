"""Current-candidate helper qualification beyond the original guide scripts."""
import base64
import json
import os
import fcntl
import pty
import re
import select
import signal
import struct
import termios
from pathlib import Path
import subprocess
import sys
import time
import unittest

# The existing guide fixture owns daemon setup/teardown only; avoid inheriting
# its test cases and rerunning them for each additional helper scenario.
import guide_test as guide
ROOT, EXE = guide.ROOT, guide.EXE


class Helper(unittest.TestCase):
    setUp, stop, call, write = guide.Daemon.setUp, guide.Daemon.stop, guide.Daemon.call, guide.Daemon.write

    def helper(self, *args, expected=0, env=None, executable=None, timeout=30):
        result = subprocess.run(['/bin/bash',str(ROOT/'skills/workgraph/scripts/wgx.sh'),'--context',str(self.context),*map(str,args)],
            env={**os.environ,'WG':executable or EXE,'NO_COLOR':'1',**(env or {})},capture_output=True,timeout=timeout)
        if expected is not None:
            self.assertEqual(result.returncode,expected,(args,result.stdout,result.stderr))
        return result

    def batch(self, operations):
        for offset in range(0,len(operations),32):
            self.write('transaction.apply',operations=operations[offset:offset+32])

    def test_over_100_rows_in_all_collection_panels_and_exact_no_write(self):
        self.write('ticket.create',ticket_id='t',title='Detailed task')
        operations=[]
        for n in range(105):
            operations += [
                {'method':'ticket.create','params':{'ticket_id':f't{n:03}','title':f'Title {n} café \u001b[2J'}},
                {'method':'run.register','params':{'target_run_id':f'r{n:03}','objective':'Reported state'}},
                {'method':'request.ask','params':{'request_id':f'q{n:03}','title':f'Question {n}','body':f'Question body {n}','resolver_id':'ci','recipients':[{'kind':'actor','id':'ci'}]}},
                {'method':'comment.add','params':{'comment_id':f'c{n:03}','target':{'kind':'ticket','id':'t'},'body':f'Comment marker {n}'}},
                {'method':'resource.put_text','params':{'resource_id':f'f{n:03}','expected_revision':'0','title':f'File {n}','text':'Visible'}},
                {'method':'resource.link','params':{'resource_id':f'f{n:03}','expected_revision':'1','target':{'kind':'ticket','id':'t'}}}
            ]
        self.batch(operations)
        for offset in range(0,105,32):
            self.write('reservation.paths.acquire',target_run_id='r000',requests=[{'target':{'worktree_id':'integration','kind':'file','path':f'src/{n:03}.ml'},'mode':'exclusive'} for n in range(offset,min(offset+32,105))])
        before=self.call('workspace.overview')
        inbox=self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='observer',limit='100')
        for args, last in [(('status',),'t104'),(('questions',),'q104'),(('agents',),'r104'),(('files',),'src/104.ml'),(('ticket','t'),'Comment marker 104'),(('inbox','ci','observer'),'Question body 104')]:
            result=self.helper(*args)
            self.assertIn(last.encode(),result.stdout,args)
            self.assertNotIn(b'\x1b',result.stdout,args)
        self.assertEqual(self.call('workspace.overview'),before)
        self.assertEqual(self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='observer',limit='100'),inbox)
        incomplete=self.helper('questions',expected=1,env={'WGX_MAX_PAGES':'1'})
        self.assertEqual(incomplete.stdout,b'')
        self.assertIn(b'incomplete collection',incomplete.stderr)
        self.assertIn(b'page_limit',incomplete.stderr)
        self.assertIn(b'next_request',incomplete.stderr)
        byte_limited=self.helper('questions',expected=1,env={'WGX_TOTAL_BYTES':'4096'})
        self.assertEqual(byte_limited.stdout,b'')
        self.assertIn(b'byte',byte_limited.stderr)

    def test_readable_dashboard_and_detail_views_keep_context_and_safe_colors(self):
        self.write('ticket.create',ticket_id='prereq',title='First step')
        self.write('ticket.create',ticket_id='task',title='Implement cache \x1b[2J')
        self.write('dependency.add',ticket_id='task',prerequisite_id='prereq')
        self.write('run.register',target_run_id='worker',objective='Implement the cache safely',capabilities=['ocaml'])
        self.write('request.ask',request_id='cache-question',title='Which cache policy?',body='TTL choice',resolver_id='lead',ticket_id='task',recipients=[{'kind':'actor','id':'lead'}])
        self.write('comment.add',comment_id='decision',target={'kind':'ticket','id':'task'},kind='decision',body='Keep cached values immutable')
        before=self.call('workspace.overview')
        status=self.helper('status').stdout
        for expected in [b'Which cache policy?',b'Implement the cache safely',b'declared prerequisites: prereq',b'RECENT',b'Keep cached values immutable',b'KiB',b'[',b'none']:
            self.assertIn(expected,status)
        self.assertNotIn(b'\x1b',status)
        self.assertIn(b'\\u001b[2J',status)
        self.assertIn(b'Which cache policy?',self.helper('questions').stdout)
        self.assertIn(b'Implement the cache safely',self.helper('agents').stdout)
        ticket=self.helper('ticket','task').stdout
        for expected in [b'priority=0',b'blocked by: prereq',b'declared prerequisites: prereq',b'decision',b'ci',b'Keep cached values immutable']:
            self.assertIn(expected,ticket)
        color=self.helper('status',env={'WGX_COLOR':'always','NO_COLOR':''}).stdout
        for code in [b'\x1b[1m',b'\x1b[32m',b'\x1b[33m',b'\x1b[36m',b'\x1b[35m']:
            self.assertIn(code,color)
        self.assertNotIn(b'\x1b[2J',color)
        for env in [{'WGX_COLOR':'always'}, {'WGX_COLOR':'never','NO_COLOR':''}, {'WGX_COLOR':'auto','NO_COLOR':''}]:
            self.assertNotIn(b'\x1b',self.helper('questions',env=env).stdout)
        self.assertEqual(self.call('workspace.overview'),before)

    def test_semantic_watch_uses_digest_capture_and_changes_only_for_wake(self):
        self.write('ticket.create',ticket_id='watched',title='Visible watch work')
        self.write('comment.add',comment_id='watch-decision',target={'kind':'ticket','id':'watched'},kind='decision',body='Use bounded caching')
        log=self.root/'readable-watch-log';proxy=self.root/'readable-watch-proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\np=Path('+repr(str(log))+')\nwith p.open("a") as f: f.write(json.dumps(sys.argv[3:])+"\\n")\nif sys.argv[3]=="changes.wait":\n print(json.dumps({"error":{"message":"deliberate stop"}}));sys.exit(1)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        result=self.helper('watch','--all',expected=1,executable=str(proxy))
        self.assertIn(b'task_changed: Visible watch work',result.stdout)
        self.assertIn(b'decision',result.stdout)
        self.assertIn(b'Use bounded caching',result.stdout)
        self.assertNotIn(b'\x1b',result.stdout)
        calls=[json.loads(line) for line in log.read_text().splitlines()]
        expansion=next(call for call in calls if call[0]=='activity.digest')
        self.assertEqual(expansion[expansion.index('--after')+1],'0')
        self.assertNotIn('--at-revision', expansion)
        wake=next(call for call in calls if call[0]=='changes.wait')
        self.assertEqual(wake[wake.index('--after')+1], '2')
        self.assertNotIn('activity.since', log.read_text())
        self.assertIn(b'retained cursor:',result.stderr)
        # Failed enrichment must not consume its change cursor or proceed to wait.
        proxy.write_text(proxy.read_text().replace('=="changes.wait"','=="activity.digest"'))
        log.unlink()
        failed=self.helper('watch','--all',expected=1,executable=str(proxy))
        self.assertEqual(failed.stdout,b'')
        self.assertIn(b'initial after: 0',failed.stderr)
        self.assertNotIn('changes.wait',log.read_text())

    def test_contention_observation_and_captured_request_summaries_are_read_only(self):
        for run in ['holder', 'waiter']:
            self.write('run.register', target_run_id=run, objective='Database integration')
        target={'kind':'named','reservation_id':'test-db'}
        self.write('reservation.acquire', target_run_id='holder', requests=[{'reservation_id':'test-db','mode':'exclusive'}])
        self.write('reservation.holder_note.put', target=target,target_run_id='holder',token='1',expected_revision='0',action='set',duration_ms='300000',note='Finish database checks',expected_release_unix_ms='500')
        self.write('reservation.waiter.put', target=target,target_run_id='waiter',expected_revision='0',action='begin',duration_ms='300000',note='Needs database')
        self.write('request.ask',request_id='question',title='Captured summary',body='Choose policy',resolver_id='lead',recipients=[{'kind':'actor','id':'lead'}])
        before=self.call('workspace.overview')
        result=self.helper('contention','named','test-db')
        for text in [b'ADVISORY',b'holder ci/holder',b'waiter ci/waiter',b'phase=waiting',b'elapsed_ms=',b'Needs database',b'Finish database checks',b'500',b'lease=',b'no FIFO']:
            self.assertIn(text,result.stdout)
        self.write('reservation.waiter.put',target=target,target_run_id='waiter',expected_revision='1',action='close',reason='Cancelled')
        before=self.call('workspace.overview')
        self.assertIn(b'phase=closed',self.helper('contention','named','test-db').stdout)
        path={'worktree_id':'tree','kind':'subtree','path':'src'}
        self.write('reservation.paths.acquire',target_run_id='holder',requests=[{'target':path,'mode':'exclusive'}])
        self.assertIn(b'holder ci/holder',self.helper('contention','path','tree','file','src/a.ml').stdout)
        before=self.call('workspace.overview')
        agents=self.helper('agents').stdout
        self.assertIn(b'unobserved',agents)
        self.assertIn(b'held_work',agents)
        proxy=self.root/'summary-proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport os,sys\nif sys.argv[3] in ("thread.list","activity.since"):\n raise SystemExit(9)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        self.assertIn(b'Captured summary',self.helper('questions',executable=str(proxy)).stdout)
        self.helper('status',executable=str(proxy))
        self.assertEqual(self.call('workspace.overview'),before)

    def test_large_commit_semantic_excerpts_and_contention_cursor_pages(self):
        self.write('ticket.create',ticket_id='large',title='Semantic excerpts')
        operations=[{'method':'comment.add','params':{'comment_id':f'large{n}','target':{'kind':'ticket','id':'large'},'kind':'decision','body':('decision marker '+str(n)+' ')+'x'*60000}} for n in range(20)]
        params=self.root/'large-commit.json'
        params.write_text(json.dumps({'operations':operations}))
        published=subprocess.run([EXE,'--context',str(self.context),'transaction.apply','--params-file',str(params)],capture_output=True)
        self.assertEqual(published.returncode,0,published.stderr)
        result=self.helper('feed','30')
        self.assertIn(b'decision marker 19',result.stdout)
        self.assertIn(b'[source excerpt]',result.stdout)
        self.assertIn(b'sources=',result.stdout)
        self.assertIn(b'Semantic capture:',result.stderr)
        operations=[]
        target={'kind':'named','reservation_id':'busy-db'}
        for n in range(105):
            operations += [{'method':'run.register','params':{'target_run_id':f'wait{n:03}','objective':'Wait cooperatively'}},
                           {'method':'reservation.waiter.put','params':{'target':target,'target_run_id':f'wait{n:03}','expected_revision':'0','action':'begin','duration_ms':'300000','note':f'wait marker {n}'}}]
        self.batch(operations)
        before=self.call('workspace.overview')
        result=self.helper('contention','named','busy-db')
        self.assertIn(b'wait marker 104',result.stdout)
        failed=self.helper('contention','named','busy-db',expected=1,env={'WGX_MAX_PAGES':'1'})
        self.assertIn(b'restart contention target:',failed.stderr)
        self.assertIn(b'busy-db',failed.stderr)
        self.assertIn(b'diagnostic only',failed.stderr)
        self.assertEqual(failed.stdout,b'')
        self.assertEqual(self.call('workspace.overview'),before)

    def test_buffered_second_page_errors_restart_original_target_or_digest_boundary(self):
        proxy=self.root/'buffered-proxy'
        entry={'workspace_revision':'1','change_index':'0','category':'decision',
               'item':{'summary':'unseen buffered row','clipped_fields':[],'sources':[],'record':{}}}
        packets={'activity.digest':{'entries':[entry],'capture':{'through':'2'},'cursor':'internal-page-two','has_more':True},
                 'reservation.contention':{'items':[{'sentinel':'unseen buffered row'}],'cursor':'internal-page-two','has_more':True,'needs_larger_budget':False}}
        proxy.write_text('#!/usr/bin/env python3\nimport json,sys\nmethod=sys.argv[3]\nif method=="workspace.overview": print(json.dumps({"result":{"data":{},"meta":{"workspace_revision":"2"}}}));raise SystemExit(0)\nif "--cursor" in sys.argv: print(json.dumps({"error":{"message":"independent second page failure"}}));raise SystemExit(1)\npackets='+repr(packets)+'\nprint(json.dumps({"result":{"data":packets[method],"meta":{}}}))\n')
        proxy.chmod(0o755)
        feed=self.helper('feed','100',executable=str(proxy),expected=1)
        self.assertEqual(feed.stdout,b'')
        self.assertIn(b'restart digest after: 0 scope:',feed.stderr)
        self.assertIn(b'failed-page cursor (diagnostic only): internal-page-two',feed.stderr)
        self.assertNotIn(b'retained cursor:',feed.stderr)
        contention=self.helper('contention','named','database',executable=str(proxy),expected=1)
        self.assertEqual(contention.stdout,b'')
        self.assertIn(b'restart contention target:',contention.stderr)
        self.assertIn(b'database',contention.stderr)
        self.assertIn(b'include_inactive=true',contention.stderr)
        self.assertIn(b'diagnostic only',contention.stderr)
        self.assertNotIn(b'retained cursor:',contention.stderr)

    def test_semantic_watch_rejects_stalled_digest_without_wait_or_cursor_loss(self):
        log=self.root/'digest-log';stub=self.root/'digest-stub'
        packet={'entries':[],'capture':{'through':'999999'},'cursor':'start','has_more':True}
        stub.write_text('#!/usr/bin/env python3\nfrom pathlib import Path\nimport json,sys\np=Path('+repr(str(log))+');p.write_text(sys.argv[3])\nprint('+repr(json.dumps({'result':{'data':packet,'meta':{}}}))+')\n')
        stub.chmod(0o755)
        result=self.helper('watch','--cursor','start',executable=str(stub),expected=1)
        self.assertEqual(log.read_text(),'activity.digest')
        self.assertEqual(result.stdout,b'')
        self.assertIn(b'retained cursor: start',result.stderr)

    def test_authoritative_readiness_and_explicit_run_capability_policy(self):
        self.write('project.create',project_id='p',title='Filtered')
        self.write('ticket.create',ticket_id='outside',title='External prerequisite')
        self.write('ticket.create',ticket_id='dependent',project_id='p',title='Wait for external prerequisite')
        self.write('dependency.add',ticket_id='dependent',prerequisite_id='outside')
        self.write('ticket.create',ticket_id='gpu',project_id='p',title='GPU work')
        self.write('allocation.ticket_policy_put',ticket_id='gpu',expected_revision='0',required_capabilities=['gpu'],pools=[])
        self.write('run.register',target_run_id='cpu',objective='CPU',capabilities=[])
        result=self.helper('status','-p','p','--run','cpu')
        eligible=result.stdout.split(b'ELIGIBLE FOR cpu',1)[1].split(b'OTHER TODO',1)[0]
        self.assertNotIn(b'dependent',eligible)
        self.assertNotIn(b'gpu ',eligible)
        self.assertIn(b'OTHER TODO',result.stdout)
        self.assertIn(b'dependent',result.stdout)
        graph=self.helper('status','-p','p')
        self.assertIn(b'graph-ready only',graph.stdout)
        # Match daemon authority exactly, without inferring absent prerequisites done.
        expected=self.call('ticket.ready',project_id='p')['data']['items']
        section=graph.stdout.split(b'GRAPH READY (not run eligibility)',1)[1].split(b'OTHER TODO',1)[0]
        for ticket in expected:
            self.assertIn(ticket['ticket_id'].encode(),section)
        self.assertNotIn(b'dependent',section)

    def test_large_binary_verified_output_is_bounded_safe_and_raw_exact(self):
        stage=self.root/'capture'
        counter=self.root/'executions'
        data=b'\x00\x1b[31m\xff caf\xc3\xa9\n'*15000
        script='from pathlib import Path; import sys; Path(sys.argv[1]).write_text("once"); sys.stdout.buffer.write('+repr(b'\x00\x1b[31m\xff caf\xc3\xa9\n')+'*15000)'
        run=subprocess.run([EXE,'evidence-run','--stage',str(stage),'--cwd',str(self.root),'--output-limit','65536','--',sys.executable,'-c',script,str(counter)],capture_output=True)
        self.assertEqual(run.returncode,0,run.stderr)
        published=subprocess.run([EXE,'--context',str(self.context),'evidence-publish','--stage',str(stage),'--resource-id','capture','--expected-revision','0','--title','Binary evidence'],capture_output=True)
        self.assertEqual(published.returncode,0,published.stderr)
        self.assertGreater((stage/'capture.json').stat().st_size,65536)
        parent=self.root/'private-temp';parent.mkdir()
        shown=self.helper('output','capture',env={'TMPDIR':str(parent)})
        self.assertNotIn(b'\x1b',shown.stdout)
        self.assertNotIn(b'\x00',shown.stdout)
        self.assertIn(b'\\u001b',shown.stdout)
        self.assertIn(b'"truncated":true',shown.stdout)
        self.assertIn(b'"text_lossy":true',shown.stdout)
        self.assertIn(b'"retained_bytes":"65536"',shown.stdout)
        self.assertEqual(list(parent.iterdir()),[])
        raw=self.helper('output','capture','--raw','stdout',env={'TMPDIR':str(parent)})
        self.assertEqual(raw.stdout,data[:65536])
        self.assertEqual(list(parent.iterdir()),[])
        self.assertEqual(counter.read_text(),'once')
        self.write('resource.put_text',resource_id='invalid-capture',expected_revision='0',title='Invalid',text='{}')
        invalid=self.helper('output','invalid-capture',expected=1)
        self.assertEqual(invalid.stdout,b'')

    def test_history_captured_pages_and_visible_control_previews(self):
        self.write('session.create',session_id='history',title='History',scopes=[])
        events=[{'client_id':f'e{n}','role':'assistant','kind':'message','phase':'completed','payload':{'kind':'inline','bytes_base64':base64.b64encode(('needle '+str(n)+'\x1b[2J café').encode()).decode()},'searchable_text':{'kind':'inline','bytes_base64':base64.b64encode(('needle '+str(n)+'\x1b[2J café').encode()).decode()}} for n in range(105)]
        self.write('session.append',session_id='history',events=events)
        deadline=time.monotonic()+5
        while not self.call('history.search',text='needle')['data']['index_complete']:
            self.assertLess(time.monotonic(),deadline);time.sleep(.02)
        result=self.helper('history','needle')
        self.assertIn(b'#105',result.stdout)
        before=self.call('workspace.overview')
        preview=self.helper('convo','history','1','1')
        self.assertIn(b'#1 ',preview.stdout)
        self.assertIn(b'next_anchor',preview.stdout)
        self.assertNotIn(b'\x1b',preview.stdout)
        self.assertIn(b'\\u001b',preview.stdout)
        self.assertEqual(self.call('workspace.overview'),before)

    def test_watch_consumes_read_and_wait_pages_never_uses_through(self):
        log=self.root/'watch-requests'
        stub=self.root/'watch-stub'
        stub.write_text('''#!/usr/bin/env python3
import json,sys
from pathlib import Path
log=Path('''+repr(str(log))+''')
a=sys.argv[3:];method=a.pop(0)
previous=log.read_text().splitlines() if log.exists() else []
with log.open('a') as out: out.write(json.dumps([method,a])+"\\n")
if method=='workspace.overview': data={};meta={'workspace_revision':'999'}
else:
 n=len(previous)-1
 if n==4:
  print(json.dumps({'error':{'message':'deliberate stop','data':{'kind':'Unavailable'}}}));sys.exit(1)
 data={'items':[{'revision':str(1000+n),'actor_id':'observer','timestamp':'2026-11-05 05:00:00Z','run_id':None,'targets':[],'kinds':['ticket_put']}], 'cursor':'c'+str(n+1),'through':'999999','needs_larger_budget':False,'has_more':n in (0,2)};meta={}
print(json.dumps({'result':{'data':data,'meta':meta}}))
''')
        stub.chmod(0o755)
        result=self.helper('watch','--metadata',expected=1,executable=str(stub))
        requests=[json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([row[0] for row in requests],['workspace.overview','changes.read','changes.read','changes.wait','changes.read','changes.wait'])
        self.assertIn('--after',requests[1][1])
        self.assertIn('999',requests[1][1])
        for row,cursor in zip(requests[2:],['c1','c2','c3','c4']):
            self.assertIn(cursor,row[1])
            self.assertNotIn('999999',row[1])
        self.assertEqual([line.split()[1] for line in result.stdout.splitlines()],[b'1000',b'1001',b'1002',b'1003'])
        self.assertIn(b'retained cursor: c4',result.stderr)

    def test_metadata_watch_renders_real_kinds_targets_and_attribution(self):
        self.write('ticket.create',ticket_id='watched',title='Watch metadata')
        self.write('run.register',target_run_id='worker',objective='Metadata attribution')
        self.call('comment.add',actor_id='ci',run_id='worker',mutation_id='metadata-comment',
                  comment_id='observed',target={'kind':'ticket','id':'watched'},body='Metadata only')
        before=self.call('workspace.overview')
        feed=self.call('changes.read',source='planning',after='0',limit='100')
        self.assertTrue(feed['data']['items'])
        proxy=self.root/'metadata-proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport os,sys\nif sys.argv[3]=="changes.wait":\n print(\'{"error":{"message":"deliberate stop"}}\');sys.exit(1)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        result=self.helper('watch','--metadata','--all',expected=1,executable=str(proxy))
        for item in feed['data']['items']:
            self.assertNotIn('changes',item)
            line=next(line for line in result.stdout.decode().splitlines()
                      if line.startswith('revision '+item['revision']+'  '))
            self.assertIn(item['actor_id'],line)
            for kind in item['kinds']:
                self.assertIn(kind,line)
        self.assertIn(b'ci (worker)',result.stdout)
        self.assertIn(b'watched',result.stdout)
        self.assertNotIn(b'? changes',result.stdout)
        self.assertNotIn(b'\x1b',result.stdout)
        colored=self.helper('watch','--metadata','--all',expected=1,executable=str(proxy),
                            env={'WGX_COLOR':'always','NO_COLOR':''})
        for code in [b'\x1b[1m',b'\x1b[36m',b'\x1b[35m']:
            self.assertIn(code,colored.stdout)
        self.assertEqual(self.call('workspace.overview'),before)

    def test_real_watch_wait_cancel_preserves_state_ack_and_journals(self):
        log=self.root/'watch-log';proxy=self.root/'watch-proxy'
        proxy.write_text('#!/usr/bin/env python3\nfrom pathlib import Path\nimport os,sys\np=Path('+repr(str(log))+')\nwith p.open("a") as out: out.write(sys.argv[3]+"\\n")\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        before=self.call('workspace.overview')
        inbox=self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='watch-observer')
        journals=sorted((self.root/'requests').iterdir())
        process=subprocess.Popen(['/bin/bash',str(ROOT/'skills/workgraph/scripts/wgx.sh'),'--context',str(self.context),'watch'],env=dict(os.environ,WG=str(proxy)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        try:
            deadline=time.monotonic()+5
            while not log.exists() or 'changes.wait' not in log.read_text():
                self.assertIsNone(process.poll())
                self.assertLess(time.monotonic(),deadline)
                time.sleep(.02)
            os.killpg(process.pid,signal.SIGTERM)
            out,err=process.communicate(timeout=5)
            self.assertEqual(process.returncode,143,(out,err))
            self.assertRegex(err,rb'retained cursor: [^ \n]+ \(initial after:')
        finally:
            if process.poll() is None: os.killpg(process.pid,signal.SIGKILL);process.wait(5)
        self.assertEqual(self.call('workspace.overview'),before)
        self.assertEqual(self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='watch-observer'),inbox)
        self.assertEqual(sorted((self.root/'requests').iterdir()),journals)

    def test_watch_budget_and_no_progress_stop_before_advancing(self):
        for budget in [True,False]:
            log=self.root/('budget-log' if budget else 'stalled-log')
            stub=self.root/('budget-stub' if budget else 'stalled-stub')
            packet={'items':[],'cursor':'start','through':'999999','needs_larger_budget':budget,'has_more':True}
            stub.write_text('#!/usr/bin/env python3\nfrom pathlib import Path\nimport json\np=Path('+repr(str(log))+');p.write_text(p.read_text()+"x" if p.exists() else "x")\nprint('+repr(json.dumps({'result':{'data':packet,'meta':{}}}))+')\n')
            stub.chmod(0o755)
            result=self.helper('watch','--metadata','--cursor','start',expected=1,executable=str(stub))
            self.assertEqual(result.stdout,b'')
            self.assertIn(b'retained cursor: start',result.stderr)
            self.assertEqual(log.read_text(),'x')

    def test_feed_is_last_rendered_events_from_one_capture(self):
        self.batch([{'method':'ticket.create','params':{'ticket_id':f'f{n}','title':f'feed marker {n}'}} for n in range(10)])
        result=self.helper('feed','3')
        self.assertEqual(len(result.stdout.splitlines()),3)
        for n in [7,8,9]: self.assertIn(f'f{n}'.encode(),result.stdout)

    def test_protocol_failure_and_body_omissions_are_visible(self):
        self.write('ticket.create',ticket_id='t',title='Visible')
        proxy=self.root/'proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport json,os,sys\nif sys.argv[3]=="request.list":\n print(json.dumps({"error":{"message":"visible failure\u009b31m\u202eevil","data":{"kind":"Conflict"}}}));sys.exit(1)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        failed=self.helper('status',expected=1,executable=str(proxy))
        self.assertEqual(failed.stdout,b'')
        self.assertIn(b'Conflict',failed.stderr)
        self.assertNotIn('\u009b'.encode(),failed.stderr)
        self.assertNotIn('\u202e'.encode(),failed.stderr)
        self.assertIn(b'\\u009b',failed.stderr)
        self.assertIn(b'incomplete collection',failed.stderr)
        packet={'data':{'pages':[{'data':{'items':[{'request_id':'partial','thread_id':'captured-thread','thread_summary':{'thread_revision':'7','title':'Pre','title_bytes':'120','scope':{'kind':'workspace'},'links':[],'link_count':'2'},'created':{'actor_id':'ci'},'resolver_id':'lead','status':{'kind':'open'},'responsibility':{'kind':'unaccepted'}}]},'meta':{'budget':{'truncated':True,'omitted_fields':'1','omitted_items':'0'}}}],'pagination':{'complete':True}},'meta':{}}
        packet['data']['pages'][0]['meta']['query_revision']='1'
        thread_packet={'data':{'pages':[{'data':{'items':[]},'meta':{'query_revision':'1'}}],'pagination':{'complete':True}},'meta':{}}
        proxy.write_text('#!/usr/bin/env python3\nimport sys\nprint('+repr(json.dumps({'result':thread_packet}))+' if sys.argv[3]=="thread.list" else '+repr(json.dumps({'result':packet}))+')\n')
        partial=self.helper('questions',executable=str(proxy))
        self.assertIn(b'partial',partial.stdout)
        self.assertIn(b'thread.get --thread-id captured-thread',partial.stdout)
        self.assertIn(b'captured thread revision 7',partial.stdout)
        self.assertIn(b'omitted fields/bodies',partial.stderr)
        self.assertIn(b'"omitted_fields":"1"',partial.stderr)
        for malformed in ['not json','{"result":{}}\n{"result":{}}']:
            proxy.write_text('#!/usr/bin/env python3\nprint('+repr(malformed)+')\n')
            result=self.helper('status',expected=1,executable=str(proxy))
            self.assertEqual(result.stdout,b'')
            self.assertIn(b'no valid success envelope',result.stderr)

    def test_dash_signals_and_error_restore_terminal(self):
        self.write('ticket.create',ticket_id='t',title='Signal cleanup')
        before=self.call('workspace.overview')
        inbox=self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='dash-observer')
        proxy=self.root/'failing-proxy'
        proxy.write_text('#!/usr/bin/env python3\nimport json,os,sys\nif sys.argv[3]=="request.list":\n print(json.dumps({"error":{"message":"forced panel failure"}}));sys.exit(1)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        for action in ['TERM','INT','error']:
            master,slave=pty.openpty()
            try:
                fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,100,0,0))
                before_modes=guide.terminal_modes(master)
                process=subprocess.Popen(['/bin/bash',str(ROOT/'skills/workgraph/scripts/wgx.sh'),'--context',str(self.context),'dash'],stdin=slave,stdout=slave,stderr=slave,preexec_fn=guide.foreground_session,env=dict(os.environ,WG=str(proxy) if action=='error' else EXE,TERM='xterm'))
                data=b'';deadline=time.monotonic()+10;sent=False
                while process.poll() is None:
                    self.assertLess(time.monotonic(),deadline,(action,data[-1000:]))
                    if select.select([master],[],[],.1)[0]:
                        part=guide.read_pty(master)
                        if not part: break
                        data+=part
                    if action=='error' and not sent and b'STALE / RECONNECTING' in data:
                        os.write(master,b'q');sent=True
                    if action!='error' and not sent and b'\x1b[32;1H' in data:
                        foreground=os.tcgetpgrp(master)
                        self.assertEqual(foreground,process.pid)
                        os.killpg(foreground,signal.SIGTERM if action=='TERM' else signal.SIGINT);sent=True
                process.wait(timeout=max(.001,deadline-time.monotonic()))
                while select.select([master],[],[],.05)[0]:
                    part=guide.read_pty(master)
                    if not part: break
                    data+=part
                self.assertEqual(process.returncode,{'TERM':143,'INT':130,'error':0}[action],data[-1000:])
                self.assertIn(b'\x1b[?7h',data)
                self.assertIn(b'\x1b[?25h',data)
                self.assertEqual(guide.terminal_modes(master),before_modes)
            finally:
                if 'process' in locals(): guide.stop_pty_job(process)
                os.close(master);os.close(slave)
        self.assertEqual(self.call('workspace.overview'),before)
        self.assertEqual(self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='dash-observer'),inbox)

    def test_invalid_bounds_offline_help_and_plain_dash_do_not_send_bad_requests(self):
        self.write('ticket.create',ticket_id='t',title='Plain')
        for args in [('feed','0'),('feed','x'),('status','-p'),('dash','--run'),('convo','t','1','101'),('output','t','--limit','0')]:
            result=self.helper(*args,expected=None)
            self.assertNotEqual(result.returncode,0,args)
            self.assertEqual(result.stdout,b'',args)
        plain=self.helper('dash',env={'TERM':'dumb'})
        self.assertNotIn(b'\x1b',plain.stdout)
        help_result=subprocess.run(['/bin/bash',str(ROOT/'skills/workgraph/scripts/wgx.sh'),'help'],env=dict(os.environ,WG='/does/not/exist',WG_CONTEXT='/missing'),capture_output=True)
        self.assertEqual(help_result.returncode,0)


if __name__=='__main__':
    unittest.main()
