open Core
module F = Api_codec.Fields

let ( ++ ) = F.both
let id of_string to_string = Coordination_wire.id of_string to_string
let actor = id Id.Actor.of_string Id.Actor.to_string
let run = id Id.Run.of_string Id.Run.to_string
let ticket = id Id.Ticket.of_string Id.Ticket.to_string
let comment = id Id.Comment.of_string Id.Comment.to_string
let resource_id = id Id.Resource.of_string Id.Resource.to_string
let positive = Coordination_wire.positive
let counter = Coordination_wire.counter
let text = Api_codec.text ~max_bytes:65536
let timestamp = Api_codec.text ~max_bytes:128
let nullable = Api_codec.nullable
let list codec = Api_codec.list codec ~max_items:100000
let wrong () = Json.fail Invalid_argument "wrong historical change constructor"

let version =
  Api_codec.map
    positive
    ~decode:(fun n ->
      if n = 1
      then Ok n
      else Error (Problem.create Unsupported_version "unsupported family event version"))
    ~encode:Fn.id
    ~description:"Current family event version one."
;;

let facts = Facts.Change.codec

let discussion_kind =
  Api_codec.enum
    [ "comment", Discussion.Kind.Comment
    ; "progress", Progress
    ; "decision", Decision
    ; "blocker", Blocker
    ; "evidence", Evidence
    ]
    ~equal:Discussion.Kind.equal
;;

let discussion_origin =
  Api_codec.enum
    [ "authored", Discussion.Origin.Authored; "completion", Completion ]
    ~equal:Discussion.Origin.equal
;;

let comment_version =
  Api_codec.object_
    (F.map
       (F.required "revision" positive
        ++ F.required "serial" positive
        ++ F.required "sequence" positive
        ++ F.required "actor_id" actor
        ++ F.required "timestamp" timestamp
        ++ F.required "body" text
        ++ F.required "tombstone" Api_codec.boolean)
       ~decode:
         (fun
           ((((((revision, serial), sequence), actor_id), timestamp), body), tombstone) ->
         ({ revision; serial; sequence; actor = actor_id; timestamp; body; tombstone }
          : Discussion.Version.t))
       ~encode:(fun (value : Discussion.Version.t) ->
         ( ( ( (((value.revision, value.serial), value.sequence), value.actor)
             , value.timestamp )
           , value.body )
         , value.tombstone )))
;;

let comment_version =
  Api_codec.map
    comment_version
    ~decode:(fun value ->
      Json.decode (fun () ->
        if value.tombstone && not (String.is_empty value.body)
        then Json.fail Invalid_argument "tombstone body must be empty";
        value))
    ~encode:Fn.id
    ~description:"Actual typed family invariants."
;;

let discussion : Discussion.Change.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Discussion.Change.Create _ -> "create"
      | Discussion.Change.Revise _ -> "revise")
    ~cases:
      [ ( "create"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "create")
                ++ F.required "comment_id" comment
                ++ F.required "target" Evidence_wire.entity_ref
                ++ F.required "reply_to_comment_id" (nullable comment)
                ++ F.required "comment_kind" discussion_kind
                ++ F.required "origin" discussion_origin
                ++ F.required "version" comment_version)
               ~decode:
                 (fun
                   ( ( (((((), comment_id), target), reply_to_comment_id), comment_kind)
                     , origin )
                   , version ) ->
                 Discussion.Change.Create
                   { id = comment_id
                   ; target
                   ; reply_to = reply_to_comment_id
                   ; kind = comment_kind
                   ; origin
                   ; version
                   })
               ~encode:(function
                 | Discussion.Change.Create
                     { id = comment_id
                     ; target
                     ; reply_to = reply_to_comment_id
                     ; kind = comment_kind
                     ; origin
                     ; version
                     } ->
                   ( ( (((((), comment_id), target), reply_to_comment_id), comment_kind)
                     , origin )
                   , version )
                 | _ -> wrong ())) )
      ; ( "revise"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "revise")
                ++ F.required "comment_id" comment
                ++ F.required "version" comment_version)
               ~decode:(fun (((), comment_id), version) ->
                 Discussion.Change.Revise { id = comment_id; version })
               ~encode:(function
                 | Discussion.Change.Revise { id = comment_id; version } ->
                   ((), comment_id), version
                 | _ -> wrong ())) )
      ]
;;

