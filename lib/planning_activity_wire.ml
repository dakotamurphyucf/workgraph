open Core
module F = Api_codec.Fields

let ( ++ ) = F.both
let wrong () = Json.fail Invalid_argument "wrong planning audit change constructor"
let run = Coordination_wire.id Id.Run.of_string Id.Run.to_string
let attempt = Coordination_wire.id Attempt.Id.of_string Attempt.Id.to_string

let signal_receipt =
  Api_codec.object_
    (F.map
       (F.required
          "command"
          (Option.value_exn
             (External_condition.Command.codec ~method_:"condition.signal"))
        ++ F.required "original" External_condition.Signal.codec)
       ~decode:(fun (command, original) ->
         ({ command; original } : External_condition.Repeat.t))
       ~encode:(fun (value : External_condition.Repeat.t) ->
         value.command, value.original))
;;

let signal_receipt =
  Api_codec.map
    signal_receipt
    ~decode:(fun (value : External_condition.Repeat.t) ->
      match value.command with
      | External_condition.Command.Put _ ->
        Error (Problem.create Invalid_argument "signal receipt requires a signal command")
      | Signal command ->
        let original = value.original in
        if
          External_condition.Signal_id.equal command.signal_id original.signal_id
          && External_condition.Condition_id.equal
               command.condition_id
               original.condition_id
          && Int.equal command.expected_revision original.condition_revision
          && External_condition.Operation_id.equal
               command.operation_id
               original.operation_id
          && Evidence_event.Pin.equal command.artifact original.artifact
          && List.equal Evidence_event.Pin.equal command.evidence original.evidence
          && String.equal command.summary original.summary
        then Ok value
        else
          Error
            (Problem.create
               Invalid_argument
               "signal receipt command differs from accepted original"))
    ~encode:Fn.id
    ~description:
      "Exact stable signal retry content; the accepted original preserves its original \
       timestamp and sequence."
;;

