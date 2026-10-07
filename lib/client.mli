type t

(** One connection per request with a finite monotonic timeout. No implicit retry
    or mutation-ID generation. Transport/protocol failures after a write attempt
    report Outcome_unknown for write methods. External cancellation propagates. *)
val create
  :  net:_ Eio.Net.t
  -> clock:_ Eio.Time.Mono.t
  -> socket:string
  -> timeout_seconds:float
  -> (t, Problem.t) result

val execute : t -> Protocol.Request.t -> (Protocol.response, Problem.t) result
val invoke : t -> Protocol.Request.t -> (Jsonaf.t, Problem.t) result

module Commit : sig
  type t =
    { workspace_revision : int
    ; result : Jsonaf.t
    }
end

(** Encodes and validates every public domain command. The caller owns the stable
    mutation ID; [Ok] requires a response explicitly marked durable. *)
val mutate
  :  t
  -> ?run:Id.Run.t
  -> workspace:Id.Workspace.t
  -> actor:Id.Actor.t
  -> mutation_id:Id.Actor.t
  -> Domain_command.t
  -> (Commit.t, Problem.t) result

module Administration : sig
  type t =
    | Create of
        { workspace : Id.Workspace.t
        ; name : string
        ; root : string
        }
    | Register of { root : string }
    | Open of Id.Workspace.t
    | Close of Id.Workspace.t
    | Unregister of Id.Workspace.t
    | Export of
        { workspace : Id.Workspace.t
        ; destination : string
        }
    | Export_all of
        { destination : string
        ; allow_partial : bool
        }
    | Cancel_export of { job_id : string }
    | Retry_export of { job_id : string }
    | Restore of
        { directory : string
        ; root : string
        }
    | Restore_all of
        { directory : string
        ; roots : (Id.Workspace.t * string) list
        }
    | Cancel_restore of
        { target_actor : Id.Actor.t
        ; target_mutation : Id.Actor.t
        }
end

val administrate
  :  t
  -> actor:Id.Actor.t
  -> mutation_id:Id.Actor.t
  -> Administration.t
  -> (Jsonaf.t, Problem.t) result

module Query_result : sig
  type t =
    { workspace_revision : int
    ; data : Jsonaf.t
    ; budget : Jsonaf.t
    }
end

val query
  :  t
  -> workspace:Id.Workspace.t
  -> parameters:(string * Jsonaf.t) list
  -> Query_request.t
  -> (Query_result.t, Problem.t) result
