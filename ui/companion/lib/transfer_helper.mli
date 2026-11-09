open Core

(** Companion-owned resource upload staging and exact native publication. One
    single-domain metadata owner; read observers never own admitted task lifetime.
    This helper is not an ordinary Operation_store entry or a daemon method.
    Cancellation and unexpected exceptions propagate at every entry point. *)
type t

module Stage : sig
  module Id : Workgraph.Id.S

  type t

  (** Public immutable ID, declared SHA256/size, received byte offset and sealed
      state. Never exposes an arbitrary host path or accepts one from a browser. *)
  val to_json : t -> Jsonaf.t
end

module Plan : sig
  type t

  (** Closed original input: immutable endpoint/profile, writer/workspace capture,
      sealed stage, resource identity/metadata guard, title/filename/MIME and
      optional ticket. No caller file/upload ID or digest override. An explicit
      validated mutation ID is retained; a missing mutation is generated once only
      after full-input deduplication. Validate complete input before identity materialization; creation
      itself performs no daemon I/O or native journal publication. *)
  val create
    :  intention_id:Operation.Id.t
    -> connection:Connection_profile.t
    -> context:Operation.Context.t
    -> stage_id:Stage.Id.t
    -> params:Jsonaf.t
    -> (t, Workgraph.Problem.t) Result.t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Job : sig
  type t

  (** Original input hash, captured profile/writer, exact saved native upload plan
      and journal identity, local revision, diagnostic and discriminated phase.
      Prepared_unsent is local only; Running is admitted, not committed. Preserve
      validated publication independently of optional link failed/unknown state.
      Receipt absence never proves unsent and never resets a previous unknown. *)
  val to_json : t -> Jsonaf.t
end

(** The injected client factory is the companion's qualified captured-profile
    boundary. Invoke it on every start/retry/recovery path, never fall back to a
    current profile or rebuild a plan. Service retains at most100 intentions and
    one admitted transfer at a time, two active incoming stages and1000 retained
    stage/tombstone records. Aggregate
    retained private source bytes, including prepared/uncertain jobs, are <=128MiB;
    uncertain sources consume capacity and cannot be automatically evicted.
    A stage is <=64MiB. Restart durably converts Running to Outcome_unknown before
    exposure; it never resumes. Root lock outlives this service. *)
val create
  :  sw:Eio.Switch.t
  -> env:Eio_unix.Stdenv.base
  -> root:State_root.t
  -> client:(Connection_profile.t -> (Workgraph.Client.t, Workgraph.Problem.t) Result.t)
  -> (t, Workgraph.Problem.t) Result.t

(** Idempotent complete-input equality before allocating a private spool. Both
    expected size and SHA256 are required and immutable. Zero-byte stages are
    valid. Capacity rejects explicitly; no daemon requests occur during staging. *)
val begin_stage
  :  t
  -> id:Stage.Id.t
  -> digest:string
  -> size_bytes:int
  -> (Stage.t, Workgraph.Problem.t) Result.t

(** <=256KiB decoded bytes. Offset is an exact nonnegative byte count. An already
    retained range is accepted only if its bytes match. Invalid/gapped/oversized
    or changed ranges reject. Sync private bytes before advancing visible offset;
    interrupted publication remains fenced until exact reconciliation. *)
val append_stage
  :  t
  -> id:Stage.Id.t
  -> byte_offset:int
  -> bytes:string
  -> (Stage.t, Workgraph.Problem.t) Result.t

(** Hash complete bounded private regular file and compare declared identity;
    synchronize sealed state before acknowledging. No source mutation after seal. *)
val seal_stage : t -> id:Stage.Id.t -> (Stage.t, Workgraph.Problem.t) Result.t

(** Read-only durable staging inventory, including unprepared browser-abandoned
    inputs after restart. Complete identity/status, retained byte capacity and
    cleanup diagnostics are distinct from publication outcome. *)
val inspect_stage : t -> id:Stage.Id.t -> (Stage.t, Workgraph.Problem.t) Result.t

val list_stages : t -> offset:int -> limit:int -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Explicit cleanup of only an unprepared stage. Once referenced by a prepared
    intention, close/abort cannot remove its source or deduplication identity.
    Confirmed-publication cleanup is separately receipt-backed and leaves the
    saved plan/intention available for receipt-only recovery. *)
val abandon_stage : t -> id:Stage.Id.t -> (unit, Workgraph.Problem.t) Result.t

(** Full input deduplication precedes missing mutation generation. Verify sealed
    bytes, use native Transfer.Upload_plan, and synchronize exact saved native
    plan/journal plus intention mapping before acknowledgment. Any local sync
    uncertainty fences transmission; installed identities are never regenerated. *)
val prepare : t -> Plan.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Durable Running barrier before one service-owned upload_with_link. Repeated
    start coalesces. Browser cancellation/close detaches only; no rollback or
    automatic mutation retry. Existing terminal/uncertain jobs do not restart. *)
val start : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Explicit exact retry only; original plan, mutation/finish/link identities and
    guards. Native receipt-first semantics permit a completed publication after
    source cleanup. Never refresh a stale link guard or manufacture a new upload. *)
val retry_exact : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Read-only exact native finish/link receipt inspection. Validate original saved
    request hashes and durable method-specific acknowledgments. Never calls
    upload_with_link, upload.begin/chunk/finish/link, nor resumes source transfer.
    Known publication wins observation errors, with separate diagnostic/link state.
    After the verified finish is durably recorded, automatically remove its source
    and sync capacity bookkeeping even when link failed. Cleanup failure is an
    explicit capacity diagnostic, never negation of publication; saved plan and
    deduplication fences remain. Unknown finish sources are never cleaned. *)
val recover : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Wait for in-progress local publication under the metadata owner; never expose
    successful completion before sync. Expected local I/O has explicit diagnostics
    and retained fences rather than an older apparently sendable state. *)
val inspect : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

val list : t -> offset:int -> limit:int -> (Jsonaf.t, Workgraph.Problem.t) Result.t
