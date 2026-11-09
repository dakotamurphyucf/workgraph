# Bounded history format projections

`projectCapturedPayload(capture, selection)` projects one complete captured payload. It performs no I/O, stream assembly, session-wide detection, tool invocation or UI rendering. Generic is always available for arbitrary binary/text/event data. Unsupported and ambiguous results retain the same capture and are instructions to render Generic, not errors that discard content.

The caller owns immutable original bytes and opaque metadata. Capture identity names the exact event; scopeId is a typed tuple of connection ID, immutable connection generation, workspace ID and logical source session/collection ID. It excludes mutable head and event sequence. No arbitrary JSON is passed through JSON.parse. Raw source and all unknown fields remain available in the bounded lossless document. Producer claims must be exact caller-provided provenance, never inferred from model names, vendor labels or ID prefixes.

Auto checks ten closed descriptors against one payload, limited to 16 MiB, 64 container levels, 200,000 lossless nodes and 256 entries per projected array. Generic skips parsing. Partial, malformed, duplicate-key, non-UTF8, oversized and unqualified payloads remain Generic. Manual selection applies the same validation and cannot promote malformed data. More than one valid shape is ambiguous unless exact producer provenance excludes candidates. An explicit conflicting producer claim rejects recognition. A shape match without provenance is labeled validated shape only.

This is a bounded projection of required envelope fields and consumed variants, not universal validation of every upstream field. Unknown fields remain raw. Unknown content/output variants become unsupported items beside validated content. SDKUserMessage requires the recorded wrapper uuid/session_id subset; SDK request inputs lacking those optional upstream fields remain Generic. Claude Code disk JSONL has a separate consumed-field adapter based on the published 0.3.319 SDK session reader. Codex combines the original pinned source with observed local rollout variants; neither is a promise of historical/future compatibility.

Metrics retain JSON number lexemes, source path, capture identity, adapter/schema pin, scope, explicit reported coverage, units and snapshot/breakdown/report basis. Missing fields stay absent. Count fields require nonnegative integer syntax; no arithmetic or conversion to Number. USD cost is only an explicit SDK estimate. SDK result.usage is main-agent-only and per-turn in streaming-input sessions. It is scoped to the exact result UUID, not merged into a session total. num_turns is exposed as model_round_trips within one turn, not a count of user turns. Durations retain result scope without inferred lifecycle extent. total_cost_usd/modelUsage cover cumulative query-pipeline calls; modelUsage stays raw. A session ID does not identify a query() boundary or /clear reset. Cost therefore has no exact snapshotKey; possibleOverlapKey only groups potentially overlapping reports in a source session and never authorizes addition. Lifecycle/object snapshots for the same response share a key within caller scope; keys identify overlapping reports and are never additive. No summation or selection of latest snapshots is performed here. No run-level usage is assigned to history collections.

Timestamps and sequences are source reports, distinct from Workgraph event metadata. Source strings are never parsed into invented time. Signatures/encrypted/redacted reasoning are opaque; only explicit retained text/summary is readable. SDK subtype and is_error are preserved separately; subtype success can carry an API error and is rendered as reported-error when is_error is true. SDK results and final_answer phases do not prove actual project completion, process termination or liveness. There is no inferred cost, turn count, tool error, guard denial or compaction count.

Integration must run these bounded synchronous primitives in the owned content worker when projecting content off the main thread. This module supplies no worker protocol, HTTP decoding, payload retrieval, transcript grouping, final-message deduplication, UI selector or browser qualification; those remain downstream tickets. Link destinations and all projected strings are passive data.