let resource : Resource.Change.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Resource.Change.Published _ -> "published"
      | Resource.Change.Metadata_changed _ -> "metadata_changed")
    ~cases:
      [ ( "published"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "published")
                ++ F.required "resource_id" resource_id
                ++ F.required "revision" positive
                ++ F.required "metadata" Resource_wire.metadata
                ++ F.required "version" Resource_wire.version)
               ~decode:(fun (((((), resource_id), revision), metadata), version) ->
                 Resource.Change.Published
                   { id = resource_id; revision; metadata; version })
               ~encode:(function
                 | Resource.Change.Published
                     { id = resource_id; revision; metadata; version } ->
                   ((((), resource_id), revision), metadata), version
                 | _ -> wrong ())) )
      ; ( "metadata_changed"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "metadata_changed")
                ++ F.required "resource_id" resource_id
                ++ F.required "revision" positive
                ++ F.required "metadata" Resource_wire.metadata)
               ~decode:(fun ((((), resource_id), revision), metadata) ->
                 Resource.Change.Metadata_changed { id = resource_id; revision; metadata })
               ~encode:(function
                 | Resource.Change.Metadata_changed
                     { id = resource_id; revision; metadata } ->
                   (((), resource_id), revision), metadata
                 | _ -> wrong ())) )
      ]
;;

let actor_snapshot =
  Api_codec.map
    Planning_wire.Actor.codec
    ~decode:(fun (value : Planning_wire.Actor.t) ->
      Ok
        ({ id = value.actor_id
         ; name = value.name
         ; kind = value.kind
         ; revision = value.revision
         ; archived = value.archived
         }
         : Workflow.Actor.t))
    ~encode:Planning_wire.Actor.of_domain
    ~description:"Exact retained workflow record."
;;

let label_snapshot =
  Api_codec.map
    Planning_wire.Label.codec
    ~decode:(fun (value : Planning_wire.Label.t) ->
      Ok
        ({ id = value.label_id
         ; name = value.name
         ; description = value.description
         ; revision = value.revision
         ; archived = value.archived
         }
         : Workflow.Label.t))
    ~encode:Planning_wire.Label.of_domain
    ~description:"Exact retained workflow record."
;;

let status_snapshot =
  Api_codec.map
    Planning_wire.Status.codec
    ~decode:(fun (value : Planning_wire.Status.t) ->
      Ok
        ({ id = value.status_id
         ; name = value.name
         ; category = value.category
         ; revision = value.revision
         ; archived = value.archived
         }
         : Workflow.Status.t))
    ~encode:Planning_wire.Status.of_domain
    ~description:"Exact retained workflow record."
;;

let workflow : Workflow.Change.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Workflow.Change.Actor _ -> "actor"
      | Workflow.Change.Label _ -> "label"
      | Workflow.Change.Status _ -> "status")
    ~cases:
      [ ( "actor"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "actor")
                ++ F.required "actor" actor_snapshot)
               ~decode:(fun ((), value) -> Workflow.Change.Actor value)
               ~encode:(function
                 | Workflow.Change.Actor value -> (), value
                 | _ -> wrong ())) )
      ; ( "label"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "label")
                ++ F.required "label" label_snapshot)
               ~decode:(fun ((), value) -> Workflow.Change.Label value)
               ~encode:(function
                 | Workflow.Change.Label value -> (), value
                 | _ -> wrong ())) )
      ; ( "status"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "status")
                ++ F.required "status" status_snapshot)
               ~decode:(fun ((), value) -> Workflow.Change.Status value)
               ~encode:(function
                 | Workflow.Change.Status value -> (), value
                 | _ -> wrong ())) )
      ]
;;

let policy_command : Agent_run_policy_command.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Agent_run_policy_command.Template_register _ -> "template_register"
      | Agent_run_policy_command.Instance_register _ -> "instance_register"
      | Agent_run_policy_command.Budget_put _ -> "budget_put"
      | Agent_run_policy_command.Usage_report _ -> "usage_report")
    ~cases:
      [ ( "template_register"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "template_register")
                ++ F.required "template" Workflow_template_wire.template)
               ~decode:(fun ((), value) ->
                 Agent_run_policy_command.Template_register value)
               ~encode:(function
                 | Agent_run_policy_command.Template_register value -> (), value
                 | _ -> wrong ())) )
      ; ( "instance_register"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "instance_register")
                ++ F.required "instance" Workflow_template_wire.instance)
               ~decode:(fun ((), value) ->
                 Agent_run_policy_command.Instance_register value)
               ~encode:(function
                 | Agent_run_policy_command.Instance_register value -> (), value
                 | _ -> wrong ())) )
      ; ( "budget_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "budget_put")
                ++ F.required "budget" Agent_run_policy_api.budget)
               ~decode:(fun ((), value) -> Agent_run_policy_command.Budget_put value)
               ~encode:(function
                 | Agent_run_policy_command.Budget_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "usage_report"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "usage_report")
                ++ F.required "usage" Usage_record_wire.record)
               ~decode:(fun ((), value) -> Agent_run_policy_command.Usage_report value)
               ~encode:(function
                 | Agent_run_policy_command.Usage_report value -> (), value
                 | _ -> wrong ())) )
      ]
