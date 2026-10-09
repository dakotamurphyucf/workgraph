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
    assert "ticket.start [mutation]" in text and '"workspace_id"' in text
    parameters_text = text.split("Result envelope (JSON Schema):")[0]
    assert '"attempt_id"' in parameters_text and '"evidence"' not in parameters_text
    assert "fact.keys [read]" in call(directory, "methods").stdout
    assert catalog == json.loads(call(directory, "methods", "--output", "json").stdout)

    unknown = call(directory, "schema", "does.not.exist", expected=1)
    assert "Not_found" in unknown.stderr
    call(directory, "schema", "ticket.start", "unexpected", expected=1)
    call(directory, "methods", "--output", "xml", expected=1)
    assert not list(Path(directory).iterdir()), "offline discovery wrote files"

print("offline method discovery passed")
