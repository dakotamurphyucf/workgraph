open Core
module Pin = Evidence_event.Pin

let unwrap = function
  | Ok t -> t
  | Error p -> raise (Json.Decode_error p)
;;

let require condition message = if not condition then Json.fail Invalid_argument message
let text maximum = Api_codec.text ~max_bytes:maximum
let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let id of_string to_string =
  Api_codec.map
    (text 96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated ASCII identifier."
;;

let positive =
  Api_codec.map
    (Api_codec.decimal ~max:Int.max_value)
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "version must be positive"))
    ~encode:Fn.id
    ~description:"Positive exact version."
;;

let nonblank value maximum =
  ignore (unwrap (Api_codec.encode (text maximum) value) : Jsonaf.t);
  require (not (String.is_empty (String.strip value))) "pin source is blank"
;;

let validate_pin = Pin.validate
let mismatch () = Json.fail Invalid_argument "pin kind mismatch"

let pin =
  let branch kind fields ~decode ~encode =
    obj
      (req "kind" (Api_codec.literal kind) <*> fields)
      ~decode:(fun ((), value) -> decode value)
      ~encode:(fun value -> (), encode value)
  in
  let resource =
    branch
      "resource"
      (req "resource_id" (id Id.Resource.of_string Id.Resource.to_string)
       <*> req "revision" positive
       <*> req "digest" (text 64))
      ~decode:(fun ((id, revision), digest) -> Pin.Resource { id; revision; digest })
      ~encode:(function
        | Resource { id; revision; digest } -> (id, revision), digest
        | _ -> mismatch ())
  in
  let event =
    branch
      "event"
      (req "session_id" (id Session_id.of_string Session_id.to_string)
       <*> req "sequence" positive)
      ~decode:(fun (session, sequence) ->
        Pin.Event (unwrap (Session.Event_ref.create ~session ~sequence)))
      ~encode:(function
        | Event p -> p.session, p.sequence
        | _ -> mismatch ())
  in
  let commit =
    branch
      "commit"
      (req "repository" (text 1024) <*> req "object_id" (text 64))
      ~decode:(fun (repository, object_id) -> Pin.Commit { repository; object_id })
      ~encode:(function
        | Commit { repository; object_id } -> repository, object_id
        | _ -> mismatch ())
  in
  let checksum =
    branch
      "checksum"
      (req "source" (text 1024) <*> req "digest" (text 64))
      ~decode:(fun (source, digest) -> Pin.Checksum { source; digest })
      ~encode:(function
        | Checksum { source; digest } -> source, digest
        | _ -> mismatch ())
  in
  let comment =
    branch
      "comment"
      (req "comment_id" (id Id.Comment.of_string Id.Comment.to_string)
       <*> req "revision" positive)
      ~decode:(fun (id, revision) -> Pin.Comment { id; revision })
      ~encode:(function
        | Comment { id; revision } -> id, revision
        | _ -> mismatch ())
  in
  let contract =
    branch
      "contract"
      (req
         "contract_id"
         (id Evidence_id.Contract.of_string Evidence_id.Contract.to_string)
       <*> req "revision" positive)
      ~decode:(fun (id, revision) -> Pin.Contract { id; revision })
      ~encode:(function
        | Contract { id; revision } -> id, revision
        | _ -> mismatch ())
  in
  let decision =
    branch
      "decision"
      (req
         "decision_id"
         (id Evidence_id.Decision.of_string Evidence_id.Decision.to_string)
       <*> req "revision" positive)
      ~decode:(fun (id, revision) -> Pin.Decision { id; revision })
      ~encode:(function
        | Decision { id; revision } -> id, revision
        | _ -> mismatch ())
  in
  Api_codec.map
    (Api_codec.tagged
       ~discriminator:"kind"
       ~cases:
         [ "resource", resource
         ; "event", event
         ; "commit", commit
         ; "checksum", checksum
         ; "comment", comment
         ; "contract", contract
         ; "decision", decision
         ]
       ~select:(function
         | Resource _ -> "resource"
         | Event _ -> "event"
         | Commit _ -> "commit"
         | Checksum _ -> "checksum"
         | Comment _ -> "comment"
         | Contract _ -> "contract"
         | Decision _ -> "decision"))
    ~decode:(fun t -> Result.map (validate_pin t) ~f:(fun () -> t))
    ~encode:Fn.id
    ~description:"Immutable exact historical provenance pin."
;;

