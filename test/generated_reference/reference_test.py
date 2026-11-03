import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import html
import re

SCRIPT = Path(sys.argv.pop(1)).resolve()
BINARY = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location('reference', SCRIPT)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


def document(data):
    return [json.loads(body) for _, body in re.findall(r'^(`{3,})json\n(.*?)^\1$', data.decode(), re.M | re.S)]


def expand(schema):
    """Independent expansion oracle for the generator's local-only references."""
    definitions = schema.get('$defs', {})
    def visit(value):
        if isinstance(value, list):
            return [visit(item) for item in value]
        if not isinstance(value, dict):
            return value
        if set(value) == {'$ref'}:
            prefix = '#/$defs/'
            assert value['$ref'].startswith(prefix)
            return visit(definitions[value['$ref'][len(prefix):]])
        return {key: child if key in {'const', 'default', 'enum', 'examples'} or key.startswith('x-')
                else visit(child) for key, child in value.items()}
    return visit({key: value for key, value in schema.items() if key != '$defs'})


class ReferenceTest(unittest.TestCase):
    def catalog(self):
        return {'schema_dialect': 'https://json-schema.org/draft/2020-12/schema', 'methods': [
            {'name': 'ticket.demo', 'mode': 'read', 'tier': 'core', 'summary': 'Text ]]> with <markup> | and\nline break',
             'params': {'type': 'object', 'required': ['ticket_id'], 'properties': {'ticket_id': {'type': 'string'}}},
             'result': {'type': 'object', 'properties': {'data': {'type': 'string'}, 'meta': {'type': 'object'}}}}]}

    def test_structural_contract_is_recoverable_without_loss(self):
        catalog = self.catalog()
        files = reference.render(catalog)
        doc = document(files['ticket.demo.md'])
        self.assertIn(catalog['methods'][0]['summary'], html.unescape(files['ticket.demo.md'].decode()))
        self.assertEqual(len(doc), 2)
        self.assertEqual(doc[0], catalog['methods'][0]['params'])
        self.assertEqual(doc[1], catalog['methods'][0]['result'])
        self.assertEqual(files, reference.render(json.loads(json.dumps(catalog))))

    def test_read_only_check_and_guarded_regeneration(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'generated'
            files = reference.render(self.catalog())
            reference.reconcile(output, files, check=False)
            reference.reconcile(output, files, check=True)
            catalog = self.catalog()
            catalog['methods'][0]['name'] = 'ticket.renamed'
            updated = reference.render(catalog)
            with self.assertRaises(ValueError):
                reference.reconcile(output, updated, check=True)
            self.assertTrue((output / 'ticket.demo.md').exists())
            reference.reconcile(output, updated, check=False)
            self.assertFalse((output / 'ticket.demo.md').exists())
            reference.reconcile(output, updated, check=True)
            (output / 'private-note.md').write_text('retain this')
            with self.assertRaises(ValueError):
                reference.reconcile(output, files, check=False)
            self.assertEqual((output / 'private-note.md').read_text(), 'retain this')
            (output / 'private-note.md').unlink()
            (output / 'ticket.renamed.md').write_text('manual correction')
            with self.assertRaises(ValueError):
                reference.reconcile(output, files, check=False)
            self.assertEqual((output / 'ticket.renamed.md').read_text(), 'manual correction')

    def test_local_definitions_preserve_constraints_and_literal_data(self):
        shared = {'type': 'object', 'description': 'A complete attributed record with ```json and ```` fences. ' * 20,
                  'properties': {'id': {'type': 'string'}, 'enabled': {'type': 'boolean'}},
                  'required': ['id', 'enabled'], 'additionalProperties': False}
        literal = {'$ref': '#/$defs/not-a-schema', 'properties': shared}
        schema = {'type': 'object', 'properties': {'left': shared, 'right': shared},
                  'allOf': [{'not': False}, {'if': {'type': 'object'}, 'then': shared}],
                  'const': literal, 'default': literal, 'examples': [literal],
                  'x-extension-data': literal}
        original = json.loads(json.dumps(schema))
        compact = reference.compact_schema(schema)
        self.assertIn('$defs', compact)
        self.assertLess(len(json.dumps(compact)), len(json.dumps(schema)))
        self.assertEqual(expand(compact), schema)
        self.assertEqual(schema, original)
        self.assertEqual(compact['const'], literal)
        self.assertEqual(compact, reference.compact_schema(json.loads(json.dumps(schema))))
        for scope in ['$schema', '$id', '$anchor', '$ref', '$dynamicRef', '$defs']:
            scoped = {**schema, scope: {} if scope == '$defs' else 'existing-scope'}
            self.assertEqual(reference.compact_schema(scoped), scoped)

    def test_rejects_unsafe_names_duplicate_methods_and_malformed_manifest(self):
        for name in ['../escape', 'a/b', 'Ticket.get', 'ticket.get\n', 'index']:
            catalog = self.catalog()
            catalog['methods'][0]['name'] = name
            with self.assertRaises(ValueError):
                reference.render(catalog)
        catalog = self.catalog()
        catalog['methods'].append(catalog['methods'][0])
        with self.assertRaises(ValueError):
            reference.render(catalog)
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)
            (output / 'MANIFEST.json').write_text('[]')
            with self.assertRaises(ValueError):
                reference.reconcile(output, reference.render(self.catalog()), check=False)

    def test_actual_executable_catalog_has_exact_method_documents(self):
        catalog = json.loads(subprocess.check_output([str(BINARY), 'schema'], timeout=30))
        with tempfile.TemporaryDirectory() as root:
            command = [sys.executable, str(SCRIPT), '--binary', str(BINARY), '--output', root]
            generated = json.loads(subprocess.check_output(command, timeout=30))
            checked = json.loads(subprocess.check_output(command + ['--check'], timeout=30))
            self.assertEqual(generated['methods'], len(catalog['methods']))
            self.assertEqual(checked['status'], 'checked')
            for method in catalog['methods']:
                doc = document((Path(root) / (method['name'] + '.md')).read_bytes())
                self.assertEqual(expand(doc[0]), expand(method['params']))
                self.assertEqual(expand(doc[1]), expand(method['result']))
                text = (Path(root) / (method['name'] + '.md')).read_text()
                self.assertIn('common.md', text)
                self.assertIn('| Input | Presence | Type and constraints |', text)
                for name, _, _, _ in reference.input_fields(method['params'], method['params']):
                    self.assertIn('| `' + name + '` |', text)


if __name__ == '__main__':
    unittest.main()
