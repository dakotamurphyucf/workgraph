# Token usage and cost in History

A history session is a recorded event collection. A run is an attributed agent
invocation, and an attempt is one try at a ticket. A session may name a run when
created; `run.link_session` also connects an existing session. Attempts can retain
session references, but usage attribution follows the usage record’s actual run
or attempt scope, not a guessed connection based on time or actor.

The History overview reads `usage.aggregate` grouped by run, with nested metrics.
It counts each run once, including its attempt reports. If `run.sessions` reports
exactly one associated session, the row shows that session’s title. Otherwise it
shows a shared run total. A run with three sessions does not contribute three
copies of its spending.

An individual session can be associated with **multiple runs**. Its header sums
the usage of each distinct associated run once. When all those runs have only this
session, that is displayed as **Session cost**. When a run also has other sessions,
the header says **Associated run cost** and identifies shared totals; that figure
is not an exact cost allocation to one session. Workspace totals stay grouped by
run and never add up session headers, which could overlap. This does not claim a
transcript contains every request made by its associated runs.

## Recording useful measurements

Use existing `usage.report`. Reports are immutable, additive observations; emit a
non-overlapping measured interval or request exactly once, using a stable usage ID
and the usual saved mutation identity. Never send cumulative lifetime totals as
successive additive reports. Never report the same spending at both run and
attempt scope. The native store does not detect provider-level overlap for you.

In addition to the required `tokens` and `elapsed_ms`, these named integer samples
have a defined meaning in the History dashboard:

| Name | Unit | Meaning |
| --- | --- | --- |
| `input_tokens` | `tokens` | Total input, including cache reads and writes if applicable |
| `output_tokens` | `tokens` | Total output, including billed reasoning where supplied |
| `cached_input_tokens` | `tokens` | Cache-read subset of input; do not add it to input again |
| `reasoning_output_tokens` | `tokens` | Reasoning subset of output; do not add it again |
| `cost_usd_micros` | `microUSD` | Caller-reported cost, one million units per USD |
| `estimated_cost_usd_micros` | `microUSD` | Calculated estimate, one million units per USD |

Use only one cost sample per report. Sort the metric array by name as required by
the API. Other custom names/units remain supported in Usage reports, but the UI
does not guess that an arbitrary sample is a token count or price. A missing
measure remains unknown. A measured zero is valid. If only some reports contain
a metric, the dashboard labels that figure partial. Integer overflow is disclosed.

For example, one non-overlapping report might contain:

```json
{
  "usage_id": "request-42-usage",
  "scope": {"kind": "run", "run_id": "worker-run"},
  "reported_actor_id": "worker",
  "tokens": "1100000",
  "elapsed_ms": "12000",
  "metrics": [
    {"name": "cached_input_tokens", "unit": "tokens", "value": "500000"},
    {"name": "estimated_cost_usd_micros", "unit": "microUSD", "value": "2100000"},
    {"name": "input_tokens", "unit": "tokens", "value": "1000000"},
    {"name": "output_tokens", "unit": "tokens", "value": "100000"}
  ],
  "provenance": "Illustrative rates only: USD/million ordinary input=2, cached=0.2, output=10. Record the actual model, service tier, effective date and price source in real reports.",
  "timestamp": "2026-11-09T00:00:00Z"
}
```

Supply workspace, actor and mutation fields through the normal CLI context/request
flow. These are illustrative numbers, not current provider prices.

## Calculating an estimate

The Report usage dialog has a calculator. Enter measured input, cached-input and
output counts plus applicable USD-per-million rates. The calculator subtracts
cached input from ordinary input, prices the two categories separately, then adds
output cost. It uses exact integer arithmetic and rounds once to micro-USD.
**Use estimate in this draft** updates the token/cost samples and records the
pricing basis in provenance. Review and Apply still control the durable write.

The calculator covers these three categories only. Different cache-write
lifetimes, context-length bands, batch/priority tiers, images, audio, server tools,
regional surcharges and negotiated rates may require separate calculations. Do
not enter an ordinary-input price as a substitute for unknown specialized rates.
Supply the correctly calculated cost as a report instead. A cost estimate is not
a verified invoice; subscription use is not necessarily billed at API rates.

Use the applicable provider price source, such as [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
or [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Workgraph does not fetch prices or silently reprice historical reports.

## Reading source histories correctly

OpenAI response usage is attached to a response, not every message/tool item in its
output. If you import each item as a separate event, keep the corresponding usage
record separately and report that response’s consumption once. Cached input and
reasoning are breakdowns of input/output, not additional totals.

Observed Codex logs contain `token_usage_record` with a `response_id` and per-response
`usage`, alongside `turn_token_usage` and `thread_token_usage` cumulative snapshots.
The `event_msg.token_count` record may repeat the same observation. Prefer one
validated per-response record per unique response ID; detect conflicting repeats
instead of blindly adding them. Do not add the cumulative snapshots too. Older
logs may not provide this form; they need a source-specific importer policy rather
than an assumed conversion. Preserve the coverage interval in provenance.

Anthropic input tokens may be reported separately from cache-read and cache-write
input. Normalize the dashboard’s input total deliberately and price each category
at the correct rate. Claude SDK cost/usage fields can have different extents:
query-pipeline cumulative cost, per-turn/main-agent usage, and subagent activity
are not automatically the same scope. Raw Claude Code assistant messages can also
contain repeated IDs or branch records. An importer must establish its actual
accounting interval and deduplicate before writing additive reports.

The UI displays recorded measurements; viewing a history does not automatically
create usage reports. Importers and harnesses own measurement, pricing and durable
reporting. This keeps the generic history service independent of provider schemas
and avoids repeatedly scanning large transcripts to draw the dashboard.

If a run contains both `cost_usd_micros` and `estimated_cost_usd_micros` series,
the dashboard leaves its cost unknown rather than adding potentially overlapping
reports. Sample counts alone cannot prove the two series describe disjoint usage.
Use one cost family consistently for a run; both original series remain available
in Usage reports for inspection.
