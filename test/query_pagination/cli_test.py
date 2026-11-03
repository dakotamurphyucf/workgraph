"""Real captured pagination families, exact filters and stale guard preservation."""
import base64
import json
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
    def exact(n):
        result = b""
        while len(result) < n:
            data = flow.recv(n-len(result))
            if not data:
                raise EOFError("incomplete frame")
            result += data
        return result
    header = exact(4)
    body = exact(struct.unpack(">I", header)[0])
    return header + body, json.loads(body)


class Proxy:
    def __init__(self, path, upstream, method, after_first):
        self.path, self.upstream, self.method = path, upstream, method
        self.after_first = after_first
        self.requests, self.responses, self.error = [], [], None
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        self.listener.listen()
        self.listener.settimeout(.1)
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        try:
            while not self.stop.is_set():
                try:
                    incoming, _ = self.listener.accept()
                except socket.timeout:
                    continue
                with incoming, socket.socket(socket.AF_UNIX) as upstream:
                    incoming.settimeout(5)
                    upstream.settimeout(5)
                    encoded, request = frame(incoming)
                    upstream.connect(str(self.upstream))
                    upstream.sendall(encoded)
                    encoded, response = frame(upstream)
                    if request["method"] == self.method:
                        self.requests.append(request)
                        self.responses.append(response)
                        if len(self.requests) == 1:
                            self.after_first()
                    incoming.sendall(encoded)
        except Exception as error:
            self.error = error
        finally:
            self.listener.close()

    def close(self):
        self.stop.set()
        self.thread.join(6)
        assert not self.thread.is_alive() and self.error is None, self.error


class PaginationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-page-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = self.root / "s"
        self.log = (self.root / "daemon.log").open("w")
        self.addCleanup(self.log.close)
        self.daemon = subprocess.Popen([EXE, "serve", str(self.root / "registry"), str(self.socket)], stdout=subprocess.DEVNULL, stderr=self.log)
        self.addCleanup(self.shutdown)
        deadline = time.monotonic()+10
        while time.monotonic() < deadline:
            if self.socket.exists() and self.cli("request", self.socket, "daemon.health", expected=None).returncode == 0:
                break
            assert self.daemon.poll() is None
            time.sleep(.02)
        else:
            self.fail("daemon startup failed")
        self.counter = 0
        self.write("workspace.create", name="Work", root=str(self.root / "workspace"))
        self.write("project.create", project_id="p", title="Project")
        self.write("project.create", project_id="q", title="Other")
        for name, project in [("a","p"),("b","p"),("c","p"),("d","q")]:
            self.write("ticket.create", ticket_id=name, title=name, project_id=project)

    def shutdown(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(10)

    def cli(self, *args, expected=0):
        result = subprocess.run([EXE, *map(str,args)], capture_output=True, timeout=15)
        if expected is not None:
            self.assertEqual(result.returncode, expected, (args,result.stdout,result.stderr))
        return result

    def write(self, method, **params):
        self.counter += 1
        params = dict(workspace_id="w", actor_id="a", mutation_id="m"+str(self.counter), **params)
        return json.loads(self.cli("call", self.socket, method, json.dumps(params)).stdout)["result"]

    def read(self, method, **params):
        return json.loads(self.cli("call", self.socket, method, json.dumps(dict(workspace_id="w",**params))).stdout)["result"]

    def collect(self, method, params=None, options=(), expected=0, address=None):
        args = ["request", address or self.socket, method, "--workspace-id", "w", "--paginate", *options]
        for key, value in (params or {}).items():
            args += ["--json-field", key, json.dumps(value)]
        return json.loads(self.cli(*args, expected=expected).stdout)["result"]

    def proxy(self, method, action):
        proxy = Proxy(self.root / "proxy", self.socket, method, action)
        self.addCleanup(proxy.close)
        return proxy

    def test_planning_filters_and_exact_resume(self):
        first = self.collect("ticket.list", {"project_id":"p", "status":"todo", "limit":"1"}, options=["--page-limit","1"], expected=1)
        metadata = first["data"]["pagination"]
        self.assertEqual(metadata["stop"], "page_limit")
        request = metadata["next_request"]
        self.assertEqual(request["params"]["project_id"], "p")
        self.assertEqual(request["params"]["status"], "todo")
        self.assertEqual(request["params"]["at_revision"], first["data"]["pages"][0]["meta"]["workspace_revision"])
        rest = self.collect(request["method"], {k:v for k,v in request["params"].items() if k!="workspace_id"})
        items = [i for p in first["data"]["pages"]+rest["data"]["pages"] for i in p["data"]["items"]]
        self.assertEqual({i["ticket_id"] for i in items}, {"a","b","c"})
        self.assertTrue(rest["data"]["pagination"]["complete"])

    def test_concurrent_change_is_conflict_without_refresh(self):
        proxy = self.proxy("ticket.list", lambda: self.write("ticket.create",ticket_id="later",title="Later",project_id="p"))
        result = self.collect("ticket.list", {"project_id":"p","limit":"1"}, expected=1,address=proxy.path)
        metadata = result["data"]["pagination"]
        self.assertEqual(metadata["stop"], "error")
        self.assertEqual(metadata["problem"]["kind"], "Conflict")
        self.assertEqual(len(result["data"]["pages"]),1)
        self.assertEqual(len(proxy.requests),2)
        self.assertEqual(proxy.requests[1]["params"]["at_revision"],proxy.responses[0]["result"]["meta"]["workspace_revision"])
        self.assertEqual(metadata["problem"], proxy.responses[1]["error"]["data"])

    def test_domain_revision_and_resource_target(self):
        for run in ["r1","r2"]:
            self.write("run.register",target_run_id=run,objective="Test")
        result = self.collect("run.list", {"limit":"1"})
        pages = result["data"]["pages"]
        self.assertEqual({p["meta"]["query_scope"] for p in pages},{"runs"})
        self.assertEqual(len({p["meta"]["query_revision"] for p in pages}),1)
        for n in ["one","two"]:
            put = self.write("resource.put_text",resource_id=n,expected_revision="0",title=n,text=n)
            self.write("resource.link",resource_id=n,expected_revision=put["data"]["revision"],target={"kind":"project","id":"p"})
        result = self.collect("resource.list", {"target":{"kind":"project","id":"p"},"limit":"1"})
        self.assertEqual({i["resource_id"] for p in result["data"]["pages"] for i in p["data"]["items"]},{"one","two"})

    def test_domain_whole_item_budget_never_skips_rows(self):
        for i in range(25):
            self.write("run.register",target_run_id="run"+str(i)+"x"*70,objective="Recorded objective")
        result=self.collect("run.list",{"limit":"100","max_bytes":"4096"})
        metadata=result["data"]["pagination"]
        self.assertTrue(metadata["complete"])
        rows=[r for p in result["data"]["pages"] for r in p["data"]["items"]]
        self.assertEqual({r["run_id"] for r in rows},{"run"+str(i)+"x"*70 for i in range(25)})
        self.assertGreater(len(result["data"]["pages"]),1)
        self.assertTrue(all(len(json.dumps(p,separators=(",",":"),ensure_ascii=False).encode())<=4096 for p in result["data"]["pages"]))

    def test_inbox_through_is_notification_bound_not_revision(self):
        def send(name):
            self.write("message.send",message_id=name,body=name,recipients=[{"kind":"actor","id":"b"}])
        send("one"); send("two")
        proxy = self.proxy("inbox.read",lambda:send("later"))
        params={"recipient":{"kind":"actor","id":"b"},"consumer_id":"reader","limit":"1"}
        result=self.collect("inbox.read",params,address=proxy.path)
        pages=result["data"]["pages"]
        self.assertEqual(sum(len(p["data"]["items"]) for p in pages),2)
        through=pages[0]["data"]["through"]
        self.assertTrue(all(r["params"].get("through")==through for r in proxy.requests[1:]))
        self.assertEqual(len(self.read("inbox.read",**dict(params,limit="100"))["data"]["items"]),3) # no implicit ack

    def test_feed_cursor_stops_at_original_capture(self):
        proxy=self.proxy("changes.read",lambda:self.write("ticket.create",ticket_id="later",title="Later"))
        result=self.collect("changes.read",{"source":"planning","after":"0","limit":"1","project_id":"p"},address=proxy.path)
        pages=result["data"]["pages"]
        self.assertTrue(result["data"]["pagination"]["complete"])
        self.assertEqual(len({p["data"]["through"] for p in pages}),1)
        self.assertFalse(pages[-1]["data"]["has_more"])
        for request in proxy.requests[1:]:
            self.assertNotIn("after",request["params"])
            self.assertEqual(request["params"]["project_id"],"p")
            self.assertEqual(request["params"]["source"],"planning")
            self.assertIn("cursor",request["params"])

    def test_opaque_digest_and_coordinator_keep_scopes(self):
        before=self.read("workspace.get")["meta"]["workspace_revision"]
        self.write("transaction.apply",operations=[{"method":"comment.add","params":{"comment_id":"decision"+str(i),"target":{"kind":"ticket","id":"a"},"kind":"decision","body":"Decision "+str(i)}} for i in range(5)])
        result=self.collect("activity.digest",{"scope":{"kind":"ticket","ticket_id":"a"},"after":before,"limit":"1"})
        pages=result["data"]["pages"]
        self.assertEqual(sum(len(p["data"]["entries"]) for p in pages),5)
        self.assertEqual(len({p["data"]["capture"]["lineage"] for p in pages}),1)
        self.assertTrue(result["data"]["pagination"]["complete"])
        result=self.collect("coordinator.overview",{"project_id":"p","kinds":["ready_work"],"limit":"1"})
        pages=result["data"]["pages"]
        self.assertEqual(sum(len(p["data"]["items"]) for p in pages),3)
        self.assertEqual(len({p["data"]["captured_now_unix_ms"] for p in pages}),1)

    def test_oversized_feed_stops_and_retains_cursor(self):
        base=self.read("changes.read",source="planning")
        ids=["target-"+str(i)+"-"+"x"*78 for i in range(32)]
        self.write("transaction.apply",operations=[{"method":"ticket.create","params":{"ticket_id":name,"title":str(i)}} for i,name in enumerate(ids)])
        result=self.collect("changes.read",{"source":"planning","cursor":base["data"]["cursor"],"max_bytes":"4096"},expected=1)
        metadata=result["data"]["pagination"]
        self.assertEqual(metadata["stop"],"needs_larger_budget")
        self.assertEqual(metadata["page_count"],"1")
        retry=metadata["retry_request"]
        self.assertEqual(retry["params"]["cursor"],result["data"]["pages"][0]["data"]["cursor"])
        self.write("ticket.create",ticket_id="after-capture",title="Later")
        params={k:v for k,v in retry["params"].items() if k!="workspace_id"}
        resumed=self.collect("changes.read",dict(params,max_bytes="1048576"))
        self.assertEqual(resumed["data"]["pages"][0]["data"]["through"],result["data"]["pages"][0]["data"]["through"])
        self.assertEqual(sum(len(p["data"]["items"]) for p in resumed["data"]["pages"]),1)
        self.assertTrue(result["data"]["pages"][0]["data"]["needs_larger_budget"])

    def test_history_head_and_payload_ranges(self):
        for name in ["s1","s2","s3"]: self.write("session.create",session_id=name,title=name)
        proxy=self.proxy("session.list",lambda:self.write("session.create",session_id="later",title="Later"))
        result=self.collect("session.list",{"limit":"1"},address=proxy.path)
        pages=result["data"]["pages"]
        self.assertEqual(sum(len(p["data"]["items"]) for p in pages),3)
        head=pages[0]["meta"]["history_capture"]["head"]
        self.assertTrue(all(r["params"].get("head")==head for r in proxy.requests[1:]))
        payload=b"exact\x00binary\xff"*1000
        self.write("session.append",session_id="s1",events=[{"client_id":"e1","role":"user","kind":"message","phase":"final","payload":{"kind":"inline","bytes_base64":base64.b64encode(payload).decode()}}])
        result=self.collect("history.payload",{"event_ref":{"session_id":"s1","sequence":"1"},"length":"1000"})
        self.assertEqual(b"".join(base64.b64decode(p["data"]["bytes_base64"]) for p in result["data"]["pages"]),payload)
        self.write("session.append",session_id="s1",events=[{"client_id":"e"+str(i),"role":"user","kind":"message","phase":"final","payload":{"kind":"inline","bytes_base64":"YQ=="}} for i in [2,3]])
        result=self.collect("history.read",{"session_id":"s1","direction":"before","anchor":"3","limit":"1"})
        self.assertEqual([e["event_ref"]["sequence"] for p in result["data"]["pages"] for e in p["data"]["items"]],["2","1"])


    def test_server_omissions_total_bound_and_offline_rejection(self):
        self.write("ticket.create",ticket_id="large",project_id="p",title="Large",description="x"*60000)
        result=self.collect("ticket.list",{"text":"Large","max_bytes":"4096"},expected=1)
        self.assertEqual(result["data"]["pagination"]["stop"],"server_field_omissions")
        result=self.collect("ticket.list",{"project_id":"p","limit":"1"},options=["--total-bytes","4096"],expected=1)
        metadata=result["data"]["pagination"]
        self.assertEqual(metadata["stop"],"byte_limit")
        self.assertLessEqual(len(json.dumps(result,separators=(",",":"),ensure_ascii=False).encode()),4096)
        self.assertEqual(str(len(json.dumps(result,separators=(",",":"),ensure_ascii=False).encode())),metadata["returned_bytes"])
        path=self.root/"no-journal.json"
        self.cli("request",self.root/"absent","ticket.create","--workspace-id","w","--actor-id","a","--ticket-id","forbidden","--title","No","--paginate","--save-request",path,expected=1)
        self.assertFalse(path.exists())
        # A first opaque page cannot be thrown away while claiming a captured continuation.
        rejected=self.cli("request",self.root/"absent","changes.read","--workspace-id","w","--source","planning","--paginate","--total-bytes","4096",expected=1)
        self.assertIn(b"initial opaque-cursor",rejected.stderr)
        self.assertNotIn(b"cannot connect",rejected.stderr)
        for method in ["inbox.wait","ticket.context"]:
            self.cli("request",self.root/"absent",method,"--paginate","--workspace-id","w",expected=1)
        self.assertIn(b"pagination [local read helper]",self.cli("--context",self.root/"absent-context","help","pagination").stdout)
        self.assertIn(b"ticket.list",self.cli("--context",self.root/"absent-context","ticket","list","--paginate","--help").stdout)


if __name__=="__main__": unittest.main()