let manifest_ref =
  obj
    (req "manifest_id" (id Evidence_id.Manifest.of_string Evidence_id.Manifest.to_string)
     <*> req "revision" positive)
    ~decode:(fun (id, revision) -> { Evidence_event.Manifest_ref.id; revision })
    ~encode:(fun p -> p.Evidence_event.Manifest_ref.id, p.revision)
;;

let artifact =
  obj
    (req "name" (id Id.Resource.of_string Id.Resource.to_string) <*> req "pin" pin)
    ~decode:(fun (name, pin) ->
      { Evidence_event.Artifact.name = Id.Resource.to_string name; pin })
    ~encode:(fun a ->
      unwrap (Id.Resource.of_string a.Evidence_event.Artifact.name), a.pin)
;;

module Attribution = Evidence_event.Attribution
module Contract = Evidence_event.Contract
module Manifest = Evidence_event.Manifest
module Policy = Evidence_event.Policy
module Submission = Evidence_event.Submission
module Review = Evidence_event.Review
module Validation = Evidence_event.Validation
module Decision = Evidence_event.Decision
module Reconciliation = Evidence_event.Reconciliation

let many codec = Api_codec.list codec ~max_items:100
let nullable = Api_codec.nullable
let counter = Api_codec.decimal ~max:Int.max_value

let name =
  Api_codec.map
    (text 96)
    ~decode:(fun value ->
      Result.map (Id.Resource.of_string value) ~f:Id.Resource.to_string)
    ~encode:Fn.id
    ~description:"Validated ASCII name."
;;

let names = many name

let nonblank_codec maximum =
  Api_codec.map
    (text maximum)
    ~decode:(fun value ->
      Json.decode (fun () ->
        nonblank value maximum;
        value))
    ~encode:Fn.id
    ~description:"Nonblank bounded UTF-8 text."
;;

let actor_id = id Id.Actor.of_string Id.Actor.to_string
let run_id = id Id.Run.of_string Id.Run.to_string
let ticket_id = id Id.Ticket.of_string Id.Ticket.to_string
let attempt_id = id Attempt.Id.of_string Attempt.Id.to_string
let comment_id = id Id.Comment.of_string Id.Comment.to_string
let contract_id = id Evidence_id.Contract.of_string Evidence_id.Contract.to_string
let manifest_id = id Evidence_id.Manifest.of_string Evidence_id.Manifest.to_string
let decision_id = id Evidence_id.Decision.of_string Evidence_id.Decision.to_string

let entity_ref =
  let tag kind fields ~decode ~encode =
    obj
      (req "kind" (Api_codec.literal kind) <*> fields)
      ~decode:(fun ((), value) -> decode value)
      ~encode:(fun value -> (), encode value)
  in
  let workspace =
    obj
      (req "kind" (Api_codec.literal "workspace"))
      ~decode:(fun () -> Entity_ref.Workspace)
      ~encode:(function
        | Entity_ref.Workspace -> ()
        | _ -> mismatch ())
  in
  let project =
    tag
      "project"
      (req "project_id" (id Id.Project.of_string Id.Project.to_string))
      ~decode:(fun id -> Entity_ref.Project id)
      ~encode:(function
        | Entity_ref.Project id -> id
        | _ -> mismatch ())
  in
  let milestone =
    tag
      "milestone"
      (req "milestone_id" (id Id.Milestone.of_string Id.Milestone.to_string))
      ~decode:(fun id -> Entity_ref.Milestone id)
      ~encode:(function
        | Entity_ref.Milestone id -> id
        | _ -> mismatch ())
  in
  let ticket =
    tag
      "ticket"
      (req "ticket_id" ticket_id)
      ~decode:(fun id -> Entity_ref.Ticket id)
      ~encode:(function
        | Entity_ref.Ticket id -> id
        | _ -> mismatch ())
  in
  let resource =
    tag
      "resource"
      (req "resource_id" (id Id.Resource.of_string Id.Resource.to_string))
      ~decode:(fun id -> Entity_ref.Resource id)
      ~encode:(function
        | Entity_ref.Resource id -> id
        | _ -> mismatch ())
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ "workspace", workspace
      ; "project", project
      ; "milestone", milestone
      ; "ticket", ticket
      ; "resource", resource
      ]
    ~select:(function
      | Entity_ref.Workspace -> "workspace"
      | Project _ -> "project"
      | Milestone _ -> "milestone"
      | Ticket _ -> "ticket"
      | Resource _ -> "resource")
;;

let attribution : Attribution.t Api_codec.t =
  obj
    (req "actor_id" actor_id
     <*> req "run_id" (nullable run_id)
     <*> req "timestamp" (nonblank_codec 128))
    ~decode:(fun ((actor, run), timestamp) -> { Attribution.actor; run; timestamp })
    ~encode:(fun (value : Attribution.t) -> (value.actor, value.run), value.timestamp)
