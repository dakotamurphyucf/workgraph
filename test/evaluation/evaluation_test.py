import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("evaluation", sys.argv.pop(1))
evaluation = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = evaluation
spec.loader.exec_module(evaluation)


class Client:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class EvaluationTest(unittest.TestCase):
    def test_result_failure_cancellation_and_latencies(self):
        result = {"data": {"secret": "never log me"}, "meta": {"durable": True}}
        source = Client(result)
        clock = iter([100, 110, 200, 230, 400, 450])
        client = evaluation.MeasuredClient(source, clock_ns=lambda: next(clock))
        self.assertIs(client.call("ticket.get", {"secret": "not logged"}), result)
        error = RuntimeError("sensitive server response")
        source.result = error
        with self.assertRaises(RuntimeError) as raised:
            client.call("ticket.get", {})
        self.assertIs(raised.exception, error)
        source.result = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            client.call("ticket.get", {})
        report = client.report()
        self.assertEqual(report["observed_calls"], 3)
        row = report["methods"]["ticket.get"]
        self.assertEqual((row["returned"], row["raised"]), (1, 2))
        self.assertEqual(row["latency_ns"], {
            "total": 90, "min": 10, "max": 50, "mean": 30.0,
            "recent_sample_count": 3, "recent_sample_limit": 4096,
            "recent_p50": 30, "recent_p95": 50})
        self.assertNotIn("secret", json.dumps(report))
        self.assertNotIn("sensitive", json.dumps(report))
        self.assertEqual(len(source.calls), 3)

    def test_explicit_usage_and_snapshot_isolation(self):
        client = evaluation.MeasuredClient(Client(None))
        args = dict(input_tokens=12, output_tokens=3, provenance="provider response p1")
        self.assertTrue(client.report_usage("p1", **args))
        self.assertFalse(client.report_usage("p1", **args))
        with self.assertRaises(ValueError):
            client.report_usage("p1", **{**args, "output_tokens": 4})
        for invalid in [True, -1, 1.5, "12"]:
            with self.assertRaises(ValueError):
                client.report_usage("p2", **{**args, "input_tokens": invalid})
        old = client.report()
        old["reported_usage"]["observations"]["p1"]["input_tokens"] = 900
        self.assertEqual(client.report()["reported_usage"]["input_tokens"], 12)
        self.assertEqual(client.report()["observed_calls"], 0)

    def test_sample_window_does_not_change_totals(self):
        stats = evaluation.CallStats()
        for n in range(5000):
            stats.record(n, True)
        row = stats.report()
        self.assertEqual(row["observed_calls"], 5000)
        self.assertEqual(row["latency_ns"]["total"], 12497500)
        self.assertEqual(row["latency_ns"]["recent_sample_count"], 4096)
        self.assertEqual(row["latency_ns"]["min"], 0)
        self.assertEqual(row["latency_ns"]["max"], 4999)

    def test_workload_validation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "requests.jsonl"
            path.write_text('{"method":"workspace.get","params":{}}\n\n')
            self.assertEqual(len(evaluation.load_workload(path)), 1)
            path.write_text('{"method":"workspace.get","params":{}}\n{"method":1,"params":{}}')
            with self.assertRaises(ValueError):
                evaluation.load_workload(path)


if __name__ == "__main__":
    unittest.main()
