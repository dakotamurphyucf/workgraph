open Core
module Pin = Evidence_event.Pin
module Resource_pin = Evidence_event.Resource_pin
module Contract_ref = Evidence_event.Contract_ref
module Manifest_ref = Evidence_event.Manifest_ref
module Artifact = Evidence_event.Artifact
module Contract = Evidence_event.Contract
module Manifest = Evidence_event.Manifest
module Policy = Evidence_event.Policy
module Policy_version = Evidence_event.Acceptance_policy_version
module Assertion = Evidence_event.Assertion
module Submission = Evidence_event.Submission
module Review = Evidence_event.Review
module Validation = Evidence_event.Validation
module Decision = Evidence_event.Decision
module Reconciliation = Evidence_event.Reconciliation
module Change = Evidence_event
module Counter = Change.Counter
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Disposition = struct
  type t =
    | Acknowledge
    | Continue of string
    | Revised of Manifest_ref.t
  [@@deriving sexp, jsonaf]
end

module Ticket_context = struct
  module Ownership = struct
    type t =
      { token : int
      ; actor : Id.Actor.t
      ; run : Id.Run.t option
      }
    [@@deriving sexp]
  end

  type t =
    { project : Id.Project.t option
    ; membership_revision : int
    ; minimum_reopening_token : int option
    ; current_token : int option
    ; ownership : Ownership.t option
    ; attempt : Attempt.Id.t option
    }
  [@@deriving sexp]
end