;;

let policy =
  Api_codec.object_
    (F.map
       (F.required "revision" counter ++ F.required "command" policy_command)
       ~decode:(fun (revision, command) ->
         ({ revision; command } : Agent_run_policy.Change.t))
       ~encode:(fun (value : Agent_run_policy.Change.t) -> value.revision, value.command))
;;

let evidence_update : Evidence_event.Update.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Evidence_event.Update.Contract_put _ -> "contract_put"
      | Evidence_event.Update.Manifest_put _ -> "manifest_put"
      | Evidence_event.Update.Policy_put _ -> "policy_put"
      | Evidence_event.Update.Assertion_added _ -> "assertion_added"
      | Evidence_event.Update.Submission_put _ -> "submission_put"
      | Evidence_event.Update.Review_added _ -> "review_added"
      | Evidence_event.Update.Validation_added _ -> "validation_added"
      | Evidence_event.Update.Decision_put _ -> "decision_put"
      | Evidence_event.Update.Input_changed _ -> "input_changed"
      | Evidence_event.Update.Reconciliation_put _ -> "reconciliation_put")
    ~cases:
      [ ( "contract_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "contract_put")
                ++ F.required "contract" Evidence_wire.contract)
               ~decode:(fun ((), value) -> Evidence_event.Update.Contract_put value)
               ~encode:(function
                 | Evidence_event.Update.Contract_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "manifest_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "manifest_put")
                ++ F.required "manifest" Evidence_wire.manifest)
               ~decode:(fun ((), value) -> Evidence_event.Update.Manifest_put value)
               ~encode:(function
                 | Evidence_event.Update.Manifest_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "policy_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "policy_put")
                ++ F.required "policy" Evidence.policy_version_codec)
               ~decode:(fun ((), value) -> Evidence_event.Update.Policy_put value)
               ~encode:(function
                 | Evidence_event.Update.Policy_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "assertion_added"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "assertion_added")
                ++ F.required "assertion" Evidence.assertion_codec)
               ~decode:(fun ((), value) -> Evidence_event.Update.Assertion_added value)
               ~encode:(function
                 | Evidence_event.Update.Assertion_added value -> (), value
                 | _ -> wrong ())) )
      ; ( "submission_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "submission_put")
                ++ F.required "submission" Evidence_wire.submission)
               ~decode:(fun ((), value) -> Evidence_event.Update.Submission_put value)
               ~encode:(function
                 | Evidence_event.Update.Submission_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "review_added"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "review_added")
                ++ F.required "review" Evidence_wire.review
                ++ F.required "submission" Evidence_wire.submission)
               ~decode:(fun (((), review), submission) ->
                 Evidence_event.Update.Review_added { review; submission })
               ~encode:(function
                 | Evidence_event.Update.Review_added { review; submission } ->
                   ((), review), submission
                 | _ -> wrong ())) )
      ; ( "validation_added"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "validation_added")
                ++ F.required "validation" Evidence.validation_codec)
               ~decode:(fun ((), value) -> Evidence_event.Update.Validation_added value)
               ~encode:(function
                 | Evidence_event.Update.Validation_added value -> (), value
                 | _ -> wrong ())) )
      ; ( "decision_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "decision_put")
                ++ F.required "decision" Evidence_wire.decision)
               ~decode:(fun ((), value) -> Evidence_event.Update.Decision_put value)
               ~encode:(function
                 | Evidence_event.Update.Decision_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "input_changed"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "input_changed")
                ++ F.required "previous" Evidence_wire.pin
                ++ F.required "current" Evidence_wire.pin)
               ~decode:(fun (((), previous), current) ->
                 Evidence_event.Update.Input_changed { previous; current })
               ~encode:(function
                 | Evidence_event.Update.Input_changed { previous; current } ->
                   ((), previous), current
                 | _ -> wrong ())) )
      ; ( "reconciliation_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "reconciliation_put")
                ++ F.required "reconciliation" Evidence_wire.reconciliation)
               ~decode:(fun ((), value) -> Evidence_event.Update.Reconciliation_put value)
               ~encode:(function
                 | Evidence_event.Update.Reconciliation_put value -> (), value
                 | _ -> wrong ())) )
      ]