module Change = struct
  type t =
    | Facts_changed of Facts.Change.t
    | Communication_changed of Communication.Change.t
    | Agent_run_changed of Agent_run_event.t
    | Evidence_changed of Evidence.Change.t
    | Policy_changed of Agent_run_policy.Change.t
    | Policy_unchanged of Agent_run_policy.Change.t
    | Allocation_empty of
        { run_id : Id.Run.t
        ; attempt_id : Attempt.Id.t
        }
    | Ticket_recovered of Ticket_recovery.t
    | Signal_receipt of External_condition.Repeat.t
    | Settings_changed of Workflow.Change.t
    | Workspace_updated of Planning_wire.Workspace_settings.t
    | Project_put of Planning_wire.Project.t
    | Milestone_put of Planning_wire.Milestone.t
    | Ticket_put of Planning_ticket_wire.Ticket.t
    | Comment_changed of Discussion.Change.t
    | Handoff_put of Planning_ticket_wire.Handoff.t
    | Resource_changed of Resource.Change.t

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~select:(function
        | Facts_changed _ -> "facts_changed"
        | Communication_changed _ -> "communication_changed"
        | Agent_run_changed _ -> "agent_run_changed"
        | Evidence_changed _ -> "evidence_changed"
        | Policy_changed _ -> "policy_changed"
        | Policy_unchanged _ -> "policy_unchanged"
        | Ticket_recovered _ -> "ticket_recovered"
        | Signal_receipt _ -> "signal_receipt"
        | Settings_changed _ -> "settings_changed"
        | Workspace_updated _ -> "workspace_updated"
        | Project_put _ -> "project_put"
        | Milestone_put _ -> "milestone_put"
        | Ticket_put _ -> "ticket_put"
        | Comment_changed _ -> "comment_changed"
        | Handoff_put _ -> "handoff_put"
        | Resource_changed _ -> "resource_changed"
        | Allocation_empty _ -> "allocation_empty")
      ~cases:
        [ ( "facts_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "facts_changed")
                  ++ F.required "fact" Planning_activity_snapshot.facts)
                 ~decode:(fun ((), value) -> Facts_changed value)
                 ~encode:(function
                   | Facts_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "communication_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "communication_changed")
                  ++ F.required "event" Planning_activity_snapshot.communication)
                 ~decode:(fun ((), value) -> Communication_changed value)
                 ~encode:(function
                   | Communication_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "agent_run_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "agent_run_changed")
                  ++ F.required "event" Planning_activity_snapshot.agent_run)
                 ~decode:(fun ((), value) -> Agent_run_changed value)
                 ~encode:(function
                   | Agent_run_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "evidence_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "evidence_changed")
                  ++ F.required "event" Planning_activity_snapshot.evidence)
                 ~decode:(fun ((), value) -> Evidence_changed value)
                 ~encode:(function
                   | Evidence_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "policy_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "policy_changed")
                  ++ F.required "change" Planning_activity_snapshot.policy)
                 ~decode:(fun ((), value) -> Policy_changed value)
                 ~encode:(function
                   | Policy_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "policy_unchanged"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "policy_unchanged")
                  ++ F.required "change" Planning_activity_snapshot.policy)
                 ~decode:(fun ((), value) -> Policy_unchanged value)
                 ~encode:(function
                   | Policy_unchanged value -> (), value
                   | _ -> wrong ())) )
        ; ( "ticket_recovered"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "ticket_recovered")
                  ++ F.required "recovery" Ticket_recovery.codec)
                 ~decode:(fun ((), value) -> Ticket_recovered value)
                 ~encode:(function
                   | Ticket_recovered value -> (), value
                   | _ -> wrong ())) )
        ; ( "signal_receipt"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "signal_receipt")
                  ++ F.required "receipt" signal_receipt)
                 ~decode:(fun ((), value) -> Signal_receipt value)
                 ~encode:(function
                   | Signal_receipt value -> (), value
                   | _ -> wrong ())) )
        ; ( "settings_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "settings_changed")
                  ++ F.required "change" Planning_activity_snapshot.workflow)
                 ~decode:(fun ((), value) -> Settings_changed value)
                 ~encode:(function
                   | Settings_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "workspace_updated"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "workspace_updated")
                  ++ F.required "settings" Planning_wire.Workspace_settings.codec)
                 ~decode:(fun ((), value) -> Workspace_updated value)
                 ~encode:(function
                   | Workspace_updated value -> (), value
                   | _ -> wrong ())) )
        ; ( "project_put"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "project_put")
                  ++ F.required "project" Planning_wire.Project.codec)
                 ~decode:(fun ((), value) -> Project_put value)
                 ~encode:(function
                   | Project_put value -> (), value
                   | _ -> wrong ())) )
        ; ( "milestone_put"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "milestone_put")
                  ++ F.required "milestone" Planning_wire.Milestone.codec)
                 ~decode:(fun ((), value) -> Milestone_put value)
                 ~encode:(function
                   | Milestone_put value -> (), value
                   | _ -> wrong ())) )
        ; ( "ticket_put"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "ticket_put")
                  ++ F.required "ticket" Planning_ticket_wire.Ticket.codec)
                 ~decode:(fun ((), value) -> Ticket_put value)
                 ~encode:(function
                   | Ticket_put value -> (), value
                   | _ -> wrong ())) )
        ; ( "comment_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "comment_changed")
                  ++ F.required "change" Planning_activity_snapshot.discussion)
                 ~decode:(fun ((), value) -> Comment_changed value)
                 ~encode:(function
                   | Comment_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "handoff_put"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "handoff_put")
                  ++ F.required "handoff" Planning_ticket_wire.Handoff.codec)
                 ~decode:(fun ((), value) -> Handoff_put value)
                 ~encode:(function
                   | Handoff_put value -> (), value
                   | _ -> wrong ())) )
        ; ( "resource_changed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "resource_changed")
                  ++ F.required "change" Planning_activity_snapshot.resource)
                 ~decode:(fun ((), value) -> Resource_changed value)
                 ~encode:(function
                   | Resource_changed value -> (), value
                   | _ -> wrong ())) )
        ; ( "allocation_empty"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "allocation_empty")
                  ++ F.required "run_id" run
                  ++ F.required "attempt_id" attempt)
                 ~decode:(fun (((), run_id), attempt_id) ->
                   Allocation_empty { run_id; attempt_id })
                 ~encode:(function
                   | Allocation_empty { run_id; attempt_id } -> ((), run_id), attempt_id
                   | _ -> wrong ())) )
        ]
  ;;
end