module Command = struct
  type t =
    | Contract_put of
        { id : Evidence_id.Contract.t
        ; expected_revision : Counter.t
        ; schema_version : Counter.t
        ; schema : Resource_pin.t
        ; required_inputs : string list
        ; required_outputs : string list
        }
    | Manifest_publish of
        { id : Evidence_id.Manifest.t
        ; expected_revision : Counter.t
        ; schema_version : Counter.t
        ; attempt : Attempt.Id.t
        ; ticket : Id.Ticket.t
        ; contract : Contract_ref.t
        ; inputs : Artifact.t list
        ; outputs : Artifact.t list
        }
    | Policy_put of
        { ticket : Id.Ticket.t
        ; expected_revision : Counter.t
        ; enabled : bool
        ; reviewers : Policy.Requirement.t list
        ; separate_actor : bool
        ; validators : string list
        ; weakening_reason : string option
        }
    | Acceptance_policy_put of
        { definition : Acceptance_policy.Definition.t
        ; expected_revision : Counter.t
        ; weakening_reason : string option
        }
    | Assert of
        { ticket : Id.Ticket.t
        ; token : Counter.t
        ; attempt : Attempt.Id.t option
        ; manifest : Manifest_ref.t option
        ; expected_policy_digest : string
        ; criterion : Acceptance_policy.Criterion.Ref.t
        ; passed : bool
        ; evidence_pins : Pin.t list
        ; evidence : string
        }
    | Submit of
        { ticket : Id.Ticket.t
        ; expected_revision : Counter.t
        ; manifest : Manifest_ref.t
        ; review_request : Communication_id.Request.t option
        }
    | Review of
        { id : Evidence_id.Review.t
        ; ticket : Id.Ticket.t
        ; generation : Counter.t
        ; verdict : Review.Verdict.t
        ; evidence : string
        ; comment : Id.Comment.t option
        }
    | Accept of
        { ticket : Id.Ticket.t
        ; expected_revision : Counter.t
        }
    | Validate of
        { id : Evidence_id.Validation.t
        ; manifest : Manifest_ref.t
        ; name : string
        ; expected_policy_digest : string
        ; passed : bool
        ; evidence : string
        }
    | Decision_put of
        { id : Evidence_id.Decision.t
        ; expected_revision : Counter.t
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
        { serial : Counter.t
        ; expected_revision : Counter.t
        ; disposition : Disposition.t
        }
  [@@deriving sexp, jsonaf]
end

module Attribution = Change.Attribution
module Update = Change.Update

type t =
  { revision : int
  ; contracts : Contract.t list Evidence_id.Contract.Map.t
  ; manifests : Manifest.t list Evidence_id.Manifest.Map.t
  ; policies : Policy_version.t list Acceptance_policy.Scope.Map.t
  ; assertions : Assertion.t Int.Map.t
  ; submissions : Submission.t list Id.Ticket.Map.t
  ; reviews : Review.t Evidence_id.Review.Map.t
  ; validations : Validation.t Evidence_id.Validation.Map.t
  ; decisions : Decision.t list Evidence_id.Decision.Map.t
  ; reconciliations : Reconciliation.t Int.Map.t
  ; latest_by_attempt : Manifest_ref.t Attempt.Id.Map.t
  ; latest_by_ticket : Manifest_ref.t Id.Ticket.Map.t
  ; history : Change.t list
  ; serial : int
  }

type prepared =
  { candidate : t
  ; changes : Change.t list
  ; result : Jsonaf.t
  }

let empty =
  { revision = 0
  ; contracts = Evidence_id.Contract.Map.empty
  ; manifests = Evidence_id.Manifest.Map.empty
  ; policies = Acceptance_policy.Scope.Map.empty
  ; assertions = Int.Map.empty
  ; submissions = Id.Ticket.Map.empty
  ; reviews = Evidence_id.Review.Map.empty
  ; validations = Evidence_id.Validation.Map.empty
  ; decisions = Evidence_id.Decision.Map.empty
  ; reconciliations = Int.Map.empty
  ; latest_by_attempt = Attempt.Id.Map.empty
  ; latest_by_ticket = Id.Ticket.Map.empty
  ; history = []
  ; serial = 0
  }
;;

let revision t = t.revision
let candidate p = p.candidate
let changes p = p.changes
let result p = p.result

let unwrap_evidence = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let require condition kind message = if not condition then Json.fail kind message

let find map key =
  match Map.find map key with
  | Some value -> value
  | None -> Json.fail Not_found "evidence record not found"
;;

let head values =
  match values with
  | x :: _ -> x
  | [] -> Json.fail Corrupt_store "evidence history is empty"
;;

let current map key = head (find map key)

let expected actual requested =
  require (Int.equal actual requested) Conflict "evidence revision conflict"
;;

let next_revision map id ~revision_of =
  Option.value_map (Map.find map id) ~default:1 ~f:(fun history ->
    revision_of (head history) + 1)
;;

let historical map id revision ~revision_of =
  Map.find map id
  |> Option.bind ~f:(fun versions ->
    List.find versions ~f:(fun x -> Int.equal (revision_of x) revision))
;;

let get_manifest t (ref_ : Manifest_ref.t) =
  historical t.manifests ref_.id ref_.revision ~revision_of:(fun x -> x.Manifest.revision)
;;

let manifest t ref_ =
  match get_manifest t ref_ with
  | Some x -> x
  | None -> Json.fail Not_found "manifest version not found"
;;

let get_contract t (ref_ : Contract_ref.t) =
  historical t.contracts ref_.id ref_.revision ~revision_of:(fun x -> x.Contract.revision)
;;

let contract t ref_ =
  match get_contract t ref_ with
  | Some x -> x
  | None -> Json.fail Not_found "contract version not found"
;;

let get_submission t ticket = Map.find t.submissions ticket |> Option.map ~f:head
let submission t ticket = current t.submissions ticket
let unique xs ~compare = List.dedup_and_sort xs ~compare

let bound text max =
  require (String.length text <= max) Invalid_argument "evidence text exceeds byte limit"
;;

let nonempty text max =
  bound text max;
  require
    (not (String.is_empty (String.strip text)))
    Invalid_argument
    "evidence text is empty"
;;

let limit xs max =
  require
    (List.length xs <= max)
    Invalid_argument
    "evidence collection exceeds item limit"
;;

let canonical xs ~compare ~equal =
  require
    (List.equal equal xs (unique xs ~compare))
    Corrupt_store
    "evidence collection is not canonical"
;;

let name value =
  match Id.Resource.of_string value with
  | Ok _ -> ()
  | Error e -> raise (Json.Decode_error e)
;;

let hex text lengths =
  require
    (List.mem lengths (String.length text) ~equal:Int.equal
     && String.for_all text ~f:(fun c ->
       Char.is_digit c || (Char.(c >= 'a') && Char.(c <= 'f'))))
    Invalid_argument
    "invalid lowercase hexadecimal digest/object ID"
;;

let resource_pin_valid (p : Resource_pin.t) =
  require (p.revision > 0) Invalid_argument "resource pin revision must be positive";
  hex p.digest [ 64 ]
;;

let pin_valid = function
  | Pin.Resource p -> resource_pin_valid p
  | Event ref_ ->
    require (ref_.sequence > 0) Invalid_argument "event pin sequence must be positive"
  | Commit { repository; object_id } ->
    nonempty repository 1024;
    hex object_id [ 40; 64 ]
  | Checksum { source; digest } ->
    nonempty source 1024;
    hex digest [ 64 ]
  | Comment { revision; _ } | Decision { revision; _ } ->
    require (revision > 0) Invalid_argument "pin revision must be positive"
  | Contract ref_ ->
    require (ref_.revision > 0) Invalid_argument "contract pin revision must be positive"
;;

let attribution_valid (a : Attribution.t) = nonempty a.timestamp 128

let pin_same_source (a : Pin.t) (b : Pin.t) =
  match a, b with
  | Pin.Resource a, Resource b -> Id.Resource.equal a.id b.id
  | Event a, Event b -> Session_id.equal a.session b.session
  | Commit a, Commit b -> String.equal a.repository b.repository
  | Checksum a, Checksum b -> String.equal a.source b.source
  | Comment a, Comment b -> Id.Comment.equal a.id b.id
  | Contract a, Contract b -> Evidence_id.Contract.equal a.id b.id
  | Decision a, Decision b -> Evidence_id.Decision.equal a.id b.id
  | ( (Resource _ | Event _ | Commit _ | Checksum _ | Comment _ | Contract _ | Decision _)
    , _ ) -> false
;;

let input_changed_valid previous current =
  pin_valid previous;
  pin_valid current;
  require
    (pin_same_source previous current && not (Pin.equal previous current))
    Conflict
    "input change must replace a pin from the same source";
  let ascending a b = require (b > a) Conflict "input revision must advance" in
  match previous, current with
  | Pin.Resource a, Resource b -> ascending a.revision b.revision
  | Event a, Event b -> ascending a.sequence b.sequence
  | Comment a, Comment b -> ascending a.revision b.revision
  | Contract a, Contract b -> ascending a.revision b.revision
  | Decision a, Decision b -> ascending a.revision b.revision
  | (Commit _ | Checksum _), _ -> ()
  | (Resource _ | Event _ | Comment _ | Contract _ | Decision _), _ ->
    Json.fail Conflict "input pin source differs"
;;

let names_valid xs =
  limit xs 100;
  List.iter xs ~f:name;
  canonical xs ~compare:String.compare ~equal:String.equal
;;

let artifacts_valid xs =
  limit xs 100;
  List.iter xs ~f:(fun a ->
    name a.Artifact.name;
    pin_valid a.pin);
  canonical
    (List.map xs ~f:(fun a -> a.Artifact.name))
    ~compare:String.compare
    ~equal:String.equal
;;

let append map id record =
  Map.update map id ~f:(fun history -> record :: Option.value history ~default:[])
;;

let contract_valid t (c : Contract.t) =
  require
    (Int.equal c.schema_version 1)
    Unsupported_version
    "unsupported built-in contract schema version";
  expected
    c.revision
    (next_revision t.contracts c.id ~revision_of:(fun c -> c.Contract.revision));
  resource_pin_valid c.schema;
  names_valid c.required_inputs;
  names_valid c.required_outputs
;;

let manifest_valid t attribution (m : Manifest.t) =
  require
    (Int.equal m.schema_version 1)
    Unsupported_version
    "unsupported built-in manifest schema version";
  expected
    m.revision
    (next_revision t.manifests m.id ~revision_of:(fun m -> m.Manifest.revision));
  require
    (Attribution.equal m.published attribution)
    Corrupt_store
    "manifest publication attribution differs";
  Option.iter (Map.find t.manifests m.id) ~f:(fun previous ->
    let previous = head previous in
    require
      (Attempt.Id.equal previous.attempt m.attempt
       && Id.Ticket.equal previous.ticket m.ticket)
      Conflict
      "manifest attempt/ticket are immutable");
  let c = contract t m.contract in
  artifacts_valid m.inputs;
  artifacts_valid m.outputs;
  let present artifacts required =
    List.iter required ~f:(fun required ->
      require
        (List.exists artifacts ~f:(fun a -> String.equal a.Artifact.name required))
        Invalid_argument
        ("missing required artifact: " ^ required))
  in
  present m.inputs c.required_inputs;
  present m.outputs c.required_outputs
;;

let attribution_codec = Evidence_wire.attribution

let policy_version_codec =
  let ( <*> ) = Api_codec.Fields.both in
  Api_codec.object_
    (Api_codec.Fields.map
       (Api_codec.Fields.required "definition" Acceptance_policy.Definition.codec
        <*> Api_codec.Fields.required
              "weakening_reason"
              (Api_codec.nullable (Api_codec.text ~max_bytes:4096))
        <*> Api_codec.Fields.required "attribution" attribution_codec)
       ~decode:(fun ((definition, weakening_reason), attribution) ->
         { Policy_version.definition; weakening_reason; attribution })
       ~encode:(fun t -> (t.Policy_version.definition, t.weakening_reason), t.attribution))
;;

let validation_codec = Evidence_wire.validation

let assertion_codec =
  let ( <*> ) = Api_codec.Fields.both in
  let req = Api_codec.Fields.required in
  let id of_string to_string =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:of_string
      ~encode:to_string
      ~description:"Validated identity."
  in
  let positive =
    Api_codec.map
      (Api_codec.decimal ~max:Int.max_value)
      ~decode:(fun value ->
        if value > 0
        then Ok value
        else Error (Problem.create Invalid_argument "positive assertion counter required"))
      ~encode:Fn.id
      ~description:"Positive exact counter."
  in
  Api_codec.object_
    (Api_codec.Fields.map
       (req "serial" positive
        <*> req "ticket_id" (id Id.Ticket.of_string Id.Ticket.to_string)
        <*> req "token" positive
        <*> req
              "attempt_id"
              (Api_codec.nullable (id Attempt.Id.of_string Attempt.Id.to_string))
        <*> req "manifest" (Api_codec.nullable Evidence_wire.manifest_ref)
        <*> req "artifacts" (Api_codec.list Evidence_wire.artifact ~max_items:200)
        <*> req "policy_binding" Acceptance_policy.Effective.Binding.codec
        <*> req "criterion" Acceptance_policy.Criterion.Ref.codec
        <*> req "passed" Api_codec.boolean
        <*> req "evidence_pins" (Api_codec.list Evidence_wire.pin ~max_items:100)
        <*> req "evidence" (Api_codec.text ~max_bytes:65_536)
        <*> req "attribution" attribution_codec)
       ~decode:
         (fun
           ( ( ( ( ( ( (((((serial, ticket), token), attempt), manifest), artifacts)
                     , policy_binding )
                   , criterion )
                 , passed )
               , evidence_pins )
             , evidence )
           , attribution ) ->
         { Assertion.serial
         ; ticket
         ; token
         ; attempt
         ; manifest
         ; artifacts
         ; policy_binding
         ; criterion
         ; passed
         ; evidence_pins
         ; evidence
         ; attribution
         })
       ~encode:(fun a ->
         ( ( ( ( ( ( ( ((((a.Assertion.serial, a.ticket), a.token), a.attempt), a.manifest)
                     , a.artifacts )
                   , a.policy_binding )
                 , a.criterion )
               , a.passed )
             , a.evidence_pins )
           , a.evidence )
         , a.attribution )))
;;

let assertion_codec =
  Api_codec.map
    assertion_codec
    ~decode:(fun a -> Result.map (Assertion.validate a) ~f:(fun () -> a))
    ~encode:Fn.id
    ~description:
      "Exact policy/ownership-bound assertion with nonblank evidence and validated pins."
;;

let assertion_json a = unwrap_evidence (Api_codec.encode assertion_codec a)
let policy_version_json p = unwrap_evidence (Api_codec.encode policy_version_codec p)
let wire_json codec value = unwrap_evidence (Api_codec.encode codec value)
let requirement_compare = Policy.Requirement.compare

let policy_view (p : Policy_version.t) =
  let d = p.definition in
  match Acceptance_policy.Definition.scope d with
  | Acceptance_policy.Scope.Project _ -> None
  | Ticket ticket ->
    Some
      { Policy.ticket
      ; revision = Acceptance_policy.Definition.revision d
      ; enabled = Acceptance_policy.Definition.enabled d
      ; reviewers = Acceptance_policy.Definition.reviewers d
      ; separate_actor = Acceptance_policy.Definition.separate_actor d
      ; validators = Acceptance_policy.Definition.validators d
      }
;;

let current_definition t scope =
  Map.find t.policies scope
  |> Option.map ~f:(fun versions -> (head versions).Policy_version.definition)
;;

let current_policy t ticket = current_definition t (Acceptance_policy.Scope.Ticket ticket)

let context (ticket_context : Id.Ticket.t -> Ticket_context.t option) ticket =
  match ticket_context ticket with
  | Some capture -> capture
  | None -> Json.fail Not_found "acceptance ticket not found"
;;

let effective_exn t ~ticket_context ~ticket =
  let capture = context ticket_context ticket in
  unwrap_evidence
    (Acceptance_policy.Effective.resolve
       ~ticket_id:ticket
       ~project_id:capture.project
       ~membership_revision:capture.membership_revision
       ~project:
         (Option.bind capture.project ~f:(fun id ->
            current_definition t (Acceptance_policy.Scope.Project id)))
       ~ticket:(current_policy t ticket)
       ~minimum_reopening_token:capture.minimum_reopening_token
       ~ownership_token:capture.current_token)
;;

let effective_policy t ~ticket_context ~ticket =
  Json.decode (fun () -> effective_exn t ~ticket_context ~ticket)
;;

let policy_valid t attribution ~ticket_context (p : Policy_version.t) =
  let d = p.definition in
  let scope = Acceptance_policy.Definition.scope d in
  let previous = current_definition t scope in
  expected
    (Acceptance_policy.Definition.revision d)
    (Option.value_map previous ~default:1 ~f:(fun old ->
       Acceptance_policy.Definition.revision old + 1));
  require
    (Attribution.equal p.attribution attribution)
    Corrupt_store
    "policy attribution differs";
  unwrap_evidence
    (Acceptance_policy.Definition.check_update
       previous
       ~next:d
       ~weakening_reason:p.weakening_reason);
  (* Resolution validates exact source membership and every named waived requirement. *)
  match scope with
  | Project _ -> ()
  | Ticket ticket ->
    let capture = context ticket_context ticket in
    ignore
      (unwrap_evidence
         (Acceptance_policy.Effective.resolve
            ~ticket_id:ticket
            ~project_id:capture.project
            ~membership_revision:capture.membership_revision
            ~project:
              (Option.bind capture.project ~f:(fun id ->
                 current_definition t (Acceptance_policy.Scope.Project id)))
            ~ticket:(Some d)
            ~minimum_reopening_token:capture.minimum_reopening_token
            ~ownership_token:capture.current_token)
       : Acceptance_policy.Effective.t);
    Option.iter (Acceptance_policy.Definition.inherited_override d) ~f:(fun override ->
      let unchanged =
        Option.value_map previous ~default:false ~f:(fun old ->
          Option.equal
            Acceptance_policy.Inherited_override.equal
            (Acceptance_policy.Definition.inherited_override old)
            (Some override))
      in
      let source = Acceptance_policy.Inherited_override.against override in
      let current =
        Option.bind capture.project ~f:(fun project ->
          current_definition t (Acceptance_policy.Scope.Project project))
      in
      require
        (unchanged
         || (Acceptance_policy.Inherited_override.membership_revision override
             = capture.membership_revision
             && Option.value_map current ~default:false ~f:(fun project ->
               Acceptance_policy.Scope.equal
                 source.scope
                 (Acceptance_policy.Definition.scope project)
               && source.revision = Acceptance_policy.Definition.revision project)))
        Conflict
        "inherited override does not bind the current project policy")
;;

let requirement_members = function
  | Policy.Requirement.Named_actor actor -> [ actor ]
  | Role { members; _ } -> members
;;

let review_recipients t ~ticket_context ~ticket =
  let effective = effective_exn t ~ticket_context ~ticket in
  List.concat_map (Acceptance_policy.Effective.reviewers effective) ~f:requirement_members
  |> unique ~compare:Id.Actor.compare
;;

let bound_submission_current t ~ticket_context (s : Submission.t) =
  let m = manifest t s.manifest in
  require
    (Id.Ticket.equal m.ticket s.ticket && Contract_ref.equal m.contract s.contract)
    Conflict
    "submission manifest/contract binding differs";
  require
    (Manifest_ref.equal (find t.latest_by_ticket s.ticket) s.manifest)
    Conflict
    "submission output has been replaced";
  require
    (Option.value_map
       (context ticket_context s.ticket).attempt
       ~default:false
       ~f:(Attempt.Id.equal m.attempt))
    Conflict
    "submission does not bind the current latest attempt";
  let c = current t.contracts s.contract.id in
  expected c.revision s.contract.revision;
  require
    (Acceptance_policy.Effective.Binding.equal
       s.policy_binding
       (Acceptance_policy.Effective.binding
          (effective_exn t ~ticket_context ~ticket:s.ticket)))
    Conflict
    "submission effective policy binding differs";
  m
;;

let pending_reconciliations t ~attempt =
  Map.data t.reconciliations
  |> List.filter ~f:(fun issue ->
    Reconciliation.State.equal issue.Reconciliation.state Pending
    && Option.value_map attempt ~default:true ~f:(Attempt.Id.equal issue.attempt))
;;

let review_matches (r : Review.t) (s : Submission.t) =
  Id.Ticket.equal r.ticket s.ticket
  && Int.equal r.generation s.generation
  && Manifest_ref.equal r.manifest s.manifest
  && Contract_ref.equal r.contract s.contract
  && Acceptance_policy.Effective.Binding.equal r.policy_binding s.policy_binding
;;

let approval_valid t ~ticket_context (s : Submission.t) =
  let m = bound_submission_current t ~ticket_context s in
  require
    (List.is_empty (pending_reconciliations t ~attempt:(Some m.attempt)))
    Blocked
    "attempt inputs need reconciliation";
  let p = effective_exn t ~ticket_context ~ticket:s.ticket in
  let reviews = Map.data t.reviews |> List.filter ~f:(fun r -> review_matches r s) in
  let latest =
    List.fold reviews ~init:Id.Actor.Map.empty ~f:(fun latest r ->
      Map.update latest r.Review.reviewer.actor ~f:(function
        | None -> r
        | Some old -> if r.serial > old.serial then r else old))
  in
  List.iter (Acceptance_policy.Effective.reviewers p) ~f:(fun requirement ->
    require
      (List.exists (requirement_members requirement) ~f:(fun actor ->
         Option.value_map (Map.find latest actor) ~default:false ~f:(fun r ->
           Review.Verdict.equal r.verdict Approve)))
      Blocked
      "required reviewer approval is missing");
  List.iter (Acceptance_policy.Effective.validators p) ~f:(fun validator ->
    let matches =
      Map.data t.validations
      |> List.filter ~f:(fun v ->
        Manifest_ref.equal v.Validation.manifest s.manifest
        && Contract_ref.equal v.contract s.contract
        && Acceptance_policy.Effective.Binding.equal v.policy_binding s.policy_binding
        && String.equal v.name validator)
    in
    let latest =
      List.max_elt matches ~compare:(fun a b -> Int.compare a.Validation.serial b.serial)
    in
    require
      (Option.value_map latest ~default:false ~f:(fun v -> v.Validation.passed))
      Blocked
      "required validator result is missing or failed")
;;

let assertion_target t ~ticket_context ~ticket =
  let capture = context ticket_context ticket in
  let manifest_ref = Map.find t.latest_by_ticket ticket in
  let artifacts =
    Option.value_map manifest_ref ~default:[] ~f:(fun ref_ ->
      let m = manifest t ref_ in
      m.inputs @ m.outputs)
  in
  capture, manifest_ref, artifacts
;;

let assertion_inputs_replaced t (a : Assertion.t) =
  let pins =
    a.evidence_pins
    @ List.map a.artifacts ~f:(fun artifact -> artifact.Artifact.pin)
    @ Option.value_map a.manifest ~default:[] ~f:(fun reference ->
      [ Pin.Contract (manifest t reference).contract ])
  in
  let consumed pin = List.mem pins pin ~equal:Pin.equal in
  List.exists t.history ~f:(fun change ->
    change.Change.revision > a.serial
    && (List.exists change.reconciliations ~f:(fun issue ->
          consumed issue.Reconciliation.previous)
        ||
        match change.update with
        | Input_changed { previous; _ } -> consumed previous
        | Contract_put contract ->
          contract.Contract.revision > 1
          && consumed
               (Pin.Contract { id = contract.id; revision = contract.revision - 1 })
        | Decision_put decision ->
          (decision.Decision.revision > 1
           && consumed
                (Pin.Decision { id = decision.id; revision = decision.revision - 1 }))
          || List.exists pins ~f:(function
            | Pin.Decision { id; _ } ->
              List.mem decision.supersedes id ~equal:Evidence_id.Decision.equal
            | Resource _ | Event _ | Commit _ | Checksum _ | Comment _ | Contract _ ->
              false)
        | Manifest_put _
        | Policy_put _
        | Assertion_added _
        | Submission_put _
        | Review_added _
        | Validation_added _
        | Reconciliation_put _ -> false))
;;

let assertion_current t ~ticket_context (a : Assertion.t) =
  let capture, manifest_ref, artifacts =
    assertion_target t ~ticket_context ~ticket:a.ticket
  in
  (not (assertion_inputs_replaced t a))
  && Option.value_map capture.current_token ~default:false ~f:(Int.equal a.token)
  && Option.equal Attempt.Id.equal capture.attempt a.attempt
  && Option.equal Manifest_ref.equal manifest_ref a.manifest
  && List.equal Artifact.equal artifacts a.artifacts
  && Acceptance_policy.Effective.Binding.equal
       a.policy_binding
       (Acceptance_policy.Effective.binding
          (effective_exn t ~ticket_context ~ticket:a.ticket))
;;

let assert_valid t attribution ~ticket_context (a : Assertion.t) =
  unwrap_evidence (Assertion.validate a);
  expected a.serial (t.revision + 1);
  require (not (Map.mem t.assertions a.serial)) Conflict "assertion already exists";
  require
    (Attribution.equal a.attribution attribution)
    Corrupt_store
    "assertion attribution differs";
  let capture = context ticket_context a.ticket in
  require
    (Option.value_map capture.ownership ~default:false ~f:(fun owner ->
       Int.equal owner.Ticket_context.Ownership.token a.token
       && Id.Actor.equal owner.actor attribution.actor
       && Option.equal Id.Run.equal owner.run attribution.run))
    Stale_claim
    "assertion requires current claim ownership";
  require
    (assertion_current t ~ticket_context a)
    Conflict
    "assertion target or effective policy changed";
  let effective = effective_exn t ~ticket_context ~ticket:a.ticket in
  require
    (List.exists
       (Acceptance_policy.Effective.criteria effective)
       ~f:(fun (reference, _) ->
         Acceptance_policy.Criterion.Ref.equal reference a.criterion))
    Conflict
    "assertion criterion is not in the current policy";
  require
    (not (List.is_empty a.evidence_pins))
    Invalid_argument
    "assertion requires exact evidence pins";
  limit a.evidence_pins 100;
  List.iter a.evidence_pins ~f:pin_valid;
  nonempty a.evidence 65_536
;;

let ensure_can_complete t ~ticket_context ~ticket =
  Json.decode (fun () ->
    let p = effective_exn t ~ticket_context ~ticket in
    if
      not
        (List.is_empty (Acceptance_policy.Effective.reviewers p)
         && List.is_empty (Acceptance_policy.Effective.validators p))
    then (
      let s =
        match get_submission t ticket with
        | Some s -> s
        | None -> Json.fail Blocked "ticket output has not been submitted"
      in
      Option.iter
        (context ticket_context ticket).minimum_reopening_token
        ~f:(fun minimum ->
          require
            (Option.value_map
               (Acceptance_policy.Effective.Binding.ownership_token s.policy_binding)
               ~default:false
               ~f:(fun token -> token >= minimum))
            Blocked
            "accepted output predates reopened work");
      match s.state with
      | Accepted _ -> approval_valid t ~ticket_context s
      | Pending | Changes_requested _ ->
        Json.fail Blocked "ticket output has not been accepted");
    List.iter (Acceptance_policy.Effective.criteria p) ~f:(fun (reference, criterion) ->
      if criterion.Acceptance_policy.Criterion.required
      then (
        let latest =
          Map.data t.assertions
          |> List.filter ~f:(fun a ->
            Id.Ticket.equal a.Assertion.ticket ticket
            && Acceptance_policy.Criterion.Ref.equal a.criterion reference
            && assertion_current t ~ticket_context a)
          |> List.max_elt ~compare:(fun a b -> Int.compare a.Assertion.serial b.serial)
        in
        require
          (Option.value_map latest ~default:false ~f:(fun a -> a.Assertion.passed))
          Blocked
          "required acceptance criterion assertion is missing or failed")))
;;

let ensure_attempt_can_complete t ~ticket_context ~attempt ~ticket =
  Json.decode (fun () ->
    unwrap_evidence (ensure_can_complete t ~ticket_context ~ticket);
    let p = effective_exn t ~ticket_context ~ticket in
    if
      not
        (List.is_empty (Acceptance_policy.Effective.reviewers p)
         && List.is_empty (Acceptance_policy.Effective.validators p))
    then (
      let ref_ =
        match Map.find t.latest_by_attempt attempt with
        | Some ref_ -> ref_
        | None ->
          Json.fail Blocked "configured completion requires an input/output manifest"
      in
      let m = manifest t ref_ in
      require
        (Id.Ticket.equal m.ticket ticket)
        Conflict
        "manifest ticket differs from attempt";
      require
        (Manifest_ref.equal (submission t ticket).manifest ref_)
        Blocked
        "accepted submission must bind the completing attempt manifest"))
;;

let submission_valid t attribution ~ticket_context (s : Submission.t) =
  expected
    s.revision
    (next_revision t.submissions s.ticket ~revision_of:(fun s -> s.Submission.revision));
  ignore (bound_submission_current t ~ticket_context s : Manifest.t);
  let previous = get_submission t s.ticket in
  match previous with
  | None ->
    require
      (Int.equal s.generation 1
       && Attribution.equal s.author attribution
       && Submission.State.equal s.state Pending)
      Corrupt_store
      "invalid initial submission"
  | Some previous ->
    if Int.equal s.generation (previous.generation + 1)
    then
      require
        (Attribution.equal s.author attribution && Submission.State.equal s.state Pending)
        Corrupt_store
        "new submission generation is not pending"
    else (
      expected s.generation previous.generation;
      require
        (Submission.State.equal previous.state Pending)
        Conflict
        "submission is no longer pending";
      let wanted =
        { previous with
          Submission.revision = previous.revision + 1
        ; state = Accepted attribution
        }
      in
      require
        (Submission.equal s wanted)
        Corrupt_store
        "submission acceptance changed immutable fields";
      approval_valid t ~ticket_context previous)
;;

let review_valid t attribution ~ticket_context (r : Review.t) (s : Submission.t) =
  require (not (Map.mem t.reviews r.id)) Conflict "review already exists";
  expected r.serial (t.revision + 1);
  require
    (Attribution.equal r.reviewer attribution)
    Corrupt_store
    "review attribution differs";
  nonempty r.evidence 65_536;
  let old = submission t r.ticket in
  ignore (bound_submission_current t ~ticket_context old : Manifest.t);
  require
    (review_matches r old)
    Conflict
    "review refers to a different submission version";
  require
    (Submission.State.equal old.state Pending)
    Conflict
    "submission is no longer pending";
  let p = effective_exn t ~ticket_context ~ticket:old.ticket in
  require
    (List.exists (Acceptance_policy.Effective.reviewers p) ~f:(fun requirement ->
       List.mem (requirement_members requirement) attribution.actor ~equal:Id.Actor.equal))
    Conflict
    "actor is not an eligible reviewer";
  require
    ((not (Acceptance_policy.Effective.separate_actor p))
     || not (Id.Actor.equal old.author.actor attribution.actor))
    Conflict
    "reviewer must differ from submitter";
  let wanted =
    match r.verdict with
    | Approve -> old
    | Request_changes ->
      { old with
        Submission.revision = old.revision + 1
      ; state = Changes_requested attribution
      }
  in
  require
    (Submission.equal s wanted)
    Corrupt_store
    "review changed unrelated submission fields"
;;

let validation_valid t attribution ~ticket_context (v : Validation.t) =
  require (not (Map.mem t.validations v.id)) Conflict "validator result already exists";
  expected v.serial (t.revision + 1);
  require
    (Attribution.equal v.attribution attribution)
    Corrupt_store
    "validator attribution differs";
  let m = manifest t v.manifest in
  require
    (Acceptance_policy.Effective.Binding.equal
       v.policy_binding
       (Acceptance_policy.Effective.binding
          (effective_exn t ~ticket_context ~ticket:m.ticket)))
    Conflict
    "validator effective policy binding differs";
  require
    (Manifest_ref.equal (find t.latest_by_ticket m.ticket) v.manifest)
    Conflict
    "validator manifest has been replaced";
  require
    (Option.value_map
       (context ticket_context m.ticket).attempt
       ~default:false
       ~f:(Attempt.Id.equal m.attempt))
    Conflict
    "validation does not bind the current latest attempt";
  name v.name;
  nonempty v.evidence 65_536;
  require
    (Contract_ref.equal (manifest t v.manifest).contract v.contract)
    Conflict
    "validation contract differs from manifest"
;;

let decision_valid t attribution (d : Decision.t) =
  expected
    d.revision
    (next_revision t.decisions d.id ~revision_of:(fun d -> d.Decision.revision));
  require
    (Attribution.equal d.attribution attribution)
    Corrupt_store
    "decision attribution differs";
  nonempty d.title 512;
  pin_valid d.rationale;
  limit d.evidence 100;
  List.iter d.evidence ~f:pin_valid;
  limit d.affected 100;
  canonical d.affected ~compare:Entity_ref.compare ~equal:Entity_ref.equal;
  limit d.supersedes 100;
  canonical
    d.supersedes
    ~compare:Evidence_id.Decision.compare
    ~equal:Evidence_id.Decision.equal;
  List.iter d.supersedes ~f:(fun id ->
    require
      (not (Evidence_id.Decision.equal id d.id))
      Dependency_cycle
      "decision supersedes itself";
    ignore (current t.decisions id : Decision.t));
  let visited = ref Evidence_id.Decision.Set.empty in
  let rec visit pending =
    match pending with
    | [] -> ()
    | id :: rest ->
      require
        (not (Evidence_id.Decision.equal id d.id))
        Dependency_cycle
        "decision supersession cycle";
      if Set.mem !visited id
      then visit rest
      else (
        visited := Set.add !visited id;
        visit ((current t.decisions id).Decision.supersedes @ rest))
  in
  visit d.supersedes
;;

let reconciliation_valid t attribution (r : Reconciliation.t) =
  let old = find t.reconciliations r.serial in
  expected r.revision (old.Reconciliation.revision + 1);
  require
    (Reconciliation.State.equal old.state Pending)
    Conflict
    "reconciliation is already handled";
  let state =
    match r.state with
    | Pending -> Json.fail Conflict "reconciliation disposition is unchanged"
    | Acknowledged a ->
      require
        (Attribution.equal a attribution)
        Corrupt_store
        "reconciliation attribution differs";
      r.state
    | Continued { attribution = a; reason } ->
      require
        (Attribution.equal a attribution)
        Corrupt_store
        "reconciliation attribution differs";
      nonempty reason 65_536;
      r.state
    | Revised { attribution = a; manifest = ref_ } ->
      require
        (Attribution.equal a attribution)
        Corrupt_store
        "reconciliation attribution differs";
      let m = manifest t ref_ in
      require
        (Attempt.Id.equal m.attempt old.attempt
         && (Pin.equal (Pin.Contract m.contract) old.current
             || List.exists m.inputs ~f:(fun a -> Pin.equal a.Artifact.pin old.current)))
        Conflict
        "revised manifest does not consume replacement input";
      r.state
  in
  require
    (Reconciliation.equal r { old with revision = old.revision + 1; state })
    Corrupt_store
    "reconciliation changed provenance"
;;

let input_pairs t = function
  | Update.Contract_put c ->
    Option.value_map (Map.find t.contracts c.id) ~default:[] ~f:(fun versions ->
      let old = head versions in
      [ ( Pin.Contract { id = old.id; revision = old.revision }
        , Pin.Contract { id = c.id; revision = c.revision } )
      ])
  | Decision_put d ->
    let current_pin = Pin.Decision { id = d.id; revision = d.revision } in
    let own =
      Option.value_map (Map.find t.decisions d.id) ~default:[] ~f:(fun versions ->
        let old = head versions in
        [ Pin.Decision { id = old.id; revision = old.revision }, current_pin ])
    in
    own
    @ List.map d.supersedes ~f:(fun id ->
      let old = current t.decisions id in
      Pin.Decision { id = old.id; revision = old.revision }, current_pin)
  | Input_changed { previous; current } -> [ previous, current ]
  | Manifest_put _
  | Policy_put _
  | Assertion_added _
  | Submission_put _
  | Review_added _
  | Validation_added _
  | Reconciliation_put _ -> []
;;

let resolved_reconciliations t update =
  let pairs = input_pairs t update in
  let _, issues =
    Map.to_alist t.latest_by_attempt
    |> List.fold ~init:(t.serial, []) ~f:(fun (serial, issues) (attempt, ref_) ->
      let m = manifest t ref_ in
      let consumed =
        Pin.Contract m.contract :: List.map m.inputs ~f:(fun a -> a.Artifact.pin)
      in
      List.fold
        pairs
        ~init:(serial, issues)
        ~f:(fun (serial, issues) (previous, current) ->
          let exists =
            Map.exists t.reconciliations ~f:(fun old ->
              Attempt.Id.equal old.Reconciliation.attempt attempt
              && Pin.equal old.previous previous
              && Pin.equal old.current current)
          in
          if exists || not (List.mem consumed previous ~equal:Pin.equal)
          then serial, issues
          else (
            let issue =
              { Reconciliation.serial = serial + 1
              ; revision = 1
              ; attempt
              ; ticket = m.ticket
              ; previous
              ; current
              ; state = Pending
              }
            in
            serial + 1, issue :: issues)))
  in
  List.rev issues
;;

let update_state t attribution ~ticket_context = function
  | Update.Contract_put c ->
    contract_valid t c;
    { t with contracts = append t.contracts c.id c }
  | Manifest_put m ->
    manifest_valid t attribution m;
    let ref_ = { Manifest_ref.id = m.id; revision = m.revision } in
    { t with
      manifests = append t.manifests m.id m
    ; latest_by_attempt = Map.set t.latest_by_attempt ~key:m.attempt ~data:ref_
    ; latest_by_ticket = Map.set t.latest_by_ticket ~key:m.ticket ~data:ref_
    }
  | Policy_put p ->
    policy_valid t attribution ~ticket_context p;
    { t with
      policies = append t.policies (Acceptance_policy.Definition.scope p.definition) p
    }
  | Assertion_added a ->
    assert_valid t attribution ~ticket_context a;
    { t with assertions = Map.set t.assertions ~key:a.serial ~data:a }
  | Submission_put s ->
    submission_valid t attribution ~ticket_context s;
    { t with submissions = append t.submissions s.ticket s }
  | Review_added { review; submission } ->
    review_valid t attribution ~ticket_context review submission;
    let submissions =
      if Review.Verdict.equal review.verdict Approve
      then t.submissions
      else append t.submissions submission.ticket submission
    in
    { t with reviews = Map.set t.reviews ~key:review.id ~data:review; submissions }
  | Validation_added v ->
    validation_valid t attribution ~ticket_context v;
    { t with validations = Map.set t.validations ~key:v.id ~data:v }
  | Decision_put d ->
    decision_valid t attribution d;
    { t with decisions = append t.decisions d.id d }
  | Input_changed { previous; current } ->
    input_changed_valid previous current;
    t
  | Reconciliation_put r ->
    reconciliation_valid t attribution r;
    { t with reconciliations = Map.set t.reconciliations ~key:r.serial ~data:r }
;;

let apply_exn t (change : Change.t) ~ticket_context =
  require
    (Int.equal change.version 1)
    Unsupported_version
    "unsupported evidence event version";
  expected change.revision (t.revision + 1);
  require (change.sequence > 0) Corrupt_store "invalid workspace sequence";
  Option.iter (List.hd t.history) ~f:(fun old ->
    require
      (change.sequence >= old.sequence)
      Corrupt_store
      "evidence sequence moved backwards");
  attribution_valid change.attribution;
  let updated = update_state t change.attribution ~ticket_context change.update in
  let reconciliations = resolved_reconciliations t change.update in
  require
    (List.equal Reconciliation.equal reconciliations change.reconciliations)
    Corrupt_store
    "resolved reconciliation consumers differ";
  let records =
    List.fold reconciliations ~init:updated.reconciliations ~f:(fun records issue ->
      Map.set records ~key:issue.Reconciliation.serial ~data:issue)
  in
  { updated with
    revision = change.revision
  ; serial = t.serial + List.length reconciliations
  ; reconciliations = records
  ; history = change :: t.history
  }
;;

let apply t change ~ticket_context =
  Json.decode (fun () -> apply_exn t change ~ticket_context)
;;

let command_update t command attribution ~ticket_context =
  match command with
  | Command.Contract_put
      { id; expected_revision; schema_version; schema; required_inputs; required_outputs }
    ->
    expected
      (next_revision t.contracts id ~revision_of:(fun c -> c.Contract.revision) - 1)
      expected_revision;
    Update.Contract_put
      { id
      ; revision = expected_revision + 1
      ; schema_version
      ; schema
      ; required_inputs = unique required_inputs ~compare:String.compare
      ; required_outputs = unique required_outputs ~compare:String.compare
      }
  | Manifest_publish
      { id
      ; expected_revision
      ; schema_version
      ; attempt
      ; ticket
      ; contract
      ; inputs
      ; outputs
      } ->
    expected
      (next_revision t.manifests id ~revision_of:(fun m -> m.Manifest.revision) - 1)
      expected_revision;
    let sort artifacts =
      List.sort artifacts ~compare:(fun a b -> String.compare a.Artifact.name b.name)
    in
    Update.Manifest_put
      { id
      ; revision = expected_revision + 1
      ; schema_version
      ; attempt
      ; ticket
      ; contract
      ; inputs = sort inputs
      ; outputs = sort outputs
      ; published = attribution
      }
  | Policy_put
      { ticket
      ; expected_revision
      ; enabled
      ; reviewers
      ; separate_actor
      ; validators
      ; weakening_reason
      } ->
    let scope = Acceptance_policy.Scope.Ticket ticket in
    let previous = current_definition t scope in
    expected
      (Option.value_map previous ~default:0 ~f:Acceptance_policy.Definition.revision)
      expected_revision;
    let definition =
      unwrap_evidence
        (Acceptance_policy.Definition.create
           ~scope
           ~revision:(expected_revision + 1)
           ~enabled
           ~reviewers
           ~separate_actor
           ~validators
           ~criteria:
             (Option.value_map
                previous
                ~default:[]
                ~f:Acceptance_policy.Definition.criteria)
           ~inherited_override:
             (Option.bind previous ~f:Acceptance_policy.Definition.inherited_override))
    in
    Update.Policy_put { definition; weakening_reason; attribution }
  | Acceptance_policy_put { definition; expected_revision; weakening_reason } ->
    let scope = Acceptance_policy.Definition.scope definition in
    expected
      (Option.value_map
         (current_definition t scope)
         ~default:0
         ~f:Acceptance_policy.Definition.revision)
      expected_revision;
    expected (Acceptance_policy.Definition.revision definition) (expected_revision + 1);
    Update.Policy_put { definition; weakening_reason; attribution }
  | Assert
      { ticket
      ; token
      ; attempt
      ; manifest
      ; expected_policy_digest
      ; criterion
      ; passed
      ; evidence_pins
      ; evidence
      } ->
    let capture, current_manifest, artifacts =
      assertion_target t ~ticket_context ~ticket
    in
    require
      (Option.equal Attempt.Id.equal attempt capture.attempt)
      Conflict
      "assertion must identify the current attempt";
    require
      (Option.equal Manifest_ref.equal manifest current_manifest)
      Conflict
      "assertion must identify the current manifest";
    let effective = effective_exn t ~ticket_context ~ticket in
    require
      (String.equal expected_policy_digest (Acceptance_policy.Effective.digest effective))
      Conflict
      "observed effective policy changed";
    Update.Assertion_added
      { serial = t.revision + 1
      ; ticket
      ; token
      ; attempt
      ; manifest
      ; artifacts
      ; policy_binding = Acceptance_policy.Effective.binding effective
      ; criterion
      ; passed
      ; evidence_pins
      ; evidence
      ; attribution
      }
  | Submit { ticket; expected_revision; manifest = ref_; review_request } ->
    expected
      (next_revision t.submissions ticket ~revision_of:(fun s -> s.Submission.revision)
       - 1)
      expected_revision;
    let m = manifest t ref_ in
    let generation =
      Option.value_map (get_submission t ticket) ~default:1 ~f:(fun s -> s.generation + 1)
    in
    let policy_binding =
      Acceptance_policy.Effective.binding (effective_exn t ~ticket_context ~ticket)
    in
    Update.Submission_put
      { ticket
      ; revision = expected_revision + 1
      ; generation
      ; manifest = ref_
      ; contract = m.contract
      ; policy_binding
      ; author = attribution
      ; review_request
      ; state = Pending
      }
  | Review { id; ticket; generation; verdict; evidence; comment } ->
    let s = submission t ticket in
    expected s.generation generation;
    let review =
      { Review.id
      ; serial = t.revision + 1
      ; ticket
      ; generation
      ; manifest = s.manifest
      ; contract = s.contract
      ; policy_binding = s.policy_binding
      ; reviewer = attribution
      ; verdict
      ; evidence
      ; comment
      }
    in
    let submission =
      match verdict with
      | Approve -> s
      | Request_changes ->
        { s with revision = s.revision + 1; state = Changes_requested attribution }
    in
    Update.Review_added { review; submission }
  | Accept { ticket; expected_revision } ->
    let s = submission t ticket in
    expected s.revision expected_revision;
    Update.Submission_put
      { s with revision = s.revision + 1; state = Accepted attribution }
  | Validate { id; manifest = ref_; name; expected_policy_digest; passed; evidence } ->
    let m = manifest t ref_ in
    let effective = effective_exn t ~ticket_context ~ticket:m.ticket in
    require
      (String.equal expected_policy_digest (Acceptance_policy.Effective.digest effective))
      Conflict
      "observed effective policy changed";
    Update.Validation_added
      { id
      ; serial = t.revision + 1
      ; manifest = ref_
      ; contract = m.contract
      ; policy_binding = Acceptance_policy.Effective.binding effective
      ; name
      ; passed
      ; evidence
      ; attribution
      }
  | Decision_put
      { id; expected_revision; scope; title; rationale; evidence; affected; supersedes }
    ->
    expected
      (next_revision t.decisions id ~revision_of:(fun d -> d.Decision.revision) - 1)
      expected_revision;
    Update.Decision_put
      { id
      ; revision = expected_revision + 1
      ; scope
      ; title
      ; rationale
      ; evidence
      ; affected = unique affected ~compare:Entity_ref.compare
      ; supersedes = unique supersedes ~compare:Evidence_id.Decision.compare
      ; attribution
      }
  | Input_changed { previous; current } -> Update.Input_changed { previous; current }
  | Reconcile { serial; expected_revision; disposition } ->
    let r = find t.reconciliations serial in
    expected r.revision expected_revision;
    let state =
      match disposition with
      | Disposition.Acknowledge -> Reconciliation.State.Acknowledged attribution
      | Continue reason -> Continued { attribution; reason }
      | Revised manifest -> Revised { attribution; manifest }
    in
    Update.Reconciliation_put { r with revision = r.revision + 1; state }
;;

let update_json = function
  | Update.Contract_put c -> (wire_json Evidence_wire.contract) c
  | Manifest_put m -> (wire_json Evidence_wire.manifest) m
  | Policy_put p -> policy_version_json p
  | Assertion_added a -> assertion_json a
  | Submission_put s -> (wire_json Evidence_wire.submission) s
  | Review_added { review; _ } -> (wire_json Evidence_wire.review) review
  | Validation_added v -> unwrap_evidence (Api_codec.encode validation_codec v)
  | Decision_put d -> (wire_json Evidence_wire.decision) d
  | Input_changed { previous; current } ->
    Json.obj
      [ "previous", (wire_json Evidence_wire.pin) previous
      ; "current", (wire_json Evidence_wire.pin) current
      ]
  | Reconciliation_put r -> (wire_json Evidence_wire.reconciliation) r
;;

let prepare t command ~ticket_context ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let attribution = { Attribution.actor; run; timestamp } in
    attribution_valid attribution;
    let update = command_update t command attribution ~ticket_context in
    let change =
      { Change.version = 1
      ; revision = t.revision + 1
      ; sequence
      ; attribution
      ; update
      ; reconciliations = resolved_reconciliations t update
      }
    in
    let candidate = apply_exn t change ~ticket_context in
    { candidate; changes = [ change ]; result = update_json update })
