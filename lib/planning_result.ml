open Core
module Fields = Api_codec.Fields

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let text = Api_codec.text ~max_bytes:65_536
let decimal = Api_codec.decimal ~max:Int.max_value
let decimal64 = Api_codec.decimal64 ~max:Int64.max_value
let boolean = Api_codec.boolean

let identifier =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:(fun value -> Result.map (Id.Actor.of_string value) ~f:(fun _ -> value))
    ~encode:Fn.id
    ~description:"Resolved opaque entity ID."
;;

let identifiers = Api_codec.list identifier ~max_items:100_000

let status =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

let field name codec =
  Fields.map
    (Fields.required name codec)
    ~decode:(fun value -> [ name, unwrap (Api_codec.encode codec value) ])
    ~encode:(fun fields ->
      unwrap (Api_codec.decode codec (Json.field (`Object fields) name)))
;;

let record fields =
  let fields =
    List.fold
      fields
      ~init:(Fields.map Fields.empty ~decode:(fun () -> []) ~encode:(fun _ -> ()))
      ~f:(fun previous next ->
        Fields.map
          (Fields.both previous next)
          ~decode:(fun (left, right) -> left @ right)
          ~encode:(fun fields -> fields, fields))
  in
  Api_codec.map
    (Api_codec.object_ fields)
    ~decode:(fun fields -> Ok (`Object fields))
    ~encode:(function
      | `Object fields -> fields
      | _ -> Json.fail Invalid_argument "expected receipt object")
    ~description:"Exact planning mutation receipt."
;;

let revision = record [ field "revision" decimal ]
let entity_revision key = record [ field key identifier; field "revision" decimal ]

let workspace =
  record
    [ field "description" text
    ; field "instructions" text
    ; field "summary" text
    ; field "revision" decimal
    ; field "name" (Api_codec.nullable text)
    ; field "archived" boolean
    ]
;;

let project = Api_codec.as_json Planning_wire.Project.codec
let milestone = Api_codec.as_json Planning_wire.Milestone.codec
let lease = Api_codec.as_json Planning_ticket_wire.Lease.codec
let claim = record [ field "ticket_id" identifier; field "token" decimal ]
let ownership = Api_codec.as_json Planning_ticket_wire.Ownership.codec
let ticket = Api_codec.as_json Planning_ticket_wire.Ticket.codec
let handoff = Api_codec.as_json Planning_ticket_wire.Handoff.codec
let resource_version = Api_codec.as_json Resource_wire.version

let actor =
  record
    [ field "actor_id" identifier
    ; field "name" text
    ; field
        "kind"
        (Api_codec.enum
           [ "person", Workflow.Actor.Person; "agent", Agent ]
           ~equal:Workflow.Actor.equal_kind)
    ; field "revision" decimal
    ; field "archived" boolean
    ]
;;

let label =
  record
    [ field "label_id" identifier
    ; field "name" text
    ; field "description" text
    ; field "revision" decimal
    ; field "archived" boolean
    ]
;;

let workflow_status =
  record
    [ field "status_id" identifier
    ; field "name" text
    ; field "category" status
    ; field "revision" decimal
    ; field "archived" boolean
    ]
;;

let settings change =
  let codec, fields =
    match change with
    | Workflow.Change.Actor { id; name; kind; revision; archived } ->
      ( actor
      , [ "actor_id", Id.Actor.jsonaf_of_t id
        ; "name", Json.string name
        ; ( "kind"
          , Json.string
              (match kind with
               | Person -> "person"
               | Agent -> "agent") )
        ; "revision", Json.int revision
        ; ("archived", if archived then `True else `False)
        ] )
    | Label { id; name; description; revision; archived } ->
      ( label
      , [ "label_id", Id.Label.jsonaf_of_t id
        ; "name", Json.string name
        ; "description", Json.string description
        ; "revision", Json.int revision
        ; ("archived", if archived then `True else `False)
        ] )
    | Status { id; name; category; revision; archived } ->
      ( workflow_status
      , [ "status_id", Id.Status.jsonaf_of_t id
        ; "name", Json.string name
        ; "category", Workflow.Category.jsonaf_of_t category
        ; "revision", Json.int revision
        ; ("archived", if archived then `True else `False)
        ] )
  in
  Api_codec.encode codec (Json.obj fields)
;;

let claim_next =
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "empty"
        , record [ field "kind" (Api_codec.enum [ "empty", () ] ~equal:Unit.equal) ] )
      ; ( "selected"
        , record
            [ field "kind" (Api_codec.enum [ "selected", () ] ~equal:Unit.equal)
            ; field "claim" claim
            ; field "attempt" revision
            ] )
      ]
    ~select:(fun json -> Json.text (Json.field json "kind"))
;;

let thread = Communication_wire.thread

module Template = struct
  let json_boolean value = if value then `True else `False

  module Kind = struct
    type t =
      | Ticket_create
      | Dependency_add
      | Ticket_policy_put
      | Review_policy_put
      | Instance_register

    let name = function
      | Ticket_create -> "ticket_create"
      | Dependency_add -> "dependency_add"
      | Ticket_policy_put -> "ticket_policy_put"
      | Review_policy_put -> "review_policy_put"
      | Instance_register -> "instance_register"
    ;;
  end

  let select value = Json.text (Json.field value "kind")
  let review_policy_codec = Api_codec.as_json Evidence_wire.policy
  let review_policy policy = Api_codec.encode Evidence_wire.policy policy
  let instance = Api_codec.as_json Workflow_template_wire.instance

  let instance_json plan =
    match Api_codec.encode Workflow_template_wire.instance plan with
    | Ok json -> json
    | Error problem -> raise (Json.Decode_error problem)
  ;;

  let registration = record [ field "revision" decimal; field "duplicate" boolean ]

  let receipts =
    [ Kind.Ticket_create, ticket
    ; Dependency_add, record [ field "ticket_id" identifier ]
    ; Ticket_policy_put, revision
    ; Review_policy_put, review_policy_codec
    ; Instance_register, registration
    ]
  ;;

  let operations =
    List.map receipts ~f:(fun (kind, codec) ->
      let name = Kind.name kind in
      name, record [ field "kind" (Api_codec.literal name); field "data" codec ])
  ;;

  let operation_codec = Api_codec.tagged ~discriminator:"kind" ~cases:operations ~select

  let codec =
    record
      [ field "instance" instance
      ; field "results" (Api_codec.list operation_codec ~max_items:32)
      ; field "duplicate" boolean
      ]
  ;;

  let operation kind ~data =
    Api_codec.encode
      operation_codec
      (Json.obj [ "kind", Json.string (Kind.name kind); "data", data ])
  ;;

  let create plan ~results ~duplicate =
    Api_codec.encode
      codec
      (Json.obj
         [ "instance", instance_json plan
         ; "results", `Array results
         ; "duplicate", json_boolean duplicate
         ])
  ;;
end

let codec ~method_ =
  match method_ with
  | "template.instantiate" -> Some Template.codec
  | "actor.put" -> Some actor
  | "label.put" -> Some label
  | "status.put" -> Some workflow_status
  | "workspace.update" | "workspace.archive" -> Some workspace
  | "project.create" | "project.update" | "project.archive" -> Some project
  | "milestone.create" | "milestone.update" | "milestone.archive" | "milestone.schedule"
    -> Some milestone
  | "ticket.create" -> Some ticket
  | "ticket.metadata"
  | "ticket.hold"
  | "dependency.waive"
  | "resource.update"
  | "resource.archive"
  | "resource.link"
  | "resource.unlink" -> Some revision
  | "ticket.update" -> Some (entity_revision "ticket_id")
  | "ticket.move" -> Some (record [ field "moved" decimal ])
  | "ticket.archive" -> Some (record [ field "archived" boolean ])
  | "dependency.add" | "dependency.remove" ->
    Some (record [ field "ticket_id" identifier ])
  | "related.add" | "related.remove" ->
    Some (record [ field "ticket_revision" decimal; field "related_revision" decimal ])
  | "ticket.reassign" -> Some (record [ field "token" (Api_codec.nullable decimal) ])
  | "ticket.claim" -> Some claim
  | "ticket.claim_next" -> Some claim_next
  | "thread.reply" ->
    Some (record [ field "comment_id" identifier; field "thread" thread ])
  | "ticket.renew_lease" ->
    Some (record [ field "ticket_id" identifier; field "lease" lease ])
  | "ticket.release" -> Some (record [ field "released" boolean ])
  | "ticket.complete" -> Some (record [ field "completed" boolean ])
  | "comment.add" ->
    Some
      (record
         [ field "comment_id" identifier
         ; field "sequence" decimal
         ; field "revision" decimal
         ])
  | "comment.edit" | "comment.tombstone" -> Some (entity_revision "comment_id")
  | "ticket.progress" ->
    Some (record [ field "comment_id" identifier; field "sequence" decimal ])
  | "resource.put_text" ->
    Some
      (record
         [ field "resource_id" identifier
         ; field "revision" decimal
         ; field "version" resource_version
         ])
  | "handoff.set" -> Some handoff
  | _ -> None
;;