;;

let evidence =
  Api_codec.object_
    (F.map
       (F.required "version" version
        ++ F.required "revision" positive
        ++ F.required "sequence" positive
        ++ F.required "attribution" Evidence_wire.attribution
        ++ F.required "update" evidence_update
        ++ F.required "reconciliations" (list Evidence_wire.reconciliation))
       ~decode:
         (fun
           (((((version, revision), sequence), attribution), update), reconciliations) ->
         ({ version; revision; sequence; attribution; update; reconciliations }
          : Evidence_event.t))
       ~encode:(fun (value : Evidence_event.t) ->
         ( ( (((value.version, value.revision), value.sequence), value.attribution)
           , value.update )
         , value.reconciliations )))
;;

let external_condition : External_condition.Change.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | External_condition.Change.Put _ -> "put"
      | External_condition.Change.Signal _ -> "signal")
    ~cases:
      [ ( "put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "put")
                ++ F.required "declaration" External_condition.Declaration.codec)
               ~decode:(fun ((), value) -> External_condition.Change.Put value)
               ~encode:(function
                 | External_condition.Change.Put value -> (), value
                 | _ -> wrong ())) )
      ; ( "signal"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "signal")
                ++ F.required "signal" External_condition.Signal.codec)
               ~decode:(fun ((), value) -> External_condition.Change.Signal value)
               ~encode:(function
                 | External_condition.Change.Signal value -> (), value
                 | _ -> wrong ())) )
      ]
;;

let recovery_snapshot : Agent_run_event.Recovery_snapshot.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Agent_run_event.Recovery_snapshot.Named _ -> "named"
      | Agent_run_event.Recovery_snapshot.Path _ -> "path")
    ~cases:
      [ ( "named"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "named")
                ++ F.required "reservation" Agent_run_wire.reservation)
               ~decode:(fun ((), value) -> Agent_run_event.Recovery_snapshot.Named value)
               ~encode:(function
                 | Agent_run_event.Recovery_snapshot.Named value -> (), value
                 | _ -> wrong ())) )
      ; ( "path"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "path")
                ++ F.required "reservation" Agent_coordination_api.path_reservation_codec
               )
               ~decode:(fun ((), value) -> Agent_run_event.Recovery_snapshot.Path value)
               ~encode:(function
                 | Agent_run_event.Recovery_snapshot.Path value -> (), value
                 | _ -> wrong ())) )
      ]
;;

