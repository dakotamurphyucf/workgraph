open Core

type t =
  | Create of Session.t
  | Archive of Session_id.t
  | Append of
      { session : Session_id.t
      ; inputs : Session_event.Input.t list
      }

(** Decode through the same public codecs used by method descriptors. Resolved
    references never admit planning aliases. Scope/version existence checks remain
    the enclosing dispatcher's responsibility. *)
val decode
  :  workspace:Id.Workspace.t
  -> actor:Id.Actor.t
  -> ?run:Id.Run.t
  -> method_:string
  -> params:Jsonaf.t
  -> unit
  -> (t, Problem.t) Result.t

val session_scopes : t -> Entity_ref.t list
val resource_versions : t -> Session_event.Resource_ref.t list

(** Publish on the separate durable journal, then project and validate the saved
    receipt. Exact retries retain the original receipt metadata. Invalid internal
    response data raises [Api_method.Invalid_response], preserving uncertain-write
    behavior; cancellation and unexpected exceptions propagate. *)
val execute
  :  Session_store.t
  -> t
  -> actor:Id.Actor.t
  -> ?run:Id.Run.t
  -> key:string
  -> request_hash:string
  -> unit
  -> (Jsonaf.t, Problem.t) Result.t

(** Execute typed queries against this fixed capture. Budgets fit complete public
    metadata records and exact byte prefixes with explicit cursors; oversized
    captures/records return [Blocked]. The internal response includes [capture],
    projected by [Api_response.History] into public [meta.history_capture]. *)
val query
  :  Session_store.Capture.t
  -> fs:_ Eio.Path.t
  -> root:string
  -> index:History_index.t
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val mutation_methods : string list
val query_methods : string list
