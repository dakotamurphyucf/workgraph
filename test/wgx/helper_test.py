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
        result = subprocess.run(['/bin/bash',str(ROOT/'tools/wgx.sh'),'--context',str(self.context),*map(str,args)],
            env=dict(os.environ,WG=executable or EXE,NO_COLOR='1',**(env or {})),capture_output=True,timeout=timeout)
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
        while not self.call('history.search',text='needle')['data']['complete']:
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
 data={'items':[{'revision':str(1000+n),'actor_id':'observer','targets':[],'changes':'1'}], 'cursor':'c'+str(n+1),'through':'999999','needs_larger_budget':False,'has_more':n in (0,2)};meta={}
print(json.dumps({'result':{'data':data,'meta':meta}}))
''')
        stub.chmod(0o755)
        result=self.helper('watch',expected=1,executable=str(stub))
        requests=[json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([row[0] for row in requests],['workspace.overview','changes.read','changes.read','changes.wait','changes.read','changes.wait'])
        self.assertIn('--after',requests[1][1])
        self.assertIn('999',requests[1][1])
        for row,cursor in zip(requests[2:],['c1','c2','c3','c4']):
            self.assertIn(cursor,row[1])
            self.assertNotIn('999999',row[1])
        self.assertEqual([line.split()[1] for line in result.stdout.splitlines()],[b'1000',b'1001',b'1002',b'1003'])
        self.assertIn(b'retained cursor: c4',result.stderr)

    def test_real_watch_wait_cancel_preserves_state_ack_and_journals(self):
        log=self.root/'watch-log';proxy=self.root/'watch-proxy'
        proxy.write_text('#!/usr/bin/env python3\nfrom pathlib import Path\nimport os,sys\np=Path('+repr(str(log))+')\nwith p.open("a") as out: out.write(sys.argv[3]+"\\n")\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
        proxy.chmod(0o755)
        before=self.call('workspace.overview')
        inbox=self.call('inbox.read',recipient={'kind':'actor','id':'ci'},consumer_id='watch-observer')
        journals=sorted((self.root/'requests').iterdir())
        process=subprocess.Popen(['/bin/bash',str(ROOT/'tools/wgx.sh'),'--context',str(self.context),'watch'],env=dict(os.environ,WG=str(proxy)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
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
            result=self.helper('watch','--cursor','start',expected=1,executable=str(stub))
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
        packet={'data':{'pages':[{'data':{'items':[{'request_id':'partial','created':{'actor_id':'ci'},'resolver_id':'lead','status':{'kind':'open'},'responsibility':{'kind':'unaccepted'}}]},'meta':{'budget':{'truncated':True,'omitted_fields':'1','omitted_items':'0'}}}],'pagination':{'complete':True}},'meta':{}}
        proxy.write_text('#!/usr/bin/env python3\nprint('+repr(json.dumps({'result':packet}))+')\n')
        partial=self.helper('questions',executable=str(proxy))
        self.assertIn(b'partial',partial.stdout)
        self.assertIn(b'omitted fields/bodies',partial.stderr)
        self.assertIn(b'"omitted_fields":"1"',partial.stderr)
        for malformed in ['not json','{"result":{}}\n{"result":{}}']:
            proxy.write_text('#!/usr/bin/env python3\nprint('+repr(malformed)+')\n')
            result=self.helper('status',expected=1,executable=str(proxy))
            self.assertEqual(result.stdout,b'')
            self.assertIn(b'no valid success envelope',result.stderr)

    def test_dash_signals_and_error_restore_terminal(self):
        if sys.platform!='darwin': self.skipTest('macOS PTY qualification; Linux gate is separate')
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
                def session(): os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
                command='set -m; saved=$(stty -g); /bin/bash "$1" --context "$2" dash <&0 & child=$!; printf "CHILD=%s\\n" "$child"; fg %1; code=$?; printf "BEFORE=%s AFTER=%s\\n" "$saved" "$(stty -g)"; exit "$code"'
                process=subprocess.Popen(['/bin/bash','-c',command,'cleanup',str(ROOT/'tools/wgx.sh'),str(self.context)],stdin=slave,stdout=slave,stderr=slave,preexec_fn=session,env=dict(os.environ,WG=str(proxy) if action=='error' else EXE,TERM='xterm'))
                data=b'';deadline=time.monotonic()+10;sent=False
                while process.poll() is None:
                    self.assertLess(time.monotonic(),deadline,(action,data[-1000:]))
                    if select.select([master],[],[],.1)[0]: data+=os.read(master,65536)
                    if action!='error' and not sent and b'\x1b[32;1H' in data:
                        child=int(re.search(rb'CHILD=(\d+)',data)[1])
                        foreground=os.tcgetpgrp(master)
                        self.assertEqual(foreground,child)
                        os.killpg(foreground,signal.SIGTERM if action=='TERM' else signal.SIGINT);sent=True
                while select.select([master],[],[],.05)[0]:
                    part=os.read(master,65536)
                    if not part: break
                    data+=part
                self.assertEqual(process.returncode,{'TERM':143,'INT':130,'error':1}[action],data[-1000:])
                self.assertIn(b'\x1b[?7h',data)
                self.assertIn(b'\x1b[?25h',data)
                states=re.search(rb'BEFORE=(\S+) AFTER=(\S+)',data)
                self.assertIsNotNone(states,data[-1000:])
                def modes(value):
                    fields=dict(field.split('=',1) for field in value.decode().split(':')[1:])
                    fields['lflag']=int(fields['lflag'],16)&~getattr(termios,'PENDIN',0)
                    return fields
                self.assertEqual(modes(states[1]),modes(states[2]))
            finally:
                if 'process' in locals() and process.poll() is None:
                    os.killpg(process.pid,signal.SIGKILL);process.wait(5)
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
        help_result=subprocess.run(['/bin/bash',str(ROOT/'tools/wgx.sh'),'help'],env=dict(os.environ,WG='/does/not/exist',WG_CONTEXT='/missing'),capture_output=True)
        self.assertEqual(help_result.returncode,0)


if __name__=='__main__':
    unittest.main()
