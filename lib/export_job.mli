open Core

module Capture : sig
  type t =
    { workspace : Id.Workspace.t
    ; revision : int
    ; head : string option
    ; history_head : string option
    }

  val to_json : t -> Jsonaf.t
  val validate : t -> unit
  val of_json : Jsonaf.t -> t
end

type kind =
  | Single
  | All
[@@deriving equal, sexp]

type status =
  | Running
  | Completed
  | Failed
  | Canceled
  | Interrupted
[@@deriving equal, sexp]

(** Pure durable metadata. Main dispatcher owns transitions and persists this
    record atomically with the registry receipt. Capture identity never changes
    on retry; each attempt uses a fresh private stage. No absolute source paths
    appear in the exported inventory. Errors are bounded diagnostic text. *)
type t =
  { id : string
  ; kind : kind
  ; destination : string
  ; captures : Capture.t list
  ; omitted : Id.Workspace.t list
  ; status : status
  ; attempt : int
  ; cancel_requested : bool
  ; error : string option
  }

val stage : t -> string
val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> t
val validate : t -> unit
val contains : t -> workspace:string -> bool
