open Core

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let rec wire command =
  let open Domain_command in
  match Planning_api.encode command with
  | Some result -> unwrap result
  | None ->
    (match command with
     | Communication command -> unwrap (Communication.encode command)
     | Message_send command ->
       "message.send", unwrap (Api_codec.encode Communication.Message_send.codec command)
     | Agent_run command -> Agent_run.encode command
     | Facts command -> unwrap (Facts.Command.encode command)
     | Evidence command -> unwrap (Evidence.encode command)
     | Policy command -> Agent_run_policy.encode command
     | Batch commands ->
       ( "transaction.apply"
       , Json.obj
           [ ( "operations"
             , `Array
                 (List.map commands ~f:(fun command ->
                    let method_, params = wire command in
                    Json.obj [ "method", Json.string method_; "params", params ])) )
           ] )
     | Resource_publish _ ->
       Json.fail
         Invalid_argument
         "Resource_publish is internal; finish a verified upload instead"
     | Template_instantiate _
     | Settings_put _
     | Ticket_claim _
     | Ticket_claim_with_lease _
     | Comment_add _
     | Resource_link _
     | Lifecycle _
     | Claim_next _
     | Comment_edit _
     | Dependency_add _
     | Dependency_remove _
     | Dependency_waive _
     | Handoff_set _
     | Milestone_create _
     | Milestone_schedule _
     | Milestone_update _
     | Project_create _
     | Project_update _
     | Related_link _
     | Resource_metadata _
     | Resource_put _
     | Thread_reply _
     | Ticket_archive _
     | Ticket_complete _
     | Ticket_create _
     | Ticket_hold _
     | Ticket_metadata _
     | Ticket_move _
     | Ticket_progress _
     | Ticket_reassign _
     | Ticket_release _
     | Ticket_renew_lease _
     | Ticket_update _
     | Workspace_update _ ->
       Json.fail Invalid_argument "command is outside its planning wire contract")
;;

let encode command =
  Json.decode (fun () ->
    let method_, params = wire command in
    ignore (unwrap (Domain_command.decode ~method_ ~params) : Domain_command.t);
    method_, params)
;;
