open Core

(** SHA256 of exact contiguous retained audit prefix through a workspace
    revision; zero denotes the empty prefix. One current schema, no alternate
    cursor format. Private helper shared by changes.read and activity.digest. *)
type t

val of_activity : Jsonaf.t list -> through:int -> (t, Problem.t) Result.t
val through : t -> int
val digest : t -> string
val equal : t -> t -> bool

(** One traversal can validate an older checkpoint while hashing a new upper
    capture. This preserves existing changes.read cursor behavior. *)
val with_checkpoint
  :  Jsonaf.t list
  -> through:int
  -> checkpoint:int option
  -> (t * string option, Problem.t) Result.t
