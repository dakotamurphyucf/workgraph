# Measuring external workflows

```xml
<workgraph_reference topic="evaluation">
<purpose><![CDATA[
examples/evaluation.py measures calls made by an external agent or harness. It is
optional, uses Python's standard library, and requires no daemon configuration.
Workspace activity tells you what committed; this wrapper also observes reads,
failed calls and transport retries. These are different measurements.
]]></purpose>
<workload_cli><![CDATA[
Create a UTF-8 JSONL file containing one explicit {"method":...,"params":...} object
per line. For example, after creating workspace demo:

{"method":"workspace.get","params":{"workspace_id":"demo"}}
{"method":"fact.keys","params":{"workspace_id":"demo","scope":{"kind":"workspace"}}}

python3 examples/evaluation.py --socket /absolute/workgraph.sock \
  --requests /absolute/workload.jsonl --report /absolute/new-report.json \
  --label 'local retrieval comparison; record binary revision and workload here'

The tool validates the workload shape before executing it, reserves a fresh report
file, executes each request once and stops at the first error. Exit 0 means every
wrapped call returned; exit 1 means a recognized call failure. The report includes
attempted calls, returned/raised counts, nanosecond latency and platform information.
Use read-only workloads for repeatable retrieval comparisons. Writes execute real
mutations: supply explicit identities and preserve the workload for exact retries.
Never rerun with new mutation IDs merely because a transport response was lost.
No automatic retry or durable request journal is supplied by this measurement tool.
]]></workload_cli>
<harness_wrapper><![CDATA[
Load examples/evaluation.py as a Python module using importlib.util (register the
module in sys.modules before exec_module), then wrap your existing synchronous
client with MeasuredClient(client). Its call(method, params) returns the original
result or propagates the original exception, including cancellation. The wrapped
client must raise on JSON-RPC error responses if you want them counted as failures.
The supplied examples/history-adapter.py client does this.

measured = evaluation.MeasuredClient(client)
result = measured.call('workspace.get', {'workspace_id': 'demo'})
measured.report_usage('provider-response-123', input_tokens=1200, output_tokens=80,
                      provenance='provider response usage fields')
report = measured.report()

report_usage counts explicitly supplied disjoint observations. Repeating the same
ID and content is ignored; changing its content fails. Do not report cumulative
snapshots as increments or duplicate the same provider response under different
IDs. Input tokens already include any cached input counted by the provider; cached
input is not added again. Zero observations means no usage was supplied, not that
an agent used zero tokens. Measurements are local until you explicitly save report().
]]></harness_wrapper>
<interpretation><![CDATA[
Latency measures the entire wrapped synchronous call, including transport and
client processing; it does not isolate server time. Counts/min/max/mean cover all
observed calls. p50/p95 use nearest-rank quantiles from only the most recent 4096
observations per method, with sample count and bound disclosed. Exact retries count
as additional calls even when they retrieve an existing durable receipt.

A returned call is not proof of a new committed write. A raised call can be an
uncertain write that actually committed. These counts neither measure provider
spending nor establish productivity/rework or causal benefit. Compare equivalent
workloads and retain the binary revision, platform, initial state and input sizes.

The wrapper keeps no request/response bodies or exception messages. It retains
method names and caller-provided usage IDs/provenance; choose those accordingly.
It is for one synchronous client, not shared concurrent access. Reports are ordinary
local evaluation output, not durable audit records; hard process termination can
lose them. No per-query workspace events or metrics service are created.
]]></interpretation>
</workgraph_reference>
```
