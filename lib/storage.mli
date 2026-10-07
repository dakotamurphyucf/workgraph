open Core

(** Current portable canonical file schemas. Readers reject unknown fields and
    versions before replay. Constructors validate exactly the same invariants as
    readers. JSON integers are canonical nonnegative signed-int64 decimal strings;
    this profile additionally bounds sequences to 100000. *)
module Descriptor : sig
  type t

  val create : workspace:Id.Workspace.t -> name:string -> (t, Problem.t) Result.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val workspace : t -> Id.Workspace.t
  val name : t -> string
end

module Head : sig
  type t

  val create : sequence:int -> digest:string option -> (t, Problem.t) Result.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val sequence : t -> int
  val digest : t -> string option
end

module Transaction : sig
  type t

  (** Checks receipt identity, event actor/revision, hash syntax, predecessor shape,
      and the durable response envelope. The opaque command result is retained.
      Hash-chain membership is checked by the store using the original file bytes. *)
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t

  val to_json : t -> Jsonaf.t
  val workspace : t -> Id.Workspace.t
  val sequence : t -> int
  val previous : t -> string option
  val key : t -> string
  val request_hash : t -> string
  val events : t -> Jsonaf.t
  val response : t -> Jsonaf.t
end
