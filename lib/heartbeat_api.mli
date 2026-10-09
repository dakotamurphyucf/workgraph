open Core

module Read : sig
  type t =
    { workspace_id : Id.Workspace.t
    ; target_run_id : Id.Run.t
    }
end

module Observe : sig
  type t =
    { workspace_id : Id.Workspace.t
    ; target_run_id : Id.Run.t
    ; actor_id : Id.Actor.t
    }
end

(** Advisory observations are coalesced, not journaled transactions. No mutation
    identity is accepted; acknowledgements report whether this exact observation
    reached the local cache file. They never renew claim or reservation leases.
    Result validation preserves observation times, actor identity and the exact
    relationship between current/persisted observations and [durable]. *)
val observe : (Observe.t, Jsonaf.t) Api_method.t

val read : (Read.t, Jsonaf.t) Api_method.t
val methods : Api_method.Packed.t list
