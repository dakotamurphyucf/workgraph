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
module Counter = Change.Counter
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Disposition = struct
  type t =
    | Acknowledge
    | Continue of string
    | Revised of Manifest_ref.t
  [@@deriving sexp, jsonaf]
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
  ; policies : Policy.t list Id.Ticket.Map.t
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
  ; policies = Id.Ticket.Map.empty
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

let requirement_compare a b =
  String.compare
    (Sexp.to_string (Policy.Requirement.sexp_of_t a))
    (Sexp.to_string (Policy.Requirement.sexp_of_t b))
;;

let policy_valid t (p : Policy.t) =
  expected
    p.revision
    (next_revision t.policies p.ticket ~revision_of:(fun p -> p.Policy.revision));
  limit p.reviewers 100;
  names_valid p.validators;
  canonical p.reviewers ~compare:requirement_compare ~equal:Policy.Requirement.equal;
  let all_reviewers =
    List.concat_map p.reviewers ~f:(function
      | Policy.Requirement.Named_actor actor -> [ actor ]
      | Role { members; _ } -> members)
    |> unique ~compare:Id.Actor.compare
  in
  limit all_reviewers 1000;
  let roles =
    List.filter_map p.reviewers ~f:(function
      | Named_actor _ -> None
      | Role { name = role; members } ->
        name role;
        limit members 1000;
        require
          (not (List.is_empty members))
          Invalid_argument
          "review role has no members";
        canonical members ~compare:Id.Actor.compare ~equal:Id.Actor.equal;
        Some role)
  in
  require
    (not (List.contains_dup roles ~compare:String.compare))
    Invalid_argument
    "duplicate review role names";
  require
    ((not p.enabled) || not (List.is_empty p.reviewers && List.is_empty p.validators))
    Invalid_argument
    "enabled review policy has no requirements"
;;

let requirement_members = function
  | Policy.Requirement.Named_actor actor -> [ actor ]
  | Role { members; _ } -> members
;;

let review_recipients t ~ticket =
  Option.value_map (Map.find t.policies ticket) ~default:[] ~f:(fun versions ->
    List.concat_map (head versions).Policy.reviewers ~f:requirement_members
    |> unique ~compare:Id.Actor.compare)
;;

let current_policy t ticket = Map.find t.policies ticket |> Option.map ~f:head

let policy_for_submission t (s : Submission.t) =
  if Int.equal s.policy_revision 0
  then None
  else (
    match
      historical t.policies s.ticket s.policy_revision ~revision_of:(fun p ->
        p.Policy.revision)
    with
    | Some p -> Some p
    | None -> Json.fail Not_found "submission policy version not found")
;;

let bound_submission_current t (s : Submission.t) =
  let m = manifest t s.manifest in
  require
    (Id.Ticket.equal m.ticket s.ticket && Contract_ref.equal m.contract s.contract)
    Conflict
    "submission manifest/contract binding differs";
  require
    (Manifest_ref.equal (find t.latest_by_ticket s.ticket) s.manifest)
    Conflict
    "submission output has been replaced";
  let c = current t.contracts s.contract.id in
  expected c.revision s.contract.revision;
  let policy_revision =
    Option.value_map (current_policy t s.ticket) ~default:0 ~f:(fun p ->
      p.Policy.revision)
  in
  expected policy_revision s.policy_revision;
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
  && Int.equal r.policy_revision s.policy_revision
;;

