# Workgraph OCaml engineering standards

Status: required project conventions. Applies to first-party OCaml library/application/example/test code.

## Core-based OCaml

* Use Jane Street Core as the standard library foundation, ordinarily with `open Core` or `open! Core` at module scope. Prefer Core collection/string/option/result APIs and labelled arguments such as `~f`, `~key`, `~data`, and `~init`.
* Avoid polymorphic equality and ordering. Use `String.equal`, `Int.equal`, `Int64.equal`, `List.equal Element.equal`, `Option.equal Element.equal`, a module's `equal`/`compare`, or appropriately derived functions.
* Do not restore polymorphic comparison through `open Poly`, `Poly.equal`, `Poly.compare`, or `Stdlib.(=)`/`Stdlib.compare`. Core's default integer-specialized `=` is not polymorphic and does not violate this rule. Code review/lint must distinguish typed equality from polymorphic operators rather than rejecting every equals sign.
* Use explicit comparator/key modules for maps, sets and hash tables; derive or define equality/comparison/hash consistently with the intended key semantics. Physical identity is not a substitute for semantic equality; use `phys_equal` only when identity is deliberately part of the implementation contract.
* Prefer exhaustive pattern matching, descriptive domain types, immutable values by default, and small modules with a principal `type t`. Public `.mli` files document invariants, lifecycle/ownership and error behavior. Mutation remains appropriate for native bridges, caches and state machines when its ownership is explicit.
* Use `Result`/`Or_error` for expected recoverable failures. Reserve raising operations and `_exn` functions for documented invariants or explicitly exceptional paths. Preserve cancellation rather than converting every exception into an ordinary error. Do not let an OCaml exception cross an FFI boundary.

Real World OCaml explains why Base hides polymorphic comparison and discusses interfaces and explicit error handling. Those sources support these conventions; the project's no-polymorphic-comparison rule is explicit user policy. [Comparison](<https://dev.realworldocaml.org/lists-and-patterns.html#polymorphic-compare>), [modules/interfaces](<https://dev.realworldocaml.org/files-modules-and-programs.html>), [error handling](<https://dev.realworldocaml.org/error-handling.html>).

## Type and module design

RWO's public Core/Base conventions are a module for **almost** every type, principal type `t`, and that value first in operations on it. Draft types and interfaces before implementations; refine them as implementation teaches you more. Favor abstract interfaces to protect invariants and preserve implementation freedom. Expose a representation when callers benefit substantially from pattern matching and the type itself enforces the relevant invariants. Design names and labelled arguments for readable call sites. Use consistent operation names/signatures across modules, and `_exn` for operations that routinely raise. These are explicit recommendations in [Designing with Modules](<https://dev.realworldocaml.org/files-modules-and-programs.html#designing-with-modules>).

Workgraph application of those conventions:

* Give coherent domain concepts modules such as `Id.Ticket`, `Allocation_lease`, `Discussion`, `Resource` and `Session_event`, with operations beside their principal `t`. Nested modules are appropriate: this is not a requirement for one physical file per helper type. Avoid collecting unrelated domain definitions in a generic `Types` module; small local tuples and tightly related helper types need not acquire artificial wrappers.
* Keep public contracts in `.mli` files. Document ownership, permitted domains, lifecycle, units, mutation and failure behavior. For example, specify whether a resource offset counts bytes or a cursor counts events; an unqualified `int` description is insufficient for resumable retrieval.
* Introduce functors/shared signatures where multiple real modules need the same contract, rather than manufacturing abstractions for hypothetical reuse. Keep dependency direction clear: domain commands must not import the daemon runtime or filesystem adapters.

### Choosing representations

