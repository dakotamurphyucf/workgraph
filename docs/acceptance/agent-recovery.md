# Fresh-agent recovery and discovery

On 2026-10-09, two fresh GPT-6.1 Sol agents using high reasoning completed a
controlled recovery exercise. Neither received the previous agent's transcript.
One received Workgraph's entry guide, connection values and an objective; the
other received equivalent information in a directory of ordinary notes. This was
a small discovery and correctness check, not a performance benchmark.

The fixture contained an initial configuration proposal, a handoff recording that
analysis was complete but implementation had not started, a later correction,
current settings, recorded verification and an unanswered clarification. The
handoff deliberately contained the superseded settings. Workgraph was restarted
between the handoff and the correction. The verification's 14 passing cases were
supplied fixture evidence, not tests performed by either recovering agent.

Both agents recovered the corrected namespace and interval, identified the old
proposal as superseded, cited supporting records, answered the clarification and
left implementation pending. Neither repeated the completed analysis or claimed
to have rerun the verification. The Workgraph agent discovered and used resume,
resource retrieval, request retrieval, threaded replies, delivery acknowledgement
and request resolution without being given method names or request shapes.

The implementation reviewer independently read the resulting records, stopped and
restarted the daemon, and read them again. The reply, request resolution and
delivery acknowledgement were unchanged after restart. Resume covered workspace
revision 15; the ticket remained `todo` and unclaimed. Both test daemon sessions
were stopped and their temporary socket directory removed.

## Observed retrieval cost

An external helper recorded document reads and CLI invocations, their exit status
and returned UTF-8 byte counts. Root verification, fixture setup and observer
self-checks were excluded. The two agents used the same model and reasoning level.

| Observation | Plain notes | Workgraph |
| --- | ---: | ---: |
| Recorded helper operations | 9 | 16 |
| Document/file reads | 8 | 7 |
| Directory listings | 1 | 0 |
| CLI calls to the daemon | 0 | 7 |
| Offline CLI help calls | 0 | 2 |
| Returned stdout bytes | 3,153 | 256,763 |
| Returned stderr bytes | 0 | 484 |
| Operations with nonzero exit status | 0 | 0 |

For Workgraph, document reads accounted for 138,056 stdout bytes, two full-schema
help calls for 93,389 bytes, four query calls for 23,431 bytes and three mutation
calls for 1,887 bytes. Mutation stderr contained saved-request notices. For plain
notes, the total included 1,526 bytes of source notes, a 77-byte listing and 1,550
bytes of answer/readback. Writes outside the observer were not counted, so these
are observed retrieval/CLI operations, not total agent tool calls. Reading the
same documentation twice contributes twice to these counts.

This exercise demonstrates successful discovery and recovery, **not token savings**.
The Workgraph arm retrieved substantially more material, principally documentation
and complete CLI schemas. Provider token usage was unavailable; bytes must not be
converted into claimed token consumption. A larger task may amortize initial
documentation, but this exercise does not establish that benefit. Focused reference
navigation and selective reads remain important; merely splitting files does not
ensure an unfamiliar agent will read narrowly.

## Scope

This was a controlled fresh-agent reset, not an observed model context compaction.
It used a Python socket client for fixture preparation and the ordinary CLI for
agent work; it did not establish coordination between two different production
harnesses. It tested one modest synthetic task and graceful daemon restart, not
crash fault injection or comparative productivity. Those distinctions prevent a
successful recovery example from standing in for the separate persistence,
integration and installed-artifact acceptance checks.

## Documentation follow-up

The observations above preceded a review of the communication/evidence and resource
guides. Their duplicate schema inventories were replaced with links to generated
method contracts, while retaining workflow, provenance and recovery guidance. Their
combined source size fell from 78,175 to 40,421 bytes; this is a file-size comparison,
not measured agent token savings. The reviewer executed all ten command examples
from the revised guides against a real daemon. They passed, including acknowledgement,
policy reads, small-resource publication, exact upload retry and verified binary
download. The test daemon was stopped. These example checks do not constitute a
second unfamiliar-agent discovery measurement.
