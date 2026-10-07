open Core

module Registration : sig
  type t =
    { root : string
    ; is_open : bool
    ; known_head : string option
    ; known_history_head : string option
    }
end

module Receipt : sig
  type t =
    { request_hash : string
    ; response : Jsonaf.t
    }
end

module Create_intent : sig
  type t =
    { request_hash : string
    ; root : string
    ; workspace : Id.Workspace.t
    ; name : string
    ; token : string
    }
end

(** Immutable local registry snapshot. The service publishes a candidate only after
    the worker atomically replaces and syncs registry.json. Receipts are scoped to
    actor/mutation in this registry, independently of portable workspace receipts.
    Create intents reserve identity and root until a successful retry completes. *)
type t =
  { registrations : Registration.t String.Map.t
  ; receipts : Receipt.t String.Map.t
  ; creates : Create_intent.t String.Map.t
  ; exports : Export_job.t String.Map.t
  ; restores : Restore_plan.t String.Map.t
  }

val empty : t
val encode : t -> (string, Problem.t) Result.t
val decode : string -> (t, Problem.t) Result.t
val request : method_:string -> params:Jsonaf.t -> (string * string, Problem.t) Result.t
