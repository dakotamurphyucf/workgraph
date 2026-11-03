"""Byte-preserving CLI materialization, exact retry, and verified chunk streaming."""
import base64
import hashlib
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading

binary = str(Path(sys.argv[1]).resolve())


def receive(stream, size):
    chunks = []
    while size:
        chunk = stream.recv(size)
        assert chunk
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


with tempfile.TemporaryDirectory(prefix="wg-text-") as temporary:
    root = Path(temporary)
    address = root / "p.sock"
    requests, errors = [], []
    peer = socket.socket(socket.AF_UNIX)
    peer.bind(str(address))
    peer.listen()
    peer.settimeout(3)
    journal = root / "requests"
    journal.mkdir()
    context = root / "context.json"
    context.write_text(json.dumps({"socket": str(address), "workspace_id": "demo", "actor_id": "worker", "request_directory": str(journal)}))

    def invoke(*args, data=b"", code=0):
        result = subprocess.run([binary, "--context", str(context), *map(str, args)], input=data, capture_output=True, timeout=5)
        assert result.returncode == code, (args, result.stdout, result.stderr)
        return result

    def exchange(args, replies, data=b"", code=0):
        def serve():
            try:
                for reply in replies:
                    stream, _ = peer.accept()
                    with stream:
                        request = json.loads(receive(stream, struct.unpack(">I", receive(stream, 4))[0]))
                        requests.append(request)
                        if reply is None:
                            response = {"error": {"code": -32000, "message": "probe", "data": {"kind": "Not_found", "message": "probe"}}}
                        else:
                            response = {"result": {"data": reply(request), "meta": {}}}
                        response.update(jsonrpc="2.0", id=request["id"])
                        encoded = json.dumps(response).encode()
                        stream.sendall(struct.pack(">I", len(encoded)) + encoded)
            except BaseException as error:
                errors.append(error)
        worker = threading.Thread(target=serve)
        worker.start()
        try:
            return invoke(*args, data=data, code=code)
        finally:
            worker.join(4)
            assert not worker.is_alive() and not errors, errors

    text = "first\r\nUnicode α🙂\n\n".encode()
    saved = root / "stdin.json"
    exchange(["resource.put_text", "--resource-id", "note", "--expected-revision", "0", "--title", "Note", "--field-file", "text", "-", "--save-request", saved], [None], text, 1)
    frozen = saved.read_bytes()
    assert json.loads(frozen)["params"]["text"].encode() == text
    first = requests[-1]
    exchange(["retry", saved], [None], b"different ignored stdin", 1)
    assert requests[-1] == first and saved.read_bytes() == frozen
    params = {"resource_id": "note", "expected_revision": "0", "title": "Note", "text": text.decode()}
    exchange(["resource.put_text", "--params-file", "-"], [None], json.dumps(params).encode(), 1)
    assert requests[-1]["params"]["text"].encode() == text
    field_file = root / "field.txt"
    field_file.write_bytes(text)
    exchange(["resource.put_text", "--resource-id", "file-note", "--expected-revision", "0", "--title", "Note", "--field-file", "text", field_file], [None], code=1)
    assert requests[-1]["params"]["text"].encode() == text
    before = sorted(journal.iterdir())
    bad_inputs = [
        (["resource.put_text", "--field-file", "text", "-", "--params-file", "-"], b"{}", "one explicit"),
        (["resource.put_text", "--field-file", "text", "-"], b"\xff", "UTF-8"),
        (["resource.put_text", "--params-file", "-"], b"[]", "object"),
        (["resource.put_text", "--params-file", "-"], b"{", "JSON"),
        (["resource.put_text", "--params-file", "-"], b" "+b" "*4194304, "4194304"),
        (["resource.put_text", "--params-file", "-"], json.dumps({**params, "text": "x"*65537}).encode(), "65536"),
    ]
    for args, data, message in bad_inputs:
        result = invoke(*args, data=data, code=1)
        assert message.lower() in result.stderr.decode().lower(), result.stderr
        assert sorted(journal.iterdir()) == before
    # Reject duplicate consumers without waiting for an open stdin pipe.
    process = subprocess.Popen([binary, "--context", str(context), "resource.put_text", "--params-file", "-", "--field-file", "text", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.wait(timeout=2) == 1
    process.stdin.close()
    fifo = root / "pipe"
    import os
    os.mkfifo(fifo)
    assert b"regular file" in invoke("resource.put_text", "--params-file", fifo, code=1).stderr
    assert sorted(journal.iterdir()) == before

    content = (b"\x00\xffline\r\n" + "🙂".encode()) * 25000
    digest = hashlib.sha256(content).hexdigest()
    chunks = (len(content) + 262143) // 262144

    def chunk(request, mode="good"):
        p = request["params"]
        offset = int(p["offset"])
        if offset:
            assert p["version"] == "7", p
        block = content[offset:offset + 262144]
        next_offset = offset + len(block)
        result = {"resource_id": "blob", "version": "7", "digest": digest, "size_bytes": str(len(content)), "offset": str(offset), "data_base64": base64.b64encode(block).decode(), "chunk_digest": hashlib.sha256(block).hexdigest(), "next_offset": None if next_offset == len(content) else str(next_offset), "eof": next_offset == len(content)}
        if mode == "whole": result["digest"] = "f"*64
        if mode == "chunk": result["chunk_digest"] = "e"*64
        if mode == "version" and offset: result["version"] = "8"
        if mode == "cursor": result["next_offset"] = "1"
        return result

    args = ["resource.download", "--resource-id", "blob", "--destination", "-"]
    result = exchange(args, [chunk]*chunks)
    assert result.stdout == content
    assert json.loads(result.stderr)["result"]["data"]["version"] == "7"
    spool = root / "verified.bin"
    result = exchange([*args, "--spool", spool], [chunk]*chunks)
    assert result.stdout == content == spool.read_bytes()
    assert spool.stat().st_mode & 0o777 == 0o600
    for mode, count in [("whole", chunks), ("chunk", 1), ("version", 2), ("cursor", 1)]:
        replies = [lambda request, mode=mode: chunk(request, mode)] * count
        result = exchange(args, replies, code=1)
        if mode == "whole": assert result.stdout == content
        if mode in ("chunk", "cursor"): assert result.stdout == b""
        if mode == "version": assert result.stdout == content[:262144]
    failed_spool = root / "failed.bin"
    result = exchange([*args, "--spool", failed_spool], [lambda request: chunk(request, "whole")]*chunks, code=1)
    assert result.stdout == b"" and not failed_spool.exists()
    assert not list(root.glob("failed.bin.downloading-*"))
    assert invoke(*args, "--spool", spool, code=1).stdout == b""
    # Errors above created no connection or durable journal.
    assert sorted(journal.iterdir()) == before
    empty = lambda request: {"resource_id": "blob", "version": "7", "digest": hashlib.sha256(b"").hexdigest(), "size_bytes": "0", "offset": "0", "data_base64": "", "chunk_digest": hashlib.sha256(b"").hexdigest(), "next_offset": None, "eof": True}
    result = exchange(args, [empty])
    assert result.stdout == b"" and json.loads(result.stderr)["result"]["data"]["size_bytes"] == "0"
    peer.close()
print("CLI stdin materialization, exact retries and verified byte streaming passed")
