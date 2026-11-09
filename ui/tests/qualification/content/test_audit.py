"""Self-contained evidence-audit controls; no workspace or saved run is required."""
from copy import deepcopy
from pathlib import Path
import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest

AUDIT = Path(__file__).with_name('audit.py')
MATRIX = json.loads(Path(__file__).with_name('matrix.json').read_text())


class ContentEvidenceAudit(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix='workgraph-content-audit-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

        def saved(name: str, value: object) -> dict:
            path = self.root / name
            raw = json.dumps(value).encode()
            path.write_bytes(raw)
            return dict(path=str(path), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())

        self.saved = saved
        code = saved('source.json', {'synthetic': True})
        code['path'] = 'source.json'
        inventory = saved('inputs.json', [code])
        artifacts = {name: saved(name, {'synthetic': name})
                     for name in ['companion', 'core', 'assets', 'inlineRunner', 'stateProcess']}
        def attached(name: str, value: object) -> dict:
            return dict(name=name, contentType='application/json',
                        body=base64.b64encode(json.dumps(value).encode()).decode())
        attachments = [
            attached('browser-diagnostics', {'failures': []}),
            attached('daemon-after-dispose', dict(errorsAlreadyObserved=[], process=dict(
                disposeStartedAt='synthetic', exit=dict(code=0)))),
            attached('companion-after-dispose', dict(errorsAlreadyObserved=[], process=dict(
                disposeStartedAt='synthetic', exit=dict(signal='SIGTERM'), stderrTail=''))),
        ]
        self.report = dict(errors=[], suites=[dict(specs=[dict(title='synthetic pass', tests=[
            dict(status='expected', results=[dict(status='passed', errors=[], attachments=attachments)])])])])
        report = saved('report.json', self.report)
        accepted = saved('accepted.json', dict(result=dict(data=dict(state=dict(kind='accepted'),
            generation='1', manifest=dict(manifest_id='synthetic', revision='1')))))
        completed = saved('completed.json', dict(result=dict(data=dict(completed=True,
            attempt=dict(state='completed')))))
        gate = saved('gate.json', dict(result=dict(data=dict(allowed=True))))
        submitted = saved('submitted.json', dict(result=dict(data=dict(state=dict(kind='submitted'),
            generation='1', manifest=dict(manifest_id='synthetic', revision='1')))))
        self.manifest = dict(format='workgraph-ui-content-qualification-1', sourceRoot=str(self.root),
            sourceInventory=inventory, candidate=artifacts, matrix=MATRIX,
            proofs=[dict(id='synthetic audit fixture', controlIds=[c['id'] for c in MATRIX['controls']],
                basis='current_candidate', sourceInventory=inventory, sourcePaths=['source.json'],
                artifacts=list(artifacts.values()), evidence=[], report=dict(kind='playwright', file=report,
                    cases=['synthetic pass'], nativeCases=['synthetic pass'], componentCases=[]))],
            editor=dict(generation='1', manifest=dict(id='synthetic', revision='1'),
                        acceptance=accepted, completion=completed, completionGate=gate, submission=submitted))

    def run_case(self, value: dict) -> subprocess.CompletedProcess:
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps(value))
        return subprocess.run([sys.executable, str(AUDIT), str(self.root), str(manifest),
                               str(self.root / 'result.json')], capture_output=True, text=True)

    def test_complete_synthetic_evidence_can_pass(self) -> None:
        result = self.run_case(self.manifest)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_runtime_source_cannot_pass(self) -> None:
        value = deepcopy(self.manifest)
        value['proofs'][0]['sourcePaths'].append('not-captured.ts')
        result = self.run_case(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Runtime source differs', result.stdout)

    def test_unexecuted_named_case_cannot_pass(self) -> None:
        value = deepcopy(self.manifest)
        value['proofs'][0]['report']['cases'].append('unexecuted synthetic claim')
        value['proofs'][0]['report']['nativeCases'].append('unexecuted synthetic claim')
        result = self.run_case(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Expected exactly one case', result.stdout)

    def test_missing_native_teardown_cannot_pass(self) -> None:
        value = deepcopy(self.manifest)
        report = deepcopy(self.report)
        result = report['suites'][0]['specs'][0]['tests'][0]['results'][0]
        result['attachments'] = [a for a in result['attachments'] if a['name'] != 'daemon-after-dispose']
        value['proofs'][0]['report']['file'] = self.saved('altered-report.json', report)
        result = self.run_case(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing required native diagnostic/teardown', result.stdout)

    def test_submission_is_not_acceptance(self) -> None:
        value = deepcopy(self.manifest)
        value['editor']['acceptance'] = value['editor']['submission']
        result = self.run_case(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Wrong accepted editor generation', result.stdout)


if __name__ == '__main__':
    unittest.main()
