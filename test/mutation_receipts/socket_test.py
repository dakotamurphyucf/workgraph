"""Mutation-specific state receipts survive lost replies, later writes and restore."""
import json
import hashlib
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

EXE = str(Path(sys.argv.pop(1)).resolve())


def frame(flow):
    def exact(length):
        data = b""
        while len(data) < length:
            part = flow.recv(length-len(data))
            if not part:
                raise EOFError("incomplete response")
            data += part
        return data
    header = exact(4)
    body = exact(struct.unpack(">I", header)[0])
    return header+body, json.loads(body)


class LostReply:
    def __init__(self, address, upstream):
        self.upstream, self.receipt, self.error = upstream, None, None
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(address))
        self.listener.listen()
        self.listener.settimeout(10)
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        try:
            incoming, _ = self.listener.accept()
            with incoming, socket.socket(socket.AF_UNIX) as upstream:
                incoming.settimeout(10)
                upstream.settimeout(10)
                upstream.connect(str(self.upstream))
                encoded, request = frame(incoming)
                assert request["method"] == "run.observe", request
                upstream.sendall(encoded)
                _, response = frame(upstream)
                self.receipt = response["result"]
                # Committed and captured, deliberately no acknowledgement to caller.
        except Exception as error:
            self.error = error
        finally:
            self.listener.close()

    def join(self):
        self.thread.join(10)
        assert not self.thread.is_alive() and self.error is None, self.error