;;

let contract_ref : Evidence_event.Contract_ref.t Api_codec.t =
  obj
    (req "contract_id" contract_id <*> req "revision" positive)
    ~decode:(fun (id, revision) -> { Evidence_event.Contract_ref.id; revision })
    ~encode:(fun (value : Evidence_event.Contract_ref.t) -> value.id, value.revision)
;;

let resource_pin : Evidence_event.Resource_pin.t Api_codec.t =
  obj
    (req "resource_id" (id Id.Resource.of_string Id.Resource.to_string)
     <*> req "revision" positive
     <*> req "digest" (text 64))
    ~decode:(fun ((id, revision), digest) ->
      { Evidence_event.Resource_pin.id; revision; digest })
    ~encode:(fun (value : Evidence_event.Resource_pin.t) ->
      (value.id, value.revision), value.digest)
;;

let resource_pin =
  Api_codec.map
    resource_pin
    ~decode:(fun p -> Result.map (validate_pin (Pin.Resource p)) ~f:(fun () -> p))
    ~encode:Fn.id
    ~description:"Exact resource revision and SHA-256 digest."
;;

let contract : Contract.t Api_codec.t =
  obj
    (req "contract_id" contract_id
     <*> req "revision" positive
     <*> req "schema_version" positive
     <*> req "schema" resource_pin
     <*> req "required_inputs" names
     <*> req "required_outputs" names)
    ~decode:
      (fun
        (((((id, revision), schema_version), schema), required_inputs), required_outputs) ->
      { Contract.id; revision; schema_version; schema; required_inputs; required_outputs })
    ~encode:(fun (value : Contract.t) ->
      ( ( (((value.id, value.revision), value.schema_version), value.schema)
        , value.required_inputs )
      , value.required_outputs ))
;;

let manifest : Manifest.t Api_codec.t =
  obj
    (req "manifest_id" manifest_id
     <*> req "revision" positive
     <*> req "schema_version" positive
     <*> req "attempt_id" attempt_id
     <*> req "ticket_id" ticket_id
     <*> req "contract" contract_ref
     <*> req "inputs" (many artifact)
     <*> req "outputs" (many artifact)
     <*> req "published" attribution)
    ~decode:
      (fun
        ( ( ((((((id, revision), schema_version), attempt), ticket), contract), inputs)
          , outputs )
        , published ) ->
      { Manifest.id
      ; revision
      ; schema_version
      ; attempt
      ; ticket
      ; contract
      ; inputs
      ; outputs
      ; published
      })
    ~encode:(fun (value : Manifest.t) ->
      ( ( ( ( ( (((value.id, value.revision), value.schema_version), value.attempt)
              , value.ticket )
            , value.contract )
          , value.inputs )
        , value.outputs )
      , value.published ))
;;

let policy : Policy.t Api_codec.t =
  obj
    (req "ticket_id" ticket_id
     <*> req "revision" positive
     <*> req "enabled" Api_codec.boolean
     <*> req "reviewers" (many Acceptance_policy.Requirement.codec)
     <*> req "separate_actor" Api_codec.boolean
     <*> req "validators" names)
    ~decode:
      (fun
        (((((ticket, revision), enabled), reviewers), separate_actor), validators) ->
      { Policy.ticket; revision; enabled; reviewers; separate_actor; validators })
    ~encode:(fun (value : Policy.t) ->
      ( ( (((value.ticket, value.revision), value.enabled), value.reviewers)
        , value.separate_actor )
      , value.validators ))
;;

let submission_state =
  let pending =
    obj
      (req "kind" (Api_codec.literal "pending"))
      ~decode:(fun () -> Submission.State.Pending)
      ~encode:(function
        | Submission.State.Pending -> ()
        | Accepted _ | Changes_requested _ -> mismatch ())
  in
  let accepted =
    obj
      (req "kind" (Api_codec.literal "accepted") <*> req "attribution" attribution)
      ~decode:(fun ((), a) -> Submission.State.Accepted a)
      ~encode:(function
        | Submission.State.Accepted a -> (), a
        | Pending | Changes_requested _ -> mismatch ())
  in
  let changed =
    obj
      (req "kind" (Api_codec.literal "changes_requested")
       <*> req "attribution" attribution)
      ~decode:(fun ((), a) -> Submission.State.Changes_requested a)
      ~encode:(function
        | Submission.State.Changes_requested a -> (), a
        | Pending | Accepted _ -> mismatch ())
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:[ "pending", pending; "accepted", accepted; "changes_requested", changed ]
    ~select:(function
      | Submission.State.Pending -> "pending"
      | Accepted _ -> "accepted"
      | Changes_requested _ -> "changes_requested")
