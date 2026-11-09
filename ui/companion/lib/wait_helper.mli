open Core

(** Explicit bounded reservation-acquisition helper. Uses the existing
    Workgraph.Reservation_wait state machine, not a shell, queue, ownership
    recovery service or generic retry policy. One service-owned flight at a time;
    read observers never own an admitted write's lifetime. *)
type t

module Plan : sig
  type t

  (** Only reservation.acquire and reservation.paths.acquire. The preparation
      freezes complete writer, workspace and immutable endpoint generation.
      Limits reuse the native 1000..300000ms / 1..100 attempts / 1..25000ms bounds.
      A missing mutation ID is generated once after full-plan deduplication.
      No Operation_store entry is also created for this independent helper job. *)
  val create
    :  preparation:Operation.Preparation.t
    -> timeout_ms:int
    -> max_attempts:int
    -> wait_slice_ms:int
    -> (t, Workgraph.Problem.t) Result.t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Job : sig
  type t

  (** Original full plan/input hash, local monotone revision, cancellation request,
      phase and native Outcome. Every attempt keeps its actual synchronized saved
      request/journal path; completed requires the core's validated durable grant.
      Stopped/deadline/attempt-limit do not mean ownership acquired or queued.
      Outcome_unknown retains the exact last request and actionable journal. *)
  val to_json : t -> Jsonaf.t
end

(** Root lock outlives this service. Load current storage only; before exposing
    metadata durably turn interrupted Running into Outcome_unknown, retaining the
    last synchronized request. Never resume automatically. At most 100 jobs and one
    active helper; cancellation and unexpected defects stay distinct. *)
val create
  :  sw:Eio.Switch.t
  -> env:Eio_unix.Stdenv.base
  -> root:State_root.t
  -> (t, Workgraph.Problem.t) Result.t

(** Complete-input equality before identity materialization; synchronize the
    original request and prepared job before acknowledging. Conflicting intention
    reuse rejects. A persistence failure never permits exchange. *)
val prepare : t -> Plan.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Explicit start only. Durable Running admission precedes the service-owned
    flight; duplicate starts coalesce and completed/stopped jobs never restart.
    Native collect captures feed before first acquisition and generates a fresh
    identity only after definite, typed matching contention. Guards never refresh;
    malformed/nondurable/uncertain results stop. Each explicit invocation qualifies
    the daemon package before admission. The original total deadline includes
    qualification and the native collect loop. Its internal connections are one
    bounded cooperative invocation, not an authenticated daemon session. *)
val start : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Prepared cancellation is definitely unsent. Admitted cancellation prevents
    later attempts and cancels owned feed reads. A bounded write already in flight
    may finish so a verified durable grant wins a racing cancellation. An uncertain
    write stays unknown, including when an unsent exact retry is canceled; that
    cancellation cannot settle the original write. It is never rolled back or
    implicitly released. Its exact journal
    remains visible. IDs occupy a service-local namespace distinct from operations. *)
val cancel : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Explicit retry of only the exact retained uncertain request, synchronized
    before exchange. One attempt, no new mutation identity, refreshed guards or
    resumed acquisition loop. A definite failure remains definite; known acquired
    jobs cannot be resent. Canceling an unsent retry preserves the earlier unknown
    outcome and its exact saved request; it does not establish cancellation of that
    original write. Qualification failure before retry leaves that original
    unknown state/request unchanged; no daemon acquisition bytes are emitted. *)
val retry_exact : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Inspection and listing wait for in-progress local publication under the same
    mutex. They cannot expose a new completion before its metadata sync finishes;
    a persistence diagnostic remains explicit if that publication fails. *)
val inspect : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

val list : t -> offset:int -> limit:int -> (Jsonaf.t, Workgraph.Problem.t) Result.t
