"""Maintained guide examples: exact sources, visible import, CI and terminal viewport."""
import errno
import fcntl
import hashlib
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
import tempfile
import termios
import time
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
EXE = str(Path(sys.argv.pop(1)).resolve())
sys.path.insert(0, str(ROOT / "test"))
from daemon_ready import is_listening


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


converter = load("converter", ROOT / "examples/transcript-converter.py")
adapter = load("adapter", ROOT / "examples/history-adapter.py")


def read_pty(fd):
    """Linux reports a closed slave as EIO; other PTYs return an empty read."""
    try:
        return os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise


def terminal_modes(fd):
    """Compare portable attributes, excluding only the transient retype flag."""
    modes = termios.tcgetattr(fd)
    # Darwin may set PENDIN for queued input while Bash read restores modes.
    # PENDIN requests input retyping; it is not a persistent terminal setting.
    modes[3] &= ~getattr(termios, "PENDIN", 0)
    return modes


def foreground_session():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.tcsetpgrp(0, os.getpgrp())
    # Do not inherit ignored SIGINT from a harness/background shell. The helper
    # starts as a normal foreground job and installs its own signal traps.
    signal.signal(signal.SIGINT, signal.SIG_DFL)


def stop_pty_job(process):
    if process.poll() is None:
        try:
            # This process owns its session/group; never signal a foreign group.
            if os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        process.wait(5)


