# Public response envelope and discovery guide

This records the initial envelope milestone. Its guide and test counts describe
that checkpoint, before later feature integration; they are not a final validation
claim for the current checkout. See [generated references](generated-reference.md)
for the current documentation checks.

This change adopts one current public success format:

```json
{"jsonrpc":"2.0","id":"request-id","result":{"data":{},"meta":{}}}
```

Operation output always lives in `data`. Applicable durability, workspace/query
revisions, history captures, snapshot identity and query budgets live in `meta`.
Entity revisions remain attached to their records. History feed positions use
`history_sequence`; they are never labelled as planning workspace revisions.
`Api_position` distinguishes planning revisions, domain query revisions, journal
commit sequences and session event sequences in typed code.

The projection is a transport boundary over domain results, not a compatibility
reader. Persisted receipts remain independently validated domain records. Receipt
lookup projects the original result into the same public envelope as the original
write, including durability metadata. Planning commits and history publication
retain their existing serialized persistence boundaries.

`Api_metadata` validates nested budget diagnostics and history captures. Budget
pointers are rebased to the public data location; fitting measures the complete
public result, excluding JSON-RPC framing. Complete omission details must account
for all reported omitted fields/items. Incomplete details cannot exceed the totals.
The OCaml planning/administration clients and file-transfer completion require
explicit durable acknowledgement. Missing or malformed write acknowledgements
preserve uncertain-outcome handling and do not trigger an automatic retry.

The compact XML agent guide introduces all existing capabilities and links eight
focused references. The move preserved all 197 method entries. Source/native
packaging includes those references and a standard-library-only bundle checker;
AlmaLinux qualification checks installed guide/reference bytes against the source
archive. This does not imply that the current checkout has been published.

Validation includes independently constructed invalid metadata/response inputs,
byte-budget and omission-pointer assertions, typed-client workflows, malformed
socket acknowledgements, exact retry and receipt recovery after restart, history
recovery examples, and all 66 main daemon integration cases. The root reviewer
personally inspected the code; an independent reviewer also examined the envelope,
metadata invariants, examples and documentation packaging. Review findings were
fixed before the formatter, test and install checks passed.

Remaining work in the broader API plan includes migrating every method family to
executable codec descriptors, generating full method schemas/help, normalizing
remaining reference/variant encodings, and the later feature packages. The common
envelope and modular guide do not by themselves complete that plan.