Records combine fields that coexist; variants represent alternatives. Combining them lets shared data live outside a variant and case-specific data live with its constructor. This is the modeling approach explained in [Records and Variants](<https://dev.realworldocaml.org/variants.html#combining-records-and-variants>).

For Workgraph, represent ownership with distinct cases carrying their applicable data, rather than independent `is_claimed`, `is_expired` and optional-owner fields that admit contradictory combinations. An illustrative shape is:

```ocaml
module Ownership = struct
  type t =
    | Unclaimed
    | Claimed of { actor : Id.Actor.t; token : int }
    | Expired of { actor : Id.Actor.t; token : int }
end
```

This is a design example, not the finalized claim model. Lease timing and recovery reasons belong beside their applicable state. Likewise, distinguish an omitted patch field (preserve the value) from explicit clearing; do not collapse both into an unexplained `None`.

* Prefer named records for meaningful multi-field public data; tuples suit small, obvious local groupings. Ordinary closed variants are the default for finite protocol commands and lifecycle states. Polymorphic variants need a concrete composition benefit and explicit interface bounds; they are not banned.
* Use validated constructors for constraints that the type cannot express, such as ordered event ranges or bounded, nonnegative byte sizes. Keep the representation abstract when unrestricted construction could violate those constraints.
* Preserve validation at all entry points, including decoding. A generated deserializer is not automatically a validating constructor. Decode wire data into a wire representation and validate before admitting it into the domain model; version wire formats separately from ergonomic public types. RWO demonstrates validating customized deserialization in [Data Serialization](<https://dev.realworldocaml.org/data-serialization.html>).
* Use immutable records and functional updates for value models. Make mutable caches/workspace registries explicit, with one owner and documented lifetime; do not derive value comparison over mutable resource identity accidentally.
* Enable missing-record-field pattern warnings (warning 9). Enumerate fields when additions should force review; use `{ field; _ }` when ignoring other fields is intentional. Functional record updates also preserve unmentioned fields, so review their behavior when extending the record. See [Records](<https://dev.realworldocaml.org/records.html>).

## Control flow, matching and function interfaces

The following is Workgraph's practical rule, consistent with RWO's examples, not a purported universal Jane Street ban on either syntax:

| Situation | Preferred expression |
| -- | -- |
| Decide from a Boolean predicate, comparison or membership test | `if predicate then ... else ...` |
| Inspect a variant/option/result/list and obtain its payload | `match ... with` (or `function` for a function consisting of a match) |
| Perform a standard collection/option transformation | The relevant Core operation when clearer, such as `List.map`, `List.filter_map`, `Option.map` or `Result.bind` |
| Add a condition that patterns cannot express | An `if` in the branch, or a readable `when` guard with complete fallback handling |

For example, `if String.is_empty text then ... else ...` is natural. When looking up a ticket, match `Map.find tickets id` into `None` and `Some ticket`; do not check presence and then call `find_exn`. A Boolean-only presence check can legitimately use `Map.mem` or `Option.is_some` when no payload is needed.

Prefer structural patterns over redundant guards; guards limit the compiler's ability to reason about coverage. A lowercase name in a pattern binds a variable—it does not compare against an existing variable of that name. Compare using a typed equality function in an expression or guard. [Lists and Patterns](<https://dev.realworldocaml.org/lists-and-patterns.html>).

Enumerate constructors of closed variants, using alternatives such as `Done | Canceled` when behavior is shared. Avoid a final catch-all that silently accepts newly added lifecycle/protocol constructors. `_` remains appropriate for intentionally unused payloads and genuinely unrestricted inputs; this is not a token ban. RWO explains how catch-all branches reduce the usefulness of exhaustiveness checks during refactoring, including additional risks with open polymorphic variants. [Catch-All Cases and Refactoring](<https://dev.realworldocaml.org/variants.html#catch-all-cases-and-refactoring>).

Use labels to clarify arguments whose meaning is not obvious. Optional arguments must have a following positional argument if omission is to erase them; add a final `()` when needed for a constructor otherwise taking only labelled/optional arguments. Do not append `()` to every API indiscriminately. Prefer meaningful defaults and show partial-application behavior in API examples when relevant. [Variables and Functions](<https://dev.realworldocaml.org/variables-and-functions.html#optional-arguments-and-partial-application>).

Keep compiler exhaustiveness/redundancy diagnostics enabled and resolve first-party warnings; document narrow suppressions rather than disabling them globally. Select flags for the pinned compiler instead of copying every warning number from an older book example. Use local opens/qualified names for specialized operators; avoid broad opens that make API provenance or comparison semantics unclear. Core's standard top-level open is intentional.

## Source precedence and additional accepted practices

 Follow explicit project decisions, then the pinned Core/Base interface conventions; use broader OCaml guides where compatible. For example, retain receiver-first operations rather than importing a data-last convention. Do not import another project's blanket bans on optional arguments or short local names. Formatting remains controlled by the pinned Jane Street profile.

### Parameter, function and module names

Jane Street's published naming advice favors informative names, greater descriptiveness for infrequent operations, and avoiding gratuitous renaming. RWO also relates name length to scope. These are principles, not a rule that every variable must have a long name. [Jane Street: Notes on Naming](<https://blog.janestreet.com/notes-on-naming/>), [RWO: call-site design](<https://dev.realworldocaml.org/files-modules-and-programs.html#design-for-the-call-site>).

Use the following Workgraph conventions, consistent with Core's existing vocabulary:

| Kind | Convention and examples |
| -- | -- |
| Values, parameters, functions, record fields, filenames | Lowercase words separated by underscores: `request_id`, `apply_batch`, `allocation_lease.ml`. Constants use this convention too. |
| Modules and variant constructors | Initial capital with underscore-separated words: `Allocation_lease`, `Workspace_closed`. Match established upstream spelling when referring to upstream modules. |
| Module types | Follow nearby Core-style interfaces: conventional `S` where appropriate, otherwise a descriptive capitalized name. No general ALL_CAPS requirement. |
| Principal value and type variables | `t` for the module's main value; `'a` for an unconstrained generic type. Prefer roles such as `previous` and `next` when comparing revisions. Use descriptive type variables when their roles matter. |
| Queries and predicates | `Discussion.revision`, `is_empty`, `has_more`, `can_complete`; retain established names such as `mem`, `equal` and `compare`. |
| Commands and transformations | Name the action or result: `insert_text`, `reset`, `apply_batch`, `normalize`. Use `map`, `fold`, `iter` only with their expected semantics. |
| Construction and conversion | Follow the relevant Core analogy: `create`, `empty`, `of_string`, `to_string`, `of_list`, `to_list`. Document failures; upstream conversion names alone do not guarantee exception-free behavior. |
| Exceptional variants | Use `_exn` for new operations with an ordinary failure mode exposed through raising; retain the established typed-error/option alternative where useful. Do not use a bang suffix as a blanket mutation convention. |
| Generic callback / initial accumulator | `~f` / `~init`, following Core collection operations. |
| Key/value and source/destination roles | `~key`, `~data`, `~src`, `~dst` when those are the actual roles. Use semantic labels for other roles. |
| Event callbacks | `~on_commit`, `~on_change`, etc. distinguish event handling from ordinary function arguments; ownership and cancellation remain part of the public API design. |

The naming/label table is our project policy, not a claim that every entry is mandated by a single Jane Street style document. Core's uniform interface principle supplies the default vocabulary. [Core interface conventions](<https://blog.janestreet.com/core-principles-uniformity-of-interface/>).

* Keep `t` first in operations on the module's primary type. Label other arguments where their roles would otherwise be ambiguous, especially same-typed inputs. Not every argument needs a label: `equal : t -> t -> bool` is an established clear signature.
* Use the module namespace to carry context: `Discussion.revision` instead of `Discussion.get_discussion_revision`. Avoid vague public names such as `process`, `handle` or `data` when the interface does not establish their meaning. Conventional `~data` on a map operation is meaningful.
* Short `x`, `i`, `acc`, `f` and `t` are appropriate in small, obvious scopes. Use `pending_revision` rather than an unexplained `r2` across a multi-step protocol operation. Avoid redundant type suffixes and unexplained abbreviations.
* Prefer affirmative Boolean names such as `is_enabled` over `not_disabled`. If a flag selects materially different behavior, consider a variant such as `Append | Replace`; ordinary Boolean properties remain valid.
* Prefer semantic units/types; where an integer count remains, name its unit, e.g. `byte_offset` or `max_batch_bytes`. Do not call a byte count `length` when callers may reasonably infer characters.
* Keep exported labels and parameter documentation stable; renaming a label changes source-level calls. Refactor names when clarity warrants it, with the relevant callers/docs updated together.
* Prefer local bindings and label/record punning when they make roles obvious. Do not rename a clearly named variable merely to enable punning. Avoid an expanding series of apostrophe-suffixed names when explicit stage names are clearer.

Illustrative interface shape (not finalized SDK spelling):

```ocaml
val revision : t -> int
val is_closed : t -> bool
val publish
  :  t
  -> expected_revision:int
  -> content:string
  -> (Receipt.t, Problem.t) Result.t
```

Here `t` is the storage receiver, labels explain the remaining inputs, and the error type supports programmatic recovery. A production interface must also document durability before acknowledgement and uncertain-write recovery.

### Function size, decomposition and local readability

The official OCaml guidelines recommend small functions and factoring repeated logic; Dune's contributor guide also emphasizes narrow scopes and small public interfaces. Neither source establishes a universal numeric function-length limit, and no such Jane Street limit was verified. [OCaml guidelines](<https://ocaml.org/docs/guidelines>), [Dune contributor guide](<https://github.com/ocaml/dune/blob/main/doc/hacking.rst>).

For Workgraph, evaluate structure rather than enforce a line-count maximum:

* A function should have a coherent purpose that its name can communicate. Separate unrelated parsing, state mutation, transport submission and logging phases into meaningful operations.
* Extract a helper when it names a real concept, isolates an invariant, removes duplicated policy or makes a substantial branch readable. Keep a one-use helper local when appropriate.
* Review deep nesting and large anonymous callbacks. An explicit match, a named branch helper or `Result.Let_syntax` can clarify dependent steps. Use let-syntax appropriate to the abstraction; Eio's direct-style I/O does not need a new monadic wrapper.
* Keep bindings near their uses and scopes narrow. Promote a helper to the module interface only when callers actually need its contract.
* Long exhaustive dispatch matches, declarative view trees and expect fixtures can remain together when splitting them would obscure their structure. Their line count alone is not a defect.
* Do not manufacture one-line wrappers or generic utility modules just to make functions shorter. Factor shared meaning, not coincidentally similar syntax; preserve readable application-specific composition.
* A long parameter list prompts a design review, not an arbitrary count limit. Introduce a configuration/domain record when the arguments form a coherent concept; keep capabilities explicit and do not hide everything in a global context record.
* Retain straightforward pipelines where data flow is clear; name meaningful intermediate stages when a pipeline becomes difficult to inspect. Avoid mixing clever operator chains with unrelated effects.
* Group multiple effects intended within an `if` branch explicitly. In `if condition then first (); second ()`, the second call is outside the conditional. Let the formatter render grouping consistently.

These rules are review guidance, not automatic lint bans on line counts, nesting depths, operators or temporary variables.

### Reliability, diagnostics and performance

The following applies the additional practices approved by the user:

* Keep reconciliation, validation and state-transition logic independently executable as ordinary computations. Perform filesystem/network/native operations through the established adapters. Encapsulated implementation mutation is acceptable.
* Define typed error variants when callers choose different recovery actions; never dispatch by matching error-message strings. Use `Or_error.t` where diagnostic context is the primary requirement.
* Scope exception handlers to operations whose failures they can interpret; preserve unexpected failures, original diagnostic context/backtraces and cancellation. A callback's failure must not accidentally become a lookup miss. [RWO: error handling](<https://dev.realworldocaml.org/error-handling.html#catching-specific-exceptions>).
* Supplement deterministic expect examples with Quickcheck properties, reference-model comparisons and relevant malformed-input/fuzz coverage. For the protocol and event log, retain independent JSON/socket/replay fixtures as well as round trips: matching encoder/decoder mistakes can cancel out. Preserve useful failing inputs as regression cases. [RWO: testing](<https://dev.realworldocaml.org/testing.html#property-testing-with-quickcheck>).
* Keep public wire and persisted event representations separate from ergonomic domain types. Only the current unreleased schema is supported; update callers and fixtures together, without compatibility branches or migration readers. Deriving `bin_io` alone promises neither backward compatibility nor migration. Future compatibility requires an explicit release policy. [Jane Street: protocol versioning](<https://blog.janestreet.com/lightweight-versioning-for-lightweight-protocols/>).
* Document ordering, complexity, copying/retention, invalidation and ownership where callers depend on them. Explain reasons and non-obvious constraints in comments; keep usage examples beside public contracts.
* Measure realistic input/frame latency, allocation and retained memory as well as throughput. Record workloads and pinned toolchain/platform details. Use traces/profiles before adopting complex optimizations; test rare expensive paths as well as steady-state streaming. [Jane Street: performance education](<https://blog.janestreet.com/developer-education-at-jane-street-index/#ocaml-performance>).
* Review stack usage on input-sized recursion. Use a stack-safe traversal or bounded-depth contract where needed; do not assume every recursive function needs rewriting or every library traversal is unsafe. Check the pinned implementation. [OCaml: recursion](<https://ocaml.org/docs/loops-recursion>).

Community guidance also supports separating pure and imperative work, typed error dispatch, documentation of invariants, shallow control flow and explicit branch sequencing. Those compatible principles inform this section; its suggested data-last argument order, polymorphic equality examples and older tooling advice do not override our Core/toolchain choices. [Christian Lindig's OCaml guide](<https://github.com/lindig/ocaml-style>).

## Eio for OCaml-side I/O

* Eio is the standard runtime and API for all first-party OCaml-side filesystem, network, process, timer and other I/O work. This supersedes the earlier design wording that described Eio merely as an optional choice.
* Use `Eio.Path` for filesystem operations; `Eio.Flow`/buffered I/O for streams; Eio networking, process and clock APIs for their respective work. Pass the required Eio capabilities explicitly instead of fetching ambient global filesystem/network access.
* Do not implement ordinary application I/O with blocking `Stdlib` channels, `Core.In_channel`/`Out_channel`, `Core_unix`, or direct Unix APIs. Do not introduce an Async/Lwt application scheduler as a substitute for Eio.
* Pure data/protocol/query modules need not depend on Eio simply because they are in this repository. A separate `Workgraph_io` library remains a possible dependency boundary, but Eio is the required first-party I/O implementation, not a runtime decision left to each contributor.
* Expect-test captured output (`print_s`, `[%sexp]`, etc.) follows the expect framework's output-capture mechanism. Filesystem/network work inside tests still uses Eio capabilities/mocks; production logging/output should use the chosen Eio-compatible sink.

Eio documents direct-style I/O, scoped lifetimes, capability passing and filesystem access. Use those APIs with the pinned Eio version. Real World OCaml's Async chapters are educational background, not this project's runtime choice. [Eio documentation](<https://github.com/ocaml-multicore/eio#readme>).

## Formatting and PPX

* Check in a root `.ocamlformat` with `profile=janestreet`. Pin the formatter version in the development toolchain and record the corresponding `version` setting; do not let each editor silently choose a different formatter release.
* Use the same formatter configuration for editors, local commands and CI. Add documented format/check commands and make CI reject formatting drift.
* Use `ppx_jane` for the normal OCaml preprocessing pipeline. Use Jane Street deriving and syntax facilities where appropriate: `equal`, `compare`, `sexp`/`sexp_of`, `bin_io`, `let%bind`/`let%map`, and expect tests. Derive only what a type needs; don't serialize opaque native handles or blindly derive comparison over callback-bearing types.
* Keep `ppx_jane`, `ppx_expect`, `expect_test_helpers_core`, related PPX packages and Core consistent with the accepted v0.17 dependency family. Additional preprocessors need a concrete use and an explicit dependency.

The formatter supports a named Jane Street profile, and `ppx_jane` is Jane Street's standard rewriter collection. [ocamlformat](<https://github.com/ocaml-ppx/ocamlformat>), [ppx_jane](<https://github.com/janestreet/ppx_jane>).

## Expect-test-first OCaml tests

* Use Jane Street expect tests as the default OCaml test style: `let%expect_test`, `[%expect]`, `ppx_expect` and `expect_test_helpers_core`, wired through Dune inline-test libraries.
* Test observable behavior and invariants with stable sexp/text output. Normalize generated IDs, paths, clocks and platform details deliberately; do not blindly promote a changed expectation.
* Use fake clocks, controlled Eio scheduling/mocks, isolated temporary filesystem capabilities and deterministic streaming fixtures. Avoid timing-sensitive sleeps and external LLM/network dependencies in unit tests.
* Cover codecs, reconciliation, lifecycle ordering, cancellation, revision/claim races, durable replay and immutable captures. Supplement expect coverage with properties and independent socket fixtures; native filesystem durability and packaged runtime checks need execution on their target platforms.
* `dune runtest` must run the OCaml suite. Document reviewing diffs and `dune promote`; CI checks expected output without auto-promoting it. Run Python process/socket checks through the same Dune alias.

Illustrative Dune stanza, following Workgraph's existing pattern:

```lisp
(library
 (name workgraph_tests)
 (libraries core expect_test_helpers_core workgraph)
 (inline_tests)
 (preprocess
  (pps ppx_jane ppx_expect)))
```

Tests needing I/O additionally declare the relevant Eio libraries.

[Real World OCaml testing chapter](<https://dev.realworldocaml.org/testing.html>) and [ppx_expect](<https://github.com/janestreet/ppx_expect>) explain the inline expectation workflow.

## Repository reference points

* `.ocamlformat` selects `profile=janestreet` and pins formatter version 0.28.1.
* `dune-project` pins the OCaml, Core, Eio and PPX dependency families.
* `lib/dune` uses `ppx_jane` and `ppx_jsonaf_conv`; the root Dune configuration enables warning 9.
* `lib/state.mli` documents preparation, validation and durable replay contracts.
* `lib/platform.mli` isolates native durability operations missing from Eio's high-level APIs.
* `test/dune` wires expect tests and process/socket integration tests into `@runtest`.

Before accepting new first-party OCaml code, review:

* Domain modules/principal `t`, receiver-first operations, intentional public representations and clear call sites.
* State representations, ID separation, units, validated construction/decoding and equality/comparator semantics.
* `if` versus structural matching, coverage on new constructors, intentional record wildcards and narrow warning suppressions.
* Eio capabilities/resource ownership, cancellation and explicit recoverable errors/FFI exception boundaries.
* Jane Street formatting/PPX and appropriate deterministic expect coverage.

Enforcement should target actual violations, not blanket token bans or checks that merely mirror implementation. Formatting is automated; semantic API/type/I/O choices also require review. This covers the project's initial engineering baseline, not every topic in OCaml or an assertion that a hidden internal style guide has been exhaustively reproduced.

These conventions draw on [Real World OCaml, second edition](<https://dev.realworldocaml.org/>), co-authored by Yaron Minsky and Anil Madhavapeddy. It is the public learning/reference source; the explicit project policies above determine Workgraph's choices where examples in the book differ.