let approval_valid t (s : Submission.t) =
  let m = bound_submission_current t s in
  require
    (List.is_empty (pending_reconciliations t ~attempt:(Some m.attempt)))
    Blocked
    "attempt inputs need reconciliation";
  match policy_for_submission t s with
  | None -> ()
  | Some p when not p.enabled -> ()
  | Some p ->
    let reviews = Map.data t.reviews |> List.filter ~f:(fun r -> review_matches r s) in
    let latest =
      List.fold reviews ~init:Id.Actor.Map.empty ~f:(fun latest r ->
        Map.update latest r.Review.reviewer.actor ~f:(function
          | None -> r
          | Some old -> if r.serial > old.serial then r else old))
    in
    List.iter p.reviewers ~f:(fun requirement ->
      require
        (List.exists (requirement_members requirement) ~f:(fun actor ->
           match Map.find latest actor with
           | Some r -> Review.Verdict.equal r.verdict Approve
           | None -> false))
        Blocked
        "required reviewer approval is missing");
    List.iter p.validators ~f:(fun validator ->
      let matches =
        Map.data t.validations
        |> List.filter ~f:(fun v ->
          Manifest_ref.equal v.Validation.manifest s.manifest
          && Contract_ref.equal v.contract s.contract
          && String.equal v.name validator)
      in
      let latest =
        List.max_elt matches ~compare:(fun a b ->
          Int.compare a.Validation.serial b.serial)
      in
      require
        (Option.value_map latest ~default:false ~f:(fun v -> v.Validation.passed))
        Blocked
        "required validator result is missing or failed")
;;

let ensure_can_complete t ~ticket =
  Json.decode (fun () ->
    match current_policy t ticket with
    | None -> ()
    | Some p when not p.enabled -> ()
    | Some _ ->
      let s =
        match get_submission t ticket with
        | Some s -> s
        | None -> Json.fail Blocked "ticket output has not been submitted"
      in
      (match s.state with
       | Accepted _ -> approval_valid t s
       | Pending | Changes_requested _ ->
         Json.fail Blocked "ticket output has not been accepted"))
;;

let ensure_attempt_can_complete t ~attempt ~ticket =
  Json.decode (fun () ->
    let ref_ =
      match Map.find t.latest_by_attempt attempt with
      | Some ref_ -> ref_
      | None -> Json.fail Blocked "completed attempt requires an input/output manifest"
    in
    let m = manifest t ref_ in
    require
      (Id.Ticket.equal m.ticket ticket)
      Conflict
      "manifest ticket differs from attempt";
    (match ensure_can_complete t ~ticket with
     | Ok () -> ()
     | Error error -> raise (Json.Decode_error error));
    match current_policy t ticket with
    | None -> ()
    | Some p when not p.enabled -> ()
    | Some _ ->
      let s = submission t ticket in
      require
        (Manifest_ref.equal s.manifest ref_)
        Blocked
        "accepted submission must bind the completing attempt manifest")
;;

let submission_valid t attribution (s : Submission.t) =
  expected
    s.revision
    (next_revision t.submissions s.ticket ~revision_of:(fun s -> s.Submission.revision));
  ignore (bound_submission_current t s : Manifest.t);
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
      approval_valid t previous)
;;

let review_valid t attribution (r : Review.t) (s : Submission.t) =
  require (not (Map.mem t.reviews r.id)) Conflict "review already exists";
  expected r.serial (t.revision + 1);
  require
    (Attribution.equal r.reviewer attribution)
    Corrupt_store
    "review attribution differs";
  nonempty r.evidence 65_536;
  let old = submission t r.ticket in
  ignore (bound_submission_current t old : Manifest.t);
  require
    (review_matches r old)
    Conflict
    "review refers to a different submission version";
  require
    (Submission.State.equal old.state Pending)
    Conflict
    "submission is no longer pending";
  (match policy_for_submission t old with
   | None -> Json.fail Conflict "review requires a configured policy"
   | Some p ->
     require p.enabled Conflict "review policy is disabled";
     require
       (List.exists p.reviewers ~f:(fun requirement ->
          List.mem
            (requirement_members requirement)
            attribution.actor
            ~equal:Id.Actor.equal))
       Conflict
       "actor is not an eligible reviewer";
     require
       ((not p.separate_actor) || not (Id.Actor.equal old.author.actor attribution.actor))
       Conflict
       "reviewer must differ from submitter");
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

let validation_valid t attribution (v : Validation.t) =
  require (not (Map.mem t.validations v.id)) Conflict "validator result already exists";
  expected v.serial (t.revision + 1);
  require
    (Attribution.equal v.attribution attribution)
    Corrupt_store
    "validator attribution differs";
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