let agent_update : Agent_run_event.Update.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Agent_run_event.Update.Pool_put _ -> "pool_put"
      | Agent_run_event.Update.Ticket_policy_put _ -> "ticket_policy_put"
      | Agent_run_event.Update.Run_put _ -> "run_put"
      | Agent_run_event.Update.Attempt_started _ -> "attempt_started"
      | Agent_run_event.Update.Attempt_put _ -> "attempt_put"
      | Agent_run_event.Update.Reservation_put _ -> "reservation_put"
      | Agent_run_event.Update.Path_reservation_put _ -> "path_reservation_put"
      | Agent_run_event.Update.Ticket_paths_put _ -> "ticket_paths_put"
      | Agent_run_event.Update.External_condition_changed _ ->
        "external_condition_changed"
      | Agent_run_event.Update.Ownership_recovered _ -> "ownership_recovered"
      | Agent_run_event.Update.Actions_set _ -> "actions_set")
    ~cases:
      [ ( "pool_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "pool_put")
                ++ F.required "pool" Agent_run_wire.pool)
               ~decode:(fun ((), value) -> Agent_run_event.Update.Pool_put value)
               ~encode:(function
                 | Agent_run_event.Update.Pool_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "ticket_policy_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "ticket_policy_put")
                ++ F.required "policy" Agent_run_wire.ticket_policy)
               ~decode:(fun ((), value) -> Agent_run_event.Update.Ticket_policy_put value)
               ~encode:(function
                 | Agent_run_event.Update.Ticket_policy_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "run_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "run_put")
                ++ F.required "run" Agent_run_wire.run)
               ~decode:(fun ((), value) -> Agent_run_event.Update.Run_put value)
               ~encode:(function
                 | Agent_run_event.Update.Run_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "attempt_started"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "attempt_started")
                ++ F.required "attempt" Agent_run_wire.attempt
                ++ F.required "now_unix_ms" (Api_codec.decimal64 ~max:Int64.max_value))
               ~decode:(fun (((), attempt), now_unix_ms) ->
                 Agent_run_event.Update.Attempt_started { attempt; now_unix_ms })
               ~encode:(function
                 | Agent_run_event.Update.Attempt_started { attempt; now_unix_ms } ->
                   ((), attempt), now_unix_ms
                 | _ -> wrong ())) )
      ; ( "attempt_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "attempt_put")
                ++ F.required "attempt" Agent_run_wire.attempt)
               ~decode:(fun ((), value) -> Agent_run_event.Update.Attempt_put value)
               ~encode:(function
                 | Agent_run_event.Update.Attempt_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "reservation_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "reservation_put")
                ++ F.required "reservation" Agent_run_wire.reservation)
               ~decode:(fun ((), value) -> Agent_run_event.Update.Reservation_put value)
               ~encode:(function
                 | Agent_run_event.Update.Reservation_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "path_reservation_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "path_reservation_put")
                ++ F.required "reservation" Agent_coordination_api.path_reservation_codec
               )
               ~decode:(fun ((), value) ->
                 Agent_run_event.Update.Path_reservation_put value)
               ~encode:(function
                 | Agent_run_event.Update.Path_reservation_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "ticket_paths_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "ticket_paths_put")
                ++ F.required "paths" Ticket_paths.codec)
               ~decode:(fun ((), value) -> Agent_run_event.Update.Ticket_paths_put value)
               ~encode:(function
                 | Agent_run_event.Update.Ticket_paths_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "external_condition_changed"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "external_condition_changed")
                ++ F.required "change" external_condition)
               ~decode:(fun ((), value) ->
                 Agent_run_event.Update.External_condition_changed value)
               ~encode:(function
                 | Agent_run_event.Update.External_condition_changed value -> (), value
                 | _ -> wrong ())) )
      ; ( "ownership_recovered"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "ownership_recovered")
                ++ F.required "recovery" Ownership_recovery.codec
                ++ F.required "after" recovery_snapshot)
               ~decode:(fun (((), recovery), after) ->
                 Agent_run_event.Update.Ownership_recovered { recovery; after })
               ~encode:(function
                 | Agent_run_event.Update.Ownership_recovered { recovery; after } ->
                   ((), recovery), after
                 | _ -> wrong ())) )
      ; ( "actions_set"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "actions_set")
                ++ F.required "actions" (list Agent_run_wire.action)
                ++ F.required "evidence" text)
               ~decode:(fun (((), actions), evidence) ->
                 Agent_run_event.Update.Actions_set { actions; evidence })
               ~encode:(function
                 | Agent_run_event.Update.Actions_set { actions; evidence } ->
                   ((), actions), evidence
                 | _ -> wrong ())) )
      ]
;;

let agent_run =
  Api_codec.object_
    (F.map
       (F.required "version" version
        ++ F.required "revision" positive
        ++ F.required "actor_id" actor
        ++ F.required "run_id" (nullable run)
        ++ F.required "timestamp" timestamp
        ++ F.required "sequence" positive
        ++ F.required "update" agent_update)
       ~decode:
         (fun
           ((((((version, revision), actor_id), run_id), timestamp), sequence), update) ->
         ({ version
          ; revision
          ; actor = actor_id
          ; actor_run = run_id
          ; timestamp
          ; sequence
          ; update
          }
          : Agent_run_event.t))
       ~encode:(fun (value : Agent_run_event.t) ->
         ( ( ( (((value.version, value.revision), value.actor), value.actor_run)
             , value.timestamp )
           , value.sequence )
         , value.update )))
;;

let agent_run =
  Api_codec.map
    agent_run
    ~decode:(fun value ->
      Json.decode (fun () ->
        Agent_run_event.validate value;
        value))
    ~encode:Fn.id
    ~description:"Actual typed family invariants."
;;

