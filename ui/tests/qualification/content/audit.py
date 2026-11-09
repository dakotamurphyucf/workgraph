#!/usr/bin/env python3
"""Validate this content gate's pinned evidence; never run or infer product tests.

Usage: python3 ui/tests/qualification/content/audit.py REPO MANIFEST OUTPUT
Historical reports keep their original artifacts. Only explicitly selected passing
cases count; a broader report's unrelated failures are not called a full pass.
"""
from pathlib import Path
import base64
import hashlib
import json
import sys

repo, manifest_file, output = map(Path, sys.argv[1:])
manifest = json.loads(manifest_file.read_text())
failures: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def checked(pin: dict) -> Path:
    path = Path(pin['path'])
    path = path if path.is_absolute() else repo / path
    raw = path.read_bytes()
    require(len(raw) == pin['bytes'], f"Size mismatch: {path}")
    require(hashlib.sha256(raw).hexdigest() == pin['sha256'], f"Hash mismatch: {path}")
    return path


def inventory(pin: dict) -> dict:
    value = json.loads(checked(pin).read_text())
    if not isinstance(value, list):
        value = next((value[k] for k in ['files', 'inputs', 'sources'] if isinstance(value.get(k), list)), None)
    require(isinstance(value, list), 'Missing captured file inventory')
    result = {entry['path']: entry for entry in value}
    require(len(result) == len(value), 'Duplicate captured source path')
    return result


def specs(value: dict) -> list[dict]:
    result = [value] if 'tests' in value and 'title' in value else []
    for key in ['suites', 'specs']:
        for child in value.get(key, []):
            result.extend(specs(child))
    return result


def selected_report(report: dict) -> int:
    value = json.loads(checked(report['file']).read_text())
    cases = report['cases']
    require(bool(cases) and len(set(cases)) == len(cases), 'Empty/duplicate case selection')
    if report['kind'] == 'vitest':
        tests = {row['name'].split('/tests/')[-1] + '::' + case['fullName']: case
                 for row in value['testResults'] for case in row['assertionResults']}
        for name in cases:
            require(name in tests and tests[name]['status'] == 'passed'
                    and not tests[name]['failureMessages'], f'Pure case did not pass: {name}')
    elif report['kind'] == 'playwright':
        require(not value.get('errors'), 'Browser runner errors')
        all_specs = specs(value)
        native = report['nativeCases']
        component = report['componentCases']
        require(not (set(native) & set(component)) and set(native) | set(component) == set(cases),
                'Missing/ambiguous browser proof class')
        for name in cases:
            matches = [case for case in all_specs if case['title'] == name]
            require(len(matches) == 1, f'Expected exactly one case: {name}')
            require(bool(matches[0]['tests']), f'No project test: {name}')
            for test in matches[0]['tests']:
                require(test['status'] == 'expected' and len(test['results']) == 1,
                        f'Skipped/flaky/retried/unexpected: {name}')
                result = test['results'][0]
                if name in native:
                    attached = {a['name'] for a in result.get('attachments', [])
                                if a.get('body') is not None and a['contentType'] == 'application/json'}
                    require({'browser-diagnostics', 'daemon-after-dispose', 'companion-after-dispose'} <= attached,
                            f'Missing required native diagnostic/teardown attachment: {name}')
                require(result['status'] == 'passed' and not result.get('errors'), f'Browser case failed: {name}')
                for attachment in result.get('attachments', []):
                    if 'body' not in attachment or attachment['contentType'] != 'application/json':
                        continue
                    diagnostic = json.loads(base64.b64decode(attachment['body']))
                    if attachment['name'] == 'browser-diagnostics':
                        require(not diagnostic['failures'], f'Browser diagnostics: {name}')
                    if attachment['name'] in ['daemon-after-dispose', 'companion-after-dispose']:
                        require(not diagnostic['errorsAlreadyObserved'], f'Teardown errors: {name}')
                        process = diagnostic['process']
                        require(process['disposeStartedAt'] is not None and process['exit'] is not None,
                                f'Owned process not reaped: {name}')
                        if attachment['name'] == 'daemon-after-dispose':
                            require(process['exit']['code'] == 0, f'Daemon exit: {name}')
                        else:
                            require(process['exit']['signal'] == 'SIGTERM' and process['stderrTail'] == '',
                                    f'Companion exit: {name}')
    elif report['kind'] == 'command_log':
        require(value.get('exit_code') == 0 or value.get('result') == 'PASS', 'Command report failed')
        text = checked(report['log']).read_text()
        require(f"{report['passed']} passed (" in text and ' failed (' not in text, 'Log final count failed')
        for name in cases:
            require(name in text, f'Named passing case absent from command log: {name}')
    else:
        raise ValueError('Unsupported evidence report')
    return len(cases)


