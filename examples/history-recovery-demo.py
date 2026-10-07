#!/usr/bin/env python3
"""External deterministic driver: force adapter crash/reset and recover history."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ADAPTER = Path(__file__).with_name("history-adapter.py")
spec = importlib.util.spec_from_file_location("history_adapter", ADAPTER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def wait_socket(address, process):
    deadline = time.monotonic() + 10
    while not address.exists():
        if process.poll() is not None:
            raise RuntimeError("daemon stopped during startup")
        if time.monotonic() > deadline:
            raise TimeoutError("daemon socket unavailable")
        time.sleep(0.02)


def run(executable, directory, *, client=None):
    directory = Path(directory)
    registry, address, root = directory / "registry.json", directory / "daemon.sock", directory / "workspace"
    log = None
    daemon = None
    injected = client is not None
    if not injected:
        log = (directory / "daemon.log").open("w")
        daemon = subprocess.Popen([str(executable), "serve", str(registry), str(address)], stdout=log, stderr=log)
    try:
        if not injected:
            wait_socket(address, daemon)
            client = module.Workgraph(address)
        def mutate(method, mutation, **params):
            return client.call(method, {"workspace_id": "recovery-demo", "actor_id": "harness", "mutation_id": mutation, **params})
        mutate("workspace.create", "workspace", name="Recovery demonstration", root=str(root))
        mutate("project.create", "project", project_id="demo", title="Context continuity")
        mutate("ticket.create", "ticket", ticket_id="task", project_id="demo", title="Recover the current requirement")
        mutate("resource.put_text", "baseline-note", resource_id="agent-note", expected_revision="0", title="Agent note", text="The planted_requirement was BLUE in the initial request. Check session history for later corrections.")
        source, cursor = directory / "observable.jsonl", directory / "ingest-cursor.json"
        records = [
            {"source_id": "initial", "role": "user", "kind": "message", "payload": {"text": "planted_requirement: BLUE"}, "searchable_text": "planted_requirement: BLUE"},
            {"source_id": "tool-call", "role": "assistant", "kind": "tool_call", "correlation": "call-1", "payload": {"tool": "inspect", "argument": "telescope"}, "searchable_text": "inspect telescope"},
            {"source_id": "tool", "role": "tool", "kind": "tool_result", "correlation": "call-1", "payload": {"text": "x" * 300_000 + " tool_tail_fact: telescope"}, "searchable_text": "x" * 300_000 + " tool_tail_fact: telescope"},
            {"source_id": "correction", "role": "user", "kind": "message", "payload": {"text": "planted_requirement correction: AMBER replaces BLUE"}, "searchable_text": "planted_requirement correction: AMBER replaces BLUE"},
        ]
        source.write_text("".join(module.canonical(record) + "\n" for record in records[:3]))
        args = [sys.executable, str(ADAPTER), str(address), str(source), str(cursor), "--workspace", "recovery-demo", "--session", "conversation", "--ticket", "task"]
        if injected:
            mutate("session.create", "session-create-conversation", session_id="conversation", title="Harness conversation", scopes=[{"kind": "ticket", "id": "task"}])
            mutate("resource.put_text", "recovery-index-conversation", resource_id="recovery-index", expected_revision="0", title="Harness recovery index", text=module.canonical({"workspace_id": "recovery-demo", "session_id": "conversation", "ticket_id": "task", "note_id": "agent-note"}))
            class LostAcknowledgement:
                def call(self, method, params):
                    client.call(method, params)
                    raise EOFError("driver lost acknowledgement after real durable append")
            ingest_params = dict(source=source, state_path=cursor, workspace="recovery-demo", session="conversation", actor="harness")
            try:
                module.ingest(LostAcknowledgement(), **ingest_params)
            except EOFError:
                pass
            else:
                raise AssertionError("expected injected lost acknowledgement")
            ingest = module.ingest(client, **ingest_params)
        else:
            crashed = subprocess.run(args + ["--crash-after-ack"], capture_output=True, text=True)
            if crashed.returncode != 75:
                raise RuntimeError("expected controlled crash75: " + crashed.stderr)
            resumed = subprocess.run(args, check=True, capture_output=True, text=True)
            ingest = json.loads(resumed.stdout)
        assert ingest["next_line"] == 3 and ingest["through"] == "3", ingest
        initial_context = {"records": records[:3], "requirement": "BLUE"}
        # The external driver discards active context; the service does not compact it.
        initial_context.clear()
        bootstrap = {"workspace_id": "recovery-demo", "session_id": "conversation", "ticket_id": "task", "note_id": "agent-note"}
        def read(method, **params):
            return module.body(client.call(method, {"workspace_id": bootstrap["workspace_id"], **params}))
        first_hits = read("history.search", session_id=bootstrap["session_id"], text="planted_requirement", limit="10", max_bytes="65536")
        assert first_hits["complete"] and len(first_hits["items"]) == 1, first_hits
        first_payload = read("history.payload", ref=first_hits["items"][0]["ref"], head=first_hits["capture"]["head"], length="4096")
        active_context = {"requirement": base64.b64decode(first_payload["bytes_base64"]).decode()}
        assert "planted_requirement: BLUE" in active_context["requirement"], active_context
        # The driver observes a correction, records it durably, then evicts again.
        with source.open("a") as output:
            output.write(module.canonical(records[3]) + "\n")
        if injected:
            ingest = module.ingest(client, **ingest_params)
        else:
            corrected = subprocess.run(args, check=True, capture_output=True, text=True)
            ingest = json.loads(corrected.stdout)
        assert ingest["next_line"] == 4 and ingest["through"] == "4", ingest
        active_context.clear()
        client.calls = client.response_bytes = 0
        note = read("resource.read_chunk", resource_id=bootstrap["note_id"], offset="0", length="4096")
        note_text = base64.b64decode(note["data_base64"]).decode()
        baseline = {"calls": client.calls, "bytes": client.response_bytes, "current_requirement_recovered": "AMBER" in note_text}
        client.calls = client.response_bytes = 0
        hits = read("history.search", session_id=bootstrap["session_id"], text="planted_requirement", limit="10", max_bytes="65536")
        if not hits["complete"]:
            raise RuntimeError("index coverage is incomplete; wait/rebuild before absence claims")
        assert len(hits["items"]) == 2, hits
        head = hits["capture"]["head"]
        around = read("history.read", session_id=bootstrap["session_id"], anchor="1", direction="around", limit="10", head=head)
        assert len(around["items"]) == 4, around
        latest_ref = hits["items"][-1]["ref"]
        payload = read("history.payload", ref=latest_ref, head=head, length="4096")
        recovered = base64.b64decode(payload["bytes_base64"]).decode()
        assert "AMBER replaces BLUE" in recovered, recovered
        tail = read("history.search", session_id=bootstrap["session_id"], text="tool_tail_fact", max_bytes="65536")
        assert len(tail["items"]) == 1 and int(tail["items"][0]["byte_offset"]) > 65_536, tail
        tool_context = read("history.read", session_id=bootstrap["session_id"], anchor=tail["items"][0]["ref"]["sequence"], direction="around", limit="3", head=tail["capture"]["head"])
        calls = [event["event"] for event in tool_context["items"] if event["event"]["kind"] == "tool_call"]
        results = [event["event"] for event in tool_context["items"] if event["event"]["kind"] == "tool_result"]
        assert len(calls) == 1 and len(results) == 1, tool_context
        assert calls[0]["correlation"] == results[0]["correlation"] == "call-1", tool_context
        enhanced = {"calls": client.calls, "bytes": client.response_bytes, "current_requirement_recovered": True}
        result = {"adapter_restarted_without_duplicate": True, "adapter_restart_mode": "lost_acknowledgement_reentry" if injected else "terminated_process", "committed_events": ingest["through"], "context_reset_by": "external_driver", "context_evictions": 2, "first_recovered_requirement": "BLUE", "current_recovered_requirement": "AMBER", "tool_call_result_context_recovered": True, "notes_only": baseline, "notes_plus_history": enhanced, "tail_fact_offset": tail["items"][0]["byte_offset"], "fixture_payload_bytes": sum(len(module.canonical(record["payload"]).encode()) for record in records)}
        if not injected:
            print(module.canonical(result))
        return result
    finally:
        if daemon is not None:
            daemon.terminate()
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
        if log is not None:
            log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    executable = args.executable.resolve()
    if args.directory:
        args.directory.mkdir(parents=True, exist_ok=True)
        run(executable, args.directory.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix="workgraph-recovery-") as directory:
            run(executable, directory)


if __name__ == "__main__":
    main()