let communication_attribution = Communication_wire.attribution
let recipient = Communication_recipient.codec
let message_id = id Communication_id.Message.of_string Communication_id.Message.to_string
let team_id = id Communication_id.Team.of_string Communication_id.Team.to_string
let correlation = Coordination_wire.nonblank ~max_bytes:512

let message =
  Api_codec.object_
    (F.map
       (F.required "message_id" message_id
        ++ F.required "revision" positive
        ++ F.required "comment_id" comment
        ++ F.required "comment_revision" positive
        ++ F.required "ticket_id" (nullable ticket)
        ++ F.required "direct_recipients" (Api_codec.list recipient ~max_items:256)
        ++ F.required "team_ids" (Api_codec.list team_id ~max_items:256)
        ++ F.required "recipients" (Api_codec.list recipient ~max_items:2048)
        ++ F.required "reply_to_message_id" (nullable message_id)
        ++ F.required "correlation_id" (nullable correlation)
        ++ F.required "created" communication_attribution)
       ~decode:
         (fun
           ( ( ( ( ( ( ( (((message_id, revision), comment_id), comment_revision)
                       , ticket_id )
                     , direct_recipients )
                   , team_ids )
                 , recipients )
               , reply_to_message_id )
             , correlation_id )
           , created ) ->
         ({ message_id
          ; revision
          ; comment_id
          ; comment_revision
          ; ticket_id
          ; direct_recipients
          ; teams = team_ids
          ; recipients
          ; reply_to_message_id
          ; correlation_id
          ; created
          }
          : Communication_event.Message.t))
       ~encode:(fun (value : Communication_event.Message.t) ->
         ( ( ( ( ( ( ( ( ((value.message_id, value.revision), value.comment_id)
                       , value.comment_revision )
                     , value.ticket_id )
                   , value.direct_recipients )
                 , value.teams )
               , value.recipients )
             , value.reply_to_message_id )
           , value.correlation_id )
         , value.created )))
;;

let notification_source : Communication_event.Notification.Source.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Communication_event.Notification.Source.Thread _ -> "thread"
      | Communication_event.Notification.Source.Message _ -> "message"
      | Communication_event.Notification.Source.Request _ -> "request")
    ~cases:
      [ ( "thread"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "thread")
                ++ F.required
                     "thread_id"
                     (id
                        Communication_id.Thread.of_string
                        Communication_id.Thread.to_string))
               ~decode:(fun ((), value) ->
                 Communication_event.Notification.Source.Thread value)
               ~encode:(function
                 | Communication_event.Notification.Source.Thread value -> (), value
                 | _ -> wrong ())) )
      ; ( "message"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "message")
                ++ F.required "message_id" message_id)
               ~decode:(fun ((), value) ->
                 Communication_event.Notification.Source.Message value)
               ~encode:(function
                 | Communication_event.Notification.Source.Message value -> (), value
                 | _ -> wrong ())) )
      ; ( "request"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "request")
                ++ F.required
                     "request_id"
                     (id
                        Communication_id.Request.of_string
                        Communication_id.Request.to_string))
               ~decode:(fun ((), value) ->
                 Communication_event.Notification.Source.Request value)
               ~encode:(function
                 | Communication_event.Notification.Source.Request value -> (), value
                 | _ -> wrong ())) )
      ]
;;

let notification =
  Api_codec.object_
    (F.map
       (F.required "notification_id" positive
        ++ F.required "sequence" positive
        ++ F.required "scope" Communication_wire.scope
        ++ F.required "source" notification_source
        ++ F.required "source_revision" positive
        ++ F.required "kind" Communication_wire.kind
        ++ F.required "attribution" communication_attribution
        ++ F.required "recipients" (Api_codec.list recipient ~max_items:2048))
       ~decode:
         (fun
           ( ( (((((notification_id, sequence), scope), source), source_revision), kind)
             , attribution )
           , recipients ) ->
         ({ serial = notification_id
          ; sequence
          ; scope
          ; source
          ; source_revision
          ; kind
          ; attribution
          ; recipients
          }
          : Communication_event.Notification.t))
       ~encode:(fun (value : Communication_event.Notification.t) ->
         ( ( ( ( (((value.serial, value.sequence), value.scope), value.source)
               , value.source_revision )
             , value.kind )
           , value.attribution )
         , value.recipients )))
;;

