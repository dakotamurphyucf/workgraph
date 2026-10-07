open Core
module Status = Workflow.Category

type t =
  | Batch of t list
  | Communication of Communication.Command.t
  | Agent_run of Agent_run.Command.t
  | Evidence of Evidence.Command.t
  | Policy of Agent_run_policy.Command.t
  | Template_instantiate of
      { template : Id.Resource.t
      ; template_revision : int
      ; id : Workflow_template.Instance_id.t
      ; parameters : (string * string) list
      }
  | Claim_next of
      { attempt : Attempt.Id.t
      ; run : Id.Run.t
      ; project : Id.Project.t option
      ; lease_duration_ms : int64 option
      }
  | Thread_reply of
      { id : Communication_id.Thread.t
      ; expected_revision : int
      ; comment_id : Id.Comment.t option
      ; reply_to : Id.Comment.t option
      ; kind : Discussion.Kind.t
      ; body : string
      }
  | Settings_put of Workflow.Change.t
  | Workspace_update of
      { expected_revision : int
      ; name : string option
      ; description : string option
      ; instructions : string option
      ; summary : string option
      ; archived : bool option
      }
  | Ticket_metadata of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; priority : int option
      ; assignee : Id.Actor.t option option
      ; labels : Id.Label.t list option
      ; acceptance_criteria : string option
      ; status_id : Id.Status.t option option
      }
  | Project_create of
      { id : Id.Project.t
      ; title : string
      ; description : string
      }
  | Project_update of
      { id : Id.Project.t
      ; expected_revision : int
      ; title : string option
      ; description : string option
      ; status : Status.t option
      ; priority : int option
      ; summary : string option
      ; acceptance_criteria : string option
      ; archived : bool option
      }
  | Milestone_create of
      { id : Id.Milestone.t
      ; project : Id.Project.t
      ; title : string
      ; description : string
      ; target_date : string option
      }
  | Milestone_update of
      { id : Id.Milestone.t
      ; expected_revision : int
      ; title : string option
      ; description : string option
      ; status : Status.t option
      ; archived : bool option
      }
  | Milestone_schedule of
      { id : Id.Milestone.t
      ; expected_revision : int
      ; target_date : string option
      }
  | Ticket_move of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; project : Id.Project.t option
      ; milestone : Id.Milestone.t option
      ; parent : Id.Ticket.t option
      }
  | Ticket_archive of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; archived : bool
      }
  | Ticket_create of
      { id : Id.Ticket.t
      ; title : string
      ; description : string
      ; project : Id.Project.t option
      ; parent : Id.Ticket.t option
      ; milestone : Id.Milestone.t option
      }
  | Ticket_update of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; title : string option
      ; description : string option
      ; status : Status.t option
      }
  | Ticket_hold of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; reason : string option
      }
  | Dependency_waive of
      { ticket : Id.Ticket.t
      ; prerequisite : Id.Ticket.t
      ; expected_revision : int
      ; reason : string option
      }
  | Ticket_reassign of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; claimant : Id.Actor.t option
      ; claimant_run : Id.Run.t option
      ; reason : string
      }
  | Dependency_add of
      { ticket : Id.Ticket.t
      ; prerequisite : Id.Ticket.t
      }
  | Dependency_remove of
      { ticket : Id.Ticket.t
      ; prerequisite : Id.Ticket.t
      }
  | Related_link of
      { ticket : Id.Ticket.t
      ; related : Id.Ticket.t
      ; expected_revision : int
      ; related_expected_revision : int
      ; linked : bool
      }
  | Ticket_claim of
      { id : Id.Ticket.t
      ; expected_revision : int
      }
  | Ticket_claim_with_lease of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; lease_duration_ms : int64
      }
  | Ticket_renew_lease of
      { id : Id.Ticket.t
      ; token : int
      ; expected_lease_revision : int
      }
  | Ticket_release of
      { id : Id.Ticket.t
      ; token : int
      }
  | Ticket_complete of
      { id : Id.Ticket.t
      ; token : int
      ; evidence : string
      }
  | Comment_add of
      { id : Id.Comment.t option
      ; target : Entity_ref.t
      ; reply_to : Id.Comment.t option
      ; kind : Discussion.Kind.t
      ; body : string
      }
  | Comment_edit of
      { id : Id.Comment.t
      ; expected_revision : int
      ; body : string
      ; tombstone : bool
      }
  | Ticket_progress of
      { ticket : Id.Ticket.t
      ; token : int
      ; kind : Discussion.Kind.t
      ; body : string
      }
  | Handoff_set of
      { ticket : Id.Ticket.t
      ; expected_revision : int
      ; token : int option
      ; summary : string
      ; next_steps : string
      ; evidence : string
      ; objective : string
      ; completed : string
      ; decisions : string
      ; blockers : string
      ; resources : Id.Resource.t list
      ; covers_through : int option
      }
  | Resource_put of
      { id : Id.Resource.t
      ; expected_revision : int
      ; title : string
      ; text : string
      ; filename : string option
      ; mime_type : string option
      }
  | Resource_publish of
      { id : Id.Resource.t
      ; expected_revision : int
      ; title : string
      ; filename : string
      ; mime_type : string
      ; digest : string
      ; size_bytes : int
      }
  | Resource_metadata of
      { id : Id.Resource.t
      ; expected_revision : int
      ; title : string option
      ; filename : string option
      ; mime_type : string option
      ; description : string option
      ; archived : bool option
      }
  | Resource_link of
      { id : Id.Resource.t
      ; expected_revision : int
      ; target : Entity_ref.t
      ; remove : bool
      }
