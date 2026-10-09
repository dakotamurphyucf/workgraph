#!/usr/bin/env python3
"""Thin deterministic JSONL harness adapter; Python standard library only."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def synced_save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".pending-write")
    with temporary.open("w", encoding="utf-8") as output:
        output.write(canonical(value) + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class Workgraph:
    def __init__(self, address):
        self.address = str(address)
        self.calls = 0
        self.response_bytes = 0

    def call(self, method, params):
        payload = canonical({"jsonrpc": "2.0", "workgraph_api": "0.4", "id": "adapter", "method": method, "params": params}).encode()
        if len(payload) > 4 * 1024 * 1024:
            raise ValueError("request exceeds protocol budget; stage large payloads as resource blobs")
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(30)
            connection.connect(self.address)
            connection.sendall(struct.pack(">I", len(payload)) + payload)
            def exact(count):
                chunks = bytearray()
                while len(chunks) < count:
                    part = connection.recv(count - len(chunks))
                    if not part:
                        raise EOFError("daemon disconnected; retry saved request")
                    chunks.extend(part)
                return bytes(chunks)
            size = struct.unpack(">I", exact(4))[0]
            if size > 4 * 1024 * 1024:
                raise ValueError("response exceeds protocol budget")
            response = json.loads(exact(size))
        self.calls += 1
        self.response_bytes += size
        if "error" in response:
            raise RuntimeError(canonical(response["error"]))
        return response["result"]


def body(result):
    return result["data"]


def event_from_line(line, ordinal):
    observed = json.loads(line)
    source_id = observed.get("source_id", "line-" + str(ordinal))
    if "payload_base64" in observed:
        payload = base64.b64decode(observed["payload_base64"], validate=True)
    else:
        payload = canonical(observed.get("payload", observed)).encode()
    text = observed.get("searchable_text")
    return {
        "client_id": source_id,
        "role": observed.get("role", "assistant"),
        "kind": observed.get("kind", "message"),
        "phase": observed.get("phase", "completed"),
        "correlation": observed.get("correlation"),
        "provenance": {"adapter": "jsonl", "source_id": source_id},
        "payload": {"kind": "inline", "bytes_base64": base64.b64encode(payload).decode()},
        "searchable_text": None if text is None else {"kind": "inline", "bytes_base64": base64.b64encode(text.encode()).decode()},
        "attachments": observed.get("attachments", []),
    }


def ingest(client, *, source, state_path, workspace, session, actor, crash_after_ack=False):
    source = Path(source).resolve()
    state_path = Path(state_path)
    identity = {"workspace": workspace, "session": session, "actor": actor, "source": str(source)}
    state = json.loads(state_path.read_text()) if state_path.exists() else {
        "version": 1, **identity, "next_line": 0,
        "prefix_sha256": hashlib.sha256(b"").hexdigest(), "pending": None,
        "through": "0",
    }
    if state.get("version") != 1 or any(state.get(key) != value for key, value in identity.items()):
        raise ValueError("cursor identity/version differs; choose another cursor file")
    prefix = hashlib.sha256()
    with source.open("rb") as events:
        for _ in range(state["next_line"]):
            line = events.readline()
            if not line:
                raise ValueError("observable source was truncated")
            prefix.update(line)
        if prefix.hexdigest() != state["prefix_sha256"]:
            raise ValueError("already ingested observable source changed")
        if state["pending"] is not None:
            pending = state["pending"]
            # Verify the observable source before replaying the saved request.
            line = events.readline()
            prefix.update(line)
            if prefix.hexdigest() != pending["prefix_sha256"]:
                raise ValueError("pending source line changed")
            response = client.call("session.append", pending["params"])
            result = body(response)
            if response["meta"].get("durable") is not True:
                raise RuntimeError("append did not acknowledge durability")
            state.update(next_line=pending["next_line"], prefix_sha256=pending["prefix_sha256"],
                         through=result["through"], pending=None)
            synced_save(state_path, state)
        for line in events:
            ordinal = state["next_line"]
            event = event_from_line(line, ordinal)
            prefix.update(line)
            params = {"workspace_id": workspace, "actor_id": actor, "session_id": session,
                      "mutation_id": "ingest-" + hashlib.sha256((session + ":" + event["client_id"]).encode()).hexdigest(),
                      "events": [event]}
            state["pending"] = {"params": params, "next_line": ordinal + 1,
                                "prefix_sha256": prefix.hexdigest()}
            synced_save(state_path, state)
            response = client.call("session.append", params)
            result = body(response)
            if response["meta"].get("durable") is not True:
                raise RuntimeError("append did not acknowledge durability")
            if crash_after_ack:
                os._exit(75)  # External driver deliberately resets this adapter.
            state.update(next_line=ordinal + 1, prefix_sha256=prefix.hexdigest(),
                         through=result["through"], pending=None)
            synced_save(state_path, state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("socket")
    parser.add_argument("source")
    parser.add_argument("cursor")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--actor", default="harness")
    parser.add_argument("--ticket")
    parser.add_argument("--note", default="recovery-index")
    parser.add_argument("--crash-after-ack", action="store_true")
    args = parser.parse_args()
    client = Workgraph(args.socket)
    client.call("session.create", {"workspace_id": args.workspace, "actor_id": args.actor,
                "mutation_id": "session-create-" + args.session, "session_id": args.session,
                "title": "Harness conversation", "scopes": ([{"kind": "ticket", "id": args.ticket}] if args.ticket else [])})
    recovery = {"workspace_id": args.workspace, "session_id": args.session,
                "ticket_id": args.ticket, "note_id": args.note,
                "instructions": "Read the note, history.search, history.read, then history.payload. Keep capture.head for later pages."}
    client.call("resource.put_text", {"workspace_id": args.workspace, "actor_id": args.actor,
                "mutation_id": "recovery-index-" + args.session, "resource_id": args.note,
                "expected_revision": "0", "title": "Harness recovery index", "text": canonical(recovery)})
    state = ingest(client, source=args.source, state_path=args.cursor, workspace=args.workspace,
                   session=args.session, actor=args.actor, crash_after_ack=args.crash_after_ack)
    print(canonical({"through": state["through"], "next_line": state["next_line"],
                     "recovery": recovery, "calls": client.calls, "response_bytes": client.response_bytes}))


if __name__ == "__main__":
    main()