;;

let command_attempts t = function
  | Command.Manifest_publish { attempt; _ } -> [ attempt ]
  | Assert { attempt; _ } -> Option.to_list attempt
  | Submit { manifest = ref_; _ } -> [ (manifest t ref_).Manifest.attempt ]
  | Accept { ticket; _ } ->
    [ (manifest t (submission t ticket).manifest).Manifest.attempt ]
  | Reconcile { serial; _ } -> [ (find t.reconciliations serial).Reconciliation.attempt ]
  | Contract_put _
  | Policy_put _
  | Acceptance_policy_put _
  | Review _
  | Validate _
  | Decision_put _
  | Input_changed _ -> []
;;

let pin_internal_exists t = function
  | Pin.Contract ref_ -> Option.is_some (get_contract t ref_)
  | Decision { id; revision } ->
    Option.is_some
      (historical t.decisions id revision ~revision_of:(fun d -> d.Decision.revision))
  | Resource _ | Event _ | Commit _ | Checksum _ | Comment _ -> true
;;

let validate_references t ~attempt ~pin_exists ~entity_exists ~review_request_exists =
  Json.decode (fun () ->
    let check pin =
      pin_valid pin;
      require
        (pin_internal_exists t pin && pin_exists pin)
        Not_found
        "pinned evidence reference/version not found"
    in
    let entity e =
      require (entity_exists e) Not_found "evidence entity reference not found"
    in
    Map.iter
      t.contracts
      ~f:(List.iter ~f:(fun c -> check (Pin.Resource c.Contract.schema)));
    Map.iter
      t.manifests
      ~f:
        (List.iter ~f:(fun m ->
           entity (Entity_ref.Ticket m.Manifest.ticket);
           (match attempt m.attempt with
            | Some a ->
              require
                (Id.Ticket.equal a.Attempt.ticket m.ticket)
                Conflict
                "manifest ticket differs from attempt"
            | None -> Json.fail Not_found "manifest attempt not found");
           check (Pin.Contract m.contract);
           List.iter (m.inputs @ m.outputs) ~f:(fun a -> check a.Artifact.pin)));
    Map.iter
      t.policies
      ~f:
        (List.iter ~f:(fun p ->
           entity
             (match Acceptance_policy.Definition.scope p.Policy_version.definition with
              | Project id -> Entity_ref.Project id
              | Ticket id -> Entity_ref.Ticket id)));
    Map.iter
      t.submissions
      ~f:
        (List.iter ~f:(fun s ->
           Option.iter s.Submission.review_request ~f:(fun id ->
             require
               (review_request_exists id)
               Not_found
               "review routing request not found")));
    Map.iter t.assertions ~f:(fun a ->
      entity (Entity_ref.Ticket a.Assertion.ticket);
      Option.iter a.attempt ~f:(fun id ->
        require (Option.is_some (attempt id)) Not_found "assertion attempt not found");
      Option.iter a.manifest ~f:(fun reference ->
        require
          (Option.is_some (get_manifest t reference))
          Not_found
          "assertion manifest not found");
      List.iter a.evidence_pins ~f:check;
      List.iter a.artifacts ~f:(fun artifact -> check artifact.Artifact.pin));
    Map.iter t.reviews ~f:(fun r ->
      Option.iter r.Review.comment ~f:(fun id -> check (Pin.Comment { id; revision = 1 })));
    Map.iter
      t.decisions
      ~f:
        (List.iter ~f:(fun d ->
           entity d.Decision.scope;
           List.iter d.affected ~f:entity;
           check d.rationale;
           List.iter d.evidence ~f:check));
    List.iter t.history ~f:(fun change ->
      match change.Change.update with
      | Input_changed { previous; current } ->
        check previous;
        check current
      | Contract_put _
      | Manifest_put _
      | Policy_put _
      | Assertion_added _
      | Submission_put _
      | Review_added _
      | Validation_added _
      | Decision_put _
      | Reconciliation_put _ -> ()))
