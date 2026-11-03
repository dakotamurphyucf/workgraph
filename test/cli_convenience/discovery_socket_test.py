"""Independent CLI normalization checks against a framed fake peer and local child."""

import base64
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading

binary = str(Path(sys.argv[1]).resolve())


def invoke(*arguments, expected=0):
    result = subprocess.run([binary, *map(str, arguments)], capture_output=True, text=True)
    assert result.returncode == expected, (arguments, result.stdout, result.stderr)
    return result


def receive(stream, size):
    chunks = []
    while size:
        chunk = stream.recv(size)
        assert chunk, "partial request"
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


with tempfile.TemporaryDirectory(prefix="wg-cli-") as temporary:
    root = Path(temporary)
    socket_path = root / "peer.sock"
    journal = root / "requests"
    journal.mkdir()
    context = root / "agent with spaces.json"
    context.write_text(json.dumps({"socket": str(socket_path), "workspace_id": "demo", "actor_id": "worker", "request_directory": str(journal)}))
    requests, failures = [], []
    peer = socket.socket(socket.AF_UNIX)
    peer.bind(str(socket_path))
    peer.listen()
    peer.settimeout(5)

    def serve(count):
        try:
            for _ in range(count):
                stream, _ = peer.accept()
                with stream:
                    size = struct.unpack(">I", receive(stream, 4))[0]
                    request = json.loads(receive(stream, size))
                    requests.append(request)
                    response = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32000, "message": "probe", "data": {"kind": "Not_found", "message": "probe"}}}
                    payload = json.dumps(response).encode()
                    stream.sendall(struct.pack(">I", len(payload)) + payload)
        except BaseException as error:
            failures.append(error)

    spellings = [
        ["ticket.context"], ["ticket", "context"], ["ticket.get"], ["ticket", "get"],
        ["request", "ticket.context"], ["request", "ticket", "get"],
        ["request", str(socket_path), "ticket", "get"],
    ]
    review_spellings = [["review.submission.get"], ["review", "submission.get"], ["review", "submission", "get"]]
    total = len(spellings) + len(review_spellings) + 4
    worker = threading.Thread(target=serve, args=(total,))
    worker.start()
    try:
        for index, spelling in enumerate(spellings):
            extra = ["--save-request", root / "alias.json"] if index == 2 else []
            result = invoke("--context", context, *spelling, "--ticket-id", "task", *extra, expected=1)
            assert json.loads(result.stdout)["error"]["data"]["message"] == "probe"
            assert requests[-1]["method"] == "ticket.context"
        assert json.loads((root / "alias.json").read_text())["method"] == "ticket.context"
        for spelling in review_spellings:
            invoke("--context", context, *spelling, "--ticket-id", "task", expected=1)
            assert requests[-1]["method"] == "review.submission.get"
        invoke("--context", context, "request", "get", "--request-id", "question", expected=1)
        assert requests[-1]["method"] == "request.get"
        invoke("request", "get", socket_path, "--workspace-id", "demo", "--request-id", "question", expected=1)
        assert requests[-1]["method"] == "request.get"
        saved = root / "create.json"
        created = invoke("--context", context, "ticket.create", "--ticket-id", "task", "--title", "Task", "--save-request", saved, expected=1)
        assert "saved_request:" in created.stderr and "saved_request:" not in created.stdout
        assert "error" in json.loads(created.stdout)
        frozen = json.loads(saved.read_text())
        assert frozen["method"] == "ticket.create" and frozen == requests[-1]
        invoke("--context", context, "comment.add", "--json-field", "target", '{"kind":"workspace"}', "--body", "--help", expected=1)
        assert requests[-1]["params"]["body"] == "--help"
    finally:
        worker.join(timeout=6)
        peer.close()
    assert not worker.is_alive() and not failures, failures
    assert len(requests) == total
    # A frozen retry is never reinterpreted as a new alias operation.
    frozen["method"] = "ticket.get"
    legacy_alias = root / "noncanonical.json"
    legacy_alias.write_text(json.dumps(frozen))
    rejected = invoke("--socket", socket_path, "retry", legacy_alias, expected=1)
    assert "saved retries never change methods" in rejected.stderr

    # A listening socket and valid write context must remain untouched by help.
    offline_peer = socket.socket(socket.AF_UNIX)
    offline_peer.bind(str(root / "offline.sock"))
    offline_peer.listen()
    offline_peer.settimeout(.05)
    offline_context = root / "offline.json"
    offline_context.write_text(json.dumps({"socket": str(root / "offline.sock"), "workspace_id": "demo", "actor_id": "worker", "request_directory": str(journal)}))
    before = sorted(p.name for p in journal.iterdir())
    for spelling in [["ticket", "create"], ["ticket.create"], ["request", "ticket", "create"], ["request", str(root / "offline.sock"), "ticket", "create"]]:
        help_text = invoke("--context", offline_context, *spelling, "--help", "--title", "ignored").stdout
        assert "ticket.create [mutation]" in help_text
    assert before == sorted(p.name for p in journal.iterdir())
    try:
        offline_peer.accept()
        raise AssertionError("help connected to a peer")
    except TimeoutError:
        pass
    finally:
        offline_peer.close()

    # The child argv boundary is literal, even for CLI transport/help spellings.
    stage = root / "stage"
    arguments = ["--help", "--context", "missing.json", "ticket", "start"]
    summary = json.loads(invoke("evidence-run", "--stage", stage, "--cwd", root, "--", sys.executable, "-c", "import json,sys; print(json.dumps(sys.argv[1:]))", *arguments).stdout)
    capture = json.loads(Path(summary["capture_file"]).read_text())
    actual = json.loads(base64.b64decode(capture["stdout"]["base64"]))
    assert actual == arguments, actual

print("CLI catalog normalization, offline help and child argv passed")