require(manifest['format'] == 'workgraph-ui-content-qualification-1', 'Wrong manifest')
require(manifest['matrix'] == json.loads(Path(__file__).with_name('matrix.json').read_text()),
        'Manifest does not match the fixed content requirements')
final = inventory(manifest['sourceInventory'])
for source in final.values():
    path = Path(manifest['sourceRoot']) / source['path']
    raw = path.read_bytes()
    require(len(raw) == source['bytes'] and hashlib.sha256(raw).hexdigest() == source['sha256'],
            f'Verification source changed: {source["path"]}')
for pin in manifest['candidate'].values():
    checked(pin)
results = []
covered: set[str] = set()
for proof in manifest['proofs']:
    errors = []
    count = 0
    try:
        original = inventory(proof['sourceInventory'])
        require(bool(proof['sourcePaths']), 'No source applicability paths')
        for path in proof['sourcePaths']:
            require(path in original and path in final and original[path] == final[path],
                    f'Runtime source differs: {path}')
        for pin in proof['artifacts'] + proof['evidence']:
            checked(pin)
        require(bool(proof['artifacts']), 'No original candidate artifacts')
        if proof['basis'] == 'current_candidate':
            observed = {Path(p['path']).name: p['sha256'] for p in proof['artifacts']}
            for pin in manifest['candidate'].values():
                require(observed.get(Path(pin['path']).name) == pin['sha256'], 'Current candidate artifact mismatch')
        count = selected_report(proof['report'])
    except (ValueError, KeyError, OSError, TypeError) as error:
        errors.append(str(error))
    if not errors:
        covered.update(proof['controlIds'])
    results.append(dict(id=proof['id'], passed=not errors, selectedCases=count, failures=errors))
editor_accepted = False
try:
    editor = manifest['editor']
    accepted = json.loads(checked(editor['acceptance']).read_text())['result']['data']
    completion = json.loads(checked(editor['completion']).read_text())['result']['data']
    gate = json.loads(checked(editor['completionGate']).read_text())['result']['data']
    checked(editor['submission'])
    require(accepted['state']['kind'] == 'accepted' and accepted['generation'] == editor['generation']
            and accepted['manifest']['manifest_id'] == editor['manifest']['id']
            and accepted['manifest']['revision'] == editor['manifest']['revision'], 'Wrong accepted editor generation')
    require(completion['completed'] and completion['attempt']['state'] == 'completed' and gate['allowed'],
            'Editor not completed through allowed gate')
    editor_accepted = True
except (ValueError, KeyError, OSError, TypeError) as error:
    failures.append(str(error))
controls = {c['id'] for c in manifest['matrix']['controls']}
require(len(controls) == len(manifest['matrix']['controls']), 'Duplicate matrix control')
for requirement in manifest['matrix']['requirements']:
    require(bool(requirement['controls']) and set(requirement['controls']) <= controls, 'Unknown/empty requirement controls')
missing = sorted(controls - covered)
result = dict(format='workgraph-ui-content-audit-1', manifest=dict(path=str(manifest_file),
              bytes=manifest_file.stat().st_size, sha256=hashlib.sha256(manifest_file.read_bytes()).hexdigest()),
              proofs=results, editorAccepted=editor_accepted, missingControls=missing, failures=failures,
              readyForReview=editor_accepted and not missing and not failures and all(r['passed'] for r in results))
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
sys.exit(0 if result['readyForReview'] else 1)