;;

let change_targets t (change : Change.t) =
  let pin_targets = function
    | Pin.Resource p -> [ Entity_ref.Resource p.id ]
    | Contract ref_ -> [ Entity_ref.Resource (contract t ref_).schema.id ]
    | Decision { id; revision } ->
      Option.value_map
        (historical t.decisions id revision ~revision_of:(fun d -> d.Decision.revision))
        ~default:[]
        ~f:(fun d -> d.scope :: d.affected)
    | Event _ | Commit _ | Checksum _ | Comment _ -> []
  in
  let targets =
    match change.update with
    | Update.Contract_put c -> [ Entity_ref.Resource c.schema.id ]
    | Manifest_put m ->
      Entity_ref.Ticket m.ticket
      :: List.concat_map (m.inputs @ m.outputs) ~f:(fun a -> pin_targets a.Artifact.pin)
    | Policy_put p ->
      [ (match Acceptance_policy.Definition.scope p.definition with
         | Project id -> Entity_ref.Project id
         | Ticket id -> Entity_ref.Ticket id)
      ]
    | Assertion_added a -> [ Entity_ref.Ticket a.ticket ]
    | Submission_put s -> [ Entity_ref.Ticket s.ticket ]
    | Review_added { review; _ } -> [ Entity_ref.Ticket review.ticket ]
    | Validation_added v -> [ Entity_ref.Ticket (manifest t v.manifest).ticket ]
    | Decision_put d -> d.scope :: d.affected
    | Input_changed { previous; current } -> pin_targets previous @ pin_targets current
    | Reconciliation_put r -> [ Entity_ref.Ticket r.ticket ]
  in
  unique
    (targets
     @ List.map change.reconciliations ~f:(fun r ->
       Entity_ref.Ticket r.Reconciliation.ticket))
    ~compare:Entity_ref.compare
