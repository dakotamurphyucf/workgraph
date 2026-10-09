open Core

(** Current tagged evidence and review representation. Version/counter decoders use
    canonical decimal strings. All provenance is immutable or revisioned. *)
module Counter : sig
  type t = int [@@deriving sexp, jsonaf]
end

module Attribution : sig
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Resource_pin : sig
  type t =
    { id : Id.Resource.t
    ; revision : Counter.t
    ; digest : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Contract_ref : sig
  type t =
    { id : Evidence_id.Contract.t
    ; revision : Counter.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Manifest_ref : sig
  type t =
    { id : Evidence_id.Manifest.t
    ; revision : Counter.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Event_ref : sig
  type t = Session.Event_ref.t [@@deriving sexp, equal]

  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Pin : sig
  type t =
    | Resource of Resource_pin.t
    | Event of Event_ref.t
    | Commit of
        { repository : string
        ; object_id : string
        }
    | Checksum of
        { source : string
        ; digest : string
        }
    | Comment of
        { id : Id.Comment.t
        ; revision : Counter.t
        }
    | Contract of Contract_ref.t
    | Decision of
        { id : Evidence_id.Decision.t
        ; revision : Counter.t
        }
  [@@deriving sexp, equal, jsonaf]

  val validate : t -> (unit, Problem.t) Result.t
end

module Artifact : sig
  type t =
    { name : string
    ; pin : Pin.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Contract : sig
  type t =
    { id : Evidence_id.Contract.t
    ; revision : Counter.t
    ; schema_version : Counter.t
    ; schema : Resource_pin.t
    ; required_inputs : string list
    ; required_outputs : string list
    }
  [@@deriving sexp, equal, jsonaf]
end

module Manifest : sig
  type t =
    { id : Evidence_id.Manifest.t
    ; revision : Counter.t
    ; schema_version : Counter.t
    ; attempt : Attempt.Id.t
    ; ticket : Id.Ticket.t
    ; contract : Contract_ref.t
    ; inputs : Artifact.t list
    ; outputs : Artifact.t list
    ; published : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Policy : sig
  module Requirement = Acceptance_policy.Requirement

  type t =
    { ticket : Id.Ticket.t
    ; revision : Counter.t
    ; enabled : bool
    ; reviewers : Requirement.t list
    ; separate_actor : bool
    ; validators : string list
    }
  [@@deriving sexp, equal, jsonaf]
end

module Acceptance_policy_version : sig
  type t =
    { definition : Acceptance_policy.Definition.t
    ; weakening_reason : string option
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Assertion : sig
  type t =
    { serial : Counter.t
    ; ticket : Id.Ticket.t
    ; token : Counter.t
    ; attempt : Attempt.Id.t option
    ; manifest : Manifest_ref.t option
    ; artifacts : Artifact.t list
    ; policy_binding : Acceptance_policy.Effective.Binding.t
    ; criterion : Acceptance_policy.Criterion.Ref.t
    ; passed : bool
    ; evidence_pins : Pin.t list
    ; evidence : string
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]

  val validate : t -> (unit, Problem.t) Result.t
end

module Submission : sig
  module State : sig
    type t =
      | Pending
      | Accepted of Attribution.t
      | Changes_requested of Attribution.t
    [@@deriving sexp, equal, jsonaf]
  end

  type t =
    { ticket : Id.Ticket.t
    ; revision : Counter.t
    ; generation : Counter.t
    ; manifest : Manifest_ref.t
    ; contract : Contract_ref.t
    ; policy_binding : Acceptance_policy.Effective.Binding.t
    ; author : Attribution.t
    ; review_request : Communication_id.Request.t option
    ; state : State.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Review : sig
  module Verdict : sig
    type t =
      | Approve
      | Request_changes
    [@@deriving sexp, equal, jsonaf]
  end

  type t =
    { id : Evidence_id.Review.t
    ; serial : Counter.t
    ; ticket : Id.Ticket.t
    ; generation : Counter.t
    ; manifest : Manifest_ref.t
    ; contract : Contract_ref.t
    ; policy_binding : Acceptance_policy.Effective.Binding.t
    ; reviewer : Attribution.t
    ; verdict : Verdict.t
    ; evidence : string
    ; comment : Id.Comment.t option
    }
  [@@deriving sexp, equal, jsonaf]
end

module Validation : sig
  type t =
    { id : Evidence_id.Validation.t
    ; serial : Counter.t
    ; manifest : Manifest_ref.t
    ; contract : Contract_ref.t
    ; policy_binding : Acceptance_policy.Effective.Binding.t
    ; name : string
    ; passed : bool
    ; evidence : string
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Decision : sig
  type t =
    { id : Evidence_id.Decision.t
    ; revision : Counter.t
    ; scope : Entity_ref.t
    ; title : string
    ; rationale : Pin.t
    ; evidence : Pin.t list
    ; affected : Entity_ref.t list
    ; supersedes : Evidence_id.Decision.t list
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Reconciliation : sig
  module State : sig
    type t =
      | Pending
      | Acknowledged of Attribution.t
      | Continued of
          { attribution : Attribution.t
          ; reason : string
          }
      | Revised of
          { attribution : Attribution.t
          ; manifest : Manifest_ref.t
          }
    [@@deriving sexp, equal, jsonaf]
  end

  type t =
    { serial : Counter.t
    ; revision : Counter.t
    ; attempt : Attempt.Id.t
    ; ticket : Id.Ticket.t
    ; previous : Pin.t
    ; current : Pin.t
    ; state : State.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Update : sig
  type t =
    | Contract_put of Contract.t
    | Manifest_put of Manifest.t
    | Policy_put of Acceptance_policy_version.t
    | Assertion_added of Assertion.t
    | Submission_put of Submission.t
    | Review_added of
        { review : Review.t
        ; submission : Submission.t
        }
    | Validation_added of Validation.t
    | Decision_put of Decision.t
    | Input_changed of
        { previous : Pin.t
        ; current : Pin.t
        }
    | Reconciliation_put of Reconciliation.t
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { version : Counter.t
  ; revision : Counter.t
  ; sequence : Counter.t
  ; attribution : Attribution.t
  ; update : Update.t
  ; reconciliations : Reconciliation.t list
  }
[@@deriving sexp, equal, jsonaf]

val decode : Jsonaf.t -> (t, Problem.t) Result.t
