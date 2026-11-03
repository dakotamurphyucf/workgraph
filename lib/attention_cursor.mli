open Core

(** Private shared cursor with exact filter/workspace/lineage binding. Position
    counts immutable rows/fragments in a frozen audit range; consumed ranges
    recapture from their prior upper revision. No readiness history is retained. *)
type t =
  { after : int
  ; through : int
  ; offset : int
  ; clock : int64
  ; anchor : string
  }

val capture
  :  workspace:Id.Workspace.t
  -> revision:int
  -> activity:Jsonaf.t list
  -> filter:Jsonaf.t
  -> after:int option
  -> cursor:string option
  -> now_unix_ms:int64
  -> (t, Problem.t) Result.t

val encode : t -> workspace:Id.Workspace.t -> filter:Jsonaf.t -> string
val advance : t -> count:int -> complete:bool -> t

(** Current-view page: cursor refuses any changed planning capture; returned
    envelope is Planning_read and fitting keeps whole rows with exact position. *)
val current_page
  :  workspace:Id.Workspace.t
  -> revision:int
  -> activity:Jsonaf.t list
  -> filter:Jsonaf.t
  -> cursor:string option
  -> now_unix_ms:int64
  -> rows:Jsonaf.t list
  -> limit:int
  -> max_bytes:int
  -> (Jsonaf.t, Problem.t) Result.t
