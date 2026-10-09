"""External measured calls include exact retries and failures, without extra commits."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon_ready import is_listening

EXE = Path(sys.argv.pop(1)).resolve()
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "examples/evaluation.py"
spec = importlib.util.spec_from_file_location("history_adapter", ROOT / "examples/history-adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class SocketEvaluationTest(unittest.TestCase):
    def test_real_calls_retry_failure_stop_and_reserved_report(self):
        with tempfile.TemporaryDirectory(prefix="wg-eval-", dir="/tmp") as temporary:
            root = Path(temporary)
            address = root / "socket"
            with (root / "daemon.log").open("w+") as log:
                daemon = subprocess.Popen([str(EXE), "serve", str(root / "registry"), str(address)],
                                          stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 10
                    while not is_listening(address):
                        if daemon.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.01)
                    create = {"method": "workspace.create", "params": {
                        "workspace_id": "demo", "actor_id": "agent", "mutation_id": "create",
                        "name": "Evaluation", "root": str(root / "workspace")}}
                    workload = [create, create,
                                {"method": "workspace.get", "params": {"workspace_id": "demo"}},
                                {"method": "not.a.method", "params": {}},
                                {"method": "daemon.shutdown", "params": {}}]
                    requests = root / "workload.jsonl"
                    requests.write_text("\n".join(json.dumps(r) for r in workload))
                    report_path = root / "report.json"
                    argv = [sys.executable, str(SCRIPT), "--socket", str(address),
                            "--requests", str(requests), "--report", str(report_path)]
                    run = subprocess.run(argv, text=True, capture_output=True, timeout=20)
                    self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
                    report = json.loads(report_path.read_text())
                    self.assertEqual(report["observed_calls"], 4)
                    self.assertEqual(report["methods"]["workspace.create"]["returned"], 2)
                    self.assertEqual(report["methods"]["not.a.method"]["raised"], 1)
                    self.assertNotIn("daemon.shutdown", report["methods"])
                    self.assertIsNone(daemon.poll())
                    original_report = report_path.read_bytes()
                    requests.write_text(json.dumps(workload[-1]))
                    repeat = subprocess.run(argv, text=True, capture_output=True, timeout=20)
                    self.assertNotEqual(repeat.returncode, 0)
                    self.assertEqual(report_path.read_bytes(), original_report)
                    self.assertIsNone(daemon.poll())
                    # Exercise the documented read-only workload against the actual API.
                    requests.write_text('\n'.join(json.dumps(request) for request in [
                        workload[2], {"method": "fact.keys", "params": {
                            "workspace_id": "demo", "scope": {"kind": "workspace"}}}]))
                    argv[-1] = str(root / "read-report.json")
                    reads = subprocess.run(argv, text=True, capture_output=True, timeout=20)
                    self.assertEqual(reads.returncode, 0, reads.stdout + reads.stderr)
                    self.assertEqual(json.loads(Path(argv[-1]).read_text())["observed_calls"], 2)
                    adapter.Workgraph(address).call("daemon.shutdown", {})
                    self.assertEqual(daemon.wait(timeout=10), 0)
                finally:
                    if daemon.poll() is None:
                        daemon.terminate()
                        daemon.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