| Qualified descriptor                | Pinned producer schema                                                             | Initial projection                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic.messages.response.v1`    | anthropic-sdk-python `4c7b598466b88559583f98216139be8e9b34c1fc`                    | Complete message envelope; text, tool use, thinking/signature and redaction; reported usage                                                         |
| `openai.responses.object.v1`        | openai-python `44b1555aff1c22998c008c84400e7acce39fb928`                           | Complete response envelope; message/refusal, function call/output, reasoning summary/retained content/ciphertext; usage                             |
| `openai.responses.event.v1`         | Same openai-python commit                                                          | Individual created/completed/failed/incomplete and output_item.done only; nested object/item validates                                              |
| `openai.chat-completions.object.v1` | Same openai-python commit                                                          | Complete completion envelope; all choices, text/refusal, typed function calls, optional usage                                                       |
| `claude.agent-sdk.message.v1`       | Published `@anthropic-ai/claude-agent-sdk@0.3.319`, integrity recorded in evidence | Recorded assistant/user subset, init, success and four documented error result arms; explicit result estimates                                      |
| `codex.rollout-jsonl.7cdb219.v1`    | openai/codex `7cdb2198831e3e6e647c31a1d5c409ab8acc8568`                            | Individual session_meta, response_item, compacted and event_msg wrappers; known message/function call/output/reasoning and agent_message projection |

Known Codex lifecycle/token-count event_msg variants are markers, without derived totals. Per-response token_usage_record.usage retains its explicit response identity and counts; cumulative turn/thread snapshots are not added. Raw Claude Code transcript JSONL is distinct from normalized SDK records. No adapter claims support for every historical/future payload from a vendor. Descriptor source links and the evidence source manifest identify exact producer definitions. Unknown variants retain raw access and never acquire inferred metrics.

## Conversation ingestion and current extension evidence

Store one source message/item in one Workgraph event. `conversation.item.v1`
recognizes shared role/content messages, Responses input/output items, Chat
Completions tool-call/result messages and known Anthropic blocks. Common fields
are not provider identity. This descriptor is Workgraph's explicit consumed-shape
union, not an assertion of a universal vendor schema. Full response/request
envelopes still work when that is what the caller actually stores.

The additional descriptors are `claude.code.transcript.v1`,
`anthropic.messages.request.v1`, `openai.responses.input.v1`, and
`conversation.item.v1`. The two request adapters render complete supplied
conversations; callers do not need to manufacture them for individual messages.
Source-path provenance remains exact for every block.

Evidence inspected for the November 9 refinement:

- [Claude session API](https://code.claude.com/docs/en/agent-sdk/sessions) and
  [published SDK 0.3.319](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.319.tgz):
  raw JSONL uses camelCase sessionId/parentUuid and nested message; SDK session
  results and streamed SDK messages use different wrappers. The disk reader
  handles parent chains, compaction and sidechains. Our renderer preserves stored
  event order and flags sidechains; it does not reproduce that branch-selection
  algorithm or claim a stable complete raw-file JSON Schema.
- [OpenAI Responses items](https://developers.openai.com/api/reference/typescript/resources/responses):
  individual inputs and tool results need not contain output-only IDs/status;
  user/system/developer input messages and assistant output messages differ.
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create):
  input role/content pairs, text and structured blocks, tool_result in user
  messages, and distinct complete response usage.
- Local Codex histories: observed custom_tool_call/custom_tool_call_output,
  response_item.agent_message, turn_context, token_usage_record and lifecycle
  markers. The original Codex descriptor ID is retained; those local extensions
  are observed examples, not certification by that older source commit. Private
  original logs are not committed. Public tests use synthetic records.

Each complete source event projects **all ordered content blocks**. Nothing here
reassembles streaming fragments, infers an unknown attachment, executes tools,
recovers opaque reasoning or totals an entire session. Run/attempt usage belongs
to the independently captured native usage reports; see
[History usage](../../../../../../docs/ui/history-usage.md).

### Tool presentation (November 9 final pass)

The transcript presentation layer groups unique tool IDs in recognized Codex,
Claude Code, Claude SDK and conversation-item scopes. It preserves separate raw
events and never pairs by adjacency. Source sessions, agent/sidechain identity,
recorded run and conflicting explicit correlations restrict pairing. Ambiguous,
reversed and incomplete pairs remain separate. A matched result block can move
beside its call in Conversation mode; other blocks and raw event order do not.

`transcript/tool-display.ts` specializes observed Codex exec JavaScript, shell
commands, Claude Code Read/Write/Edit inputs and patch text. Bounded lossless JSON
decoding is display-only, including encoded strings and concatenated output
objects; `ProjectedItem.arguments` and captured original bytes remain unchanged.
Unknown or malformed input falls back to its literal source. The local Codex demo
establishes the `exec` convention; the Responses schema alone does not guarantee a
language for arbitrary custom tools.

The source call-ID relationship is also documented in [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
and [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).
These describe call/result structure, not a promise that every Claude Code disk
JSONL or Codex rollout revision has one universal stable schema.

The transcript completes and verifies event bodies through16MiB before projection;32KiB batch prefixes alone are never enough to recognize a tool result. The loader, worker admission and registry share the byte ceiling from `limits.ts`. Over-ceiling events keep explicit source inspection and verified download, without presenting a truncated JSON object as conversation content.
