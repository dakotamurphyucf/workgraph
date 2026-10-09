#!/usr/bin/env python3
"""Validate a source or installed agent guide bundle without third-party libraries."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import xml.etree.ElementTree as ET


def read_xml(path):
    text = path.read_text(encoding="utf-8")
    _, separator, body = text.partition("```xml\n")
    if not separator or "```" not in body:
        raise ValueError(f"missing XML document: {path}")
    return ET.fromstring(body.rsplit("```", 1)[0])


def check(directory, binary=None):
    directory = directory.resolve()
    entry = directory / "AGENT_GUIDE.md"
    root = read_xml(entry)
    if root.tag != "workgraph_agent_guide":
        raise ValueError("unexpected guide root")
    references = [node.attrib["href"] for node in root.findall("./references/reference")]
    if not references or len(references) != len(set(references)):
        raise ValueError("guide references must be nonempty and distinct")
    methods = set()
    files = {"AGENT_GUIDE.md": hashlib.sha256(entry.read_bytes()).hexdigest()}
    for reference in references:
        parts = PurePosixPath(reference)
        if parts.is_absolute() or ".." in parts.parts or not reference.startswith("docs/agent/"):
            raise ValueError(f"reference must be inside docs/agent: {reference}")
        path = directory / reference
        if not path.resolve().is_relative_to(directory):
            raise ValueError(f"reference escapes installation: {reference}")
        document = read_xml(path)
        if document.tag != "workgraph_reference":
            raise ValueError(f"unexpected reference root: {reference}")
        files[reference] = hashlib.sha256(path.read_bytes()).hexdigest()
        for method in document.findall(".//method"):
            name = method.attrib["name"]
            if name in methods:
                raise ValueError(f"duplicate method documentation: {name}")
            methods.add(name)
    for capability in root.findall("./capabilities/capability"):
        if capability.attrib["reference"] not in references:
            raise ValueError(f"capability reference is missing: {capability.attrib['name']}")
    if not methods:
        raise ValueError("reference bundle contains no methods")
    if binary is not None:
        catalog = json.loads(subprocess.check_output([str(Path(binary).resolve(strict=True)), "schema"], timeout=30))
        implemented = {method["name"] for method in catalog["methods"]}
        if len(implemented) != len(catalog["methods"]):
            raise ValueError("executable catalog contains duplicate methods")
        if implemented != methods:
            raise ValueError("guide/catalog coverage differs: missing documentation=" +
                             ",".join(sorted(implemented - methods)) +
                             "; missing executable contracts=" + ",".join(sorted(methods - implemented)))
    return {"status": "passed", "files": files, "methods": len(methods)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--binary", type=Path, help="also require exact executable method coverage")
    args = parser.parse_args()
    print(json.dumps(check(args.directory, args.binary), sort_keys=True))