;;

let verdict =
  Api_codec.enum
    [ "approve", Review.Verdict.Approve
    ; "request_changes", Review.Verdict.Request_changes
    ]
    ~equal:Review.Verdict.equal
;;

let submission : Submission.t Api_codec.t =
  obj
    (req "ticket_id" ticket_id
     <*> req "revision" positive
     <*> req "generation" positive
     <*> req "manifest" manifest_ref
     <*> req "contract" contract_ref
     <*> req "policy_binding" Acceptance_policy.Effective.Binding.codec
     <*> req "author" attribution
     <*> req
           "review_request_id"
           (nullable
              (id Communication_id.Request.of_string Communication_id.Request.to_string))
     <*> req "state" submission_state)
    ~decode:
      (fun
        ( ( ( (((((ticket, revision), generation), manifest), contract), policy_binding)
            , author )
          , review_request )
        , state ) ->
      { Submission.ticket
      ; revision
      ; generation
      ; manifest
      ; contract
      ; policy_binding
      ; author
      ; review_request
      ; state
      })
    ~encode:(fun (value : Submission.t) ->
      ( ( ( ( ( (((value.ticket, value.revision), value.generation), value.manifest)
              , value.contract )
            , value.policy_binding )
          , value.author )
        , value.review_request )
      , value.state ))
;;

let review : Review.t Api_codec.t =
  obj
    (req "review_id" (id Evidence_id.Review.of_string Evidence_id.Review.to_string)
     <*> req "serial" positive
     <*> req "ticket_id" ticket_id
     <*> req "generation" positive
     <*> req "manifest" manifest_ref
     <*> req "contract" contract_ref
     <*> req "policy_binding" Acceptance_policy.Effective.Binding.codec
     <*> req "reviewer" attribution
     <*> req "verdict" verdict
     <*> req "evidence" (nonblank_codec 65_536)
     <*> req "comment_id" (nullable comment_id))
    ~decode:
      (fun
        ( ( ( ( ( (((((id, serial), ticket), generation), manifest), contract)
                , policy_binding )
              , reviewer )
            , verdict )
          , evidence )
        , comment ) ->
      { Review.id
      ; serial
      ; ticket
      ; generation
      ; manifest
      ; contract
      ; policy_binding
      ; reviewer
      ; verdict
      ; evidence
      ; comment
      })
    ~encode:(fun (value : Review.t) ->
      ( ( ( ( ( ( ( (((value.id, value.serial), value.ticket), value.generation)
                  , value.manifest )
                , value.contract )
              , value.policy_binding )
            , value.reviewer )
          , value.verdict )
        , value.evidence )
      , value.comment ))
;;

let validation : Validation.t Api_codec.t =
  obj
    (req
       "validation_id"
       (id Evidence_id.Validation.of_string Evidence_id.Validation.to_string)
     <*> req "serial" positive
     <*> req "manifest" manifest_ref
     <*> req "contract" contract_ref
     <*> req "policy_binding" Acceptance_policy.Effective.Binding.codec
     <*> req "name" name
     <*> req "passed" Api_codec.boolean
     <*> req "evidence" (nonblank_codec 65_536)
     <*> req "attribution" attribution)
    ~decode:
      (fun
        ( ( ((((((id, serial), manifest), contract), policy_binding), name), passed)
          , evidence )
        , attribution ) ->
      { Validation.id
      ; serial
      ; manifest
      ; contract
      ; policy_binding
      ; name
      ; passed
      ; evidence
      ; attribution
      })
    ~encode:(fun (value : Validation.t) ->
      ( ( ( ( ( (((value.id, value.serial), value.manifest), value.contract)
              , value.policy_binding )
            , value.name )
          , value.passed )
        , value.evidence )
      , value.attribution ))
;;

let decision : Decision.t Api_codec.t =
  obj
    (req "decision_id" decision_id
     <*> req "revision" positive
     <*> req "scope" entity_ref
     <*> req "title" (nonblank_codec 512)
     <*> req "rationale" pin
     <*> req "evidence" (many pin)
     <*> req "affected" (many entity_ref)
     <*> req "supersedes" (many decision_id)
     <*> req "attribution" attribution)
    ~decode:
      (fun
        ( ( ((((((id, revision), scope), title), rationale), evidence), affected)
          , supersedes )
        , attribution ) ->
      { Decision.id
      ; revision
      ; scope
      ; title
      ; rationale
      ; evidence
      ; affected
      ; supersedes
      ; attribution
      })
    ~encode:(fun (value : Decision.t) ->
      ( ( ( ( ((((value.id, value.revision), value.scope), value.title), value.rationale)
            , value.evidence )
          , value.affected )
        , value.supersedes )
      , value.attribution ))
