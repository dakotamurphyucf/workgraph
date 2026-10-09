"""Independent installed-style discovery checks: no daemon, socket or context."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile


binary = str(Path(sys.argv[1]).resolve())


def call(directory, *arguments, expected=0):
    result = subprocess.run(
        [binary, *arguments], cwd=directory, capture_output=True, text=True, check=False
    )
    assert result.returncode == expected, (arguments, result.stdout, result.stderr)
    return result


with tempfile.TemporaryDirectory(prefix="workgraph-reference-") as directory:
    for helper in ["init", "bootstrap"]:
        local_help = call(directory, helper, "--help").stdout
        assert "[local helper]" in local_help and "--start-daemon true" in local_help
        assert local_help == call(directory, "help", helper).stdout
        assert local_help == call(directory, "--context", str(Path(directory) / "missing-context"), helper, "--help").stdout
        assert local_help == call(directory, "--context", str(Path(directory) / "missing-context"), "help", helper).stdout
    incomplete = call(directory, "request", expected=1)
    assert "request ABS_SOCKET METHOD" in incomplete.stderr
    incomplete_socket = call(directory, "request", str(Path(directory) / "missing-socket"), expected=1)
    assert "request ABS_SOCKET METHOD" in incomplete_socket.stderr
    ambiguous = call(directory, "request", "relative-socket", "request.list", expected=1)
    assert "request ABS_SOCKET METHOD" in ambiguous.stderr
    no_transport = call(directory, "request", "get", expected=1)
    assert "--context ABS_FILE" in no_transport.stderr
    catalog = json.loads(call(directory, "schema").stdout)
    assert catalog["schema_dialect"] == "https://json-schema.org/draft/2020-12/schema"
    names = [method["name"] for method in catalog["methods"]]
    assert names == sorted(set(names))
    assert {"initialize", "ticket.start", "fact.keys", "resource.read", "run.get"} <= set(names)

    single = json.loads(call(directory, "schema", "ticket.start").stdout)
    assert len(single["methods"]) == 1
    method = single["methods"][0]
    assert method["name"] == "ticket.start"
    assert method["mode"] == "mutation"
    assert method["result"]["required"] == ["data", "meta"]
    assert single == json.loads(call(directory, "help", "ticket.start", "--output", "json").stdout)
    text = call(directory, "help", "ticket.start").stdout
    assert "ticket.start [mutation]" in text and "workspace_id [required]" in text
    parameters_text = text.split("Result data:")[0]
    assert "attempt_id [optional]" in parameters_text and "evidence [" not in parameters_text
    assert text == call(directory, "help", "ticket.start", "--brief").stdout
    full = call(directory, "help", "ticket.start", "--full").stdout
    assert "Result envelope (JSON Schema):" in full and '"workspace_id"' in full
    assert "fact.keys [read]" in call(directory, "methods").stdout
    assert catalog == json.loads(call(directory, "methods", "--output", "json").stdout)
    core = json.loads(call(directory, "methods", "--core", "--output", "json").stdout)
    assert core["methods"] == [m for m in catalog["methods"] if m["tier"] == "core"]
    assert "CLI helpers" in call(directory, "methods", "--core").stdout
    assert "init [" not in call(directory, "methods", "--core").stdout
    for method in catalog["methods"]:
        brief = call(directory, "help", method["name"]).stdout
        assert len(brief.encode()) <= 8192, method["name"]
        assert ("Example params:" in brief or "Example skeleton (replace placeholders;" in brief)
        assert "Result envelope: {data, meta}" in brief

    assert call(directory, "help", "ticket.get").stdout == call(directory, "help", "ticket.context").stdout
    assert json.loads(call(directory, "schema", "ticket.get").stdout)["methods"][0]["name"] == "ticket.context"
    unknown = call(directory, "schema", "does.not.exist", expected=1)
    assert "Not_found" in unknown.stderr
    call(directory, "schema", "ticket.start", "unexpected", expected=1)
    call(directory, "methods", "--output", "xml", expected=1)
    assert not list(Path(directory).iterdir()), "offline discovery wrote files"

print("offline method discovery passed")
