open Core

(** Companion-host evidence inspection/publication only. This module never calls
    Execution_stage.run, invokes a command, discovers approvals or claims OS process
    liveness. One single-domain metadata owner; filesystem validation/hash work is
    performed by native Execution_* helpers in a bounded isolated executor. *)
type t

module Inspection : sig
  type t

  (** Summary from validated native stage: literal command/cwd, unfinished or
      finished, exact capture digest/size, stream retained/observed identities,
      EOF/truncation, native outcome/times and compact source coverage. No output
      body or full source file inventory is embedded. Existing publication intent
      is explicitly unbound external or matched to this helper's saved binding. *)
  val to_json : t -> Jsonaf.t
end

module Plan : sig
  type t

  (** New UI-owned preparation. All parameters are validated and captured before
      materializing identity or I/O. Required mutation identity is retained exactly;
      stage/capture digest, connection profile, original workspace/actor/run,
      resource/metadata guard/title and optional independently confirmed ticket.
      Offline constructor never loads a stage or sends a daemon request. *)
  val create
    :  intention_id:Operation.Id.t
    -> connection:Connection_profile.t
    -> context:Operation.Context.t
    -> directory:string
    -> capture_digest:string
    -> params:Jsonaf.t
    -> (t, Workgraph.Problem.t) Result.t

  (** Explicit operator assertion associating a previously external native intent
      with a chosen profile. Original endpoint was NOT recorded or authenticated.
      The expected intent digest is shown by inspect_intent and must still match.
      Native immutable actor/run/workspace/guards/link/request are never rewritten.
      This constructor and subsequent associate perform no daemon I/O. *)
  val external_binding
    :  intention_id:Operation.Id.t
    -> connection:Connection_profile.t
    -> directory:string
    -> intent_digest:string
    -> (t, Workgraph.Problem.t) Result.t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Job : sig
  type t

  (** Complete original plan and binding origin (UI captured / operator asserted),
      exact native intent hash/bytes and local revision. Distinct prepared_unsent,
      running, local-save uncertainty, outcome_unknown and known publication with
      independent ticket link state. Existing known publication/committed link
      never regresses on cancellation, receipt absence or observation failures. *)
  val to_json : t -> Jsonaf.t
end

(** At most100 retained immutable intentions and one admitted publication flight.
    Restart converts Running to Outcome_unknown durably; it never resumes. Client
    factory performs exact package qualification on every explicit start/retry/
    receipt-recovery invocation, preserving prior uncertainty on probe failure.
    Root lock outlives helper. HTTP disconnect cancels only the observing request,
    never an admitted service-owned write. Cancellation/unexpected exceptions are
    not disguised as input failures. *)
val create
  :  sw:Eio.Switch.t
  -> env:Eio_unix.Stdenv.base
  -> root:State_root.t
  -> client:(Connection_profile.t -> (Workgraph.Client.t, Workgraph.Problem.t) Result.t)
  -> (t, Workgraph.Problem.t) Result.t

(** Bounded read-only stage selection; no native execution or implicit binding. *)
val inspect_stage : t -> directory:string -> (Inspection.t, Workgraph.Problem.t) Result.t

(** Native Execution_inspect byte range/tail <=65536 bytes, at expected immutable
    capture digest. JSON preserves exact binary base64 and visibly lossy UTF8 text.
    Tail means retained-prefix suffix; discarded process suffix stays unavailable.
    Browser complete retained-stream download reuses existing verified-transfer
    worker with exact pinned digest/size and capture-bound range supplier. *)
val inspect_output
  :  t
  -> directory:string
  -> capture_digest:string
  -> stream:Workgraph.Execution_inspect.Stream.t
  -> selection:Workgraph.Execution_inspect.Selection.t
  -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Read/resync native saved intent without source recapture or daemon I/O. Return
    original saved request/hash plus absent original endpoint warning. A stage must
    retain compatible validated launch/ownership marker; unavailable capture bytes
    do not permit fabricating a new request or an execution completion claim. *)
val inspect_intent : t -> directory:string -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Durably bind original target before new native Execution_publication.prepare.
    Explicit external binding reuses native load and exact bytes instead. Complete
    input equality precedes all I/O; conflicts/changed intent cannot replace a saved
    binding. Saved metadata/intent uncertainty prevents sending until deliberate
    same-plan reconciliation. No native command or daemon request is invoked. *)
val prepare : t -> Plan.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Durable Running barrier then native upload using original plan. Persist the
    known resource publication before a separately acknowledged ticket-link request.
    Repeated start coalesces; terminal/uncertain jobs do not restart implicitly. *)
val start : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Explicit saved intent retry only; original attribution/endpoint/guards and
    upload/finish/link identities. No source recapture, execution or guard refresh. *)
val retry_exact : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Read-only exact receipt lookup/validation; never invokes upload/link mutations.
    Native receipt-first recovery can succeed after source removal. Known resource
    publication and failed/unknown link remain distinct. Missing receipt is unknown,
    never proof of an unsent request. *)
val recover : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

val inspect : t -> id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Compact summaries only, at most25 per page; exact plans, requests and receipts
    are available through inspect. Continuation never implies an omitted job absent. *)
val list : t -> offset:int -> limit:int -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Deliberate fixed native cleanup with exact host path/token. No recursive delete,
    published resource deletion or cleanup of unfinished/unmarked/live/symlink/
    unknown-entry/publication-intent stages. A partial native failure is not success.
    Returned success requires completed native deletion; reply loss stays uncertain
    in the observing UI and must not trigger an automatic second cleanup. *)
val cleanup
  :  t
  -> directory:string
  -> owner_token:string
  -> (unit, Workgraph.Problem.t) Result.t
