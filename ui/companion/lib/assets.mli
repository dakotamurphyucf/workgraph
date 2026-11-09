open Core

type asset =
  { path : string
  ; mime_type : string
  ; body : string
  ; digest : string
  }

(** Exact generated immutable asset manifest only; no filesystem traversal or
    fallback filesystem docroot. Bootstrap substitution is separate and no-store. *)
val find : string -> asset option

val manifest : unit -> Jsonaf.t
