open Core

(** Single-domain metadata owner; one service-owned offline helper at a time.
    File conversion/verification runs in an isolated Eio worker domain, never on
    the browser/HTTP domain. Cancellation/unexpected exceptions remain distinct. *)
type t

module Plan : sig
  type action =
    | Migrate_0_6_2 of
        { source : string
        ; destination : string
        }
    | Cleanup_stage of
        { stage : string
        ; owner_token : string
        }

  type t

  (** Absolute companion-host paths. Context is audit capture, not RPC identity.
      Only these two fixed native helpers exist; no executable/shell input. *)
  val create
    :  intention_id:Operation.Id.t
    -> context:Daemon_launcher.Context.t
    -> action:action
    -> (t, Workgraph.Problem.t) Result.t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Job : sig
  type t

  (** Exact original plan, captured canonical execution_action, combined input hash,
      decimal revision, cancel_requested, diagnostic and
      one state: prepared_unsent, running, succeeded, failed, canceled_unsent,
      outcome_unknown. Success includes an immutable full report path/hash/bytes;
      bounded metadata never silently drops history mapping report contents. A missing
      report requires a publication diagnostic and never negates known helper success.
      Startup rehashes published report bytes in an isolated domain; missing/changed
      artifacts retain the expected metadata with a diagnostic, preserving migration
      outcome. Paths/hashes describe private host files, not an HTTP download route. *)
  val to_json : t -> Jsonaf.t
end

(** Load only current format, validate public and storage invariants, durably
    recover Running to Outcome_unknown before exposing metadata. Lifetime root
    lock must outlive service. At most 100 retained records and one active helper. *)
val create
  :  sw:Eio.Switch.t
  -> env:Eio_unix.Stdenv.base
  -> root:State_root.t
  -> (t, Workgraph.Problem.t) Result.t

(** Exact full-plan deduplication precedes all materialization. Durable prepare
    publication precedes acknowledgement; failed publication is not exposed. Raw plan
    equality is checked before resolving aliases; first preparation captures canonical
    execution paths which subsequent execution/replay never re-resolve through the
    original aliases. These are path provenance, not a frozen source-byte snapshot. *)
val prepare : t -> Plan.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Persist Running barrier before invoking fixed helper; returns immediately
    after admission. Repeated start coalesces. No automatic restart/retry, and
    terminal/uncertain records cannot be rerun under the old identity: unlike a
    daemon mutation, this local conversion is not a saved immutable source capture. *)
val start : t -> intention_id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

(** Prepared cancellation is definitely unsent. Admitted cancellation is only a
    request: durably synchronize the cancellation record before delivering it to the
    helper; failed saves are retried exactly before any repeated acknowledgment.
    Propagate to helper and retain Outcome_unknown if publication might
    have occurred. Never claim rollback or delete source/published destinations. *)
val cancel : t -> intention_id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t

val inspect : t -> intention_id:Operation.Id.t -> (Job.t, Workgraph.Problem.t) Result.t
val list : t -> offset:int -> limit:int -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Existing bounded Request_journal helpers, read-only and unchecked offline.
    The default list directory is this companion's private saved-request journal;
    an explicitly supplied directory/path belongs to the companion host. *)
val journal_list
  :  t
  -> directory:string option
  -> after:string option
  -> limit:int
  -> max_bytes:int
  -> (Jsonaf.t, Workgraph.Problem.t) Result.t

val journal_inspect : t -> path:string -> (Jsonaf.t, Workgraph.Problem.t) Result.t
