open Core

type t =
  | Create of Session.t
  | Archive of Session_id.t
  | Append of
      { session : Session_id.t
      ; inputs : Session_event.Input.t list
      }

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

val execute
  :  Session_store.t
  -> t
  -> actor:Id.Actor.t
  -> ?run:Id.Run.t
  -> key:string
  -> request_hash:string
  -> unit
  -> (Jsonaf.t, Problem.t) Result.t

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