let communication_update : Communication_event.Update.t Api_codec.t =
  Api_codec.tagged
    ~discriminator:"kind"
    ~select:(function
      | Communication_event.Update.Board_put _ -> "board_put"
      | Communication_event.Update.Message_put _ -> "message_put"
      | Communication_event.Update.Thread_put _ -> "thread_put"
      | Communication_event.Update.Team_put _ -> "team_put"
      | Communication_event.Update.Request_put _ -> "request_put"
      | Communication_event.Update.Subscription_put _ -> "subscription_put"
      | Communication_event.Update.Inbox_ack _ -> "inbox_ack")
    ~cases:
      [ ( "board_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "board_put")
                ++ F.required "board" Communication_wire.board_snapshot)
               ~decode:(fun ((), value) -> Communication_event.Update.Board_put value)
               ~encode:(function
                 | Communication_event.Update.Board_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "message_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "message_put")
                ++ F.required "message" message)
               ~decode:(fun ((), value) -> Communication_event.Update.Message_put value)
               ~encode:(function
                 | Communication_event.Update.Message_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "thread_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "thread_put")
                ++ F.required "thread" Communication_wire.thread_snapshot)
               ~decode:(fun ((), value) -> Communication_event.Update.Thread_put value)
               ~encode:(function
                 | Communication_event.Update.Thread_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "team_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "team_put")
                ++ F.required "team" Communication_wire.team_snapshot)
               ~decode:(fun ((), value) -> Communication_event.Update.Team_put value)
               ~encode:(function
                 | Communication_event.Update.Team_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "request_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "request_put")
                ++ F.required "request" Communication_wire.request_snapshot
                ++ F.required "notification_kind" Communication_wire.kind)
               ~decode:(fun (((), request), notification_kind) ->
                 Communication_event.Update.Request_put
                   { request; kind = notification_kind })
               ~encode:(function
                 | Communication_event.Update.Request_put
                     { request; kind = notification_kind } ->
                   ((), request), notification_kind
                 | _ -> wrong ())) )
      ; ( "subscription_put"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "subscription_put")
                ++ F.required "subscription" Communication_wire.subscription_snapshot)
               ~decode:(fun ((), value) ->
                 Communication_event.Update.Subscription_put value)
               ~encode:(function
                 | Communication_event.Update.Subscription_put value -> (), value
                 | _ -> wrong ())) )
      ; ( "inbox_ack"
        , Api_codec.object_
            (F.map
               (F.required "kind" (Api_codec.literal "inbox_ack")
                ++ F.required
                     "consumer_id"
                     (id
                        Communication_id.Consumer.of_string
                        Communication_id.Consumer.to_string)
                ++ F.required "recipient" recipient
                ++ F.required "notification_ids" (Api_codec.list positive ~max_items:100)
               )
               ~decode:(fun ((((), consumer_id), recipient), notification_ids) ->
                 Communication_event.Update.Inbox_ack
                   { consumer_id; recipient; notification_ids })
               ~encode:(function
                 | Communication_event.Update.Inbox_ack
                     { consumer_id; recipient; notification_ids } ->
                   (((), consumer_id), recipient), notification_ids
                 | _ -> wrong ())) )
      ]
;;

let communication =
  Api_codec.object_
    (F.map
       (F.required "version" version
        ++ F.required "revision" positive
        ++ F.required "sequence" positive
        ++ F.required "attribution" communication_attribution
        ++ F.required "update" communication_update
        ++ F.required "notifications" (list notification))
       ~decode:
         (fun
           (((((version, revision), sequence), attribution), update), notifications) ->
         ({ version; revision; sequence; attribution; update; notifications }
          : Communication_event.t))
       ~encode:(fun (value : Communication_event.t) ->
         ( ( (((value.version, value.revision), value.sequence), value.attribution)
           , value.update )
         , value.notifications )))
;;

