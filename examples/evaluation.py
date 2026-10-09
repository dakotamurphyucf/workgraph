#!/usr/bin/env python3
"""Measure an external Workgraph client's calls, independently of durable activity.

Import MeasuredClient to wrap any synchronous client with call(method, params).
Run this file with --help to evaluate an explicit JSONL workload. Standard library
only; no automatic retries, model runtime, or daemon-side measurement events.
"""
import argparse
from collections import deque
from dataclasses import dataclass, field
import importlib.util
import json
from pathlib import Path
import platform
import time


@dataclass
class CallStats:
    returned: int = 0
    raised: int = 0
    total_ns: int = 0
    min_ns: int | None = None
    max_ns: int = 0
    recent_ns: deque = field(default_factory=lambda: deque(maxlen=4096))

    def record(self, elapsed_ns, returned):
        self.returned += int(returned)
        self.raised += int(not returned)
        self.total_ns += elapsed_ns
        self.min_ns = elapsed_ns if self.min_ns is None else min(self.min_ns, elapsed_ns)
        self.max_ns = max(self.max_ns, elapsed_ns)
        self.recent_ns.append(elapsed_ns)

    def report(self):
        samples = sorted(self.recent_ns)
        count = self.returned + self.raised
        # Nearest-rank quantile of explicitly disclosed recent samples.
        def percentile(percent):
            return samples[(len(samples) * percent + 99) // 100 - 1] if samples else None
        return {
            "observed_calls": count, "returned": self.returned, "raised": self.raised,
            "latency_ns": {
                "total": self.total_ns, "min": self.min_ns, "max": self.max_ns,
                "mean": self.total_ns / count if count else None,
                "recent_sample_count": len(samples), "recent_sample_limit": 4096,
                "recent_p50": percentile(50), "recent_p95": percentile(95),
            },
        }


class MeasuredClient:
    """Single synchronous caller; in-memory measurements, explicit report saving.

    A returned call is not necessarily a committed write. Error classification is
    the wrapped client's responsibility: the supplied socket adapter raises on
    JSON-RPC errors. Exceptions, including cancellation, retain their identity.
    Hard process termination may lose observations. No request/response text is kept.
    """
    def __init__(self, client, *, clock_ns=time.monotonic_ns):
        self.client = client
        self.clock_ns = clock_ns
        self.methods = {}
        self.usage = {}

    def call(self, method, params):
        stats = self.methods.setdefault(method, CallStats())
        started = self.clock_ns()
        returned = False
        try:
            result = self.client.call(method, params)
            returned = True
            return result
        finally:
            stats.record(self.clock_ns() - started, returned)

    def report_usage(self, observation_id, *, input_tokens, output_tokens, provenance):
        """Add a provider/harness-supplied observation once; never infer usage.

        IDs must identify disjoint usage (e.g. one provider response), not cumulative
        snapshots or the same spending reported under different IDs. Input tokens
        include any cached input already counted by the provider; no cache addition.
        Exact duplicate IDs return False; conflicting content raises ValueError.
        """
        if not isinstance(observation_id, str) or not observation_id.strip():
            raise ValueError("usage observation ID must be nonblank")
        if not isinstance(provenance, str) or not provenance.strip():
            raise ValueError("usage provenance must be nonblank")
        if any(type(n) is not int or n < 0 for n in (input_tokens, output_tokens)):
            raise ValueError("token counts must be nonnegative integers")
        record = {"input_tokens": input_tokens, "output_tokens": output_tokens,
                  "provenance": provenance}
        previous = self.usage.get(observation_id)
        if previous is not None:
            if previous != record:
                raise ValueError("usage observation identity has different content")
            return False
        self.usage[observation_id] = record
        return True

    def report(self):
        methods = {name: stats.report() for name, stats in sorted(self.methods.items())}
        return {
            "scope": "this external client instance; completed observations only",
            "limits": [
                "Returned calls are not committed-write counts; exact retries count as calls.",
                "Raised calls include transport, protocol, domain and cancellation failures.",
                "Latency includes wrapped client work; no server/transport attribution.",
                "Recent quantiles use at most the last 4096 observations per method.",
                "No inference of model tokens, spending, productivity or causality.",
                "Hard termination can lose observations; this report is not a durable audit.",
            ],
            "observed_calls": sum(row["observed_calls"] for row in methods.values()),
            "methods": methods,
            "reported_usage": {
                "source": "explicit provider/harness observations; not measured by Workgraph",
                "input_tokens": sum(u["input_tokens"] for u in self.usage.values()),
                "output_tokens": sum(u["output_tokens"] for u in self.usage.values()),
                "observations": {key: dict(value) for key, value in sorted(self.usage.items())},
            },
        }


def load_workload(path):
    """Validate every JSONL entry before issuing any requests; blank lines ignored."""
    requests = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        request = json.loads(line)
        if (not isinstance(request, dict) or set(request) != {"method", "params"}
                or not isinstance(request["method"], str) or not request["method"].strip()
                or not isinstance(request["params"], dict)):
            raise ValueError(f"line {number}: expected method string and params object only")
        requests.append(request)
    return requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--requests", required=True, help="explicit JSONL method/params requests")
    parser.add_argument("--report", required=True, help="new local report file (never overwritten)")
    parser.add_argument("--label", default="explicit-workload", help="human workload/toolchain label")
    args = parser.parse_args()
    requests = load_workload(args.requests)
    spec = importlib.util.spec_from_file_location(
        "workgraph_history_adapter", Path(__file__).with_name("history-adapter.py"))
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    measured = MeasuredClient(adapter.Workgraph(args.socket))
    failed = False
    # Reserve the report path before any side effect; report failure cannot invite a
    # rerun just because an existing report was discovered after executing writes.
    with open(args.report, "x", encoding="utf-8") as output:
        try:
            for request in requests:
                try:
                    measured.call(request["method"], request["params"])
                except (OSError, EOFError, ValueError, RuntimeError):
                    failed = True
                    # Stop after an error: a transport error may be an uncertain write.
                    break
        finally:
            report = measured.report()
            report["workload"] = {"label": args.label, "requested_calls": len(requests),
                                  "platform": platform.platform(), "python": platform.python_version()}
            json.dump(report, output, ensure_ascii=False, sort_keys=True, indent=2)
            output.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