class Sources(unittest.TestCase):
    def test_complete_inline_sources_and_bash3_syntax(self):
        readme = (ROOT / "README.md").read_text()
        for path in ["examples/ci-worker.sh", "examples/transcript-converter.py", "tools/wgx.sh"]:
            match = re.search(r"<!-- source: " + re.escape(path) + r" -->\s*```\w+\n(.*?)```", readme, re.S)
            self.assertIsNotNone(match, path)
            self.assertEqual(match[1], (ROOT / path).read_text(), path)
        subprocess.run(["/bin/bash", "-n", str(ROOT / "tools/wgx.sh")], check=True)
        subprocess.run(["/bin/bash", "-n", str(ROOT / "examples/ci-worker.sh")], check=True)
        self.assertEqual(readme.count("```mermaid"), 13)
        guide = (ROOT / "AGENT_GUIDE.md").read_text()
        self.assertIn("nondurable empty", guide)
        xml = guide.split("```xml\n",1)[1].rsplit("```",1)[0]
        document = ET.fromstring(xml)
        references = {node.attrib["href"] for node in document.findall("./references/reference")}
        self.assertTrue(references)
        self.assertTrue(all(node.attrib["reference"] in references for node in document.findall("./capabilities/capability")))
        self.assertNotIn("--thinking", (ROOT / "examples/transcript-converter.py").read_text())

    def test_visible_unicode_tool_records_no_clipping_or_private_parts(self):
        text = "selected café 🐟 " * 4000
        entries = [{"type":"assistant", "uuid":"u", "message":{"role":"assistant", "content":[
            {"type":"text", "text":text}, {"type":"thinking", "thinking":"PRIVATE_SENTINEL"},
            {"type":"redacted_thinking", "data":"PRIVATE_SENTINEL"},
            {"type":"tool_use", "name":"bash", "input":{"command":"printf café"}},
            {"type":"tool_result", "content":[{"type":"text","text":"visible one"},
                                                {"type":"text","text":"visible two"},
                                                {"type":"image","data":"PRIVATE_SENTINEL"}]}
        ]}}]
        events, counts = converter.convert(map(json.dumps, entries), 1024)
        self.assertEqual("".join(e["payload"]["text"] for e in events if e["kind"] == "message"), text)
        self.assertTrue(all(len(e["searchable_text"].encode()) <= 1024 for e in events))
        self.assertEqual(events[-1]["payload"]["text"], "visible one\nvisible two")
        self.assertIn('bash {"command":"printf café"}', events[-2]["payload"]["text"])
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(events))
        self.assertEqual(counts["private_parts_excluded"], 2)
        self.assertEqual(counts["unsupported_parts"], 1)
        extra = {"type":"user","uuid":"v","message":{"content":"append"}}
        appended, _ = converter.convert(map(json.dumps, entries + [extra]), 1024)
        self.assertEqual(appended[:len(events)], events)
        for malformed in [entries + entries, [{"type":"user","message":{"content":"x"}}]]:
            with self.assertRaises(ValueError):
                converter.convert(map(json.dumps, malformed))

    def test_malformed_late_record_emits_no_prefix(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.write_text('{"type":"user","uuid":"ok","message":{"content":"visible"}}\nBAD\n')
            result = subprocess.run([sys.executable, str(ROOT / "examples/transcript-converter.py"), str(source)], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")


class Daemon(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wg-guide-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = self.root / "s"
        self.log = (self.root / "daemon.log").open("w+")
        self.addCleanup(self.log.close)
        self.daemon = subprocess.Popen([EXE,"serve",str(self.root / "registry"),str(self.socket)],stdout=self.log,stderr=self.log)
        self.addCleanup(self.stop)
        deadline = time.monotonic()+10
        while not is_listening(self.socket):
            self.assertIsNone(self.daemon.poll())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        self.count = 0
        self.write("workspace.create", name="Guide", root=str(self.root / "workspace"))
        self.context = self.root / "ci context's.json"
        journal = self.root / "requests"
        journal.mkdir()
        self.context.write_text(json.dumps({"socket":str(self.socket),"workspace_id":"w","actor_id":"ci", "request_directory":str(journal)}))

    def stop(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait(10)

    def call(self, method, **params):
        reply = subprocess.run([EXE,"call",str(self.socket),method,json.dumps(dict(workspace_id="w",**params))], capture_output=True,text=True,timeout=15)
        self.assertEqual(reply.returncode, 0, (method,reply.stdout,reply.stderr))
        return json.loads(reply.stdout)["result"]

    def write(self, method, **params):
        self.count += 1
        return self.call(method,actor_id="ci",mutation_id="fixture"+str(self.count),**params)

    def test_readme_atomic_plans_preflight_and_apply(self):
        plans = re.findall(r"```json\n(.*?)\n```", (ROOT / "README.md").read_text(), re.S)
        self.assertEqual(len(plans),2)
        self.write("run.register",target_run_id="plan-run",objective="Path plan")
        for plan in plans:
            operations = json.loads(plan)["operations"]
            before = self.call("workspace.overview")["meta"]["workspace_revision"]
            self.call("transaction.preflight", actor_id="ci", run_id="plan-run", operations=operations)
            self.assertEqual(self.call("workspace.overview")["meta"]["workspace_revision"],before)
            self.write("transaction.apply", run_id="plan-run", operations=operations)

    def example(self, beginning, context=None, lead=None, **extra):
        blocks = re.findall(r"```bash\n(.*?)\n```",(ROOT / "README.md").read_text(),re.S)
        selected = [block for block in blocks if block.startswith(beginning)]
        self.assertEqual(len(selected),1,beginning)
        prelude = 'set -euo pipefail\nwg() { "$WG" --context "$WG_CONTEXT" "$@"; }\nlead() { "$WG" --context "$LEAD_CONTEXT" "$@"; }\n'
        result = subprocess.run(["/bin/bash","-c",prelude+selected[0]],env=dict(os.environ,WG=EXE,WG_CONTEXT=str(context or self.context),LEAD_CONTEXT=str(lead or self.context),**extra),capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,(beginning,result.stdout,result.stderr))
        return result

    def test_readme_smoke_and_full_memory_handoff_examples(self):
        self.example("set -euo pipefail\nwg project create")
        self.assertEqual(self.call("ticket.context",ticket_id="first-task")["data"]["ticket"]["status"],"done")
        self.write("ticket.create",ticket_id="res-task",title="Resume example")
        resumed = self.example("started=$(wg ticket start --ticket-id res-task)")
        self.assertIn("1229",resumed.stdout)
        handoff = self.call("handoff.get",ticket_id="res-task")["data"]
        self.assertIn("class1",json.dumps(handoff))
        self.assertIsNone(self.call("ticket.context",ticket_id="res-task")["data"]["ticket"]["claim"])

    def test_readme_skill_backlog_literal_cli_and_offline_full_help(self):
        self.write("project.create",project_id="demo-build",title="Backlog")
        self.write("ticket.create",ticket_id="train",project_id="demo-build",title="GPU work")
        self.example("wg allocation.ticket_policy_put --ticket-id train")
        ticket = self.call("ticket.context",ticket_id="train")["data"]["ticket"]
        self.assertEqual(ticket["claim"]["run_id"],"gpu-next")
        result = subprocess.run([EXE,"help","ticket.start","--full"],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        readme = (ROOT / "README.md").read_text()
        self.assertIn('export WG_CONTEXT="$WG_HOME/agents/worker-1.json"\nRUN=worker-1-invocation-1',readme)

    def test_readme_atomic_result_records_and_finish_share_one_commit(self):
        self.write("ticket.create",ticket_id="module-a",title="Result example")
        self.write("run.register",target_run_id="example-run",objective="README atomic result")
        started = self.write("ticket.start",run_id="example-run",ticket_id="module-a",attempt_id="example-attempt")
        before = int(started["meta"]["workspace_revision"])
        self.example("ops=$(jq -nc",RUN="example-run",token=started["data"]["token"])
        ticket = self.call("ticket.context",ticket_id="module-a")
        self.assertEqual(ticket["data"]["ticket"]["status"],"done")
        self.assertEqual(int(ticket["meta"]["workspace_revision"]),before+1)
        fact = self.call("fact.get",scope={"kind":"ticket","id":"module-a"},key="checks")
        self.assertEqual(fact["data"]["value"]["passed"],15)
        resource = self.call("resource.get",resource_id="module-result")["data"]
        self.assertIn({"kind":"ticket","id":"module-a"},resource["metadata"]["targets"])

    def test_readme_question_answer_and_selective_message_ack_examples(self):
        self.write("ticket.create",ticket_id="module-a",title="Question example")
        def context(actor):
            requests = self.root / (actor+"-requests")
            requests.mkdir()
            path = self.root / (actor+".json")
            path.write_text(json.dumps({"socket":str(self.socket),"workspace_id":"w","actor_id":actor,"request_directory":str(requests)}))
            return path
        worker, lead = context("worker-1"),context("agent-orch")
        self.call("run.register",actor_id="worker-1",mutation_id="example-worker-register",target_run_id="example-worker",objective="README examples")
        self.example("wg request ask --run-id",context=worker,lead=lead,RUN="example-worker")
        answer = self.call("request.get",request_id="module-api-question",include_messages=True)["data"]
        self.assertEqual(answer["status"]["kind"],"resolved")
        self.assertIsNotNone(answer["status"]["answer"])
        self.example("wg message send --run-id",context=worker,lead=lead,RUN="example-worker")
        notifications = self.call("inbox.read",recipient={"kind":"actor","id":"agent-orch"},consumer_id="orch-current")["data"]["items"]
        self.assertTrue(any(n["source"] == {"kind":"request","id":"module-api-question"} for n in notifications))
        self.assertFalse(any(n["source"] == {"kind":"message","id":"worker-observation"} for n in notifications))

    def test_visible_import_exact_retry_append_and_changed_source(self):
        source, cursor = self.root / "events", self.root / "cursor"
        entries = [{"type":"user","uuid":"one","message":{"content":"searchable café"}},
                   {"type":"assistant","uuid":"two","message":{"content":[{"type":"thinking","thinking":"PRIVATE_SENTINEL"},{"type":"text","text":"public answer"}]}}]
        events, _ = converter.convert(map(json.dumps, entries))
        source.write_text("".join(converter.canonical(e)+"\n" for e in events))
        self.write("session.create",session_id="visible",title="Visible",scopes=[])
        client = adapter.Workgraph(str(self.socket))
        options = dict(source=source,state_path=cursor,workspace="w",session="visible",actor="ci")
        adapter.ingest(client,**options)
        before = self.call("history.read",session_id="visible",direction="after",anchor="0")
        adapter.ingest(client,**options)
        self.assertEqual(self.call("history.read",session_id="visible",direction="after",anchor="0"),before)
        extra, _ = converter.convert([json.dumps({"type":"user","uuid":"three","message":{"content":"appended"}})])
        source.write_text(source.read_text()+converter.canonical(extra[0])+"\n")
        adapter.ingest(client,**options)
        self.assertEqual(len(self.call("history.read",session_id="visible",direction="after",anchor="0")["data"]["items"]),3)
        self.assertEqual(self.call("history.search",text="PRIVATE_SENTINEL")["data"]["items"],[])
        source.write_text(source.read_text().replace("public answer","changed answer"))
        with self.assertRaisesRegex(ValueError,"source changed"):
            adapter.ingest(client,**options)

    def prepare_ci(self):
        self.write("project.create",project_id="p",title="CI")
        self.write("label.put",label_id="ci",expected_revision="0",name="CI")
        self.write("ticket.create",ticket_id="job",project_id="p",title="CI job")
        self.write("ticket.metadata",ticket_id="job",expected_revision="1",label_ids=["ci"])
        self.write("allocation.ticket_policy_put",ticket_id="job",expected_revision="0",required_capabilities=["ci"],pools=[])
        checkout = self.root / "checkout"
        checkout.mkdir()
        subprocess.run(["git","init","-q",str(checkout)],check=True)
        subprocess.run(["git","-C",str(checkout),"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","fixture"],check=True)
        stages = self.root / "stages"
        stages.mkdir()
        return checkout, stages

    def run_ci(self, code=0, fail_publication=False):
        checkout, stages = self.prepare_ci()
        executable = EXE
        if fail_publication:
            executable = str(self.root / "proxy")
            Path(executable).write_text('#!/usr/bin/env python3\nimport os,sys\nif "evidence-publish" in sys.argv: sys.exit(1)\nos.execv('+repr(EXE)+',["workgraph"]+sys.argv[1:])\n')
            Path(executable).chmod(0o755)
        count = self.root / "executions"
        child = "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_text(p.read_text()+'x' if p.exists() else 'x'); print('captured'); sys.exit(int(sys.argv[2]))"
        result = subprocess.run(["/bin/bash",str(ROOT / "examples/ci-worker.sh"),sys.executable,"-c",child,str(count),str(code)],
            env=dict(os.environ,CTX=str(self.context),RUN="ci-run",PROJECT="p",SRC=str(checkout),STAGES=str(stages),WG=executable),capture_output=True,text=True,timeout=30)
        return result,count,stages

    def test_ci_success_finishes_only_after_linked_capture(self):
        result,count,_ = self.run_ci()
        self.assertEqual(result.returncode,0,(result.stdout,result.stderr))
        self.assertEqual(count.read_text(),"x")
        self.assertEqual(self.call("ticket.context",ticket_id="job")["data"]["ticket"]["status"],"done")
        self.assertEqual(self.call("run.get",target_run_id="ci-run")["data"]["status"],"completed")
        resource = self.call("resource.get",resource_id="ci-run-job-1")["data"]
        self.assertIn({"kind":"ticket","id":"job"},resource["metadata"]["targets"])

    def test_ci_red_releases_and_records_failed_run(self):
        result,count,_ = self.run_ci(7)
        self.assertEqual(result.returncode,2,(result.stdout,result.stderr))
        self.assertEqual(count.read_text(),"x")
        ticket = self.call("ticket.context",ticket_id="job")["data"]["ticket"]
        self.assertEqual(ticket["status"],"todo")
        notes = self.call("comment.list",target={"kind":"ticket","id":"job"})["data"]["items"]
        self.assertTrue(any('"code":"7"' in note["body"] for note in notes),notes)
        self.assertIsNone(ticket["claim"])
        self.assertEqual(self.call("run.get",target_run_id="ci-run")["data"]["status"],"failed")
        self.assertEqual(len(self.call("inbox.read",recipient={"kind":"actor","id":"agent-orch"},consumer_id="review")["data"]["items"]),1)

    def test_ci_publication_failure_retains_claim_stage_and_never_reruns(self):
        result,count,stages = self.run_ci(fail_publication=True)
        self.assertEqual(result.returncode,1,(result.stdout,result.stderr))
        self.assertEqual(count.read_text(),"x")
        self.assertIsNotNone(self.call("ticket.context",ticket_id="job")["data"]["ticket"]["claim"])
        self.assertEqual(self.call("run.get",target_run_id="ci-run")["data"]["status"],"running")
        self.assertTrue((stages / "ci-run-job-1" / "capture.json").is_file())

    def test_helper_read_views_do_not_write_or_ack(self):
        home = self.root / "home"
        (home / ".local/bin").mkdir(parents=True)
        (home / ".local/bin/workgraph").symlink_to(EXE)
        self.write("ticket.create",ticket_id="t",title="A visible ticket")
        self.write("message.send",message_id="hello",recipients=[{"kind":"actor","id":"ci"}],body="Visible")
        self.write("session.create",session_id="visible",title="Visible",scopes=[])
        source = self.root / "events"
        source.write_text(converter.canonical({"source_id":"visible-one","payload":"Visible café","searchable_text":"Visible café"})+"\n")
        adapter.ingest(adapter.Workgraph(str(self.socket)),source=source,state_path=self.root / "cursor",workspace="w",session="visible",actor="ci")
        stage = self.root / "capture"
        subprocess.run([EXE,"evidence-run","--stage",str(stage),"--cwd",str(self.root),"--",sys.executable,"-c","print('trusted capture')"],capture_output=True,check=True)
        self.write("resource.put_text",resource_id="small-capture",expected_revision="0",title="Small capture",text=(stage / "capture.json").read_text())
        before = self.call("workspace.overview")
        inbox = self.call("inbox.read",recipient={"kind":"actor","id":"ci"},consumer_id="ci")
        for command in [["status"],["ticket","t"],["questions"],["agents"],["inbox","ci"],["storage"],["files"],["feed","10"],["history","missing"],["convo","visible"],["output","small-capture"]]:
            result = subprocess.run(["/bin/bash",str(ROOT / "tools/wgx.sh"),"--context",str(self.context),*command],env=dict(os.environ,HOME=str(home),WG=EXE,NO_COLOR="1"),capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,(command,result.stdout,result.stderr))
        self.assertEqual(self.call("workspace.overview"),before)
        self.assertEqual(self.call("inbox.read",recipient={"kind":"actor","id":"ci"},consumer_id="ci"),inbox)


class Viewport(unittest.TestCase):
    def test_controlling_tty_height_resize_scroll_and_restore(self):
        with tempfile.TemporaryDirectory(prefix="wg-viewport-",dir="/tmp") as directory:
            root = Path(directory)
            binpath = root / ".local/bin"
            binpath.mkdir(parents=True)
            stub = binpath / "workgraph"
            stub.write_text('''#!/usr/bin/env python3
import json,sys
args=sys.argv[1:]
method=args[2] if args[0]=="--context" else args[0]
data={"items":[]}
if method=="workspace.overview": data={"workspace":{"name":"Viewport"},"counts":{}}
if method=="ticket.list": data={"items":[{"ticket_id":"t"+str(n),"title":"long viewport row "+str(n),"status":"in_progress","priority":0,"project_id":"p","prerequisites":[],"label_ids":[],"claim":{"actor_id":"worker","token":"1"}} for n in range(90)]}
if method=="workspace.metrics": data={"planning":{"limits":{},"admission":{}},"history":{"limits":{},"admission":{}}}
meta={"workspace_revision":"1"}
if "--paginate" in args: data={"pages":[{"data":data,"meta":meta}],"pagination":{"complete":True}}
print(json.dumps({"result":{"data":data,"meta":meta}}))
''')
            stub.chmod(0o755)
            context = root / "context"
            context.write_text('{"workspace_id":"viewport"}')
            master, slave = pty.openpty()
            self.addCleanup(os.close,master)
            self.addCleanup(os.close,slave)
            fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack("HHHH",54,120,0,0))
            before_modes = terminal_modes(master)
            process = subprocess.Popen(["/bin/bash",str(ROOT / "tools/wgx.sh"),"--context",str(context),"dash"],stdin=slave,stdout=slave,stderr=slave,
                                       env=dict(os.environ,HOME=str(root),WG=str(stub),TERM="xterm",LINES="24",COLUMNS="80"),preexec_fn=foreground_session)
            self.addCleanup(stop_pty_job,process)
            def until(marker):
                data = b""
                deadline = time.monotonic()+12
                while marker not in data:
                    self.assertLess(time.monotonic(),deadline,data[-1000:])
                    if select.select([master],[],[],.2)[0]:
                        part = read_pty(master)
                        self.assertTrue(part, data[-1000:])
                        data += part
                return data
            first = until(b"\x1b[54;1H")
            screen = first.rsplit(b"\x1b[H",1)[-1].split(b"\x1b[54;1H")[0]
            self.assertEqual(screen.count(b"\n"),53,first[:1800]+b" ... "+first[-500:])
            fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack("HHHH",36,120,0,0))
            foreground = os.tcgetpgrp(master)
            self.assertEqual(foreground,process.pid)
            os.killpg(foreground,signal.SIGWINCH)
            resized = until(b"\x1b[36;1H")
            screen = resized.rsplit(b"\x1b[H",1)[-1].split(b"\x1b[36;1H")[0]
            self.assertEqual(screen.count(b"\n"),35,resized[-1000:])
            os.write(master,b"G")
            until(b"\x1b[36;1H")
            os.write(master,b"q")
            tail = b""
            deadline = time.monotonic()+10
            while process.poll() is None and time.monotonic()<deadline:
                if select.select([master],[],[],.1)[0]:
                    part = read_pty(master)
                    if not part: break
                    tail += part
            process.wait(timeout=max(.001,deadline-time.monotonic()))
            self.assertEqual(process.returncode,0,tail[-2000:])
            while select.select([master],[],[],.05)[0]:
                part = read_pty(master)
                if not part: break
                tail += part
            self.assertIn(b"\x1b[?7h",tail)  # wrap mode restored
            self.assertIn(b"\x1b[?25h",tail) # cursor restored
            footer = re.search(rb"lines (\d+)-(\d+) of\s+(\d+)",tail)
            self.assertIsNotNone(footer,tail)
            self.assertGreater(int(footer[1]),1) # G reached bottom, not top
            self.assertEqual(footer[2],footer[3])
            self.assertEqual(process.returncode,0)
            self.assertEqual(terminal_modes(master),before_modes)


if __name__ == "__main__":
    unittest.main()
