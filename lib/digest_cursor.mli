open Core

module Position : sig
  (** after marks the last scanned resolved change. None is before revision1.
      Includes nonclassified scanned changes; fitting never advances past an
      omitted classified row. An exhausted upper capture may advance next scan. *)
  type t

  val before_first : t
  val after_revision : int -> (t, Problem.t) Result.t
  val complete : t -> through:int -> bool
  val follows : t -> revision:int -> change_index:int -> bool
  val create : revision:int -> change_index:int -> (t, Problem.t) Result.t
  val revision : t -> int
  val change_index : t -> int
end

type t

val create
  :  workspace:Id.Workspace.t
  -> scope:Resume_api.Scope.t
  -> position:Position.t
  -> lineage:Planning_lineage.t
  -> (t, Problem.t) Result.t

val encode : t -> string
val decode : string -> (t, Problem.t) Result.t

(** Bind actual workspace/scope/prefix lineage and row bounds. New commits after
    through are permitted; changed prefixes, unavailable bounds and inconsistent
    ordinals reject Conflict. Pure, no server capability or hidden clock. *)
val validate
  :  t
  -> workspace:Id.Workspace.t
  -> scope:Resume_api.Scope.t
  -> activity:Jsonaf.t list
  -> (unit, Problem.t) Result.t

val through : t -> int
val position : t -> Position.t
val lineage : t -> string
