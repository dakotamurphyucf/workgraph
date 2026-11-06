open Core

(** Domain-owned LRU of immutable, verified captures. Keys include the root's
    open generation, workspace and exact head. Idle entries hold no root pins.
    At most eight entries and 16MiB of weighted metadata are retained. The weight
    is a conservative accounting heuristic, not an OCaml heap limit; queued
    captures and current journal state are outside this cache's budget. *)
type t

val create : unit -> t

val find
  :  t
  -> root:string
  -> generation:int
  -> workspace:Id.Workspace.t
  -> head:string option
  -> Session_store.Capture.t option

(** Calculate on a read worker, not on the serialized dispatcher. *)
val weight : Session_store.Capture.t -> int

(** Oversized captures are served normally but not retained. *)
val add
  :  t
  -> root:string
  -> generation:int
  -> capture:Session_store.Capture.t
  -> weight:int
  -> unit