;;

let to_json t =
  Json.obj
    [ "version", Json.int 1
    ; "revision", Json.int t.revision
    ; "events", `Array (List.rev_map t.history ~f:Change.jsonaf_of_t)
    ]
;;

let methods =
  [ "contract.put", "Contract_put"
  ; "manifest.publish", "Manifest_publish"
  ; "review.policy.put", "Policy_put"
  ; "acceptance.policy.put", "Acceptance_policy_put"
  ; "acceptance.assert", "Assert"
  ; "review.submit", "Submit"
  ; "review.record", "Review"
  ; "review.accept", "Accept"
  ; "validation.add", "Validate"
  ; "decision.put", "Decision_put"
  ; "input.changed", "Input_changed"
  ; "reconciliation.record", "Reconcile"
  ]
;;

let mutation_methods = List.map methods ~f:fst

let query_methods =
  [ "contract.get"
  ; "contract.list"
  ; "contract.history"
  ; "manifest.get"
  ; "manifest.list"
  ; "manifest.history"
  ; "review.policy.get"
  ; "acceptance.policy.get"
  ; "acceptance.policy.effective"
  ; "acceptance.assertions"
  ; "review.submission.get"
  ; "review.submission.list"
  ; "review.list"
  ; "validation.list"
  ; "decision.get"
  ; "decision.list"
  ; "decision.history"
  ; "reconciliation.list"
  ; "evidence.context"
  ; "review.gate"
  ]
;;

type 'a request_declaration =
  { raw : Jsonaf.t Api_codec.t
  ; resolved : 'a Api_codec.t
  }

let map_declaration declaration ~decode ~encode ~description =
  { declaration with
    resolved = Api_codec.map declaration.resolved ~decode ~encode ~description
  }
;;

let acceptance_codecs =
  let ( <*> ) = Api_codec.Fields.both in
  let req = Api_codec.Fields.required in
  let opt = Api_codec.Fields.optional in
  let value_obj fields ~decode ~encode =
    Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
  in
  let obj fields ~decode ~encode =
    { raw = Api_codec.as_json (Api_codec.object_ fields)
    ; resolved = value_obj fields ~decode ~encode
    }
  in
  let literal = function
    | Api_codec.Literal value -> value
    | Alias _ -> Json.fail Invalid_argument "unresolved transaction alias"
  in
  let decode_value codec json = unwrap_evidence (Api_codec.decode codec json) in
  let encode_value codec value = unwrap_evidence (Api_codec.encode codec value) in
  let literal_id of_string to_string =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:of_string
      ~encode:to_string
      ~description:"Validated ASCII identifier."
  in
  let identifier of_string to_string =
    Api_codec.reference (literal_id of_string to_string)
  in
  let ticket_codec = identifier Id.Ticket.of_string Id.Ticket.to_string in
  let attempt_codec = identifier Attempt.Id.of_string Attempt.Id.to_string in
  let decimal = Api_codec.decimal ~max:Int.max_value in
  let nonblank_codec maximum =
    Api_codec.map
      (Api_codec.text ~max_bytes:maximum)
      ~decode:(fun value ->
        Json.decode (fun () ->
          nonempty value maximum;
          value))
      ~encode:Fn.id
      ~description:"Nonblank bounded UTF-8 text."
  in
  let positive =
    Api_codec.map
      decimal
      ~decode:(fun value ->
        if value > 0
        then Ok value
        else Error (Problem.create Invalid_argument "token or version must be positive"))
      ~encode:Fn.id
      ~description:"Positive token or version."
  in
  let digest_codec =
    Api_codec.map
      (Api_codec.text ~max_bytes:64)
      ~decode:(fun value ->
        Json.decode (fun () ->
          hex value [ 64 ];
          value))
      ~encode:Fn.id
      ~description:"Observed lowercase SHA-256 effective policy digest."
  in
  let put =
    map_declaration
      (obj
         (req "scope" Evidence_request.scope
          <*> req "expected_revision" decimal
          <*> req "enabled" Api_codec.boolean
          <*> req "reviewers" (Api_codec.list Evidence_request.requirement ~max_items:100)
          <*> req "separate_actor" Api_codec.boolean
          <*> req
                "validators"
                (Api_codec.list (Api_codec.text ~max_bytes:96) ~max_items:100)
          <*> req
                "criteria"
                (Api_codec.list Acceptance_policy.Criterion.codec ~max_items:100)
          <*> opt "inherited_override" Evidence_request.inherited_override
          <*> opt "weakening_reason" (nonblank_codec 4096))
         ~decode:
           (fun
             ( ( ( ( ((((scope, expected_revision), enabled), reviewers), separate_actor)
                   , validators )
                 , criteria )
               , inherited_override )
             , weakening_reason ) ->
           ( scope
           , expected_revision
           , enabled
           , reviewers
           , separate_actor
           , validators
           , criteria
           , inherited_override
           , weakening_reason ))
         ~encode:
           (fun
             ( scope
             , expected_revision
             , enabled
             , reviewers
             , separate_actor
             , validators
             , criteria
             , inherited_override
             , weakening_reason ) ->
           ( ( ( ( ((((scope, expected_revision), enabled), reviewers), separate_actor)
                 , validators )
               , criteria )
             , inherited_override )
           , weakening_reason )))
      ~decode:
        (fun
          ( scope
          , expected_revision
          , enabled
          , reviewers
          , separate_actor
          , validators
          , criteria
          , inherited_override
          , weakening_reason ) ->
        let open Result.Let_syntax in
        if expected_revision = Int.max_value
        then Error (Problem.create Invalid_argument "policy revision exhausted")
        else (
          let scope = decode_value Acceptance_policy.Scope.codec scope in
          let reviewers =
            List.map reviewers ~f:(decode_value Acceptance_policy.Requirement.codec)
          in
          let inherited_override =
            Option.map
              inherited_override
              ~f:(decode_value Acceptance_policy.Inherited_override.codec)
          in
          let%map definition =
            Acceptance_policy.Definition.create
              ~scope
              ~revision:(expected_revision + 1)
              ~enabled
              ~reviewers
              ~separate_actor
              ~validators
              ~criteria
              ~inherited_override
          in
          Command.Acceptance_policy_put
            { definition; expected_revision; weakening_reason }))
      ~encode:(function
        | Command.Acceptance_policy_put
            { definition = d; expected_revision; weakening_reason } ->
          ( encode_value
              Acceptance_policy.Scope.codec
              (Acceptance_policy.Definition.scope d)
          , expected_revision
          , Acceptance_policy.Definition.enabled d
          , List.map
              (Acceptance_policy.Definition.reviewers d)
              ~f:(encode_value Acceptance_policy.Requirement.codec)
          , Acceptance_policy.Definition.separate_actor d
          , Acceptance_policy.Definition.validators d
          , Acceptance_policy.Definition.criteria d
          , Option.map
              (Acceptance_policy.Definition.inherited_override d)
              ~f:(encode_value Acceptance_policy.Inherited_override.codec)
          , weakening_reason )
        | _ -> Json.fail Invalid_argument "acceptance policy command expected")
      ~description:
        "Full scoped policy update; removal or relaxation requires an attributed reason."
  in
  let assert_ =
    obj
      (req "ticket_id" ticket_codec
       <*> req "token" positive
       <*> opt "attempt_id" attempt_codec
       <*> opt "manifest" Evidence_request.manifest_ref
       <*> req "expected_policy_digest" digest_codec
       <*> req "criterion" Evidence_request.criterion_ref
       <*> req "passed" Api_codec.boolean
       <*> req
             "evidence_pins"
             (Api_codec.map
                (Api_codec.list Evidence_request.pin ~max_items:100)
                ~decode:(fun pins ->
                  if List.is_empty pins
                  then
                    Error
                      (Problem.create Invalid_argument "assertion evidence pins required")
                  else Ok pins)
                ~encode:Fn.id
                ~description:"At least one exact evidence pin.")
       <*> req "evidence" (nonblank_codec 65_536))
      ~decode:
        (fun
          ( ( ( ( ((((ticket, token), attempt), manifest), expected_policy_digest)
                , criterion )
              , passed )
            , evidence_pins )
          , evidence ) ->
        Command.Assert
          { ticket = literal ticket
          ; token
          ; attempt = Option.map attempt ~f:literal
          ; manifest = Option.map manifest ~f:(decode_value Evidence_wire.manifest_ref)
          ; expected_policy_digest
          ; criterion = decode_value Acceptance_policy.Criterion.Ref.codec criterion
          ; passed
          ; evidence_pins = List.map evidence_pins ~f:(decode_value Evidence_wire.pin)
          ; evidence
          })
      ~encode:(function
        | Command.Assert
            { ticket
            ; token
            ; attempt
            ; manifest
            ; expected_policy_digest
            ; criterion
            ; passed
            ; evidence_pins
            ; evidence
            } ->
          ( ( ( ( ( ( ( (Api_codec.Literal ticket, token)
                      , Option.map attempt ~f:(fun x -> Api_codec.Literal x) )
                    , Option.map manifest ~f:(encode_value Evidence_wire.manifest_ref) )
                  , expected_policy_digest )
                , encode_value Acceptance_policy.Criterion.Ref.codec criterion )
              , passed )
            , List.map evidence_pins ~f:(encode_value Evidence_wire.pin) )
          , evidence )
        | _ -> Json.fail Invalid_argument "acceptance assertion command expected")
  in
  let narrow =
    obj
      (req "ticket_id" ticket_codec
       <*> req "expected_revision" decimal
       <*> req "enabled" Api_codec.boolean
       <*> req "reviewers" (Api_codec.list Evidence_request.requirement ~max_items:100)
       <*> req "separate_actor" Api_codec.boolean
       <*> req "validators" (Api_codec.list (Api_codec.text ~max_bytes:96) ~max_items:100)
       <*> opt "weakening_reason" (nonblank_codec 4096))
      ~decode:
        (fun
          ( ( ((((ticket, expected_revision), enabled), reviewers), separate_actor)
            , validators )
          , weakening_reason ) ->
        Command.Policy_put
          { ticket = literal ticket
          ; expected_revision
          ; enabled
          ; reviewers =
              List.map reviewers ~f:(decode_value Acceptance_policy.Requirement.codec)
          ; separate_actor
          ; validators
          ; weakening_reason
          })
      ~encode:(function
        | Command.Policy_put
            { ticket
            ; expected_revision
            ; enabled
            ; reviewers
            ; separate_actor
            ; validators
            ; weakening_reason
            } ->
          ( ( ( ( ((Api_codec.Literal ticket, expected_revision), enabled)
                , List.map reviewers ~f:(encode_value Acceptance_policy.Requirement.codec)
                )
              , separate_actor )
            , validators )
          , weakening_reason )
        | _ -> Json.fail Invalid_argument "review policy command expected")
  in
  let validate =
    obj
      (req
         "validation_id"
         (identifier Evidence_id.Validation.of_string Evidence_id.Validation.to_string)
       <*> req "manifest" Evidence_request.manifest_ref
       <*> req "name" (literal_id Id.Resource.of_string Id.Resource.to_string)
       <*> req "expected_policy_digest" digest_codec
       <*> req "passed" Api_codec.boolean
       <*> req "evidence" (nonblank_codec 65_536))
      ~decode:
        (fun
          (((((id, manifest), name), expected_policy_digest), passed), evidence) ->
        Command.Validate
          { id = literal id
          ; manifest = decode_value Evidence_wire.manifest_ref manifest
          ; name = Id.Resource.to_string name
          ; expected_policy_digest
          ; passed
          ; evidence
          })
      ~encode:(function
        | Command.Validate
            { id; manifest; name; expected_policy_digest; passed; evidence } ->
          ( ( ( ( (Api_codec.Literal id, encode_value Evidence_wire.manifest_ref manifest)
                , unwrap_evidence (Id.Resource.of_string name) )
              , expected_policy_digest )
            , passed )
          , evidence )
        | _ -> Json.fail Invalid_argument "validator command expected")
  in
  let names =
    Api_codec.list
      (Api_codec.map
         (literal_id Id.Resource.of_string Id.Resource.to_string)
         ~decode:(fun value -> Ok (Id.Resource.to_string value))
         ~encode:(fun value -> unwrap_evidence (Id.Resource.of_string value))
         ~description:"Validated requirement name.")
      ~max_items:100
  in
  let disposition_codec =
    let acknowledge =
      value_obj
        (req "kind" (Api_codec.literal "acknowledge"))
        ~decode:(fun () -> Disposition.Acknowledge)
        ~encode:(function
          | Disposition.Acknowledge -> ()
          | Continue _ | Revised _ -> Json.fail Invalid_argument "acknowledge expected")
    in
    let continue =
      value_obj
        (req "kind" (Api_codec.literal "continue")
         <*> req "reason" (nonblank_codec 65_536))
        ~decode:(fun ((), reason) -> Disposition.Continue reason)
        ~encode:(function
          | Disposition.Continue reason -> (), reason
          | Acknowledge | Revised _ ->
            Json.fail Invalid_argument "continued disposition expected")
    in
    let revised =
      value_obj
        (req "kind" (Api_codec.literal "revised")
         <*> req "manifest" Evidence_wire.manifest_ref)
        ~decode:(fun ((), manifest) -> Disposition.Revised manifest)
        ~encode:(function
          | Disposition.Revised manifest -> (), manifest
          | Acknowledge | Continue _ ->
            Json.fail Invalid_argument "revised disposition expected")
    in
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:[ "acknowledge", acknowledge; "continue", continue; "revised", revised ]
      ~select:(function
        | Disposition.Acknowledge -> "acknowledge"
        | Continue _ -> "continue"
        | Revised _ -> "revised")
  in
  let contract_put =
    obj
      (req
         "contract_id"
         (identifier Evidence_id.Contract.of_string Evidence_id.Contract.to_string)
       <*> req "expected_revision" decimal
       <*> req "schema_version" positive
       <*> req "schema" Evidence_request.resource_pin
       <*> req "required_inputs" names
       <*> req "required_outputs" names)
      ~decode:
        (fun
          ( ((((id, expected_revision), schema_version), schema), required_inputs)
          , required_outputs ) ->
        Command.Contract_put
          { id = literal id
          ; expected_revision
          ; schema_version
          ; schema = decode_value Evidence_wire.resource_pin schema
          ; required_inputs
          ; required_outputs
          })
      ~encode:(function
        | Command.Contract_put
            { id
            ; expected_revision
            ; schema_version
            ; schema
            ; required_inputs
            ; required_outputs
            } ->
          ( ( ( ((Api_codec.Literal id, expected_revision), schema_version)
              , encode_value Evidence_wire.resource_pin schema )
            , required_inputs )
          , required_outputs )
        | _ -> Json.fail Invalid_argument "Contract_put expected")
  in
  let manifest_publish =
    obj
      (req
         "manifest_id"
         (identifier Evidence_id.Manifest.of_string Evidence_id.Manifest.to_string)
       <*> req "expected_revision" decimal
       <*> req "schema_version" positive
       <*> req "attempt_id" attempt_codec
       <*> req "ticket_id" ticket_codec
       <*> req "contract" Evidence_request.contract_ref
       <*> req "inputs" (Api_codec.list Evidence_request.artifact ~max_items:100)
       <*> req "outputs" (Api_codec.list Evidence_request.artifact ~max_items:100))
      ~decode:
        (fun
          ( ( (((((id, expected_revision), schema_version), attempt), ticket), contract)
            , inputs )
          , outputs ) ->
        Command.Manifest_publish
          { id = literal id
          ; expected_revision
          ; schema_version
          ; attempt = literal attempt
          ; ticket = literal ticket
          ; contract = decode_value Evidence_wire.contract_ref contract
          ; inputs = List.map inputs ~f:(decode_value Evidence_wire.artifact)
          ; outputs = List.map outputs ~f:(decode_value Evidence_wire.artifact)
          })
      ~encode:(function
        | Command.Manifest_publish
            { id
            ; expected_revision
            ; schema_version
            ; attempt
            ; ticket
            ; contract
            ; inputs
            ; outputs
            } ->
          ( ( ( ( ( ((Api_codec.Literal id, expected_revision), schema_version)
                  , Api_codec.Literal attempt )
                , Api_codec.Literal ticket )
              , encode_value Evidence_wire.contract_ref contract )
            , List.map inputs ~f:(encode_value Evidence_wire.artifact) )
          , List.map outputs ~f:(encode_value Evidence_wire.artifact) )
        | _ -> Json.fail Invalid_argument "Manifest_publish expected")
  in
  let submit =
    obj
      (req "ticket_id" ticket_codec
       <*> req "expected_revision" decimal
       <*> req "manifest" Evidence_request.manifest_ref
       <*> opt
             "review_request_id"
             (identifier
                Communication_id.Request.of_string
                Communication_id.Request.to_string))
      ~decode:(fun (((ticket, expected_revision), manifest), review_request) ->
        Command.Submit
          { ticket = literal ticket
          ; expected_revision
          ; manifest = decode_value Evidence_wire.manifest_ref manifest
          ; review_request = Option.map review_request ~f:literal
          })
      ~encode:(function
        | Command.Submit { ticket; expected_revision; manifest; review_request } ->
          ( ( (Api_codec.Literal ticket, expected_revision)
            , encode_value Evidence_wire.manifest_ref manifest )
          , Option.map review_request ~f:(fun x -> Api_codec.Literal x) )
        | _ -> Json.fail Invalid_argument "Submit expected")
  in
  let review =
    obj
      (req
         "review_id"
         (identifier Evidence_id.Review.of_string Evidence_id.Review.to_string)
       <*> req "ticket_id" ticket_codec
       <*> req "generation" positive
       <*> req "verdict" Evidence_wire.verdict
       <*> req "evidence" (nonblank_codec 65_536)
       <*> opt "comment_id" (identifier Id.Comment.of_string Id.Comment.to_string))
      ~decode:(fun (((((id, ticket), generation), verdict), evidence), comment) ->
        Command.Review
          { id = literal id
          ; ticket = literal ticket
          ; generation
          ; verdict
          ; evidence
          ; comment = Option.map comment ~f:literal
          })
      ~encode:(function
        | Command.Review { id; ticket; generation; verdict; evidence; comment } ->
          ( ( (((Api_codec.Literal id, Api_codec.Literal ticket), generation), verdict)
            , evidence )
          , Option.map comment ~f:(fun x -> Api_codec.Literal x) )
        | _ -> Json.fail Invalid_argument "Review expected")
  in
  let accept =
    obj
      (req "ticket_id" ticket_codec <*> req "expected_revision" decimal)
      ~decode:(fun (ticket, expected_revision) ->
        Command.Accept { ticket = literal ticket; expected_revision })
      ~encode:(function
        | Command.Accept { ticket; expected_revision } ->
          Api_codec.Literal ticket, expected_revision
        | _ -> Json.fail Invalid_argument "Accept expected")
  in
  let decision_put =
    obj
      (req
         "decision_id"
         (identifier Evidence_id.Decision.of_string Evidence_id.Decision.to_string)
       <*> req "expected_revision" decimal
       <*> req "scope" Evidence_request.entity_ref
       <*> req "title" (nonblank_codec 512)
       <*> req "rationale" Evidence_request.pin
       <*> req "evidence" (Api_codec.list Evidence_request.pin ~max_items:100)
       <*> req "affected" (Api_codec.list Evidence_request.entity_ref ~max_items:100)
       <*> req
             "supersedes"
             (Api_codec.list
                (identifier Evidence_id.Decision.of_string Evidence_id.Decision.to_string)
                ~max_items:100))
      ~decode:
        (fun
          ( ((((((id, expected_revision), scope), title), rationale), evidence), affected)
          , supersedes ) ->
        Command.Decision_put
          { id = literal id
          ; expected_revision
          ; scope = decode_value Evidence_wire.entity_ref scope
          ; title
          ; rationale = decode_value Evidence_wire.pin rationale
          ; evidence = List.map evidence ~f:(decode_value Evidence_wire.pin)
          ; affected = List.map affected ~f:(decode_value Evidence_wire.entity_ref)
          ; supersedes = List.map supersedes ~f:literal
          })
      ~encode:(function
        | Command.Decision_put
            { id
            ; expected_revision
            ; scope
            ; title
            ; rationale
            ; evidence
            ; affected
            ; supersedes
            } ->
          ( ( ( ( ( ( (Api_codec.Literal id, expected_revision)
                    , encode_value Evidence_wire.entity_ref scope )
                  , title )
                , encode_value Evidence_wire.pin rationale )
              , List.map evidence ~f:(encode_value Evidence_wire.pin) )
            , List.map affected ~f:(encode_value Evidence_wire.entity_ref) )
          , List.map supersedes ~f:(fun x -> Api_codec.Literal x) )
        | _ -> Json.fail Invalid_argument "Decision_put expected")
  in
  let input_changed =
    obj
      (req "previous" Evidence_request.pin <*> req "current" Evidence_request.pin)
      ~decode:(fun (previous, current) ->
        Command.Input_changed
          { previous = decode_value Evidence_wire.pin previous
          ; current = decode_value Evidence_wire.pin current
          })
      ~encode:(function
        | Command.Input_changed { previous; current } ->
          encode_value Evidence_wire.pin previous, encode_value Evidence_wire.pin current
        | _ -> Json.fail Invalid_argument "Input_changed expected")
  in
  let reconcile =
    obj
      (req "serial" positive
       <*> req "expected_revision" decimal
       <*> req "disposition" Evidence_request.disposition)
      ~decode:(fun ((serial, expected_revision), disposition_json) ->
        Command.Reconcile
          { serial
          ; expected_revision
          ; disposition = decode_value disposition_codec disposition_json
          })
      ~encode:(function
        | Command.Reconcile { serial; expected_revision; disposition } ->
          (serial, expected_revision), encode_value disposition_codec disposition
        | _ -> Json.fail Invalid_argument "Reconcile expected")
  in
  [ "acceptance.policy.put", put
  ; "acceptance.assert", assert_
  ; "review.policy.put", narrow
  ; "validation.add", validate
  ; "contract.put", contract_put
  ; "manifest.publish", manifest_publish
  ; "review.submit", submit
  ; "review.record", review
  ; "review.accept", accept
  ; "decision.put", decision_put
  ; "input.changed", input_changed
  ; "reconciliation.record", reconcile
  ]
;;

let acceptance_query_codecs =
  let ( <*> ) = Api_codec.Fields.both in
  let req = Api_codec.Fields.required in
  let opt = Api_codec.Fields.optional in
  let id of_string to_string =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:of_string
      ~encode:to_string
      ~description:"Validated ASCII identifier."
  in
  let ticket = id Id.Ticket.of_string Id.Ticket.to_string in
  let decimal = Api_codec.decimal ~max:Int.max_value in
  let budget = opt "max_bytes" (Api_codec.decimal ~max:1_048_576) in
  let limit =
    Api_codec.map
      (Api_codec.decimal ~max:100)
      ~decode:(fun n ->
        if n > 0
        then Ok n
        else Error (Problem.create Invalid_argument "page limit must be positive"))
      ~encode:Fn.id
      ~description:"Page limit from 1 through 100."
  in
  let page =
    opt "offset" decimal <*> opt "limit" limit <*> opt "revision" decimal <*> budget
  in
  let codec fields = Api_codec.as_json (Api_codec.object_ fields) in
  [ ( "contract.get"
    , codec
        (req
           "contract_id"
           (id Evidence_id.Contract.of_string Evidence_id.Contract.to_string)
         <*> opt "version" decimal
         <*> budget) )
  ; "contract.list", codec page
  ; ( "contract.history"
    , codec
        (req
           "contract_id"
           (id Evidence_id.Contract.of_string Evidence_id.Contract.to_string)
         <*> page) )
  ; ( "manifest.get"
    , codec
        (req
           "manifest_id"
           (id Evidence_id.Manifest.of_string Evidence_id.Manifest.to_string)
         <*> opt "version" decimal
         <*> budget) )
  ; ( "manifest.list"
    , codec
        (opt "ticket_id" ticket
         <*> opt "attempt_id" (id Attempt.Id.of_string Attempt.Id.to_string)
         <*> page) )
  ; ( "manifest.history"
    , codec
        (req
           "manifest_id"
           (id Evidence_id.Manifest.of_string Evidence_id.Manifest.to_string)
         <*> page) )
  ; "acceptance.policy.get", codec (req "scope" Acceptance_policy.Scope.codec <*> budget)
  ; "acceptance.policy.effective", codec (req "ticket_id" ticket <*> budget)
  ; ( "acceptance.assertions"
    , codec
        (req "ticket_id" ticket
         <*> opt "criterion" Acceptance_policy.Criterion.Ref.codec
         <*> opt "attempt_id" (id Attempt.Id.of_string Attempt.Id.to_string)
         <*> page) )
  ; "review.policy.get", codec (req "ticket_id" ticket <*> budget)
  ; "review.submission.get", codec (req "ticket_id" ticket <*> budget)
  ; "review.submission.list", codec (opt "ticket_id" ticket <*> page)
  ; ( "review.list"
    , codec
        (opt "ticket_id" ticket
         <*> opt "reviewer_id" (id Id.Actor.of_string Id.Actor.to_string)
         <*> page) )
  ; "validation.list", codec (opt "manifest" Evidence_wire.manifest_ref <*> page)
  ; ( "decision.get"
    , codec
        (req
           "decision_id"
           (id Evidence_id.Decision.of_string Evidence_id.Decision.to_string)
         <*> opt "version" decimal
         <*> budget) )
  ; ( "decision.history"
    , codec
        (req
           "decision_id"
           (id Evidence_id.Decision.of_string Evidence_id.Decision.to_string)
         <*> page) )
  ; "decision.list", codec (opt "target" Evidence_wire.entity_ref <*> page)
  ; ( "reconciliation.list"
    , codec
        (opt "ticket_id" ticket
         <*> opt "attempt_id" (id Attempt.Id.of_string Attempt.Id.to_string)
         <*> opt "pending_only" Api_codec.boolean
         <*> page) )
  ; "evidence.context", codec (req "ticket_id" ticket <*> budget)
  ; "review.gate", codec (req "ticket_id" ticket <*> budget)
  ]
;;

let request_codec ~method_ =
  match List.Assoc.find acceptance_codecs method_ ~equal:String.equal with
  | Some codec -> Some codec.raw
  | None -> List.Assoc.find acceptance_query_codecs method_ ~equal:String.equal
;;

let decode ~method_ ~params =
  match List.Assoc.find acceptance_codecs method_ ~equal:String.equal with
  | Some codec -> Api_codec.decode codec.resolved params
  | None -> Error (Problem.create Invalid_argument "unknown evidence mutation")
;;

let encode command =
  let method_ =
    match command with
    | Command.Contract_put _ -> "contract.put"
    | Manifest_publish _ -> "manifest.publish"
    | Policy_put _ -> "review.policy.put"
    | Acceptance_policy_put _ -> "acceptance.policy.put"
    | Assert _ -> "acceptance.assert"
    | Submit _ -> "review.submit"
    | Review _ -> "review.record"
    | Accept _ -> "review.accept"
    | Validate _ -> "validation.add"
    | Decision_put _ -> "decision.put"
    | Input_changed _ -> "input.changed"
    | Reconcile _ -> "reconciliation.record"
  in
  let codec = List.Assoc.find_exn acceptance_codecs method_ ~equal:String.equal in
  Result.map (Api_codec.encode codec.resolved command) ~f:(fun params -> method_, params)
;;

let optional params key f =
  match Json.optional params key with
  | None | Some `Null -> None
  | Some json -> Some (f json)
;;

let boolean = function
  | `True -> true
  | `False -> false
  | _ -> Json.fail Invalid_argument "expected boolean"
;;

let gate_problem_codec =
  let kind =
    Api_codec.enum
      [ "invalid_argument", Problem.Invalid_argument
      ; "not_found", Not_found
      ; "conflict", Conflict
      ; "blocked", Blocked
      ; "dependency_cycle", Dependency_cycle
      ; "already_claimed", Already_claimed
      ; "stale_claim", Stale_claim
      ; "idempotency_conflict", Idempotency_conflict
      ; "corrupt_store", Corrupt_store
      ; "storage_unavailable", Storage_unavailable
      ; "outcome_unknown", Outcome_unknown
      ; "workspace_closed", Workspace_closed
      ; "unsupported_version", Unsupported_version
      ]
      ~equal:Problem.equal_kind
  in
  Api_codec.object_
    (Api_codec.Fields.map
       (Api_codec.Fields.both
          (Api_codec.Fields.required "kind" kind)
          (Api_codec.Fields.required "message" (Api_codec.text ~max_bytes:65_536)))
       ~decode:(fun (kind, message) -> Problem.create kind message)
       ~encode:(fun p -> p.Problem.kind, p.message))
;;

(* Evidence records carry exact statements and cryptographic bindings. Fitting
   removes complete page items; it never rewrites a record or its nested values. *)
let budgeted_result ~max_bytes ~omitted_items output =
  let details =
    if omitted_items = 0
    then []
    else
      [ Json.obj
          [ "path", Json.string "/items"
          ; "kind", Json.string "items"
          ; "omitted", Json.int omitted_items
          ]
      ]
  in
  let wrap returned_bytes =
    let budget =
      Json.obj
        [ "max_bytes", Json.int max_bytes
        ; "returned_bytes", Json.int returned_bytes
        ; ("truncated", if omitted_items > 0 then `True else `False)
        ; "omitted_fields", Json.int 0
        ; "omitted_items", Json.int omitted_items
        ; "details", `Array details
        ; "details_complete", `True
        ]
    in
    match output with
    | `Object fields -> Json.obj (fields @ [ "budget", budget ])
    | _ -> Json.fail Invalid_argument "evidence query result requires an object"
  in
  let rec sized bytes =
    let result = wrap bytes in
    let measured = Api_response.encoded_size (Domain_query Evidence) result in
    if bytes = measured then result else sized measured
  in
  sized 0
;;

let query t ~ticket_context ~method_ ~params =
  Json.decode (fun () ->
    Option.iter
      (List.Assoc.find acceptance_query_codecs method_ ~equal:String.equal)
      ~f:(fun codec ->
        ignore (unwrap_evidence (Api_codec.decode codec params) : Jsonaf.t));
    let max_bytes = Query_budget.of_params params in
    let get key = Json.field params key in
    let allowed fields = Json.fields params ~allowed:("max_bytes" :: fields) in
    let ticket_filter = optional params "ticket_id" Id.Ticket.t_of_jsonaf in
    let attempt_filter = optional params "attempt_id" Attempt.Id.t_of_jsonaf in
    let ticket_matches ticket =
      Option.value_map ticket_filter ~default:true ~f:(Id.Ticket.equal ticket)
    in
    let attempt_matches attempt =
      Option.value_map attempt_filter ~default:true ~f:(Attempt.Id.equal attempt)
    in
    let page fields records =
      allowed (fields @ [ "offset"; "limit"; "revision" ]);
      let offset = Option.value (optional params "offset" Json.integer) ~default:0 in
      let limit = Option.value (optional params "limit" Json.integer) ~default:50 in
      require
        (limit > 0 && limit <= 100)
        Invalid_argument
        "evidence page limit must be 1..100";
      if offset > 0 then expected t.revision (Json.integer (get "revision"));
      let selected = List.take (List.drop records offset) limit in
      let result items =
        let remaining = Int.max 0 (List.length records - offset - List.length items) in
        let output =
          Json.obj
            [ "revision", Json.int t.revision
            ; "items", `Array items
            ; "offset", Json.int offset
            ; "remaining", Json.int remaining
            ; ( "next_offset"
              , if remaining > 0 then Json.int (offset + List.length items) else `Null )
            ]
        in
        budgeted_result
          ~max_bytes
          ~omitted_items:(List.length selected - List.length items)
          output
      in
      let rec fit reversed = function
        | [] -> List.rev reversed
        | item :: rest ->
          let candidate = List.rev (item :: reversed) in
          if
            Api_response.encoded_size (Domain_query Evidence) (result candidate)
            > max_bytes
          then List.rev reversed
          else fit (item :: reversed) rest
      in
      let items = fit [] selected in
      require
        (List.is_empty selected || not (List.is_empty items))
        Invalid_argument
        "one complete evidence record cannot fit; increase max_bytes";
      result items
    in
    let direct fields json =
      allowed fields;
      budgeted_result
        ~max_bytes
        ~omitted_items:0
        (Json.obj [ "revision", Json.int t.revision; "record", json ])
    in
    let versioned map id revision_of =
      match optional params "version" Json.integer with
      | None -> current map id
      | Some version ->
        (match historical map id version ~revision_of with
         | Some value -> value
         | None -> Json.fail Not_found "evidence version not found")
    in
    let output =
      match method_ with
      | "contract.get" ->
        let id = Evidence_id.Contract.t_of_jsonaf (get "contract_id") in
        direct
          [ "contract_id"; "version" ]
          ((wire_json Evidence_wire.contract)
             (versioned t.contracts id (fun c -> c.Contract.revision)))
      | "contract.list" ->
        page
          []
          (Map.data t.contracts
           |> List.map ~f:(fun history ->
             (wire_json Evidence_wire.contract) (head history)))
      | "contract.history" ->
        page
          [ "contract_id" ]
          (List.rev_map
             (find t.contracts (Evidence_id.Contract.t_of_jsonaf (get "contract_id")))
             ~f:(wire_json Evidence_wire.contract))
      | "manifest.get" ->
        let id = Evidence_id.Manifest.t_of_jsonaf (get "manifest_id") in
        direct
          [ "manifest_id"; "version" ]
          ((wire_json Evidence_wire.manifest)
             (versioned t.manifests id (fun m -> m.Manifest.revision)))
      | "manifest.list" ->
        Map.data t.manifests
        |> List.map ~f:head
        |> List.filter ~f:(fun m ->
          ticket_matches m.Manifest.ticket && attempt_matches m.attempt)
        |> List.map ~f:(wire_json Evidence_wire.manifest)
        |> page [ "ticket_id"; "attempt_id" ]
      | "manifest.history" ->
        page
          [ "manifest_id" ]
          (List.rev_map
             (find t.manifests (Evidence_id.Manifest.t_of_jsonaf (get "manifest_id")))
             ~f:(wire_json Evidence_wire.manifest))
      | "acceptance.policy.get" ->
        direct
          [ "scope" ]
          (policy_version_json
             (current t.policies (Acceptance_policy.Scope.t_of_jsonaf (get "scope"))))
      | "acceptance.policy.effective" ->
        direct
          [ "ticket_id" ]
          (Acceptance_policy.Effective.jsonaf_of_t
             (effective_exn
                t
                ~ticket_context
                ~ticket:(Id.Ticket.t_of_jsonaf (get "ticket_id"))))
      | "acceptance.assertions" ->
        let ticket = Id.Ticket.t_of_jsonaf (get "ticket_id") in
        ignore (context ticket_context ticket : Ticket_context.t);
        let criterion_filter =
          optional params "criterion" Acceptance_policy.Criterion.Ref.t_of_jsonaf
        in
        Map.data t.assertions
        |> List.filter ~f:(fun a ->
          Id.Ticket.equal a.Assertion.ticket ticket
          && Option.value_map
               criterion_filter
               ~default:true
               ~f:(Acceptance_policy.Criterion.Ref.equal a.criterion)
          && Option.value_map attempt_filter ~default:true ~f:(fun id ->
            Option.value_map a.attempt ~default:false ~f:(Attempt.Id.equal id)))
        |> List.map ~f:(fun a ->
          Json.obj
            [ "assertion", assertion_json a
            ; ("current", if assertion_current t ~ticket_context a then `True else `False)
            ])
        |> page [ "ticket_id"; "criterion"; "attempt_id" ]
      | "review.policy.get" ->
        direct
          [ "ticket_id" ]
          ((wire_json Evidence_wire.policy)
             (Option.value_exn
                (policy_view
                   (current
                      t.policies
                      (Acceptance_policy.Scope.Ticket
                         (Id.Ticket.t_of_jsonaf (get "ticket_id")))))))
      | "review.submission.get" ->
        direct
          [ "ticket_id" ]
          ((wire_json Evidence_wire.submission)
             (submission t (Id.Ticket.t_of_jsonaf (get "ticket_id"))))
      | "review.submission.list" ->
        Map.data t.submissions
        |> List.map ~f:head
        |> List.filter ~f:(fun s -> ticket_matches s.Submission.ticket)
        |> List.map ~f:(wire_json Evidence_wire.submission)
        |> page [ "ticket_id" ]
      | "review.list" ->
        let actor = optional params "reviewer_id" Id.Actor.t_of_jsonaf in
        Map.data t.reviews
        |> List.filter ~f:(fun r ->
          ticket_matches r.Review.ticket
          && Option.value_map actor ~default:true ~f:(Id.Actor.equal r.reviewer.actor))
        |> List.map ~f:(wire_json Evidence_wire.review)
        |> page [ "ticket_id"; "reviewer_id" ]
      | "validation.list" ->
        let manifest_filter =
          optional params "manifest" (fun json ->
            unwrap_evidence (Api_codec.decode Evidence_wire.manifest_ref json))
        in
        Map.data t.validations
        |> List.filter ~f:(fun v ->
          Option.value_map
            manifest_filter
            ~default:true
            ~f:(Manifest_ref.equal v.Validation.manifest))
        |> List.map ~f:(wire_json Evidence_wire.validation)
        |> page [ "manifest" ]
      | "decision.get" ->
        let id = Evidence_id.Decision.t_of_jsonaf (get "decision_id") in
        direct
          [ "decision_id"; "version" ]
          ((wire_json Evidence_wire.decision)
             (versioned t.decisions id (fun d -> d.Decision.revision)))
      | "decision.history" ->
        page
          [ "decision_id" ]
          (List.rev_map
             (find t.decisions (Evidence_id.Decision.t_of_jsonaf (get "decision_id")))
             ~f:(wire_json Evidence_wire.decision))
      | "decision.list" ->
        let target =
          optional params "target" (fun json ->
            unwrap_evidence (Api_codec.decode Evidence_wire.entity_ref json))
        in
        Map.data t.decisions
        |> List.map ~f:head
        |> List.filter ~f:(fun d ->
          Option.value_map target ~default:true ~f:(fun target ->
            Entity_ref.equal d.Decision.scope target
            || List.mem d.affected target ~equal:Entity_ref.equal))
        |> List.map ~f:(wire_json Evidence_wire.decision)
        |> page [ "target" ]
      | "reconciliation.list" ->
        let pending_only =
          Option.value (optional params "pending_only" boolean) ~default:true
        in
        Map.data t.reconciliations
        |> List.filter ~f:(fun r ->
          ticket_matches r.Reconciliation.ticket
          && attempt_matches r.attempt
          && ((not pending_only) || Reconciliation.State.equal r.state Pending))
        |> List.map ~f:(wire_json Evidence_wire.reconciliation)
        |> page [ "ticket_id"; "attempt_id"; "pending_only" ]
      | "review.gate" ->
        allowed [ "ticket_id" ];
        let result =
          ensure_can_complete
            t
            ~ticket_context
            ~ticket:(Id.Ticket.t_of_jsonaf (get "ticket_id"))
        in
        Json.obj
          [ "revision", Json.int t.revision
          ; ( "allowed"
            , match result with
              | Ok () -> `True
              | Error _ -> `False )
          ; ( "problem"
            , match result with
              | Ok () -> `Null
              | Error p -> unwrap_evidence (Api_codec.encode gate_problem_codec p) )
          ]
      | "evidence.context" ->
        allowed [ "ticket_id" ];
        let ticket = Id.Ticket.t_of_jsonaf (get "ticket_id") in
        let target = Entity_ref.Ticket ticket in
        let latest_manifest =
          Map.find t.latest_by_ticket ticket
          |> Option.map ~f:(fun ref_ ->
            (wire_json Evidence_wire.manifest) (manifest t ref_))
        in
        Json.obj
          [ "revision", Json.int t.revision
          ; "ticket_id", Id.Ticket.jsonaf_of_t ticket
          ; ( "effective_policy"
            , Acceptance_policy.Effective.jsonaf_of_t
                (effective_exn t ~ticket_context ~ticket) )
          ; ( "assertions"
            , `Array
                (Map.data t.assertions
                 |> List.filter ~f:(fun a -> Id.Ticket.equal a.Assertion.ticket ticket)
                 |> List.map ~f:(fun a ->
                   Json.obj
                     [ "assertion", assertion_json a
                     ; ( "current"
                       , if assertion_current t ~ticket_context a then `True else `False
                       )
                     ])) )
          ; "manifest", Option.value latest_manifest ~default:`Null
          ; ( "policy"
            , Option.value_map
                (current_policy t ticket)
                ~default:`Null
                ~f:Acceptance_policy.Definition.jsonaf_of_t )
          ; ( "submission"
            , Option.value_map
                (get_submission t ticket)
                ~default:`Null
                ~f:(wire_json Evidence_wire.submission) )
          ; ( "reviews"
            , `Array
                (Map.data t.reviews
                 |> List.filter ~f:(fun r -> Id.Ticket.equal r.Review.ticket ticket)
                 |> List.map ~f:(wire_json Evidence_wire.review)) )
          ; ( "reconciliations"
            , `Array
                (Map.data t.reconciliations
                 |> List.filter ~f:(fun r ->
                   Id.Ticket.equal r.Reconciliation.ticket ticket)
                 |> List.map ~f:(wire_json Evidence_wire.reconciliation)) )
          ; ( "decisions"
            , `Array
                (Map.data t.decisions
                 |> List.map ~f:head
                 |> List.filter ~f:(fun d ->
                   Entity_ref.equal d.Decision.scope target
                   || List.mem d.affected target ~equal:Entity_ref.equal)
                 |> List.map ~f:(wire_json Evidence_wire.decision)) )
          ]
      | _ -> Json.fail Invalid_argument "unknown evidence query"
    in
    let output =
      match method_ with
      | "review.gate" | "evidence.context" ->
        budgeted_result ~max_bytes ~omitted_items:0 output
      | _ -> output
    in
    require
      (Api_response.encoded_size (Domain_query Evidence) output <= max_bytes)
      Invalid_argument
      "complete evidence record cannot fit; increase max_bytes";
    output)
;;

let event_references t =
  let events pins =
    List.filter_map pins ~f:(function
      | Pin.Event ref_ -> Some ref_
      | Resource _ | Commit _ | Checksum _ | Comment _ | Contract _ | Decision _ -> None)
  in
  let manifests =
    Map.data t.manifests
    |> List.concat_map
         ~f:
           (List.concat_map ~f:(fun m ->
              events
                (List.map (m.Manifest.inputs @ m.outputs) ~f:(fun a -> a.Artifact.pin))))
  in
  let decisions =
    Map.data t.decisions
    |> List.concat_map
         ~f:(List.concat_map ~f:(fun d -> events (d.Decision.rationale :: d.evidence)))
  in
  let changes =
    List.concat_map t.history ~f:(fun change ->
      match change.Change.update with
      | Input_changed { previous; current } -> events [ previous; current ]
      | Contract_put _
      | Manifest_put _
      | Policy_put _
      | Assertion_added _
      | Submission_put _
      | Review_added _
      | Validation_added _
      | Decision_put _
      | Reconciliation_put _ -> [])
  in
  unique
    (manifests
     @ decisions
     @ changes
     @ List.concat_map (Map.data t.assertions) ~f:(fun a ->
       events a.Assertion.evidence_pins))
    ~compare:Session.Event_ref.compare
;;

let current_submissions t = Map.data t.submissions |> List.map ~f:head

let current_policies t =
  Map.data t.policies |> List.filter_map ~f:(fun versions -> policy_view (head versions))
;;

let policy_versions t = Map.data t.policies |> List.map ~f:head
let assertions t = Map.data t.assertions

let response_codec ~method_ =
  let count = Api_codec.decimal ~max:Int.max_value in
  let req = Api_codec.Fields.required in
  let ( <*> ) = Api_codec.Fields.both in
  let object_json fields = Api_codec.as_json (Api_codec.object_ fields) in
  let assertion_result =
    Api_codec.object_ (req "assertion" assertion_codec <*> req "current" Api_codec.boolean)
  in
  let page item =
    object_json
      (req "items" (Api_codec.list item ~max_items:100)
       <*> req "offset" count
       <*> req "remaining" count
       <*> req "next_offset" (Api_codec.nullable count))
  in
  let problem = gate_problem_codec in
  let context =
    object_json
      (req
         "ticket_id"
         (Api_codec.map
            (Api_codec.text ~max_bytes:96)
            ~decode:Id.Ticket.of_string
            ~encode:Id.Ticket.to_string
            ~description:"Ticket identity.")
       <*> req "effective_policy" Acceptance_policy.Effective.codec
       <*> req "assertions" (Api_codec.list assertion_result ~max_items:100_000)
       <*> req "manifest" (Api_codec.nullable Evidence_wire.manifest)
       <*> req "policy" (Api_codec.nullable Acceptance_policy.Definition.codec)
       <*> req "submission" (Api_codec.nullable Evidence_wire.submission)
       <*> req "reviews" (Api_codec.list Evidence_wire.review ~max_items:100_000)
       <*> req
             "reconciliations"
             (Api_codec.list Evidence_wire.reconciliation ~max_items:100_000)
       <*> req "decisions" (Api_codec.list Evidence_wire.decision ~max_items:100_000))
  in
  if not (List.mem (mutation_methods @ query_methods) method_ ~equal:String.equal)
  then None
  else
    Some
      (match method_ with
       | "contract.put" | "contract.get" -> Api_codec.as_json Evidence_wire.contract
       | "contract.list" | "contract.history" -> page Evidence_wire.contract
       | "manifest.publish" | "manifest.get" -> Api_codec.as_json Evidence_wire.manifest
       | "manifest.list" | "manifest.history" -> page Evidence_wire.manifest
       | "acceptance.policy.put" | "acceptance.policy.get" | "review.policy.put" ->
         Api_codec.as_json policy_version_codec
       | "review.policy.get" -> Api_codec.as_json Evidence_wire.policy
       | "acceptance.policy.effective" ->
         Api_codec.as_json Acceptance_policy.Effective.codec
       | "acceptance.assert" -> Api_codec.as_json assertion_codec
       | "acceptance.assertions" -> page assertion_result
       | "review.submit" | "review.accept" | "review.submission.get" ->
         Api_codec.as_json Evidence_wire.submission
       | "review.submission.list" -> page Evidence_wire.submission
       | "review.record" -> Api_codec.as_json Evidence_wire.review
       | "review.list" -> page Evidence_wire.review
       | "validation.add" -> Api_codec.as_json validation_codec
       | "validation.list" -> page validation_codec
       | "decision.put" | "decision.get" -> Api_codec.as_json Evidence_wire.decision
       | "decision.list" | "decision.history" -> page Evidence_wire.decision
       | "input.changed" ->
         object_json (req "previous" Evidence_wire.pin <*> req "current" Evidence_wire.pin)
       | "reconciliation.record" -> Api_codec.as_json Evidence_wire.reconciliation
       | "reconciliation.list" -> page Evidence_wire.reconciliation
       | "review.gate" ->
         object_json
           (req "allowed" Api_codec.boolean <*> req "problem" (Api_codec.nullable problem))
       | "evidence.context" -> context
       | _ -> Json.fail Invalid_argument "unknown evidence response")
;;

let api_methods =
  List.map (mutation_methods @ query_methods) ~f:(fun name ->
    let request = Option.value_exn (request_codec ~method_:name) in
    let response = Option.value_exn (response_codec ~method_:name) in
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Acceptance policy and exact evidence: " ^ name)
         ~mode:
           (if List.mem mutation_methods name ~equal:String.equal then Mutation else Read)
         ~request
         ~response))
;;
