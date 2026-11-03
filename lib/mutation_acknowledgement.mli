open Core

module Commit : sig
  type t =
    { workspace_revision : Api_position.Workspace_revision.t
    ; result : Jsonaf.t
    }
end

module Observation : sig
  (** An empty standalone allocation observed at this exact planning capture.
      No durable identity or attempt was consumed. Retrying the identical request
      reevaluates until a selection commits its immutable receipt. *)
  type t =
    { workspace_revision : Api_position.Workspace_revision.t
    ; explanation : Allocation.Explanation.t
    }
end

type t =
  | Committed of Commit.t
  | Observed_empty of Observation.t

(** Validate publication for the exact invoked method. Only a strictly decoded
    standalone [ticket.claim_next] empty with [durable:false] and matching capture
    revisions is an observation. Selected allocations and explicit transactions
    require durable acknowledgement. Missing, crossed or malformed metadata/data
    reports [Outcome_unknown]; it never proves a write was rejected. *)
val of_response : Api_response.t -> method_:string -> (t, Problem.t) Result.t
