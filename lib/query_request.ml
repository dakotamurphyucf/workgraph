open Core

type t =
  | Workspace_get
  | Workspace_overview
  | Actor_list
  | Label_list
  | Status_list
  | Project_list
  | Project_get of Id.Project.t
  | Project_brief of Id.Project.t
  | Milestone_list
  | Milestone_get of Id.Milestone.t
  | Ticket_list
  | Ticket_ready
  | Ticket_resolve of string
  | Ticket_context of Id.Ticket.t
  | Ticket_blockers of Id.Ticket.t
  | Ticket_readiness of Id.Ticket.t
  | Comment_list
  | Comment_get of Id.Comment.t
  | Comment_history of Id.Comment.t
  | Handoff_get of Id.Ticket.t
  | Handoff_history of Id.Ticket.t
  | Activity_since of int
  | Search of string
  | Resource_list
  | Resource_get of Id.Resource.t
  | Resource_history of Id.Resource.t

let encode query ~workspace ~parameters =
  Json.decode (fun () ->
    let method_, fields =
      match query with
      | Workspace_get -> "workspace.get", []
      | Workspace_overview -> "workspace.overview", []
      | Actor_list -> "actor.list", []
      | Label_list -> "label.list", []
      | Status_list -> "status.list", []
      | Project_list -> "project.list", []
      | Project_get value -> "project.get", [ "project_id", Id.Project.jsonaf_of_t value ]
      | Project_brief value ->
        "project.brief", [ "project_id", Id.Project.jsonaf_of_t value ]
      | Milestone_list -> "milestone.list", []
      | Milestone_get value ->
        "milestone.get", [ "milestone_id", Id.Milestone.jsonaf_of_t value ]
      | Ticket_list -> "ticket.list", []
      | Ticket_ready -> "ticket.ready", []
      | Ticket_resolve key -> "ticket.resolve", [ "display_key", Json.string key ]
      | Ticket_context value ->
        "ticket.context", [ "ticket_id", Id.Ticket.jsonaf_of_t value ]
      | Ticket_blockers value ->
        "ticket.blockers", [ "ticket_id", Id.Ticket.jsonaf_of_t value ]
      | Ticket_readiness value ->
        "ticket.readiness", [ "ticket_id", Id.Ticket.jsonaf_of_t value ]
      | Comment_list -> "comment.list", []
      | Comment_get value -> "comment.get", [ "comment_id", Id.Comment.jsonaf_of_t value ]
      | Comment_history value ->
        "comment.history", [ "comment_id", Id.Comment.jsonaf_of_t value ]
      | Handoff_get value -> "handoff.get", [ "ticket_id", Id.Ticket.jsonaf_of_t value ]
      | Handoff_history value ->
        "handoff.history", [ "ticket_id", Id.Ticket.jsonaf_of_t value ]
      | Activity_since value -> "activity.since", [ "after", Json.int value ]
      | Search value -> "search.query", [ "text", Json.string value ]
      | Resource_list -> "resource.list", []
      | Resource_get value ->
        "resource.get", [ "resource_id", Id.Resource.jsonaf_of_t value ]
      | Resource_history value ->
        "resource.history", [ "resource_id", Id.Resource.jsonaf_of_t value ]
    in
    let reserved = "workspace_id" :: List.map fields ~f:fst in
    List.iter parameters ~f:(fun (key, _) ->
      if List.mem reserved key ~equal:String.equal
      then Json.fail Invalid_argument ("reserved query parameter: " ^ key));
    let params =
      Json.obj
        ((("workspace_id", Id.Workspace.jsonaf_of_t workspace) :: fields) @ parameters)
    in
    match Protocol.Request.create ~id:"client-query" ~method_ ~params with
    | Ok request -> request
    | Error error -> raise (Json.Decode_error error))
;;
