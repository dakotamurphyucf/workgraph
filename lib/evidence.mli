open Core
module Pin = Evidence_event.Pin
module Resource_pin = Evidence_event.Resource_pin
module Contract_ref = Evidence_event.Contract_ref
module Manifest_ref = Evidence_event.Manifest_ref
module Artifact = Evidence_event.Artifact
module Contract = Evidence_event.Contract
module Manifest = Evidence_event.Manifest
module Policy = Evidence_event.Policy
module Submission = Evidence_event.Submission
module Review = Evidence_event.Review
module Validation = Evidence_event.Validation
module Decision = Evidence_event.Decision
module Reconciliation = Evidence_event.Reconciliation
module Change = Evidence_event

module Disposition : sig
  type t =
    | Acknowledge
    | Continue of string
    | Revised of Manifest_ref.t
  [@@deriving sexp]
end

module Command : sig
  type t =
    | Contract_put of
        { id : Evidence_id.Contract.t
        ; expected_revision : int
        ; schema_version : int
        ; schema : Resource_pin.t
        ; required_inputs : string list
        ; required_outputs : string list
        }
    | Manifest_publish of
        { id : Evidence_id.Manifest.t
        ; expected_revision : int
        ; schema_version : int
        ; attempt : Attempt.Id.t
        ; ticket : Id.Ticket.t
        ; contract : Contract_ref.t
        ; inputs : Artifact.t list
        ; outputs : Artifact.t list
        }
    | Policy_put of
        { ticket : Id.Ticket.t
        ; expected_revision : int
        ; enabled : bool
        ; reviewers : Policy.Requirement.t list
        ; separate_actor : bool
        ; validators : string list
        }
    | Submit of
        { ticket : Id.Ticket.t
        ; expected_revision : int
        ; manifest : Manifest_ref.t
        ; review_request : Communication_id.Request.t option
        }
    | Review of
        { id : Evidence_id.Review.t
        ; ticket : Id.Ticket.t
        ; generation : int
        ; verdict : Review.Verdict.t
        ; evidence : string
        ; comment : Id.Comment.t option
        }
    | Accept of
        { ticket : Id.Ticket.t
        ; expected_revision : int
        }
    | Validate of
        { id : Evidence_id.Validation.t
        ; manifest : Manifest_ref.t
        ; name : string
        ; passed : bool
        ; evidence : string
        }
    | Decision_put of
        { id : Evidence_id.Decision.t
        ; expected_revision : int
        ; scope : Entity_ref.t
        ; title : string
        ; rationale : Pin.t
        ; evidence : Pin.t list
        ; affected : Entity_ref.t list
        ; supersedes : Evidence_id.Decision.t list
        }
    | Input_changed of
        { previous : Pin.t
        ; current : Pin.t
        }
    | Reconcile of
        { serial : int
        ; expected_revision : int
        ; disposition : Disposition.t
        }
  [@@deriving sexp]
end

type t
type prepared

val empty : t
val revision : t -> int

val prepare
  :  t
  -> Command.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (prepared, Problem.t) Result.t

val candidate : prepared -> t
val changes : prepared -> Change.t list
val result : prepared -> Jsonaf.t
val apply : t -> Change.t -> (t, Problem.t) Result.t

(** Final-batch validation. Callbacks are pure immutable-capture lookups. They
    validate exact historical versions, not merely the latest object heads. *)
val validate_references
  :  t
  -> attempt:(Attempt.Id.t -> Attempt.t option)
  -> pin_exists:(Pin.t -> bool)
  -> entity_exists:(Entity_ref.t -> bool)
  -> review_request_exists:(Communication_id.Request.t -> bool)
  -> (unit, Problem.t) Result.t

(** Distinct historical journal references, in typed comparator order, for root
    validation against an immutable committed session capture. *)
val event_references : t -> Session.Event_ref.t list

(** Root checks actual ticket claim fencing and attempt actor ownership for
    each returned attempt before applying its command. A terminal consumer may
    acknowledge or justify continued historical input use with its recorded
    actor/run attribution, without an obsolete claim token. It cannot publish a
    revised manifest or alter a replacement attempt's ownership. *)
val command_attempts : t -> Command.t -> Attempt.Id.t list

val ensure_can_complete : t -> ticket:Id.Ticket.t -> (unit, Problem.t) Result.t

(** Registered attempts always require their exact latest input/output manifest.
    An enabled review gate must accept that same manifest, never another attempt's. *)
val ensure_attempt_can_complete
  :  t
  -> attempt:Attempt.Id.t
  -> ticket:Id.Ticket.t
  -> (unit, Problem.t) Result.t

val pending_reconciliations : t -> attempt:Attempt.Id.t option -> Reconciliation.t list
val review_recipients : t -> ticket:Id.Ticket.t -> Id.Actor.t list
val get_manifest : t -> Manifest_ref.t -> Manifest.t option
val get_submission : t -> Id.Ticket.t -> Submission.t option
val change_targets : t -> Change.t -> Entity_ref.t list
val decode : method_:string -> params:Jsonaf.t -> (Command.t, Problem.t) Result.t
val encode : Command.t -> (string * Jsonaf.t, Problem.t) Result.t
val mutation_methods : string list
val query_methods : string list
val query : t -> method_:string -> params:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t
val to_json : t -> Jsonaf.t
val current_submissions : t -> Submission.t list
val current_policies : t -> Policy.t list
