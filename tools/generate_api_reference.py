#!/usr/bin/env python3
"""Generate or check per-method references from the executable's actual codecs.

python3 tools/generate_api_reference.py --binary /path/workgraph --output docs/api-reference
Add --check for read-only drift detection. No daemon, network or third-party package.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.sax.saxutils


MANIFEST = 'MANIFEST.json'
NAME = re.compile(r'[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def cdata(value):
    return '<![CDATA[' + value.replace(']]>', ']]]]><![CDATA[>') + ']]>'


def map_schema_children(schema, transform):
    """Visit schema locations only; examples/default/const remain literal JSON."""
    if not isinstance(schema, dict):
        return schema
    maps = {'properties', 'patternProperties', 'dependentSchemas'}
    singles = {'items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems',
               'contains', 'propertyNames', 'not', 'if', 'then', 'else'}
    lists = {'allOf', 'anyOf', 'oneOf', 'prefixItems'}
    result = {}
    for key, value in sorted(schema.items()):
        if key in maps and isinstance(value, dict):
            result[key] = {name: transform(child) for name, child in sorted(value.items())}
        elif key in singles and isinstance(value, (dict, bool)):
            result[key] = transform(value)
        elif key in lists and isinstance(value, list):
            result[key] = [transform(child) for child in value]
        else:
            result[key] = value
    return result


def compact_schema(schema):
    """Factor exact repeated anonymous subschemas into local Draft 2020-12 $defs.

    Existing reference/base-URI scopes are left untouched. Definitions remain in
    the same document; no external resolver or extra agent file load is needed.
    """
    counts, originals = {}, {}
    scoped = False
    scope_keys = {'$schema', '$id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor',
                  '$recursiveRef', '$recursiveAnchor', '$defs', 'definitions'}
    def collect(value):
        nonlocal scoped
        if isinstance(value, dict):
            scoped = scoped or bool(scope_keys.intersection(value))
            key = canonical(value)
            counts[key] = counts.get(key, 0) + 1
            originals[key] = value
        return map_schema_children(value, collect)
    collect(schema)
    if scoped:
        return schema
    repeated = sorted(key for key, count in counts.items() if count > 1 and len(key) >= 384)
    names = {key: 'shape_%03d' % index for index, key in enumerate(repeated, 1)}
    def replace(value):
        name = names.get(canonical(value)) if isinstance(value, dict) else None
        return {'$ref': '#/$defs/' + name} if name else map_schema_children(value, replace)
    result = map_schema_children(schema, replace)
    if names:
        result['$defs'] = {name: map_schema_children(originals[key], replace)
                           for key, name in names.items()}
    return result if len(canonical(result)) < len(canonical(schema)) else schema


def dereference(schema, document):
    while isinstance(schema, dict) and set(schema) == {'$ref'}:
        reference = schema['$ref']
        if not reference.startswith('#/$defs/'):
            raise ValueError('reference must resolve offline within its schema document')
        schema = document['$defs'][reference[len('#/$defs/'):]]
    return schema


def input_fields(schema, document):
    schema = dereference(schema, document)
    fields = [(name, child, name in schema.get('required', []), False)
              for name, child in schema.get('properties', {}).items()]
    for child in schema.get('allOf', []):
        fields.extend(input_fields(child, document))
    branches = [input_fields(child, document) for child in schema.get('oneOf', [])]
    for name in sorted({row[0] for branch in branches for row in branch}):
        declarations = [row for branch in branches for row in branch if row[0] == name]
        schemas = {canonical(row[1]): row[1] for row in declarations}
        child = next(iter(schemas.values())) if len(schemas) == 1 else {'anyOf': list(schemas.values())}
        required = len(declarations) == len(branches) and all(row[2] and not row[3] for row in declarations)
        conditional = len(declarations) < len(branches) or (not required and any(row[2] for row in declarations))
        fields.append((name, child, required, conditional))
    return fields


def input_shape(schema, document):
    schema = dereference(schema, document)
    if 'allOf' in schema:
        return '; '.join(filter(None, [input_shape(child, document) for child in schema['allOf']] +
                                  [schema.get('description', '')]))
    alternatives = schema.get('anyOf', schema.get('oneOf', []))
    if alternatives:
        return ' | '.join(input_shape(child, document) for child in alternatives) if len(alternatives) <= 2 else 'tagged alternatives; see complete schema'
    kind = schema.get('type', 'JSON')
    if kind == 'object' and schema.get('required'):
        kind += ' (requires ' + ', '.join(schema['required']) + ')'
    for key, label in [('enum', 'enum'), ('const', 'constant'), ('pattern', 'pattern'),
                       ('maxItems', 'max items'), ('x-maxUtf8Bytes', 'max UTF-8 bytes'),
                       ('x-maximumDecimal', 'maximum decimal'), ('x-maxCanonicalBytes', 'max canonical bytes'),
                       ('x-maxDepth', 'max depth')]:
        if key in schema:
            kind += '; ' + label + '=' + canonical(schema[key])
    if schema.get('description'):
        kind += '; ' + schema['description']
    return kind


def table_cell(text):
    return xml.sax.saxutils.escape(text).replace('|', '&#124;').replace('\n', ' ')


def input_overview(method):
    text = method['summary'] + '\n\nTier: `' + method['tier'] + '`. '
    text += 'The result is `{data, meta}`; see [common envelopes and types](common.md).\n\n'
    text += '| Input | Presence | Type and constraints |\n| --- | --- | --- |\n'
    for name, schema, required, conditional in sorted(input_fields(method['params'], method['params'])):
        presence = 'conditional' if conditional else 'required' if required else 'optional'
        shape = ('array of `{method, params, as?}`; 1..32 ordered operations' if
                 method['name'] == 'transaction.apply' and name == 'operations' else input_shape(schema, method['params']))
        text += '| `' + name + '` | ' + presence + ' | ' + table_cell(shape) + ' |\n'
    if method['name'] == 'transaction.apply':
        text += '\nCreation aliases are unique 1..96-byte ASCII IDs declared with `as`. '
        text += '`$alias` resolves only earlier creations in typed reference fields, never arbitrary text. '
        text += 'Use `help METHOD` for each operation; the schema below lists the complete operation union.\n'
    text += '\nFor preconditions and a small example, run `workgraph help ' + method['name'] + '`. '
    text += 'Use `--full` for the complete contracts below.\n\n'
    return text


def render(catalog):
    if (not isinstance(catalog, dict) or set(catalog) != {'schema_dialect', 'methods'} or
            catalog['schema_dialect'] != 'https://json-schema.org/draft/2020-12/schema' or
            not isinstance(catalog['methods'], list) or not catalog['methods']):
        raise ValueError('expected nonempty executable method catalog')
    files = {}
    rows = []
    methods = catalog['methods']
    names = set()
    for method in methods:
        if (not isinstance(method, dict) or set(method) != {'name', 'mode', 'summary', 'tier', 'params', 'result'} or
                not isinstance(method['name'], str) or not NAME.fullmatch(method['name']) or
                method['mode'] not in {'read', 'write', 'mutation'} or method['tier'] not in {'core', 'advanced'} or not isinstance(method['summary'], str) or
                not isinstance(method['params'], dict) or not isinstance(method['result'], dict)):
            raise ValueError('invalid executable method description')
        name = method['name']
        if name in {'index', 'common'}:
            raise ValueError('method name conflicts with the generated index')
        if name in names:
            raise ValueError('duplicate method name: ' + name)
        names.add(name)
        rows.append((name, method['mode'], method['tier'], method['summary']))
        text = '# ' + name + '\n\nGenerated from the executable codecs. Do not edit this file.\n\n'
        text += input_overview(method)
        text += '```xml\n<workgraph_method name="' + name + '" mode="' + method['mode'] + '">\n'
        text += '<summary>' + cdata(method['summary']) + '</summary>\n'
        for label, key in [('request_schema', 'params'), ('result_schema', 'result')]:
            text += '<' + label + ' dialect="https://json-schema.org/draft/2020-12/schema">\n'
            text += cdata(json.dumps(compact_schema(method[key]), ensure_ascii=False, indent=2)) + '\n'
            text += '</' + label + '>\n'
        text += '</workgraph_method>\n```\n'
        files[name + '.md'] = text.encode()
    intro = '''# Generated API reference

These files come from `workgraph schema`, using the same executable declarations
that validate requests and results. Load one method when needed. For daemon setup,
workflows, retry rules and feature discovery, start with [the agent guide](../../AGENT_GUIDE.md).

Each method file describes its params object and complete result `{data,meta}`.
Begin with the concise input table. Use `workgraph methods --core` for the everyday
tier and `workgraph help METHOD` for a small example and preconditions. CLI helpers
such as `init` are local workflows, separately labelled in the CLI index. See
[common envelopes and types](common.md). Repeated schemas use named local `$defs`
and `$ref` within that same schema block.
Definitions preserve all original fields and validation annotations; no external
file or network lookup is needed. Start at `properties`, then follow needed shapes.
The transport wraps this result in JSON-RPC. `read` has no write effect; `write`
changes state without a durable retry receipt; `mutation` uses a saved retry
identity. Respect each method's more specific contract.

Counters are canonical decimal strings. `x-maxUtf8Bytes`, `x-maximumDecimal` and
other extension annotations describe checks ordinary JSON Schema validators may
ignore. Mapped domain invariants also appear in descriptions; runtime validation
is authoritative. Do not infer permission or operational policy from a schema.

Regenerate with `python3 tools/generate_api_reference.py --binary /absolute/workgraph
--output docs/api-reference`; add `--check` to detect drift without writing files.

| Method | Tier | Effect | Purpose |
| --- | --- | --- | --- |
'''
    for name, mode, tier, summary in sorted(rows):
        # Escape table syntax and markup without changing the exact method contract.
        summary = xml.sax.saxutils.escape(summary).replace('|', '&#124;').replace('\n', ' ')
        intro += f'| [{name}]({name}.md) | {tier} | {mode} | {summary} |\n'
    files['index.md'] = intro.encode()
    metadata_document = methods[0]['result']
    metadata = metadata_document.get('properties', {}).get('meta', {})
    metadata = dereference(metadata, metadata_document)
    # Keep copied metadata references resolvable in this standalone schema block.
    if '$defs' in metadata_document:
        metadata = {**metadata, '$defs': metadata_document['$defs']}
    common = '# Common envelopes and types\n\nGenerated from executable codecs.\n\n'
    common += 'Every success returns `{data, meta}` inside the JSON-RPC result. '
    common += '`data` is method-specific; `meta` preserves workspace/query revisions, '
    common += 'durability, immutable captures and bounded-output diagnostics when applicable.\n\n'
    common += 'Counters and revisions are canonical nonnegative decimal strings; IDs use their declared codec grammar. '
    common += '`at_revision` guards consistency of current state; it does not request historical state. '
    common += 'Entity revisions, immutable resource versions and workspace revisions are different guards.\n\n'
    common += 'Each method schema uses local `$defs` references, with no network or other file required for resolution. '
    common += 'Extension bounds and mapped invariants remain authoritative in runtime validation.\n\n'
    common += '```json\n' + json.dumps(metadata, ensure_ascii=False, indent=2) + '\n```\n'
    files['common.md'] = common.encode()
    manifest = {'generator': 'workgraph-api-reference', 'method_count': len(methods),
                'catalog_sha256': sha(canonical(catalog).encode()),
                'files': {name: sha(data) for name, data in sorted(files.items())}}
    files[MANIFEST] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    return files


def reconcile(directory, files, *, check):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError('output directory must not be a symlink')
    existing = set()
    if directory.exists():
        if not directory.is_dir():
            raise ValueError('output must be a directory')
        for path in directory.iterdir():
            if path.is_symlink() or not path.is_file():
                raise ValueError('generated directory must contain only regular files')
            existing.add(path.name)
    if check:
        if existing != set(files):
            raise ValueError('generated file set differs from current executable')
        changed = [name for name, data in files.items() if (directory / name).read_bytes() != data]
        if changed:
            raise ValueError('generated reference drift: ' + ', '.join(sorted(changed)))
        return
    if existing:
        if MANIFEST not in existing:
            raise ValueError('refusing to replace an unmanaged directory')
        previous = json.loads((directory / MANIFEST).read_text())
        owned = previous.get('files') if isinstance(previous, dict) else None
        if (not isinstance(previous, dict) or previous.get('generator') != 'workgraph-api-reference' or not isinstance(owned, dict) or
                set(owned) | {MANIFEST} != existing):
            raise ValueError('generated directory contains unowned files or an invalid manifest')
        for name, digest in owned.items():
            if (directory / name).name != name or sha((directory / name).read_bytes()) != digest:
                raise ValueError('generated file was edited; preserve it before regenerating: ' + name)
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (directory / name).write_bytes(data)
    for name in existing - set(files):
        (directory / name).unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    catalog = json.loads(subprocess.check_output([str(binary), 'schema'], timeout=30))
    files = render(catalog)
    reconcile(args.output, files, check=args.check)
    print(canonical({'status': 'checked' if args.check else 'generated',
                     'methods': len(catalog['methods']), 'files': len(files)}))


if __name__ == '__main__':
    main()