let update_state t attribution = function
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
    policy_valid t p;
    { t with policies = append t.policies p.ticket p }
  | Submission_put s ->
    submission_valid t attribution s;
    { t with submissions = append t.submissions s.ticket s }
  | Review_added { review; submission } ->
    review_valid t attribution review submission;
    let submissions =
      if Review.Verdict.equal review.verdict Approve
      then t.submissions
      else append t.submissions submission.ticket submission
    in
    { t with reviews = Map.set t.reviews ~key:review.id ~data:review; submissions }
  | Validation_added v ->
    validation_valid t attribution v;
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

let apply_exn t (change : Change.t) =
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
  let updated = update_state t change.attribution change.update in
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

let apply t change = Json.decode (fun () -> apply_exn t change)

let command_update t command attribution =
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
      { ticket; expected_revision; enabled; reviewers; separate_actor; validators } ->
    expected
      (next_revision t.policies ticket ~revision_of:(fun p -> p.Policy.revision) - 1)
      expected_revision;
    let reviewers =
      List.map reviewers ~f:(function
        | Named_actor actor -> Policy.Requirement.Named_actor actor
        | Role { name; members } ->
          Role { name; members = unique members ~compare:Id.Actor.compare })
      |> unique ~compare:requirement_compare
    in
    Update.Policy_put
      { ticket
      ; revision = expected_revision + 1
      ; enabled
      ; reviewers
      ; separate_actor
      ; validators = unique validators ~compare:String.compare
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
    let policy_revision =
      Option.value_map (current_policy t ticket) ~default:0 ~f:(fun p ->
        p.Policy.revision)
    in
    Update.Submission_put
      { ticket
      ; revision = expected_revision + 1
      ; generation
      ; manifest = ref_
      ; contract = m.contract
      ; policy_revision
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
      ; policy_revision = s.policy_revision
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
  | Validate { id; manifest = ref_; name; passed; evidence } ->
    let m = manifest t ref_ in
    Update.Validation_added
      { id
      ; serial = t.revision + 1
      ; manifest = ref_
      ; contract = m.contract
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
  | Update.Contract_put c -> Contract.jsonaf_of_t c
  | Manifest_put m -> Manifest.jsonaf_of_t m
  | Policy_put p -> Policy.jsonaf_of_t p
  | Submission_put s -> Submission.jsonaf_of_t s
  | Review_added { review; _ } -> Review.jsonaf_of_t review
  | Validation_added v -> Validation.jsonaf_of_t v
  | Decision_put d -> Decision.jsonaf_of_t d
  | Input_changed { previous; current } ->
    Json.obj [ "previous", Pin.jsonaf_of_t previous; "current", Pin.jsonaf_of_t current ]
  | Reconciliation_put r -> Reconciliation.jsonaf_of_t r
;;

let prepare t command ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let attribution = { Attribution.actor; run; timestamp } in
    attribution_valid attribution;
    let update = command_update t command attribution in
    let change =
      { Change.version = 1
      ; revision = t.revision + 1
      ; sequence
      ; attribution
      ; update
      ; reconciliations = resolved_reconciliations t update
      }
    in
    let candidate = apply_exn t change in
    { candidate; changes = [ change ]; result = update_json update })
;;

let command_attempts t = function
  | Command.Manifest_publish { attempt; _ } -> [ attempt ]
  | Submit { manifest = ref_; _ } -> [ (manifest t ref_).Manifest.attempt ]
  | Accept { ticket; _ } ->
    [ (manifest t (submission t ticket).manifest).Manifest.attempt ]
  | Reconcile { serial; _ } -> [ (find t.reconciliations serial).Reconciliation.attempt ]
  | Contract_put _
  | Policy_put _
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
      ~f:(List.iter ~f:(fun p -> entity (Entity_ref.Ticket p.Policy.ticket)));
    Map.iter
      t.submissions
      ~f:
        (List.iter ~f:(fun s ->
           Option.iter s.Submission.review_request ~f:(fun id ->
             require
               (review_request_exists id)
               Not_found
               "review routing request not found")));
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
    | Policy_put p -> [ Entity_ref.Ticket p.ticket ]
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

let decode ~method_ ~params =
  Json.decode (fun () ->
    let tag =
      match List.Assoc.find methods method_ ~equal:String.equal with
      | Some tag -> tag
      | None -> Json.fail Invalid_argument "unknown evidence mutation"
    in
    try Command.t_of_jsonaf (`Array [ Json.string tag; params ]) with
    | Jsonaf_kernel.Conv.Of_jsonaf_error (exn, _) ->
      Json.fail Invalid_argument ("invalid evidence command: " ^ Exn.to_string exn))
;;

let encode command =
  let tag, params =
    match Command.jsonaf_of_t command with
    | `Array [ `String tag; params ] -> tag, params
    | _ -> assert false
  in
  let method_ =
    List.find_map methods ~f:(fun (method_, candidate) ->
      if String.equal tag candidate then Some method_ else None)
    |> Option.value_exn
  in
  Result.map (decode ~method_ ~params) ~f:(fun _ -> method_, params)
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

let query t ~method_ ~params =
  Json.decode (fun () ->
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
      let items = List.take (List.drop records offset) limit in
      let remaining = Int.max 0 (List.length records - offset - List.length items) in
      Json.obj
        [ "revision", Json.int t.revision
        ; "items", `Array items
        ; "offset", Json.int offset
        ; "remaining", Json.int remaining
        ; ( "next_offset"
          , if remaining > 0 then Json.int (offset + List.length items) else `Null )
        ]
    in
    let direct fields json =
      allowed fields;
      Json.obj [ "revision", Json.int t.revision; "record", json ]
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
        let id = Evidence_id.Contract.t_of_jsonaf (get "id") in
        direct
          [ "id"; "version" ]
          (Contract.jsonaf_of_t (versioned t.contracts id (fun c -> c.Contract.revision)))
      | "contract.list" ->
        page
          []
          (Map.data t.contracts
           |> List.map ~f:(fun history -> Contract.jsonaf_of_t (head history)))
      | "contract.history" ->
        page
          [ "id" ]
          (List.rev_map
             (find t.contracts (Evidence_id.Contract.t_of_jsonaf (get "id")))
             ~f:Contract.jsonaf_of_t)
      | "manifest.get" ->
        let id = Evidence_id.Manifest.t_of_jsonaf (get "id") in
        direct
          [ "id"; "version" ]
          (Manifest.jsonaf_of_t (versioned t.manifests id (fun m -> m.Manifest.revision)))
      | "manifest.list" ->
        Map.data t.manifests
        |> List.map ~f:head
        |> List.filter ~f:(fun m ->
          ticket_matches m.Manifest.ticket && attempt_matches m.attempt)
        |> List.map ~f:Manifest.jsonaf_of_t
        |> page [ "ticket_id"; "attempt_id" ]
      | "manifest.history" ->
        page
          [ "id" ]
          (List.rev_map
             (find t.manifests (Evidence_id.Manifest.t_of_jsonaf (get "id")))
             ~f:Manifest.jsonaf_of_t)
      | "review.policy.get" ->
        direct
          [ "ticket_id" ]
          (Policy.jsonaf_of_t
             (current t.policies (Id.Ticket.t_of_jsonaf (get "ticket_id"))))
      | "review.submission.get" ->
        direct
          [ "ticket_id" ]
          (Submission.jsonaf_of_t
             (submission t (Id.Ticket.t_of_jsonaf (get "ticket_id"))))
      | "review.submission.list" ->
        Map.data t.submissions
        |> List.map ~f:head
        |> List.filter ~f:(fun s -> ticket_matches s.Submission.ticket)
        |> List.map ~f:Submission.jsonaf_of_t
        |> page [ "ticket_id" ]
      | "review.list" ->
        let actor = optional params "actor_id" Id.Actor.t_of_jsonaf in
        Map.data t.reviews
        |> List.filter ~f:(fun r ->
          ticket_matches r.Review.ticket
          && Option.value_map actor ~default:true ~f:(Id.Actor.equal r.reviewer.actor))
        |> List.map ~f:Review.jsonaf_of_t
        |> page [ "ticket_id"; "actor_id" ]
      | "validation.list" ->
        let manifest_filter = optional params "manifest" Manifest_ref.t_of_jsonaf in
        Map.data t.validations
        |> List.filter ~f:(fun v ->
          Option.value_map
            manifest_filter
            ~default:true
            ~f:(Manifest_ref.equal v.Validation.manifest))
        |> List.map ~f:Validation.jsonaf_of_t
        |> page [ "manifest" ]
      | "decision.get" ->
        let id = Evidence_id.Decision.t_of_jsonaf (get "id") in
        direct
          [ "id"; "version" ]
          (Decision.jsonaf_of_t (versioned t.decisions id (fun d -> d.Decision.revision)))
      | "decision.history" ->
        page
          [ "id" ]
          (List.rev_map
             (find t.decisions (Evidence_id.Decision.t_of_jsonaf (get "id")))
             ~f:Decision.jsonaf_of_t)
      | "decision.list" ->
        let target = optional params "target" Entity_ref.t_of_jsonaf in
        Map.data t.decisions
        |> List.map ~f:head
        |> List.filter ~f:(fun d ->
          Option.value_map target ~default:true ~f:(fun target ->
            Entity_ref.equal d.Decision.scope target
            || List.mem d.affected target ~equal:Entity_ref.equal))
        |> List.map ~f:Decision.jsonaf_of_t
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
        |> List.map ~f:Reconciliation.jsonaf_of_t
        |> page [ "ticket_id"; "attempt_id"; "pending_only" ]
      | "review.gate" ->
        allowed [ "ticket_id" ];
        let result =
          ensure_can_complete t ~ticket:(Id.Ticket.t_of_jsonaf (get "ticket_id"))
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
              | Error p -> Problem.to_json p )
          ]
      | "evidence.context" ->
        allowed [ "ticket_id" ];
        let ticket = Id.Ticket.t_of_jsonaf (get "ticket_id") in
        let target = Entity_ref.Ticket ticket in
        let latest_manifest =
          Map.find t.latest_by_ticket ticket
          |> Option.map ~f:(fun ref_ -> Manifest.jsonaf_of_t (manifest t ref_))
        in
        Json.obj
          [ "revision", Json.int t.revision
          ; "ticket_id", Id.Ticket.jsonaf_of_t ticket
          ; "manifest", Option.value latest_manifest ~default:`Null
          ; ( "policy"
            , Option.value_map
                (current_policy t ticket)
                ~default:`Null
                ~f:Policy.jsonaf_of_t )
          ; ( "submission"
            , Option.value_map
                (get_submission t ticket)
                ~default:`Null
                ~f:Submission.jsonaf_of_t )
          ; ( "reviews"
            , `Array
                (Map.data t.reviews
                 |> List.filter ~f:(fun r -> Id.Ticket.equal r.Review.ticket ticket)
                 |> List.map ~f:Review.jsonaf_of_t) )
          ; ( "reconciliations"
            , `Array
                (Map.data t.reconciliations
                 |> List.filter ~f:(fun r ->
                   Id.Ticket.equal r.Reconciliation.ticket ticket)
                 |> List.map ~f:Reconciliation.jsonaf_of_t) )
          ; ( "decisions"
            , `Array
                (Map.data t.decisions
                 |> List.map ~f:head
                 |> List.filter ~f:(fun d ->
                   Entity_ref.equal d.Decision.scope target
                   || List.mem d.affected target ~equal:Entity_ref.equal)
                 |> List.map ~f:Decision.jsonaf_of_t) )
          ]
      | _ -> Json.fail Invalid_argument "unknown evidence query"
    in
    Query_budget.fit ~max_bytes:(Query_budget.of_params params) output)
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
      | Submission_put _
      | Review_added _
      | Validation_added _
      | Decision_put _
      | Reconciliation_put _ -> [])
  in
  unique (manifests @ decisions @ changes) ~compare:Session.Event_ref.compare
;;

let current_submissions t = Map.data t.submissions |> List.map ~f:head
let current_policies t = Map.data t.policies |> List.map ~f:head