class Receipts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-receipt-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.address = self.root/"s"
        self.log = (self.root/"daemon.log").open("w+")
        self.addCleanup(self.log.close)
        self.daemon = None
        self.addCleanup(self.stop)
        self.start()
        self.write("workspace.create", "workspace", name="Receipts", root=str(self.root/"workspace"))

    def start(self):
        self.daemon = subprocess.Popen([EXE,"serve",str(self.root/"registry"),str(self.address)],stdout=subprocess.DEVNULL,stderr=self.log)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            if self.address.exists() and self.cli("request",self.address,"daemon.health",expected=None).returncode==0:
                return
            self.assertIsNone(self.daemon.poll())
            time.sleep(.01)
        self.fail("daemon did not start")

    def stop(self):
        if self.daemon is not None and self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(10)

    def cli(self,*args,expected=0):
        result=subprocess.run([EXE,*map(str,args)],capture_output=True,timeout=15)
        if expected is not None:
            self.assertEqual(result.returncode,expected,(args,result.stdout,result.stderr))
        return result

    def parameters(self,method,params):
        registry=method in {"export.get","export.verify","workspace.restore"}
        return dict(params) if registry else dict(workspace_id="w",**params)

    def read(self,method,**params):
        return json.loads(self.cli("call",self.address,method,json.dumps(self.parameters(method,params))).stdout)["result"]

    def write(self,method,mutation,**params):
        data=self.parameters(method,dict(actor_id="owner",mutation_id=mutation,**params))
        return json.loads(self.cli("call",self.address,method,json.dumps(data)).stdout)["result"]

    def saved_write(self,method,mutation,*,address=None,expected=0,**params):
        data=self.parameters(method,dict(actor_id="owner",mutation_id=mutation,**params))
        path=self.root/(mutation+".json")
        result=self.cli("call",address or self.address,method,json.dumps(data),"--save-request",path,expected=expected)
        self.assertTrue(path.exists())
        self.assertIn(b"saved_request: ",result.stderr)
        return path,result

    def retry(self,path):
        before=path.read_bytes()
        result=json.loads(self.cli("retry",self.address,path).stdout)["result"]
        self.assertEqual(path.read_bytes(),before)
        return result

    def assert_run(self,data,revision,status,*,observed=None,sessions=()):
        self.assertEqual(data,{"run_id":"run","revision":str(revision),"status":status,"actor_id":"owner","last_observed_unix_ms":None if observed is None else str(observed),"session_ids":list(sessions)})
        self.assertNotIn("objective",data)
        self.assertNotIn("liveness",data)

    def test_run_receipts_are_original_snapshots_after_lost_reply_restart_and_restore(self):
        registered_file,registered_output=self.saved_write("run.register","register",target_run_id="run",objective="Run objective remains in the full read")
        registered=json.loads(registered_output.stdout)["result"]
        self.assert_run(registered["data"],1,"running")
        waiting_file,waiting_output=self.saved_write("run.transition","waiting",target_run_id="run",expected_revision="1",status="waiting",evidence="Caller marks waiting")
        waiting=json.loads(waiting_output.stdout)["result"]
        self.assert_run(waiting["data"],2,"waiting")
        proxy_address=self.root/"proxy"
        proxy=LostReply(proxy_address,self.address)
        observed_file,failed=self.saved_write("run.observe","observed",address=proxy_address,expected=1,target_run_id="run",expected_revision="2",observed_unix_ms="123")
        proxy.join()
        self.assertIn(b"Outcome_unknown",failed.stderr)
        self.assertEqual(failed.stdout,b"")
        observed=proxy.receipt
        self.assert_run(observed["data"],3,"waiting",observed=123)
        self.write("session.create","session",session_id="linked",title="User-visible records")
        linked_file,linked_output=self.saved_write("run.link_session","linked",target_run_id="run",expected_revision="3",session_id="linked")
        linked=json.loads(linked_output.stdout)["result"]
        self.assert_run(linked["data"],4,"waiting",observed=123,sessions=["linked"])
        completed=self.write("run.transition","completed",target_run_id="run",expected_revision="4",status="completed",evidence="Caller reports completion")
        self.assert_run(completed["data"],5,"completed",observed=123,sessions=["linked"])
        self.assertEqual(self.read("run.get",target_run_id="run")["data"]["status"],"completed")
        originals=[(registered_file,registered),(waiting_file,waiting),(observed_file,observed),(linked_file,linked)]
        for path,receipt in originals:
            self.assertEqual(self.retry(path),receipt)
        self.stop();self.start()
        for path,receipt in originals:
            self.assertEqual(self.retry(path),receipt)
        destination=self.root/"export"
        job=self.write("workspace.export","export",destination=str(destination))["data"]
        deadline=time.monotonic()+10
        while job["status"]=="running":
            self.assertLess(time.monotonic(),deadline)
            job=self.read("export.get",job_id=job["job_id"])["data"]
            time.sleep(.01)
        self.assertEqual(job["status"],"completed")
        self.assertTrue(self.read("export.verify",directory=str(destination))["data"]["verified"])
        self.write("workspace.close","close")
        self.write("workspace.unregister","unregister")
        self.write("workspace.restore","restore",directory=str(destination),root=str(self.root/"restored"))
        self.write("workspace.open","open")
        for path,receipt in originals:
            self.assertEqual(self.retry(path),receipt)
        self.assertEqual(self.read("run.get",target_run_id="run")["data"]["revision"],"5")

    def test_template_instantiation_retains_actual_nested_policy_receipts(self):
        spec={"parameters":[],"nodes":[{"alias":"worker","title":"Work","description":"","depends_on":[],"parent":None,"capabilities":["ocaml"],"allowed_actor_ids":None,"reviewers":[],"separate_actor":False}]}
        text=json.dumps(spec,sort_keys=True,separators=(",",":"),ensure_ascii=False)
        self.write("resource.put_text","template-resource",resource_id="template",expected_revision="0",title="Template",text=text)
        self.write("template.register","template-register",template_id="template",template_revision="1",digest=hashlib.sha256(text.encode()).hexdigest(),spec=spec)
        path,output=self.saved_write("template.instantiate","instantiate",template_id="template",template_revision="1",instance_id="instance",parameters={})
        receipt=json.loads(output.stdout)["result"]
        ticket=receipt["data"]["instance"]["tickets"][0]["ticket_id"]
        policies=[row["data"] for row in receipt["data"]["results"] if row["kind"]=="ticket_policy_put"]
        self.assertEqual(policies,[{"ticket_id":ticket,"revision":"1","required_capabilities":["ocaml"],"pools":[],"allowed_actor_ids":None}])
        self.write("allocation.ticket_policy_put","later-policy",ticket_id=ticket,expected_revision="1",required_capabilities=["later"],pools=[])
        self.stop();self.start()
        self.assertEqual(self.retry(path),receipt)

    def test_existing_ownership_and_answer_receipts_keep_exact_identities(self):
        self.write("run.register","run",target_run_id="run",objective="Ownership")
        pool_file,pool_output=self.saved_write("allocation.pool_put","pool",name="build",expected_revision="0",limit="2")
        pool=json.loads(pool_output.stdout)["result"]
        self.assertEqual(pool["data"],{"name":"build","revision":"1","limit":"2"})
        self.write("ticket.create","ticket",ticket_id="task",title="Task")
        policy_file,policy_output=self.saved_write("allocation.ticket_policy_put","policy",ticket_id="task",expected_revision="0",required_capabilities=["ocaml"],pools=["build"])
        policy=json.loads(policy_output.stdout)["result"]
        self.assertEqual(policy["data"],{"ticket_id":"task","revision":"1","required_capabilities":["ocaml"],"pools":["build"],"allowed_actor_ids":None})
        named_file,named_output=self.saved_write("reservation.acquire","named",run_id="run",target_run_id="run",requests=[{"reservation_id":"build","mode":"exclusive"}])
        named=json.loads(named_output.stdout)["result"]
        hold=named["data"]["holds"][0]
        self.assertEqual(hold["reservation_id"],"build")
        self.assertEqual(hold["holder"]["run_id"],"run")
        self.assertEqual(hold["holder"]["actor_id"],"owner")
        self.assertEqual(hold["holder"]["mode"],"exclusive")
        self.assertIn("lease",hold["holder"])
        self.write("reservation.release","release-named",run_id="run",target_run_id="run",reservation_id="build",token=hold["holder"]["token"])
        target={"worktree_id":"tree","kind":"file","path":"lib/change.ml"}
        paths_file,paths_output=self.saved_write("reservation.paths.acquire","paths",run_id="run",target_run_id="run",requests=[{"target":target,"mode":"exclusive"}])
        paths=json.loads(paths_output.stdout)["result"]
        hold=paths["data"]["holds"][0]
        self.assertEqual(hold["target"],target)
        self.write("reservation.path.release","release-path",run_id="run",target_run_id="run",target=target,token=hold["holder"]["token"])
        asked_file,asked_output=self.saved_write("request.ask","ask",request_id="question",ticket_id="task",resolver_id="owner",recipients=[{"kind":"actor","id":"owner"}],title="Question",body="Exact user-visible question")
        asked=json.loads(asked_output.stdout)["result"]
        self.assertEqual(asked["data"]["request_id"],"question")
        self.assertIn("comment_id",asked["data"]["question"])
        resolved_file,resolved_output=self.saved_write("request.resolve","resolve",request_id="question",expected_revision="1",body="Pinned answer")
        resolved=json.loads(resolved_output.stdout)["result"]
        self.assertEqual(resolved["data"]["request_id"],"question")
        self.assertEqual(resolved["data"]["request_revision"],"2")
        answer=resolved["data"]["answer"]
        self.assertEqual(answer["revision"],"1")
        self.write("comment.edit","edit-answer",comment_id=answer["comment_id"],expected_revision="1",body="Later wording")
        self.assertEqual(self.read("request.get",request_id="question")["data"]["answer"]["body"],"Pinned answer")
        self.stop();self.start()
        for path,receipt in [(pool_file,pool),(policy_file,policy),(named_file,named),(paths_file,paths),(asked_file,asked),(resolved_file,resolved)]:
            self.assertEqual(self.retry(path),receipt)
        help_text=self.cli("--context",self.root/"missing-context","help","receipts").stdout
        self.assertIn(b"process exit status",help_text)
        self.assertIn(b"last_observed_unix_ms",self.cli("help","run.observe").stdout)
        self.assertIn(b"holder carries",self.cli("help","reservation.acquire").stdout)
        self.assertIn(b"exact comment/version",self.cli("help","request.resolve").stdout)


if __name__=="__main__":unittest.main()
