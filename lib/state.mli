open Core

(** Public facade over private immutable snapshot, preparation, replay, query,
    search and rendering modules. Clients cannot construct intermediate state. *)
type t

type prepared

(** Validate a nonempty name of at most 512 bytes before creating a state. *)
val empty : workspace:Id.Workspace.t -> name:string -> (t, Problem.t) Result.t

val revision : t -> int
val workspace : t -> Id.Workspace.t
val name : t -> string
val archived : t -> bool

(** Immutable projections for pure coordinator views. *)
val agent_runs : t -> Agent_run.t

val evidence : t -> Evidence.t
val communication : t -> Communication.t
val policies : t -> Agent_run_policy.t

(** Planning/entity/fact admission accounting at this immutable snapshot. These
    are enforced allowances, not physical disk usage or guaranteed future capacity. *)
val admission : t -> Admission.t list

(** Recorded transitions and UTC status intervals from retained planning audit.
    Unknown/regressed time intervals remain explicitly unavailable. *)
val metrics : t -> observed_unix_ms:int64 -> Workspace_metrics.Planning.t

(** Coordinator graph candidates and exact typed readiness. [run] supplies the
    same selector used for allocation diagnostics; omitting it retains actionable
    run-required reasons. Supply current [now_unix_ms] for timed ownership; absent
    time remains explicitly unavailable rather than inferred from a stored lease. *)
val coordination_tickets
  :  ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> t
  -> Coordinator.Ticket.t list

(** Pure preparation. State and receipt remain unpublished until durable commit.
    [actor] is attribution within the trusted local user, not authentication.
    A batch stages operations in order and validates final references/graphs as
    one transaction. All operations share one workspace revision and audit entry;
    any failure discards the entire candidate, including staged blob references.
    Content changes use entity revisions; appended activity does not change those
    revisions. Catalog status categories are immutable; archiving retains old
    references. Ticket moves update the entire descendant subtree atomically.
    Holds and unwaived unfinished prerequisites block readiness and completion.
    Claims persist until explicitly released/reassigned/completed; reassignment
    advances the fencing token and does not change assignment. Opaque run IDs may
    fence invocations without registration; a new claim for a registered run must
    match its actor and cannot target a terminal run. Reassignment reasons and
    review rejection evidence remain exact discussion bodies, including at the
    64KiB text limit; review correlation is stored on the actionable request.
    Related-ticket
    links are symmetric, nonblocking, local and limited to 100 per ticket; changing
    a link checks both endpoint revisions and updates them atomically. Ticket
    creation allocates a workspace-local WG-N display key; archive/move/update
    preserve it. *)
val prepare
  :  t
  -> ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> Domain_command.t
  -> actor:Id.Actor.t
  -> timestamp:string
  -> (prepared, Problem.t) Result.t

val candidate : prepared -> t
val events : prepared -> Jsonaf.t
val result : prepared -> Jsonaf.t
val blobs : prepared -> (string * string) list

(** Replay resolved versioned changes, without running the original command.
    Comment versions match transaction attribution. Claimed ticket completion
    requires its adjacent immutable evidence; unrelated completion origins fail.
    New attempts recheck the allocation budget at their recorded event boundary.
    Terminal reconciliation acknowledgement/continued-use events retain their
    recorded consumer actor/run and cannot revise inputs.
    Rebuilds immutable comment and audit target indexes. Scoped activity uses the
    targets captured at commit time, including both sides of project moves. *)
val replay : t -> Jsonaf.t -> (t, Problem.t) Result.t

(** Lists default to 50 items (maximum 100); subsequent offsets require the
    observed workspace revision. Ready work is ordered by priority (1..4, then
    unspecified 0), creation sequence and ID. Other lists use ascending IDs or
    activity order. Archived scopes are omitted unless explicitly requested;
    direct context queries retain access to their history. [max_bytes] bounds the
    canonical JSON result to 4KiB..1MiB, default 64KiB, with omission metadata.
    [query] searches in-memory sources only; [query_with_texts] also uses bounded
    current resource prefixes supplied by the storage adapter, validating revision
    and digest identity. Both disclose excluded text and source/index revisions. *)
val query
  :  ?now_unix_ms:int64
  -> t
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val query_with_texts
  :  ?now_unix_ms:int64
  -> t
  -> resource_texts:Search.Text.t list
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val search_resources : t -> params:Jsonaf.t -> (Resource.t list, Problem.t) Result.t
val to_json : t -> Jsonaf.t
val blob_digests : t -> string list
val blob_references : t -> (string * int option) list
val required_blobs : prepared -> (string * int option) list

val resource_version
  :  t
  -> Id.Resource.t
  -> revision:int option
  -> (Resource.Version.t, Problem.t) Result.t

(** Deterministic lazy rendering, one file at a time. Retains the immutable state;
    callers need not retain all rendered Markdown/JSON strings simultaneously. *)
val readable_files : t -> (string * string) Sequence.t

(** Pure scope validation before independent journal mutations. *)
val validate_targets : t -> Entity_ref.t list -> (unit, Problem.t) Result.t

(** Validate all cross-stream run and pinned evidence references against one
    immutable committed session capture; never performs Store I/O. *)
val validate_history
  :  t
  -> session_exists:(Session_id.t -> bool)
  -> event_exists:(Session.Event_ref.t -> bool)
  -> (unit, Problem.t) Result.t

(** Validate registered run attribution without claiming it authenticates a user. *)
val validate_run_actor
  :  t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> (unit, Problem.t) Result.t
