open Core
module Status = Workflow.Category

type t = Planning_command.t =
  | Batch of t list
  | Lifecycle of Ticket_lifecycle.Command.t
  | Communication of Communication.Command.t
  | Message_send of Communication.Message_send.t
  | Agent_run of Agent_run.Command.t
  | Facts of Facts.Command.t
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
      ; leaf_only : bool
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
  match Planning_api.decode_resolved ~method_ ~params with
  | Some result -> result
  | None ->
    Json.decode (fun () ->
      match method_ with
      | "message.send" ->
        (match Api_codec.decode Communication.Message_send.codec params with
         | Ok command -> Message_send command
         | Error error -> raise (Json.Decode_error error))
      | method_ when List.mem Facts.mutation_methods method_ ~equal:String.equal ->
        (match Facts.Command.decode ~method_ ~params with
         | Ok command -> Facts command
         | Error error -> raise (Json.Decode_error error))
      | method_
        when List.mem Agent_run_policy.mutation_methods method_ ~equal:String.equal ->
        (match Agent_run_policy.decode ~method_ ~params with
         | Ok command -> Policy command
         | Error error -> raise (Json.Decode_error error))
      | method_ when List.mem Agent_run.mutation_methods method_ ~equal:String.equal ->
        (match Agent_run.decode ~method_ ~params with
         | Ok command -> Agent_run command
         | Error error -> raise (Json.Decode_error error))
      | method_ when List.mem Evidence.mutation_methods method_ ~equal:String.equal ->
        (match Evidence.decode ~method_ ~params with
         | Ok command -> Evidence command
         | Error error -> raise (Json.Decode_error error))
      | method_ when List.mem Communication.mutation_methods method_ ~equal:String.equal
        ->
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
      let operations =
        match Api_codec.decode Transaction_api.request params with
        | Ok operations -> operations
        | Error problem -> raise (Json.Decode_error problem)
      in
      let aliases =
        List.fold operations ~init:String.Map.empty ~f:(fun aliases op ->
          match op.Planning_api.Operation.alias with
          | None -> aliases
          | Some alias ->
            if Map.mem aliases alias
            then Json.fail Invalid_argument ("duplicate alias: " ^ alias);
            let method_ = op.method_ in
            let params = op.params in
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
              | "run.register" -> "run", "target_run_id"
              | "attempt.start" -> "attempt", "attempt_id"
              | "contract.put"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "contract", "contract_id"
              | "manifest.publish"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "manifest", "manifest_id"
              | "decision.put"
                when Json.integer (Json.field params "expected_revision") = 0 ->
                "decision", "decision_id"
              | "review.record" -> "review", "review_id"
              | "validation.add" -> "validation", "validation_id"
              | "template.instantiate" -> "instance", "instance_id"
              | "template.instance_register" -> "instance", "instance_id"
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
          | "actor_id" | "reported_actor_id" | "reviewer_ids" | "member_ids" ->
            Some "actor"
          | "session_id" -> Some "session"
          | "project_id" -> Some "project"
          | "milestone_id" -> Some "milestone"
          | "ticket_id"
          | "ticket"
          | "prerequisite_id"
          | "related_id"
          | "prerequisite_ticket_ids"
          | "parent_ticket_id" -> Some "ticket"
          | "resource_id" | "resource" | "template" | "template_id" | "resource_ids" ->
            Some "resource"
          | "comment_id" | "comment" | "message" -> Some "comment"
          | "board_id" -> Some "board"
          | "thread_id" -> Some "thread"
          | "request_id" | "reply_to_request_id" | "review_request_id" | "review_request"
            -> Some "request"
          | "team_id" | "teams" -> Some "team"
          | "subscription_id" -> Some "subscription"
          | "instance_id" -> Some "instance"
          | "attempt" | "attempt_id" -> Some "attempt"
          | "run"
          | "run_id"
          | "target_run_id"
          | "old_run_id"
          | "parent_run_id"
          | "child_run_id"
          | "child" -> Some "run"
          | "parent" when String.equal method_ "run.register" -> Some "run"
          | "reply_to" | "reply_to_id" ->
            Some (if String.equal method_ "request.create" then "request" else "comment")
          | "contract_id" -> Some "contract"
          | "manifest_id" -> Some "manifest"
          | "review_id" -> Some "review"
          | "validation_id" -> Some "validation"
          | "decision_id" | "supersedes" -> Some "decision"
          | _ -> None
        in
        match key, value with
        | "value", _ when String.equal method_ "fact.put" -> value
        | "parameters", _ when String.is_prefix method_ ~prefix:"template." -> value
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
           let method_ = op.Planning_api.Operation.method_ in
           let params =
             match op.params with
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