[@@deriving sexp]

let decode_one ~method_ ~params =
  Json.decode (fun () ->
    let get key = Json.field params key in
    let optional key f = Option.map (Json.optional params key) ~f in
    let text key = Json.bounded_text (get key) ~max_bytes:65_536 in
    let title () =
      let value = Json.bounded_text (get "title") ~max_bytes:512 in
      if String.is_empty (String.strip value)
      then Json.fail Invalid_argument "empty title";
      value
    in
    let description () =
      Option.value
        (optional "description" (fun j -> Json.bounded_text j ~max_bytes:65_536))
        ~default:""
    in
    let ticket () = Id.Ticket.t_of_jsonaf (get "ticket_id") in
    let bool = function
      | `True -> true
      | `False -> false
      | _ -> Json.fail Invalid_argument "expected boolean"
    in
    let nullable key f =
      match get key with
      | `Null -> None
      | value -> Some (f value)
    in
    let revision () = Json.integer (get "expected_revision") in
    let allow xs = Json.fields params ~allowed:xs in
    match method_ with
    | "actor.put" | "label.put" | "status.put" ->
      Settings_put (Workflow.decode ~method_ ~params)
    | "workspace.update" | "workspace.archive" ->
      allow
        (if String.equal method_ "workspace.archive"
         then [ "expected_revision"; "archived" ]
         else
           [ "expected_revision"
           ; "name"
           ; "description"
           ; "instructions"
           ; "summary"
           ; "archived"
           ]);
      let boolean = function
        | `True -> true
        | `False -> false
        | _ -> Json.fail Invalid_argument "expected boolean"
      in
      if String.equal method_ "workspace.archive"
      then ignore (boolean (get "archived") : bool);
      Workspace_update
        { expected_revision = revision ()
        ; name = Option.map (Json.optional params "name") ~f:Json.text
        ; description = Option.map (Json.optional params "description") ~f:Json.text
        ; instructions = Option.map (Json.optional params "instructions") ~f:Json.text
        ; summary = Option.map (Json.optional params "summary") ~f:Json.text
        ; archived = Option.map (Json.optional params "archived") ~f:boolean
        }
    | "ticket.metadata" ->
      allow
        [ "ticket_id"
        ; "expected_revision"
        ; "priority"
        ; "assignee_id"
        ; "label_ids"
        ; "acceptance_criteria"
        ; "status_id"
        ];
      let patch key f =
        optional key (fun value ->
          match value with
          | `Null -> None
          | value -> Some (f value))
      in
      Ticket_metadata
        { id = ticket ()
        ; expected_revision = revision ()
        ; priority = optional "priority" Json.integer
        ; assignee = patch "assignee_id" Id.Actor.t_of_jsonaf
        ; labels =
            optional "label_ids" (fun value ->
              List.map (Json.list value) ~f:Id.Label.t_of_jsonaf)
        ; acceptance_criteria =
            optional "acceptance_criteria" (fun _ -> text "acceptance_criteria")
        ; status_id = patch "status_id" Id.Status.t_of_jsonaf
        }
    | "project.create" ->
      allow [ "project_id"; "title"; "description" ];
      Project_create
        { id = Id.Project.t_of_jsonaf (get "project_id")
        ; title = title ()
        ; description = description ()
        }
    | "project.update" | "project.archive" ->
      allow
        [ "project_id"
        ; "expected_revision"
        ; "title"
        ; "description"
        ; "status"
        ; "priority"
        ; "summary"
        ; "acceptance_criteria"
        ; "archived"
        ];
      Project_update
        { id = Id.Project.t_of_jsonaf (get "project_id")
        ; expected_revision = revision ()
        ; title = optional "title" (fun _ -> title ())
        ; description = optional "description" (fun _ -> text "description")
        ; status = optional "status" (fun j -> Status.of_name (Json.text j))
        ; priority = optional "priority" Json.integer
        ; summary = optional "summary" (fun _ -> text "summary")
        ; acceptance_criteria =
            optional "acceptance_criteria" (fun _ -> text "acceptance_criteria")
        ; archived =
            (if String.equal method_ "project.archive"
             then Some (bool (get "archived"))
             else optional "archived" bool)
        }
    | "milestone.create" ->
      allow [ "milestone_id"; "project_id"; "title"; "description"; "target_date" ];
      let target_date =
        optional "target_date" (fun value ->
          let date = Json.text value in
          match Or_error.try_with (fun () -> Date.of_string date) with
          | Ok parsed when String.equal (Date.to_string parsed) date -> date
          | Ok _ | Error _ ->
            Json.fail Invalid_argument "target_date must be a valid YYYY-MM-DD date")
      in
      Milestone_create
        { id = Id.Milestone.t_of_jsonaf (get "milestone_id")
        ; project = Id.Project.t_of_jsonaf (get "project_id")
        ; title = title ()
        ; description = description ()
        ; target_date
        }
    | "milestone.update" | "milestone.archive" ->
      allow
        [ "milestone_id"
        ; "expected_revision"
        ; "title"
        ; "description"
        ; "status"
        ; "archived"
        ];
      Milestone_update
        { id = Id.Milestone.t_of_jsonaf (get "milestone_id")
        ; expected_revision = revision ()
        ; title = optional "title" (fun _ -> title ())
        ; description = optional "description" (fun _ -> text "description")
        ; status = optional "status" (fun j -> Status.of_name (Json.text j))
        ; archived =
            (if String.equal method_ "milestone.archive"
             then Some (bool (get "archived"))
             else optional "archived" bool)
        }
    | "milestone.schedule" ->
      allow [ "milestone_id"; "expected_revision"; "target_date" ];
      Milestone_schedule
        { id = Id.Milestone.t_of_jsonaf (get "milestone_id")
        ; expected_revision = revision ()
        ; target_date = nullable "target_date" Json.text
        }
    | "ticket.move" ->
      allow
        [ "ticket_id"; "expected_revision"; "project_id"; "milestone_id"; "parent_id" ];
      Ticket_move
        { id = ticket ()
        ; expected_revision = revision ()
        ; project = nullable "project_id" Id.Project.t_of_jsonaf
        ; milestone = nullable "milestone_id" Id.Milestone.t_of_jsonaf
        ; parent = nullable "parent_id" Id.Ticket.t_of_jsonaf
        }
    | "ticket.archive" ->
      allow [ "ticket_id"; "expected_revision"; "archived" ];
      Ticket_archive
        { id = ticket ()
        ; expected_revision = revision ()
        ; archived = bool (get "archived")
        }
    | "ticket.create" ->
      allow
        [ "ticket_id"; "title"; "description"; "project_id"; "parent_id"; "milestone_id" ];
      Ticket_create
        { id = ticket ()
        ; title = title ()
        ; description = description ()
        ; project = optional "project_id" Id.Project.t_of_jsonaf
        ; parent = optional "parent_id" Id.Ticket.t_of_jsonaf
        ; milestone = optional "milestone_id" Id.Milestone.t_of_jsonaf
        }
    | "ticket.update" ->
      allow [ "ticket_id"; "expected_revision"; "title"; "description"; "status" ];
      let status =
        optional "status" (fun j ->
          match Json.text j with
          | "backlog" -> Status.Backlog
          | "todo" -> Todo
          | "in_progress" -> In_progress
          | "done" -> Done
          | "canceled" -> Canceled
          | _ -> Json.fail Invalid_argument "unknown status")
      in
      Ticket_update
        { id = ticket ()
        ; expected_revision = revision ()
        ; title = Option.map (Json.optional params "title") ~f:(fun _ -> title ())
        ; description = optional "description" (fun _ -> text "description")
        ; status
        }
    | "ticket.hold" ->
      allow [ "ticket_id"; "expected_revision"; "reason" ];
      Ticket_hold
        { id = ticket ()
        ; expected_revision = revision ()
        ; reason = nullable "reason" Json.text
        }
    | "dependency.waive" ->
      allow [ "ticket_id"; "prerequisite_id"; "expected_revision"; "reason" ];
      Dependency_waive
        { ticket = ticket ()
        ; prerequisite = Id.Ticket.t_of_jsonaf (get "prerequisite_id")
        ; expected_revision = revision ()
        ; reason = nullable "reason" Json.text
        }
    | "ticket.reassign" ->
      allow
        [ "ticket_id"; "expected_revision"; "claimant_id"; "claimant_run_id"; "reason" ];
      Ticket_reassign
        { id = ticket ()
        ; expected_revision = revision ()
        ; claimant = nullable "claimant_id" Id.Actor.t_of_jsonaf
        ; claimant_run =
            (match Json.optional params "claimant_run_id" with
             | None | Some `Null -> None
             | Some value -> Some (Id.Run.t_of_jsonaf value))
        ; reason = text "reason"
        }
    | "dependency.add" | "dependency.remove" ->
      allow [ "ticket_id"; "prerequisite_id" ];
      let ticket = ticket ()
      and prerequisite = Id.Ticket.t_of_jsonaf (get "prerequisite_id") in
      if String.equal method_ "dependency.add"
      then Dependency_add { ticket; prerequisite }
      else Dependency_remove { ticket; prerequisite }
    | "related.add" | "related.remove" ->
      allow
        [ "ticket_id"; "related_id"; "expected_revision"; "related_expected_revision" ];
      Related_link
        { ticket = ticket ()
        ; related = Id.Ticket.t_of_jsonaf (get "related_id")
        ; expected_revision = revision ()
        ; related_expected_revision = Json.integer (get "related_expected_revision")
        ; linked = String.equal method_ "related.add"
        }
    | "ticket.claim" ->
      allow [ "ticket_id"; "expected_revision"; "lease_duration_ms" ];
      (match optional "lease_duration_ms" Json.integer64 with
       | None -> Ticket_claim { id = ticket (); expected_revision = revision () }
       | Some lease_duration_ms ->
         Ticket_claim_with_lease
           { id = ticket (); expected_revision = revision (); lease_duration_ms })
    | "ticket.renew_lease" ->
      allow [ "ticket_id"; "token"; "expected_lease_revision" ];
      Ticket_renew_lease
        { id = ticket ()
        ; token = Json.integer (get "token")
        ; expected_lease_revision = Json.integer (get "expected_lease_revision")
        }
    | "ticket.release" ->
      allow [ "ticket_id"; "token" ];
      Ticket_release { id = ticket (); token = Json.integer (get "token") }
    | "ticket.complete" ->
      allow [ "ticket_id"; "token"; "evidence" ];
      Ticket_complete
        { id = ticket (); token = Json.integer (get "token"); evidence = text "evidence" }
    | "comment.add" ->
      allow [ "comment_id"; "ticket_id"; "target"; "reply_to"; "kind"; "body" ];
      let target =
        match Json.optional params "ticket_id", Json.optional params "target" with
        | Some value, None -> Entity_ref.Ticket (Id.Ticket.t_of_jsonaf value)
        | None, Some value -> Entity_ref.t_of_jsonaf value
        | _ -> Json.fail Invalid_argument "provide exactly one of ticket_id or target"
      in
      Comment_add
        { id = optional "comment_id" Id.Comment.t_of_jsonaf
        ; target
        ; reply_to = optional "reply_to" Id.Comment.t_of_jsonaf
        ; kind =
            Option.value (optional "kind" Discussion.Kind.t_of_jsonaf) ~default:Comment
        ; body = text "body"
        }
    | "comment.edit" | "comment.tombstone" ->
      let tombstone = String.equal method_ "comment.tombstone" in
      allow
        (if tombstone
         then [ "comment_id"; "expected_revision" ]
         else [ "comment_id"; "expected_revision"; "body" ]);
      Comment_edit
        { id = Id.Comment.t_of_jsonaf (get "comment_id")
        ; expected_revision = revision ()
        ; tombstone
        ; body = (if tombstone then "" else text "body")
        }
    | "ticket.progress" ->
      allow [ "ticket_id"; "token"; "kind"; "body" ];
      Ticket_progress
        { ticket = ticket ()
        ; token = Json.integer (get "token")
        ; kind =
            Option.value (optional "kind" Discussion.Kind.t_of_jsonaf) ~default:Progress
        ; body = text "body"
        }
    | "handoff.set" ->
      allow
        [ "ticket_id"
        ; "expected_revision"
        ; "token"
        ; "summary"
        ; "next_steps"
        ; "evidence"
        ; "objective"
        ; "completed"
        ; "decisions"
        ; "blockers"
        ; "resource_ids"
        ; "covers_through"
        ];
      let extra key = Option.value (optional key (fun _ -> text key)) ~default:"" in
      Handoff_set
        { ticket = ticket ()
        ; expected_revision = revision ()
        ; token = optional "token" Json.integer
        ; summary = text "summary"
        ; next_steps = text "next_steps"
        ; evidence = text "evidence"
        ; objective = extra "objective"
        ; completed = extra "completed"
        ; decisions = extra "decisions"
        ; blockers = extra "blockers"
        ; resources =
            Option.value
              (optional "resource_ids" (fun value ->
                 List.map (Json.list value) ~f:Id.Resource.t_of_jsonaf))
              ~default:[]
        ; covers_through = optional "covers_through" Json.integer
        }
    | "resource.put_text" ->
      allow
        [ "resource_id"; "expected_revision"; "title"; "text"; "filename"; "mime_type" ];
      Resource_put
        { id = Id.Resource.t_of_jsonaf (get "resource_id")
        ; expected_revision = revision ()
        ; title = title ()
        ; text = text "text"
        ; filename = optional "filename" Json.text
        ; mime_type = optional "mime_type" Json.text
        }
    | "resource.update" | "resource.archive" ->
      allow
        [ "resource_id"
        ; "expected_revision"
        ; "title"
        ; "filename"
        ; "mime_type"
        ; "description"
        ; "archived"
        ];
      Resource_metadata
        { id = Id.Resource.t_of_jsonaf (get "resource_id")
        ; expected_revision = revision ()
        ; title = optional "title" Json.text
        ; filename = optional "filename" Json.text
        ; mime_type = optional "mime_type" Json.text
        ; description = optional "description" Json.text
        ; archived =
            (if String.equal method_ "resource.archive"
             then Some (bool (get "archived"))
             else optional "archived" bool)
        }
    | "resource.link" | "resource.unlink" ->
      allow [ "resource_id"; "expected_revision"; "target" ];
      Resource_link
        { id = Id.Resource.t_of_jsonaf (get "resource_id")
        ; expected_revision = revision ()
        ; target = Entity_ref.t_of_jsonaf (get "target")
        ; remove = String.equal method_ "resource.unlink"
        }
    | "template.instantiate" ->
      allow [ "template"; "template_revision"; "id"; "parameters" ];
      let parameters =
        match get "parameters" with
        | `Object fields ->
          Json.fields (get "parameters") ~allowed:(List.map fields ~f:fst);
          List.map fields ~f:(fun (key, value) -> key, Json.text value)
        | _ -> Json.fail Invalid_argument "template parameters must be an object"
      in
      Template_instantiate
        { template = Id.Resource.t_of_jsonaf (get "template")
        ; template_revision = Json.integer (get "template_revision")
        ; id = Workflow_template.Instance_id.t_of_jsonaf (get "id")
        ; parameters
        }
    | method_ when List.mem Agent_run_policy.mutation_methods method_ ~equal:String.equal
      ->
      (match Agent_run_policy.decode ~method_ ~params with
       | Ok command -> Policy command
       | Error error -> raise (Json.Decode_error error))
    | "ticket.claim_next" ->
      allow [ "attempt_id"; "run"; "project_id"; "lease_duration_ms" ];
      Claim_next
        { attempt = Attempt.Id.t_of_jsonaf (get "attempt_id")
        ; run = Id.Run.t_of_jsonaf (get "run")
        ; project = optional "project_id" Id.Project.t_of_jsonaf
        ; lease_duration_ms = optional "lease_duration_ms" Json.integer64
        }
    | "thread.reply" ->
      allow [ "thread_id"; "expected_revision"; "comment_id"; "reply_to"; "kind"; "body" ];
      Thread_reply
        { id = Communication_id.Thread.t_of_jsonaf (get "thread_id")
        ; expected_revision = revision ()
        ; comment_id = optional "comment_id" Id.Comment.t_of_jsonaf
        ; reply_to = optional "reply_to" Id.Comment.t_of_jsonaf
        ; kind =
            Option.value (optional "kind" Discussion.Kind.t_of_jsonaf) ~default:Comment
        ; body = text "body"
        }
    | method_ when List.mem Agent_run.mutation_methods method_ ~equal:String.equal ->
      (match Agent_run.decode ~method_ ~params with
       | Ok command -> Agent_run command
       | Error error -> raise (Json.Decode_error error))
    | method_ when List.mem Evidence.mutation_methods method_ ~equal:String.equal ->
      (match Evidence.decode ~method_ ~params with
       | Ok command -> Evidence command
       | Error error -> raise (Json.Decode_error error))
    | method_ when List.mem Communication.mutation_methods method_ ~equal:String.equal ->
      (match Communication.decode ~method_ ~params with
       | Ok command -> Communication command
       | Error error -> raise (Json.Decode_error error))
    | _ -> Json.fail Invalid_argument ("unknown mutation method: " ^ method_))
;;

let decode ~method_ ~params =
  if not (String.equal method_ "transaction.apply")
  then decode_one ~method_ ~params
  else
    Json.decode (fun () ->
      Json.fields params ~allowed:[ "operations" ];
      let operations = Json.field params "operations" |> Json.list in
      if List.is_empty operations || List.length operations > 32
      then Json.fail Invalid_argument "transaction requires 1..32 operations";
      let aliases =
        List.fold operations ~init:String.Map.empty ~f:(fun aliases op ->
          Json.fields op ~allowed:[ "method"; "params"; "as" ];
          match Json.optional op "as" with
          | None -> aliases
          | Some value ->
            let alias = Id.Actor.t_of_jsonaf value |> Id.Actor.to_string in
            if Map.mem aliases alias
            then Json.fail Invalid_argument ("duplicate alias: " ^ alias);
            let method_ = Json.field op "method" |> Json.text in
            let params = Json.field op "params" in
            let kind, field =
              match method_ with
              | "project.create" -> "project", "project_id"
              | "ticket.create" -> "ticket", "ticket_id"
              | "milestone.create" -> "milestone", "milestone_id"
              | "comment.add" -> "comment", "comment_id"
              | "thread.reply" -> "comment", "comment_id"
              | "board.put" when Json.integer (Json.field params "expected_revision") = 0
                -> "board", "board_id"
              | "thread.put" when Json.integer (Json.field params "expected_revision") = 0
                -> "thread", "thread_id"
              | "team.put" when Json.integer (Json.field params "expected_revision") = 0
                -> "team", "team_id"
              | "subscription.put"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "subscription", "subscription_id"
              | "request.create" -> "request", "request_id"
              | "run.register" -> "run", "id"
              | "attempt.start" -> "attempt", "id"
              | "contract.put"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "contract", "id"
              | "manifest.publish"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "manifest", "id"
              | "decision.put"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "decision", "id"
              | "review.record" -> "review", "id"
              | "validation.add" -> "validation", "id"
              | "template.instantiate" | "template.instance_register" -> "instance", "id"
              | "resource.put_text"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "resource", "resource_id"
              | _ -> Json.fail Invalid_argument "aliases require a creation operation"
            in
            let id =
              Json.field params field |> Id.Actor.t_of_jsonaf |> Id.Actor.to_string
            in
            Map.set aliases ~key:alias ~data:(kind, id))
      in
      let resolve_id kind value =
        match kind, value with
        | Some kind, `String value when String.is_prefix value ~prefix:"$" ->
          let alias = String.drop_prefix value 1 in
          (match Map.find aliases alias with
           | Some (actual, id) when String.equal kind actual -> Json.string id
           | Some _ -> Json.fail Invalid_argument ("alias entity kind mismatch: " ^ alias)
           | None -> Json.fail Invalid_argument ("unknown alias: " ^ alias))
        | _ -> value
      in
      let identity_kind method_ =
        match method_ with
        | "run.register" | "run.transition" | "run.observe" | "run.link_session" ->
          Some "run"
        | "attempt.start" | "attempt.checkpoint" | "attempt.finish" -> Some "attempt"
        | "contract.put" -> Some "contract"
        | "manifest.publish" -> Some "manifest"
        | "decision.put" -> Some "decision"
        | "review.record" -> Some "review"
        | "validation.add" -> Some "validation"
        | "template.instantiate" | "template.instance_register" -> Some "instance"
        | _ -> None
      in
      let rec resolve ~method_ ~context key value =
        let kind =
          match key with
          | "id" -> context
          | "project_id" -> Some "project"
          | "milestone_id" -> Some "milestone"
          | "ticket_id" | "ticket" | "parent_id" | "prerequisite_id" | "related_id" ->
            Some "ticket"
          | "resource_id" | "resource" | "template" | "resource_ids" -> Some "resource"
          | "comment_id" | "comment" | "message" -> Some "comment"
          | "board_id" -> Some "board"
          | "thread_id" -> Some "thread"
          | "request_id" | "review_request" -> Some "request"
          | "team_id" | "teams" -> Some "team"
          | "subscription_id" -> Some "subscription"
          | "attempt" | "attempt_id" -> Some "attempt"
          | "run" | "child" -> Some "run"
          | "parent" when String.equal method_ "run.register" -> Some "run"
          | "reply_to" ->
            Some (if String.equal method_ "request.create" then "request" else "comment")
          | "supersedes" -> Some "decision"
          | _ -> None
        in
        match key, value with
        | ( ( "target"
            | "scope"
            | "links"
            | "affected"
            | "recipient"
            | "recipients"
            | "members" )
          , `Object fields ) ->
          let target_kind =
            match Json.optional value "kind" with
            | Some (`String k) -> Some (String.lowercase k)
            | _ -> None
          in
          Json.obj
            (List.map fields ~f:(fun (key, value) ->
               key, resolve ~method_ ~context:target_kind key value))
        | ("contract" | "manifest" | "schema"), `Object fields ->
          let context = Some (if String.equal key "schema" then "resource" else key) in
          Json.obj
            (List.map fields ~f:(fun (key, value) ->
               key, resolve ~method_ ~context key value))
        | ( ("pin" | "rationale" | "evidence" | "previous" | "current")
          , `Array [ `String tag; record ] ) ->
          `Array
            [ Json.string tag
            ; resolve ~method_ ~context:(Some (String.lowercase tag)) "pin_record" record
            ]
        | "disposition", `Array [ `String "Revised"; record ] ->
          `Array
            [ Json.string "Revised"
            ; resolve ~method_ ~context:(Some "manifest") "manifest_record" record
            ]
        | _, `Object fields ->
          Json.obj
            (List.map fields ~f:(fun (key, value) ->
               key, resolve ~method_ ~context key value))
        | _, `Array values ->
          `Array
            (List.map values ~f:(fun value ->
               match value with
               | `String _ -> resolve_id kind value
               | _ -> resolve ~method_ ~context key value))
        | _ -> resolve_id kind value
      in
      Batch
        (List.map operations ~f:(fun op ->
           let method_ = Json.field op "method" |> Json.text in
           let params =
             match Json.field op "params" with
             | `Object fields ->
               Json.obj
                 (List.map fields ~f:(fun (key, value) ->
                    key, resolve ~method_ ~context:(identity_kind method_) key value))
             | _ -> Json.fail Invalid_argument "operation params must be an object"
           in
           match decode_one ~method_ ~params with
           | Ok command -> command
           | Error error -> raise (Json.Decode_error error))))
;;
