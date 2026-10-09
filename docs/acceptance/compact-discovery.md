# Compact API discovery

The executable catalog supplies discovery tiers, purposes and the schemas generated
by its real request/result codecs. `workgraph help METHOD` and `--brief` present
required and optional inputs, constraints, preconditions, a small parameter example
and a shallow result summary. `--full` supplies complete contracts. JSON discovery
continues to return complete schemas. `workgraph methods --core` selects the
53-method everyday tier; the text index labels local CLI helpers separately.

Repeated schema shapes receive stable field-derived names and digest suffixes in
local `$defs`. Each params/result block is a standalone document: extract that
block to resolve its local `$ref` values. Factoring visits only schema locations,
preserves literals and validation annotations, and retains object closure,
including `unevaluatedProperties`. Existing URI/reference scopes and schemas beyond
128 schema locations remain unchanged. Runtime codecs and validation do not change.

Examples are checked through each method's actual mapped request codec. Bounded
placeholder selection covers stateless constraints such as positive fencing tokens,
digest shapes, absolute paths, nonempty collections, routing recipients and Base64.
All 238 current examples pass that validation. Live references, ownership and
revision guards still require caller values. If future codec constraints prevent
an accepted placeholder example, help explicitly labels its rejected skeleton.

The generator consumes the same catalog, places required inputs near the top of
each method page, identifies its tier and links a common envelope/type reference.
All schema references stay inside their own block and resolve offline.

## Focused evidence, 2026-10-09

Executed on the macOS ARM64 implementation workspace:

- `./dev runtest --build-dir=_build-discovery -j2 test/api_catalog`
- `./dev runtest --build-dir=_build-discovery -j2 test/generated_reference`
- The same two targets together after review fixes; five Python generator tests
  passed, as did the independent offline CLI and OCaml expect checks.

The independent expansion check compares every compact request/result schema to
its exact raw codec declaration. Separate cases cover literal reference-looking
JSON, closed objects, existing reference scopes and bounded traversal. Tests check
every declared input, every example through actual decoding, explicit/default brief
identity, core filtering, full contracts and the 8 KiB brief ceiling. Regression
cases require a positive `ticket.finish` token and describe `ticket.metadata` as a
mutation updating its actual metadata fields.

Before editing, all 238 default help outputs totaled 19,391,582 UTF-8 bytes. After
implementation and review fixes, brief outputs totaled 379,961 bytes; the largest
was `request.create` at 3,387 bytes. Full outputs totaled 7,328,971 bytes, including
nested result schemas. These are development snapshots, not a release benchmark.

| Method | Before help bytes | Brief bytes | Full bytes |
| --- | ---: | ---: | ---: |
| `ticket.resume` | 2,779,012 | 1,743 | 220,502 |
| `activity.digest` | 2,749,209 | 1,267 | 215,425 |
| `transaction.apply` | 2,416,814 | 1,685 | 720,870 |
| `ticket.context` | 1,132,150 | 1,587 | 251,554 |
| `coordinator.overview` | 1,064,744 | 2,565 | 154,504 |

Final generated-reference regeneration, installed-document qualification and the
repository-wide `./dev fmt` / `./dev build @fmt @runtest @install` gates remain part
of integration after the remaining v0.3 contracts settle. This record does not
claim those pending gates or a release qualification passed.