module Activity = struct
  type t =
    { revision : int
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; targets : Entity_ref.t list
    ; changes : Change.t list
    }

  let base =
    Api_codec.object_
      (F.map
         (F.required "revision" Coordination_wire.positive
          ++ F.required
               "actor_id"
               (Coordination_wire.id Id.Actor.of_string Id.Actor.to_string)
          ++ F.required "run_id" (Api_codec.nullable run)
          ++ F.required "timestamp" (Api_codec.text ~max_bytes:128)
          ++ F.required
               "targets"
               (Api_codec.list Evidence_wire.entity_ref ~max_items:100000)
          ++ F.required "changes" (Api_codec.list Change.codec ~max_items:100000))
         ~decode:(fun (((((revision, actor_id), run_id), timestamp), targets), changes) ->
           { revision; actor_id; run_id; timestamp; targets; changes })
         ~encode:(fun { revision; actor_id; run_id; timestamp; targets; changes } ->
           ((((revision, actor_id), run_id), timestamp), targets), changes))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun value ->
        if
          List.is_empty value.changes
          || List.contains_dup value.targets ~compare:Entity_ref.compare
        then
          Error
            (Problem.create
               Invalid_argument
               "audit record requires changes and distinct targets")
        else
          Json.decode (fun () ->
            let actor_timestamp actor timestamp =
              if
                not
                  (Id.Actor.equal actor value.actor_id
                   && String.equal timestamp value.timestamp)
              then
                Json.fail
                  Invalid_argument
                  "historical actor/timestamp differs from its planning source"
            in
            let attribution actor run timestamp sequence =
              actor_timestamp actor timestamp;
              if
                not
                  (Option.equal Id.Run.equal run value.run_id
                   && Int.equal sequence value.revision)
              then
                Json.fail
                  Invalid_argument
                  "historical run/sequence differs from its planning source"
            in
            List.iter value.changes ~f:(function
              | Change.Facts_changed change ->
                attribution
                  (Facts.Change.actor change)
                  (Facts.Change.run change)
                  (Facts.Change.timestamp change)
                  (Facts.Change.sequence change)
              | Communication_changed change ->
                attribution
                  change.attribution.actor
                  change.attribution.run
                  change.attribution.timestamp
                  change.sequence
              | Agent_run_changed change ->
                attribution change.actor change.actor_run change.timestamp change.sequence
              | Evidence_changed change ->
                attribution
                  change.attribution.actor
                  change.attribution.run
                  change.attribution.timestamp
                  change.sequence
              | Ticket_recovered change ->
                attribution change.actor_id change.run_id change.timestamp change.sequence
              | Comment_changed
                  (Discussion.Change.Create { version; _ } | Revise { version; _ }) ->
                actor_timestamp version.actor version.timestamp;
                if not (Int.equal version.sequence value.revision)
                then
                  Json.fail
                    Invalid_argument
                    "historical discussion sequence differs from its planning source"
              | Handoff_put handoff -> actor_timestamp handoff.actor_id handoff.timestamp
              | Resource_changed (Resource.Change.Published { version; _ }) ->
                actor_timestamp version.actor version.timestamp
              | Signal_receipt receipt ->
                let original = receipt.original in
                if
                  not
                    (Id.Actor.equal original.actor_id value.actor_id
                     && Option.equal Id.Run.equal original.run_id value.run_id
                     && original.sequence <= value.revision)
                then
                  Json.fail
                    Invalid_argument
                    "signal receipt attribution differs from original accepted signal"
              | Policy_changed _
              | Policy_unchanged _
              | Allocation_empty _
              | Settings_changed _
              | Workspace_updated _
              | Project_put _
              | Milestone_put _
              | Ticket_put _
              | Resource_changed (Metadata_changed _) -> ());
            value))
      ~encode:Fn.id
      ~description:
        "Complete retained audit record. Change order/contents, frozen routing and \
         source attribution remain exact."
  ;;
end

module Summary = struct
  type t =
    { revision : int
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; targets : Entity_ref.t list
    ; changes : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "revision" Coordination_wire.positive
          ++ F.required
               "actor_id"
               (Coordination_wire.id Id.Actor.of_string Id.Actor.to_string)
          ++ F.required
               "run_id"
               (Api_codec.nullable
                  (Coordination_wire.id Id.Run.of_string Id.Run.to_string))
          ++ F.required "timestamp" (Coordination_wire.nonblank ~max_bytes:128)
          ++ F.required
               "targets"
               (Api_codec.list Evidence_wire.entity_ref ~max_items:100000)
          ++ F.required "changes" Coordination_wire.positive)
         ~decode:(fun (((((revision, actor_id), run_id), timestamp), targets), changes) ->
           { revision; actor_id; run_id; timestamp; targets; changes })
         ~encode:(fun { revision; actor_id; run_id; timestamp; targets; changes } ->
           ((((revision, actor_id), run_id), timestamp), targets), changes))
  ;;

  let codec =
    Api_codec.map
      codec
      ~decode:(fun value ->
        if List.contains_dup value.targets ~compare:Entity_ref.compare
        then
          Error (Problem.create Invalid_argument "audit summary targets must be distinct")
        else Ok value)
      ~encode:Fn.id
      ~description:
        "Audit header has at least one retained change and distinct exact targets, \
         matching complete Activity records."
  ;;
end
