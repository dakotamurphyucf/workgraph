open Core

(** Companion-only package compatibility policy. No cache, attach/session state,
    endpoint authentication or core Client compatibility policy. *)
type t

(** Retains only the monotonic clock, never a qualification result or client. *)
val create : clock:_ Eio.Time.Mono.t -> t

(** Exact compiled Workgraph.Version.value, separate from the API0.7 profile. *)
val required_version : string

(** Send only initialize, decode its complete current method result, and require
    name=workgraph plus exact package version. A mismatch is Unsupported_version
    with observed/required Version details and matching-core guidance. This check
    sends no mutation. It runs again at each applicable invocation boundary; successful attachment
    never authorizes later calls. Errors do not establish any previous write's
    outcome or alter a saved identity.

    Native Client opens a new connection for each request. This cooperative check
    cannot authenticate same-version custom builds or atomically bind a later
    connection to the probed process; callers must not claim socket identity.
    Each fresh ordinary RPC is checked independently. A bounded native helper is
    checked once per explicit start, exact retry or receipt recovery, before its
    service-owned admission/semantic exchanges. Its internal exchanges are one
    invocation; no result is cached across invocations or profile attachment.
    Local-only inspection/profile editing/offline preparation do not require it.

    Uses a two-second monotonic timeout for each independent initialize probe.
    Caller cancellation and unexpected exceptions propagate. An optional caller
    budget is positive and finite; the probe is capped by its minimum with two
    seconds. A helper must additionally retain its outer total deadline across
    qualification and its semantic exchanges; this parameter alone does not
    account for time already consumed before a later operation. *)
val check
  :  t
  -> ?timeout_seconds:float
  -> Workgraph.Client.t
  -> (unit, Workgraph.Problem.t) Result.t
