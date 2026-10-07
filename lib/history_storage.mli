open Core

(** Current strict history schemas, independently validated from domain records.
    Unknown versions/fields are rejected; there are no legacy format readers.
    Receipts have exact per-change envelopes and event attribution matches the
    actor-scoped receipt and append run. Recovery additionally verifies receipt
    metadata, watermark and referenced events against replayed state. *)
module Head : sig
  type t

  val create
    :  workspace:Id.Workspace.t
    -> sequence:int
    -> digest:string option
    -> (t, Problem.t) Result.t

  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val workspace : t -> Id.Workspace.t
  val sequence : t -> int
  val digest : t -> string option
end

module Batch : sig
  type t

  val create
    :  workspace:Id.Workspace.t
    -> sequence:int
    -> previous:string option
    -> key:string
    -> request_hash:string
    -> change:Jsonaf.t
    -> response:Jsonaf.t
    -> (t, Problem.t) Result.t

  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
end
