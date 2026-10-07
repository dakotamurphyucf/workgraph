open Core

module Event_ref : sig
  type t = private
    { session : Session_id.t
    ; sequence : int
    }
  [@@deriving sexp, equal, compare]

  val create : session:Session_id.t -> sequence:int -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

type t

(** Metadata is immutable; archive preserves access and prohibits later appends.
    Scope references must be validated against the enclosing workspace by the
    dispatcher. Parent/fork refers to an already committed local event. *)
val create
  :  workspace:Id.Workspace.t
  -> id:Session_id.t
  -> title:string
  -> actor:Id.Actor.t
  -> ?run:Id.Run.t
  -> ?parent:Event_ref.t
  -> scopes:Entity_ref.t list
  -> unit
  -> (t, Problem.t) Result.t

val id : t -> Session_id.t
val workspace : t -> Id.Workspace.t
val title : t -> string
val actor : t -> Id.Actor.t
val run : t -> Id.Run.t option
val parent : t -> Event_ref.t option
val scopes : t -> Entity_ref.t list
val archived : t -> bool
val archive : t -> t
val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t
