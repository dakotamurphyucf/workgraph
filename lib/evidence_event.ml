open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

(** Current tagged evidence and review representation. Version/counter decoders use
    canonical decimal strings. All provenance is immutable or revisioned. *)
module Counter = struct
  type t = int [@@deriving sexp, equal]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Attribution = struct
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Resource_pin = struct
  type t =
    { id : Id.Resource.t
    ; revision : Counter.t
    ; digest : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Contract_ref = struct
  type t =
    { id : Evidence_id.Contract.t
    ; revision : Counter.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Manifest_ref = struct
  type t =
    { id : Evidence_id.Manifest.t
    ; revision : Counter.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Event_ref = struct
  type t = Session.Event_ref.t [@@deriving sexp, equal]

  let jsonaf_of_t = Session.Event_ref.to_json

  let t_of_jsonaf json =
    match Session.Event_ref.of_json json with
    | Ok ref_ -> ref_
    | Error error -> raise (Json.Decode_error error)
  ;;
end

module Pin = struct
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
end

module Artifact = struct
  type t =
    { name : string
    ; pin : Pin.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Contract = struct
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

module Manifest = struct
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

module Policy = struct
  module Requirement = struct
    type t =
      | Named_actor of Id.Actor.t
      | Role of
          { name : string
          ; members : Id.Actor.t list
          }
    [@@deriving sexp, equal, jsonaf]
  end

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

module Submission = struct
  module State = struct
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
    ; policy_revision : Counter.t
    ; author : Attribution.t
    ; review_request : Communication_id.Request.t option
    ; state : State.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Review = struct
  module Verdict = struct
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
    ; policy_revision : Counter.t
    ; reviewer : Attribution.t
    ; verdict : Verdict.t
    ; evidence : string
    ; comment : Id.Comment.t option
    }
  [@@deriving sexp, equal, jsonaf]
end

module Validation = struct
  type t =
    { id : Evidence_id.Validation.t
    ; serial : Counter.t
    ; manifest : Manifest_ref.t
    ; contract : Contract_ref.t
    ; name : string
    ; passed : bool
    ; evidence : string
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Decision = struct
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

module Reconciliation = struct
  module State = struct
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

module Update = struct
  type t =
    | Contract_put of Contract.t
    | Manifest_put of Manifest.t
    | Policy_put of Policy.t
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

let generated_t_of_jsonaf = t_of_jsonaf

let t_of_jsonaf json =
  let event =
    try generated_t_of_jsonaf json with
    | Jsonaf_kernel.Conv.Of_jsonaf_error (exn, _) ->
      Json.fail Invalid_argument ("invalid evidence event: " ^ Exn.to_string exn)
  in
  if not (Int.equal event.version 1)
  then Json.fail Unsupported_version "unsupported evidence event version";
  if event.revision <= 0 || event.sequence <= 0
  then Json.fail Corrupt_store "invalid evidence event counter";
  let positive n =
    if n <= 0 then Json.fail Corrupt_store "invalid evidence entity counter"
  in
  (match event.update with
   | Update.Contract_put c ->
     positive c.Contract.revision;
     positive c.schema_version
   | Manifest_put m ->
     positive m.Manifest.revision;
     positive m.schema_version;
     positive m.contract.revision
   | Policy_put p -> positive p.Policy.revision
   | Submission_put s ->
     positive s.Submission.revision;
     positive s.generation
   | Review_added { review; submission } ->
     positive review.Review.serial;
     positive review.generation;
     positive submission.Submission.revision
   | Validation_added v -> positive v.Validation.serial
   | Decision_put d -> positive d.Decision.revision
   | Input_changed _ -> ()
   | Reconciliation_put r ->
     positive r.Reconciliation.serial;
     positive r.revision);
  List.iter event.reconciliations ~f:(fun r ->
    positive r.Reconciliation.serial;
    positive r.revision);
  event
;;

let decode json = Json.decode (fun () -> t_of_jsonaf json)