let communication =
  Api_codec.map
    communication
    ~decode:(fun (value : Communication_event.t) ->
      Json.decode (fun () ->
        List.iter value.notifications ~f:(fun notification ->
          if
            notification.sequence <> value.sequence
            || not
                 (Communication_event.Attribution.equal
                    notification.attribution
                    value.attribution)
          then
            Json.fail
              Invalid_argument
              "notification source attribution/counter differs from its event");
        let distinct values compare =
          if List.contains_dup values ~compare
          then
            Json.fail
              Invalid_argument
              "duplicate historical recipient or selected identity"
        in
        let recipients values = distinct values Communication_event.Recipient.compare in
        (match value.update with
         | Board_put _ -> ()
         | Message_put message ->
           if
             message.revision <> 1
             || List.is_empty message.recipients
             || (List.is_empty message.direct_recipients && List.is_empty message.teams)
             || not
                  (Communication_event.Attribution.equal
                     message.created
                     value.attribution)
           then Json.fail Invalid_argument "invalid immutable message routing snapshot";
           recipients message.direct_recipients;
           recipients message.recipients;
           distinct message.teams Communication_id.Team.compare;
           if
             not
               (List.for_all message.direct_recipients ~f:(fun recipient ->
                  List.mem
                    message.recipients
                    recipient
                    ~equal:Communication_event.Recipient.equal))
           then
             Json.fail Invalid_argument "direct recipient missing from frozen recipients"
         | Thread_put thread ->
           distinct thread.participants Id.Actor.compare;
           distinct thread.mentions Id.Actor.compare;
           distinct thread.links Entity_ref.compare;
           distinct thread.messages Id.Comment.compare;
           distinct thread.pinned_messages Id.Comment.compare;
           if
             not
               (List.for_all thread.pinned_messages ~f:(fun id ->
                  List.mem thread.messages id ~equal:Id.Comment.equal))
           then Json.fail Invalid_argument "pinned historical message is absent"
         | Team_put team -> recipients team.members
         | Request_put { request; kind = _ } ->
           let deliveries =
             List.map request.deliveries ~f:(fun delivery ->
               delivery.Communication_event.Request.Delivery.recipient)
           in
           recipients deliveries;
           (match request.responsibility with
            | Unaccepted -> ()
            | Accepted { recipient; attribution = _ } ->
              if
                not
                  (List.mem
                     deliveries
                     recipient
                     ~equal:Communication_event.Recipient.equal)
              then
                Json.fail
                  Invalid_argument
                  "responsibility recipient missing from delivery snapshot")
         | Subscription_put subscription ->
           distinct subscription.filter.kinds (fun a b ->
             String.compare
               (Json.canonical
                  (match Api_codec.encode Communication_wire.kind a with
                   | Ok value -> value
                   | Error problem -> raise (Json.Decode_error problem)))
               (Json.canonical
                  (match Api_codec.encode Communication_wire.kind b with
                   | Ok value -> value
                   | Error problem -> raise (Json.Decode_error problem))))
         | Inbox_ack { notification_ids; consumer_id = _; recipient = _ } ->
           if List.is_empty notification_ids
           then Json.fail Invalid_argument "selected acknowledgement IDs must be nonempty";
           distinct notification_ids Int.compare);
        value))
    ~encode:Fn.id
    ~description:
      "Complete immutable communication event; validates source counters, attribution, \
       distinct frozen recipients and selected acknowledgements."
;;

let discussion =
  Api_codec.map
    discussion
    ~decode:(fun value ->
      Json.decode (fun () ->
        (match value with
         | Discussion.Change.Create { target; reply_to; kind; origin; version; id = _ } ->
           if version.revision <> 1 || version.tombstone
           then Json.fail Invalid_argument "invalid initial discussion version";
           (match origin with
            | Authored -> ()
            | Completion ->
              if
                not
                  (Discussion.Kind.equal kind Evidence
                   && Option.is_none reply_to
                   &&
                   match target with
                   | Entity_ref.Ticket _ -> true
                   | _ -> false)
              then Json.fail Invalid_argument "invalid completion discussion origin")
         | Revise { version; id = _ } ->
           if version.revision <= 1
           then
             Json.fail Invalid_argument "discussion revision must follow initial version");
        value))
    ~encode:Fn.id
    ~description:
      "Complete initial or later retained discussion version and actual origin \
       invariants."
;;

let resource =
  Api_codec.map
    resource
    ~decode:(fun value ->
      Json.decode (fun () ->
        let id, metadata =
          match value with
          | Resource.Change.Published { id; revision; metadata; version } ->
            if Option.is_none version.size_bytes || revision < version.revision
            then
              Json.fail
                Invalid_argument
                "publication needs known bytes and valid revision";
            id, metadata
          | Metadata_changed { id; metadata; revision = _ } -> id, metadata
        in
        if List.mem metadata.targets (Entity_ref.Resource id) ~equal:Entity_ref.equal
        then Json.fail Invalid_argument "resource cannot target itself";
        value))
    ~encode:Fn.id
    ~description:
      "Complete retained resource metadata/version, known publication bytes and actual \
       self-link invariant."
;;