;;

let reconciliation_state =
  let pending =
    obj
      (req "kind" (Api_codec.literal "pending"))
      ~decode:(fun () -> Reconciliation.State.Pending)
      ~encode:(function
        | Reconciliation.State.Pending -> ()
        | Acknowledged _ | Continued _ | Revised _ -> mismatch ())
  in
  let acknowledged =
    obj
      (req "kind" (Api_codec.literal "acknowledged") <*> req "attribution" attribution)
      ~decode:(fun ((), a) -> Reconciliation.State.Acknowledged a)
      ~encode:(function
        | Reconciliation.State.Acknowledged a -> (), a
        | Pending | Continued _ | Revised _ -> mismatch ())
  in
  let continued =
    obj
      (req "kind" (Api_codec.literal "continued")
       <*> req "attribution" attribution
       <*> req "reason" (nonblank_codec 65_536))
      ~decode:(fun (((), attribution), reason) ->
        Reconciliation.State.Continued { attribution; reason })
      ~encode:(function
        | Reconciliation.State.Continued { attribution; reason } ->
          ((), attribution), reason
        | Pending | Acknowledged _ | Revised _ -> mismatch ())
  in
  let revised =
    obj
      (req "kind" (Api_codec.literal "revised")
       <*> req "attribution" attribution
       <*> req "manifest" manifest_ref)
      ~decode:(fun (((), attribution), manifest) ->
        Reconciliation.State.Revised { attribution; manifest })
      ~encode:(function
        | Reconciliation.State.Revised { attribution; manifest } ->
          ((), attribution), manifest
        | Pending | Acknowledged _ | Continued _ -> mismatch ())
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ "pending", pending
      ; "acknowledged", acknowledged
      ; "continued", continued
      ; "revised", revised
      ]
    ~select:(function
      | Reconciliation.State.Pending -> "pending"
      | Acknowledged _ -> "acknowledged"
      | Continued _ -> "continued"
      | Revised _ -> "revised")
;;

let reconciliation : Reconciliation.t Api_codec.t =
  obj
    (req "serial" positive
     <*> req "revision" positive
     <*> req "attempt_id" attempt_id
     <*> req "ticket_id" ticket_id
     <*> req "previous" pin
     <*> req "current" pin
     <*> req "state" reconciliation_state)
    ~decode:
      (fun
        ((((((serial, revision), attempt), ticket), previous), current), state) ->
      { Reconciliation.serial; revision; attempt; ticket; previous; current; state })
    ~encode:(fun (value : Reconciliation.t) ->
      ( ( ((((value.serial, value.revision), value.attempt), value.ticket), value.previous)
        , value.current )
      , value.state ))
;;

let checked codec validate description =
  Api_codec.map
    codec
    ~decode:(fun value ->
      Json.decode (fun () ->
        validate value;
        value))
    ~encode:Fn.id
    ~description
;;

let unique_names values =
  require
    (not (List.contains_dup values ~compare:String.compare))
    "duplicate requirement name"
;;

let contract =
  checked
    contract
    (fun c ->
       require (c.Contract.schema_version = 1) "unsupported contract schema";
       unique_names c.required_inputs;
       unique_names c.required_outputs)
    "Current contract with unique required names."
;;

let manifest =
  checked
    manifest
    (fun m ->
       require (m.Manifest.schema_version = 1) "unsupported manifest schema";
       unique_names (List.map m.inputs ~f:(fun a -> a.Evidence_event.Artifact.name));
       unique_names (List.map m.outputs ~f:(fun a -> a.Evidence_event.Artifact.name)))
    "Current exact manifest with unique input and output names."
;;

let submission =
  checked
    submission
    (fun s ->
       require
         (Id.Ticket.equal
            s.Submission.ticket
            (Acceptance_policy.Effective.Binding.ticket_id s.policy_binding))
         "submission policy ticket differs")
    "Submission with a matching effective policy ticket."
;;

let review =
  checked
    review
    (fun r ->
       require
         (Id.Ticket.equal
            r.Review.ticket
            (Acceptance_policy.Effective.Binding.ticket_id r.policy_binding))
         "review policy ticket differs")
    "Review with a matching effective policy ticket."
;;
