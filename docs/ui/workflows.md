# Workflow drafts, templates and explicit batches

The Workflow area separates the captured live graph from local unpublished plans.
This guide describes the implemented source workflow; final UI and installed
platform qualification remain separate release gates.

Open **Templates** to inspect exact registered versions, or **Drafts** to author
related changes. A draft captures its connection ID, immutable generation and
socket, workspace, project and writer before asynchronous work begins. Changing
the shell actor or route does not retarget that draft. Create a new draft when
its writer or destination should change.

## Author a reusable template

Choose **Author template**. Give its source a Template ID and published title.
The expected resource metadata revision is `0` for a new resource, or the actual
current metadata revision when replacing one. This guard is distinct from the
published content version.

Edit the specification's named nodes, prerequisites, parent, capabilities,
allowed actors and reviewers. A prerequisite controls scheduling; parentage alone
does not. Reviewers can name an actor or a role with explicit members; a separate
actor requirement remains a native review constraint. Local aliases are names
inside the proposed template, not Workgraph ticket IDs. Empty or unknown fields
remain in source until explicitly repaired or removed.

The source is visibly **unregistered**. Saving it locally does not publish a
resource, register a template or reserve IDs. Choose **Build canonical publication
draft** to invoke the read-only native helper. It computes canonical content,
content version and digest from the exact captured input and creates a separate
publication draft. Review that batch, **Save native operation (do not execute)**,
and then **Execute saved request** deliberately. Only a confirmed committed native
result establishes publication. Keep the original source for subsequent work.

Registered templates display their exact template ID, version and SHA-256 digest.
Choose **Configure instance**, supply an instance ID, parameters and placement,
and review the exact batch. The native helper validates the complete pinned
specification and deterministic expansion. The saved mutation remains native
`template.instantiate`; it records the instance and expanded native gates rather
than replacing them with a browser-generated list of ticket creations.

A helper preview neither journals a mutation nor reserves provisional IDs.
Native preflight and preparation still validate current guards and expanded
counts. Frozen review displays the local source count separately from the exact
expanded native count. The latter comes from the planner’s actual staged-state
limit accumulator: a fresh instance includes its expansion, while an operation
for an already recorded identical instance counts one. Same-batch template
publication is included in that staged state. Execute, exact retry and receipt
recovery reuse the saved request; they never rerun a publication or instance helper.

Use the UI and core from the same released package. API-version compatibility
alone does not establish these semantics: the earlier 0.7.0 daemon reported source
operations in this field. Development qualification records an exact paired build;
a matching version string does not authenticate a custom fork or prevent external
socket replacement.

## Make independent commits explicit

A plan contains one or more named batches. Each batch commits independently;
the whole plan is not atomic. Up to 128 expanded native planning operations fit
in one atomic transaction. An instance can expand to several operations per
node. An oversized instance is rejected and is never silently split.

Use **Add explicit batch** to choose another commit boundary. The stage editor
provides named operations, structured fields, an unpublished alias/dependency
table, ordering controls and exact source as a secondary editor. Creation aliases
are local to their batch; the native transaction uses its `as` field. `$alias`
references apply only to supported typed reference fields, never arbitrary text.

For each creation declare either runnable intent or held work with its later
obligations. Runnable is a declaration of intent, not proof of readiness or gate
completeness. Native rules remain authoritative. Work awaiting links or gates in
later batches must have a final nonempty hold in the creation batch. A hold that
is subsequently cleared does not protect that work. The UI checks final effects
after receipt substitutions rather than accepting the mere presence of a hold
operation.

Held template instances need literal placement for the bounded preview helper.
If placement is created earlier in the same batch, put that placement creation
in an earlier explicit batch and bind its committed receipt. Native alias
placement remains available for other valid runnable-intent plans. The helper
does not simulate native transaction alias resolution or substitute provisional
IDs. Every ID created by a held instance must be held in the same atomic batch.

Later batches may bind actual IDs and revision counters from earlier durable
committed receipts. Preview-generated IDs are provisional and unreserved. A
missing, uncertain or rejected earlier result cannot enable a later batch.
After committing one batch, review the next against its materialized receipt
values and save a fresh native intention. A failure later in the plan leaves
prior commits intact and keeps their recovery evidence.

## Keep the different hashes distinct

The canonical captured plan hash covers the original endpoint, attribution and
plan source, including exposures and exact template pins. A frozen review hash
binds a particular batch and native preflight. The internal UI request-binding
fingerprint is a separate domain-separated consistency check. The native
preparation-input hash identifies saved preparation input.

None of those labels means the native Journal envelope hash or Server receipt
request hash. Native journals hash the canonical exact protocol request under
their own contract. Inspect the saved operation for its actual request, journal
identity and durable result. Preflight's planning revision is a read capture,
not a global compare-and-swap for a later apply.

## Recover without recreating an uncertain write

Local source and frozen batches are retained in IndexedDB for the same browser
origin, including its port. The launcher normally chooses an ephemeral port,
so a new launch can have a different origin. Export a recovery file before moving
to another port or browser, and import it deliberately. For recurring local
sessions, choose a fixed port with the matching installed companion:

```sh
workgraph-ui --state-root /absolute/private/ui-state --port 4180
```

The native root and browser profile must also remain the intended ones. Before
an imported or restored draft contacts a daemon, the UI resolves its exact
retained profile generation and compares ID, generation and socket. A different
socket under reused IDs is an explicit error. It does not fall back to a current
profile. A socket path is not cryptographic daemon identity; replacing a daemon
at that same path may be undetectable.

Use **Export selected draft** for a local `.wg-plan.ndjson` file. The versioned
`workgraph-ui-plan-draft-lines-1` container uses an explicit header, ordered source,
frozen-stage and snapshot records, and an exact end count. Each worker-decoded
record is at most 16 MiB; the whole container is at most 64 MiB. Its source chunks
preserve Unicode and exact text. Missing, duplicate, unknown, truncated,
out-of-order or identity-inconsistent records fail without replacing an editor.
Current source editing retains its separate 4 MiB per-draft and 16 MiB aggregate
source bounds. Recovery representability is checked before admitting state;
registered-stage evidence is retained when unused previews are pruned.

An imported file's hashes establish internal consistency, not native authority.
Choose **Restore saved native operations** to inspect and adopt the exact saved
journals. The UI verifies their original profile, context, source stage,
materialized receipt inputs and preparation before using them. It does not
execute, retry or recover automatically. For `outcome_unknown`, inspect the saved
operation and explicitly **Recover receipt** or **Retry exact saved request**
according to the [recovery guide](recovery.md). Neither action reconstructs an
uncertain write from edited source. If preparation was interrupted before a
journal ID returned, use [Administration journal recovery](administration.md).

A storage failure is visible and does not release a pending preparation lock.
Keep the editor open and export a copy. A failed local deletion is also reported:
that draft may return after reload. Local editor deletion never removes native
journals or reverses a committed batch.
