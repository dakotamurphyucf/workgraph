# Measuring external workflows

The optional [evaluation.py helper](../scripts/evaluation.py) measures calls made by an
external agent or **harness**, the program that calls Workgraph and runs agent
processes. It uses Python's standard library and needs no daemon configuration.
Workspace activity tells you what committed; this wrapper also observes reads, failed
calls and transport retries. These are different measurements.

Use this recipe for a repeatable local workload comparison. Use [workspace
metrics](metrics.md) for retained workspace counters and capacity limits. Reports remain
local files unless you explicitly publish them.

## Measure a JSONL workload

Create a UTF-8 **JSONL** file: one JSON object per line, each with explicit `method` and
`params`. After [setting up workspace `demo`](getting-started.md), save these read-only
calls as your workload:

```jsonl
{"method":"workspace.get","params":{"workspace_id":"demo"}}
{"method":"fact.keys","params":{"workspace_id":"demo","scope":{"kind":"workspace"}}}
```

Set `SKILL` to this installed skill folder and replace the socket, workload and fresh
report paths. The report's parent must exist.

```sh
SKILL=/absolute/path/to/workgraph-skill
SOCKET=/absolute/private/workgraph.sock
WORKLOAD=/absolute/private/workload.jsonl
REPORT=/absolute/private/new-report.json

python3 "$SKILL/scripts/evaluation.py" --socket "$SOCKET" \
  --requests "$WORKLOAD" --report "$REPORT" \
  --label 'local retrieval comparison; record binary revision and workload here'
```

The tool validates the workload shape before executing it, reserves a fresh report file,
executes each request once and stops at the first error. Exit 0 means every wrapped call
returned; exit 1 means a recognized call failure. The report includes attempted calls,
returned/raised counts, nanosecond latency and platform information. Use read-only
workloads for repeatable retrieval comparisons. Writes execute real mutations: supply
explicit identities and preserve the workload for exact retries. Never rerun with new
mutation IDs merely because a transport response was lost. No automatic retry or durable
request journal is supplied by this measurement tool.

## Harness wrapper

Load [evaluation.py](../scripts/evaluation.py) as a Python module using `importlib.util`
(register the module in `sys.modules` before `exec_module`), then wrap your existing
synchronous client with `MeasuredClient(client)`. Its call(method, params) returns the
original result or propagates the original exception, including cancellation. The
wrapped client must raise on JSON-RPC error responses if you want them counted as
failures. The supplied [history adapter](../scripts/history-adapter.py) client does
this.

For example, with `evaluation` loaded and `client` set to your synchronous client:

```python
measured = evaluation.MeasuredClient(client)
result = measured.call('workspace.get', {'workspace_id': 'demo'})
measured.report_usage('provider-response-123', input_tokens=1200, output_tokens=80,
                      provenance='provider response usage fields')
report = measured.report()
```

report_usage counts explicitly supplied disjoint observations. Repeating the same ID and
content is ignored; changing its content fails. Do not report cumulative snapshots as
increments or duplicate the same provider response under different IDs. Input tokens
already include any cached input counted by the provider; cached input is not added
again. Zero observations means no usage was supplied, not that an agent used zero
tokens. Measurements are local until you explicitly save report().

## Interpret the report

Latency measures the entire wrapped synchronous call, including transport and client
processing; it does not isolate server time. Counts/min/max/mean cover all observed
calls. p50/p95 use nearest-rank quantiles from only the most recent 4096 observations
per method, with sample count and bound disclosed. Exact retries count as additional
calls even when they retrieve an existing durable receipt.

A returned call is not proof of a new committed write. A raised call can be an uncertain
write that actually committed. These counts neither measure provider spending nor
establish productivity/rework or causal benefit. Compare equivalent workloads and retain
the binary revision, platform, initial state and input sizes.

The wrapper keeps no request/response bodies or exception messages. It retains method
names and caller-provided usage IDs/provenance; choose those accordingly. It is for one
synchronous client, not shared concurrent access. Reports are ordinary local evaluation
output, not durable audit records; hard process termination can lose them. No per-query
workspace events or metrics service are created.
