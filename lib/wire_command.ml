open Core

let bool x = if x then `True else `False
let nullable f x = Option.value_map x ~default:`Null ~f
let optional key f x = Option.value_map x ~default:[] ~f:(fun value -> [ key, f value ])

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let rec wire command =
  let open Domain_command in
  match command with
  | Communication command -> unwrap (Communication.encode command)
  | Agent_run command -> Agent_run.encode command
  | Evidence command -> unwrap (Evidence.encode command)
  | Policy command -> Agent_run_policy.encode command
  | Template_instantiate { template; template_revision; id; parameters } ->
    ( "template.instantiate"
    , Json.obj
        [ "template", Id.Resource.jsonaf_of_t template
        ; "template_revision", Json.int template_revision
        ; "id", Workflow_template.Instance_id.jsonaf_of_t id
        ; ( "parameters"
          , Json.obj (List.map parameters ~f:(fun (key, value) -> key, Json.string value))
          )
        ] )
  | Claim_next { attempt; run; project; lease_duration_ms } ->
    ( "ticket.claim_next"
    , Json.obj
        ([ "attempt_id", Attempt.Id.jsonaf_of_t attempt; "run", Id.Run.jsonaf_of_t run ]
         @ optional "project_id" Id.Project.jsonaf_of_t project
         @ optional "lease_duration_ms" Json.int64 lease_duration_ms) )
  | Thread_reply { id; expected_revision; comment_id; reply_to; kind; body } ->
    ( "thread.reply"
    , Json.obj
        ([ "thread_id", Communication_id.Thread.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ; "kind", Discussion.Kind.jsonaf_of_t kind
         ; "body", Json.string body
         ]
         @ optional "comment_id" Id.Comment.jsonaf_of_t comment_id
         @ optional "reply_to" Id.Comment.jsonaf_of_t reply_to) )
  | Batch commands ->
    ( "transaction.apply"
    , Json.obj
        [ ( "operations"
          , `Array
              (List.map commands ~f:(fun command ->
                 let method_, params = wire command in
                 Json.obj [ "method", Json.string method_; "params", params ])) )
        ] )
  | Settings_put (Workflow.Change.Actor actor) ->
    ( "actor.put"
    , Json.obj
        [ "target_actor_id", Id.Actor.jsonaf_of_t actor.id
        ; "expected_revision", Json.int actor.revision
        ; "name", Json.string actor.name
        ; ( "kind"
          , Json.string
              (match actor.kind with
               | Person -> "person"
               | Agent -> "agent") )
        ; "archived", bool actor.archived
        ] )
  | Settings_put (Workflow.Change.Label label) ->
    ( "label.put"
    , Json.obj
        [ "label_id", Id.Label.jsonaf_of_t label.id
        ; "expected_revision", Json.int label.revision
        ; "name", Json.string label.name
        ; "description", Json.string label.description
        ; "archived", bool label.archived
        ] )
  | Settings_put (Workflow.Change.Status status) ->
    ( "status.put"
    , Json.obj
        [ "status_id", Id.Status.jsonaf_of_t status.id
        ; "expected_revision", Json.int status.revision
        ; "name", Json.string status.name
        ; "category", Workflow.Category.jsonaf_of_t status.category
        ; "archived", bool status.archived
        ] )
  | Workspace_update
      { expected_revision; name; description; instructions; summary; archived } ->
    ( "workspace.update"
    , Json.obj
        ([ "expected_revision", Json.int expected_revision ]
         @ optional "name" Json.string name
         @ optional "description" Json.string description
         @ optional "instructions" Json.string instructions
         @ optional "summary" Json.string summary
         @ optional "archived" bool archived) )
  | Ticket_metadata
      { id
      ; expected_revision
      ; priority
      ; assignee
      ; labels
      ; acceptance_criteria
      ; status_id
      } ->
    ( "ticket.metadata"
    , Json.obj
        ([ "ticket_id", Id.Ticket.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ]
         @ optional "priority" Json.int priority
         @ optional "assignee_id" (nullable Id.Actor.jsonaf_of_t) assignee
         @ optional
             "label_ids"
             (fun ids -> `Array (List.map ids ~f:Id.Label.jsonaf_of_t))
             labels
         @ optional "acceptance_criteria" Json.string acceptance_criteria
         @ optional "status_id" (nullable Id.Status.jsonaf_of_t) status_id) )
  | Project_create { id; title; description } ->
    ( "project.create"
    , Json.obj
        [ "project_id", Id.Project.jsonaf_of_t id
        ; "title", Json.string title
        ; "description", Json.string description
        ] )
  | Project_update
      { id
      ; expected_revision
      ; title
      ; description
      ; status
      ; priority
      ; summary
      ; acceptance_criteria
      ; archived
      } ->
    ( "project.update"
    , Json.obj
        ([ "project_id", Id.Project.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ]
         @ optional "title" Json.string title
         @ optional "description" Json.string description
         @ optional "status" Status.jsonaf_of_t status
         @ optional "priority" Json.int priority
         @ optional "summary" Json.string summary
         @ optional "acceptance_criteria" Json.string acceptance_criteria
         @ optional "archived" bool archived) )
  | Milestone_create { id; project; title; description; target_date } ->
    ( "milestone.create"
    , Json.obj
        ([ "milestone_id", Id.Milestone.jsonaf_of_t id
         ; "project_id", Id.Project.jsonaf_of_t project
         ; "title", Json.string title
         ; "description", Json.string description
         ]
         @ optional "target_date" Json.string target_date) )
  | Milestone_update { id; expected_revision; title; description; status; archived } ->
    ( "milestone.update"
    , Json.obj
        ([ "milestone_id", Id.Milestone.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ]
         @ optional "title" Json.string title
         @ optional "description" Json.string description
         @ optional "status" Status.jsonaf_of_t status
         @ optional "archived" bool archived) )
  | Milestone_schedule { id; expected_revision; target_date } ->
    ( "milestone.schedule"
    , Json.obj
        [ "milestone_id", Id.Milestone.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "target_date", (nullable Json.string) target_date
        ] )
  | Ticket_move { id; expected_revision; project; milestone; parent } ->
    ( "ticket.move"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "project_id", (nullable Id.Project.jsonaf_of_t) project
        ; "milestone_id", (nullable Id.Milestone.jsonaf_of_t) milestone
        ; "parent_id", (nullable Id.Ticket.jsonaf_of_t) parent
        ] )
  | Ticket_archive { id; expected_revision; archived } ->
    ( "ticket.archive"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "archived", bool archived
        ] )
  | Ticket_create { id; title; description; project; parent; milestone } ->
    ( "ticket.create"
    , Json.obj
        ([ "ticket_id", Id.Ticket.jsonaf_of_t id
         ; "title", Json.string title
         ; "description", Json.string description
         ]
         @ optional "project_id" Id.Project.jsonaf_of_t project
         @ optional "parent_id" Id.Ticket.jsonaf_of_t parent
         @ optional "milestone_id" Id.Milestone.jsonaf_of_t milestone) )
  | Ticket_update { id; expected_revision; title; description; status } ->
    ( "ticket.update"
    , Json.obj
        ([ "ticket_id", Id.Ticket.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ]
         @ optional "title" Json.string title
         @ optional "description" Json.string description
         @ optional "status" Status.jsonaf_of_t status) )
  | Ticket_hold { id; expected_revision; reason } ->
    ( "ticket.hold"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "reason", (nullable Json.string) reason
        ] )
  | Dependency_waive { ticket; prerequisite; expected_revision; reason } ->
    ( "dependency.waive"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
        ; "prerequisite_id", Id.Ticket.jsonaf_of_t prerequisite
        ; "expected_revision", Json.int expected_revision
        ; "reason", (nullable Json.string) reason
        ] )
  | Ticket_reassign { id; expected_revision; claimant; claimant_run; reason } ->
    ( "ticket.reassign"
    , Json.obj
        ([ "ticket_id", Id.Ticket.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ; "claimant_id", (nullable Id.Actor.jsonaf_of_t) claimant
         ; "reason", Json.string reason
         ]
         @ optional "claimant_run_id" Id.Run.jsonaf_of_t claimant_run) )
  | Dependency_add { ticket; prerequisite } ->
    ( "dependency.add"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
        ; "prerequisite_id", Id.Ticket.jsonaf_of_t prerequisite
        ] )
  | Dependency_remove { ticket; prerequisite } ->
    ( "dependency.remove"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
        ; "prerequisite_id", Id.Ticket.jsonaf_of_t prerequisite
        ] )
  | Related_link { ticket; related; expected_revision; related_expected_revision; linked }
    ->
    ( (if linked then "related.add" else "related.remove")
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
        ; "related_id", Id.Ticket.jsonaf_of_t related
        ; "expected_revision", Json.int expected_revision
        ; "related_expected_revision", Json.int related_expected_revision
        ] )
  | Ticket_claim { id; expected_revision } ->
    ( "ticket.claim"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ] )
  | Ticket_claim_with_lease { id; expected_revision; lease_duration_ms } ->
    ( "ticket.claim"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "lease_duration_ms", Json.int64 lease_duration_ms
        ] )
  | Ticket_renew_lease { id; token; expected_lease_revision } ->
    ( "ticket.renew_lease"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "token", Json.int token
        ; "expected_lease_revision", Json.int expected_lease_revision
        ] )
  | Ticket_release { id; token } ->
    ( "ticket.release"
    , Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t id; "token", Json.int token ] )
  | Ticket_complete { id; token; evidence } ->
    ( "ticket.complete"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t id
        ; "token", Json.int token
        ; "evidence", Json.string evidence
        ] )
  | Comment_add { id; target; reply_to; kind; body } ->
    ( "comment.add"
    , Json.obj
        ([ "target", Entity_ref.jsonaf_of_t target
         ; "kind", Discussion.Kind.jsonaf_of_t kind
         ; "body", Json.string body
         ]
         @ optional "comment_id" Id.Comment.jsonaf_of_t id
         @ optional "reply_to" Id.Comment.jsonaf_of_t reply_to) )
  | Ticket_progress { ticket; token; kind; body } ->
    ( "ticket.progress"
    , Json.obj
        [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
        ; "token", Json.int token
        ; "kind", Discussion.Kind.jsonaf_of_t kind
        ; "body", Json.string body
        ] )
  | Handoff_set
      { ticket
      ; expected_revision
      ; token
      ; summary
      ; next_steps
      ; evidence
      ; objective
      ; completed
      ; decisions
      ; blockers
      ; resources
      ; covers_through
      } ->
    ( "handoff.set"
    , Json.obj
        ([ "ticket_id", Id.Ticket.jsonaf_of_t ticket
         ; "expected_revision", Json.int expected_revision
         ; "summary", Json.string summary
         ; "next_steps", Json.string next_steps
         ; "evidence", Json.string evidence
         ; "objective", Json.string objective
         ; "completed", Json.string completed
         ; "decisions", Json.string decisions
         ; "blockers", Json.string blockers
         ; ( "resource_ids"
           , (fun ids -> `Array (List.map ids ~f:Id.Resource.jsonaf_of_t)) resources )
         ]
         @ optional "token" Json.int token
         @ optional "covers_through" Json.int covers_through) )
  | Resource_put { id; expected_revision; title; text; filename; mime_type } ->
    ( "resource.put_text"
    , Json.obj
        ([ "resource_id", Id.Resource.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ; "title", Json.string title
         ; "text", Json.string text
         ]
         @ optional "filename" Json.string filename
         @ optional "mime_type" Json.string mime_type) )
  | Resource_metadata
      { id; expected_revision; title; filename; mime_type; description; archived } ->
    ( "resource.update"
    , Json.obj
        ([ "resource_id", Id.Resource.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ]
         @ optional "title" Json.string title
         @ optional "filename" Json.string filename
         @ optional "mime_type" Json.string mime_type
         @ optional "description" Json.string description
         @ optional "archived" bool archived) )
  | Comment_edit { id; expected_revision; body; tombstone } ->
    if tombstone && not (String.is_empty body)
    then Json.fail Invalid_argument "tombstone body must be empty";
    ( (if tombstone then "comment.tombstone" else "comment.edit")
    , Json.obj
        ([ "comment_id", Id.Comment.jsonaf_of_t id
         ; "expected_revision", Json.int expected_revision
         ]
         @ if tombstone then [] else [ "body", Json.string body ]) )
  | Resource_link { id; expected_revision; target; remove } ->
    ( (if remove then "resource.unlink" else "resource.link")
    , Json.obj
        [ "resource_id", Id.Resource.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "target", Entity_ref.jsonaf_of_t target
        ] )
  | Resource_publish _ ->
    Json.fail
      Invalid_argument
      "Resource_publish is internal; finish a verified upload instead"
;;

let encode command =
  Json.decode (fun () ->
    let method_, params = wire command in
    ignore (unwrap (Domain_command.decode ~method_ ~params) : Domain_command.t);
    method_, params)
;;
