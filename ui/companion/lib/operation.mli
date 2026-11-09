open Core
module Id : Workgraph.Id.S

module Context : sig
  (** Effective draft context displayed at confirmation. Namespace targets may
      differ from current workspace/project selection; no defaults are merged. *)
  type t

  val create
    :  workspace:Workgraph.Id.Workspace.t option
    -> project:Workgraph.Id.Project.t option
    -> writer:Writer.t
    -> t

  val workspace : t -> Workgraph.Id.Workspace.t option
  val project : t -> Workgraph.Id.Project.t option
  val writer : t -> Writer.t
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Preparation : sig
  (** Complete immutable browser preparation input. Params contain all effective
      scope/writer/default inputs; no ambient context is consulted after matching.
      Hash excludes a generated mutation identity and includes endpoint generation. *)
  type t

  val create
    :  intention_id:string
    -> connection:Connection_profile.t
    -> context:Context.t
    -> method_:string
    -> params:Jsonaf.t
    -> (t, Workgraph.Problem.t) Result.t

  val intention_id : t -> string
  val connection : t -> Connection_profile.t
  val context : t -> Context.t
  val method_ : t -> string
  val params : t -> Jsonaf.t
  val input_hash : t -> string
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

type state =
  | Prepared_unsent
  | Sending
  | Committed of Workgraph.Api_response.t
  | Observed of Workgraph.Api_response.t
  | Rejected of Workgraph.Problem.t
  | Outcome_unknown of Workgraph.Problem.t

(** Immutable observation. Revisions cover the complete visible observation,
    including diagnostics, and are local monotone counters distinct from daemon
    positions. Only synced observations survive a restart; per-launch browser
    correlation must discard observations from an earlier companion launch.
    A diagnostic after an observed receipt is retained
    separately; local persistence failure cannot turn commit into rejection. *)
type t

val create
  :  id:Id.t
  -> preparation:Preparation.t
  -> request:Workgraph.Protocol.Request.t
  -> journal_path:string option
  -> t

val id : t -> Id.t
val preparation : t -> Preparation.t
val request : t -> Workgraph.Protocol.Request.t
val journal_path : t -> string option
val state : t -> state
val revision : t -> int
val with_state : t -> state -> t
val with_diagnostic : t -> Workgraph.Problem.t -> t
val to_json : t -> Jsonaf.t
val summary : t -> Jsonaf.t

(** Validates current local storage, full request and recorded method result.
    Loading Sending always yields conservative Outcome_unknown. Missing/corrupt
    status is never manufactured into Prepared_unsent. *)
val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t

(** Separate local storage stores preparation/request params and response data
    as independently parsed opaque canonical text, inside shallow typed metadata
    documents. No local wrapper consumes any original payload's 64-level budget.
    Only current storage is admitted. *)
val to_storage_json : t -> Jsonaf.t

val of_storage_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
