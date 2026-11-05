#!/usr/bin/env python3
"""Check a repository/install or copied Workgraph skill using only Python's stdlib.

This project's frontmatter uses single-line YAML strings; this is a bundle check,
not a general YAML parser or an implementation of the entire Agent Skills spec.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote


def sha(data):
    return hashlib.sha256(data).hexdigest()


def frontmatter(text):
    if not text.startswith('---\n') or '\n---\n' not in text[4:]:
        raise ValueError('SKILL.md must start with YAML frontmatter')
    header, body = text[4:].split('\n---\n', 1)
    fields = {}
    for line in header.splitlines():
        key, separator, value = line.partition(':')
        if not separator or key in fields or key not in {'name', 'description', 'license', 'compatibility'}:
            raise ValueError('Use distinct supported single-line skill metadata fields')
        value = value.strip()
        if value.startswith('"'):
            value = json.loads(value)
        if not isinstance(value, str) or not value or value.startswith(('>', '|', "'")):
            raise ValueError('Skill metadata must be nonempty single-line strings')
        fields[key] = value
    if fields.get('name') != 'workgraph' or not 1 <= len(fields.get('description', '')) <= 1024:
        raise ValueError('Expected workgraph skill name and a useful description')
    if len(fields.get('compatibility', '')) > 500 or not body.strip():
        raise ValueError('Invalid compatibility or empty skill instructions')
    return fields


def check(directory, binary=None):
    directory = directory.resolve(strict=True)
    skill = directory if (directory / 'SKILL.md').is_file() else directory / 'skills/workgraph'
    if skill.is_symlink() or not skill.is_dir() or skill.name != 'workgraph':
        raise ValueError('Expected a real workgraph skill directory')
    metadata = frontmatter((skill / 'SKILL.md').read_text())
    files = {}
    for path in sorted(skill.rglob('*')):
        if '__pycache__' in path.parts or path.suffix == '.pyc':
            continue
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError('Skill contains a symlink or special file: ' + str(path))
        if not path.is_file():
            continue
        files[path.relative_to(directory).as_posix()] = sha(path.read_bytes())
        if path.suffix != '.md':
            continue
        text = path.read_text()
        if re.search(r'```xml|<!\[CDATA\[|<workgraph_', text):
            raise ValueError('Legacy XML guidance remains: ' + str(path))
        for target in re.findall(r'\]\(([^\s)]+)\)', text):
            if re.match(r'[A-Za-z][A-Za-z0-9+.-]*:', target) or target.startswith('#'):
                continue
            location = unquote(target.split('#', 1)[0])
            resolved = (path.parent / location).resolve()
            if not resolved.is_relative_to(skill) or not resolved.exists():
                raise ValueError(f'Skill reference escapes or is missing: {path.relative_to(skill)} -> {target}')
    def generated_inventory(relative, generator):
        directory = skill / relative
        manifest = json.loads((directory / 'MANIFEST.json').read_text())
        if manifest.get('generator') != generator:
            raise ValueError('Missing generated inventory: ' + relative)
        declared = manifest['files']
        actual = {p.name for p in directory.iterdir() if p.is_file() and p.name != 'MANIFEST.json'}
        if set(declared) != actual:
            raise ValueError('Generated file inventory differs from manifest: ' + relative)
        for name, digest in declared.items():
            if Path(name).name != name or sha((directory / name).read_bytes()) != digest:
                raise ValueError('Generated reference content mismatch: ' + relative + '/' + name)
        return manifest

    manifest = generated_inventory('references/api', 'workgraph-api-reference')
    discovery_manifest = generated_inventory('references/discovery', 'workgraph-discovery-reference')
    methods = set(manifest['files']) - {'index.md', 'common.md'}
    if len(methods) != manifest['method_count']:
        raise ValueError('API method count differs from inventory')
    if manifest.get('discovery_catalog_sha256') != discovery_manifest['catalog_sha256']:
        raise ValueError('API guidance and discovery metadata inventories differ')
    if binary is not None:
        executable = str(Path(binary).resolve(strict=True))
        catalog = json.loads(subprocess.check_output([executable, 'schema'], timeout=30))
        implemented = {method['name'] + '.md' for method in catalog['methods']}
        canonical = json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        if implemented != methods or len(implemented) != len(catalog['methods']) or sha(canonical) != manifest['catalog_sha256']:
            raise ValueError('Skill API reference differs from executable catalog')
        discovery = json.loads(subprocess.check_output([executable, 'discover', '--catalog'], timeout=30))
        canonical = json.dumps(discovery, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        if sha(canonical) != discovery_manifest['catalog_sha256']:
            raise ValueError('Skill discovery reference differs from executable catalog')
    return {'status': 'passed', 'skill': metadata['name'], 'files': files, 'methods': len(methods)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--binary', type=Path, help='also check exact executable API coverage')
    args = parser.parse_args()
    print(json.dumps(check(args.directory, args.binary), sort_keys=True))
