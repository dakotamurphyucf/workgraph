open Core

(** Workspace mutation attribution and exact retry identity. These fields identify
    a cooperative caller; they do not authenticate it. Method parameters are kept
    separate so they cannot override attribution or mutation identity. *)
type t =
  { workspace : Id.Workspace.t
  ; actor : Id.Actor.t
  ; mutation : Id.Mutation.t
  ; run : Id.Run.t option
  }

val codec : t Api_codec.t
val key : t -> string

(** Exact planning receipt hash: method, original unscoped method parameters and
    optional run attribution. Workspace/actor/mutation form the receipt scope/key,
    not the hashed body. Omission and transaction aliases remain unchanged. Registry
    and independent history receipts use [Registry.request] instead. *)
val request_hash : t -> method_:string -> parameters:Jsonaf.t -> string

(** Split the shared identity fields from an object of method parameters. Reject
    duplicate fields, missing/invalid identities and explicit null for run_id. *)
val of_params : Jsonaf.t -> (t * Jsonaf.t, Problem.t) Result.t

(** Combine validated identity with method fields. Reserved field collisions and
    duplicate method fields fail; this does not validate a method-specific body. *)
val params : t -> parameters:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t
