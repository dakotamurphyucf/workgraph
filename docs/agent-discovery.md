# Agent capability discovery

Workgraph provides offline navigation from an intent to an exact operation. These
commands read executable metadata, not workspace data, and need neither a daemon
nor an agent context. They do not execute suggested operations.

```sh
workgraph capabilities
workgraph discover 'ask another agent a question'
workgraph discover 'write multiple tasks atomically' --limit 3
workgraph discover 'import a conversation transcript' --kind workflow
workgraph help request
workgraph help workflow.ask_question
workgraph help request.ask
```

## Progressive detail

The entry skill introduces eight capability categories. Group cards explain API
namespaces, when to use them, how adjacent concepts differ and where to start.
Search returns at most five entries by default, labelled as daemon methods, local
helpers or workflow recipes. Each entry has a purpose, use condition, effect and
next help command. Method help contains exact inputs, examples, prerequisites and
related operations; `fields METHOD` and `schema METHOD` provide deeper contracts.

`--limit` accepts 1..20, `--capability ID` restricts the category, and `--kind`
restricts methods, helpers or recipes. Text is the default; `--output json`
provides structured results with matched/returned counts and `has_more`. Counts
use Workgraph's decimal-string convention. Narrow the query to inspect more
relevant matches; there is no implicit traversal or automatic operation selection.
`discover --catalog` explicitly exports the complete metadata without schemas.

Search is deterministic English keyword matching with curated terms, basic word
normalization, exact-name priority and weighted multiword coverage. It is not a
model or embedding service. No matches means no lexical match under those
filters, not proof that Workgraph lacks the capability. Broaden the phrase,
remove filters, or browse a capability. The query is at most 1024 UTF-8 bytes.

Feature categories are not permissions or a run's declared eligibility
capabilities. Likewise, `search.query` searches recorded work and `history.search`
searches explicitly imported conversation events; neither searches the API catalog.

## Maintenance

`Discovery_content` owns curated capability, group, method, helper and workflow
text. `Api_catalog` takes method summaries from it while retaining its executable
codecs, modes and tiers. `Discovery` joins those declarations for local search.
No second request schema or new daemon method is introduced.

Generate API references before discovery references so all links can be checked:

```sh
python3 tools/generate_api_reference.py --binary _build/default/bin/main.exe --output skills/workgraph/references/api
python3 tools/generate_discovery_reference.py --binary _build/default/bin/main.exe --output skills/workgraph/references/discovery
python3 tools/check_skill.py . --binary _build/default/bin/main.exe
```

Both generators accept `--check`; Dune runs drift checks and the copied-skill
validation. Generated inventories bind both kinds of documentation to the same
catalog. Generation refuses to overwrite unmanaged or edited reference files.
Curated coverage checks require every executable method and namespace to have a
description, with valid capability assignments and navigation targets. Behavioral
tests check intent retrieval, bounds, error routing, aliases and offline operation.

## Observed agent exercises

Two fresh GPT-6.1 Sol agents at high reasoning used only a copied executable,
the portable skill and isolated workspaces. They were given desired outcomes and
connection values, not method names or repository source. They were instructed
not to load a full schema or catalog. These are qualitative workflow exercises,
not a statistical reliability benchmark or a token-efficiency comparison.

| Exercise | Observed result |
| --- | --- |
| Plan and deliver documentation | Created a project and two dependent tickets; stored a scoped fact and linked versioned checklist; recorded progress/handoffs; asked a real separate maintainer for a decision; retrieved the exact answer, explicitly acknowledged notifications, and completed the work with readback. |
| Coordinate and reconstruct work | Registered a run and attempt; acquired/released a logical file reservation; imported two synthetic messages; searched and retrieved the exact 104-byte source payload with a matching hash; reconstructed context and produced a readable workspace export. |

Both completed the assigned outcomes without a full catalog dump. The second
agent initially loaded two long guides and encountered truncated output. This
motivated moving concise discovery ahead of detailed-guide routing in the skill.
Other observed friction led to a transcript-import recipe, capability-name help
fallbacks, related-method navigation for path operations, and explicit handoff
coverage guidance. The transcript converter supports selected Claude records;
the import recipe does not claim arbitrary JSONL compatibility.

The export check reported integrity verified but canonical state not replay-
validated; no restore was performed. Logical reservations were cooperative
records, not filesystem enforcement. The demos did not run production builds,
deploy services, or verify claims within the synthetic transcript. Larger runtime
context views can still be verbose; improving their payload shape is separate
from this offline discovery work.
