open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let obj fields = Api_codec.as_json (Api_codec.object_ fields)
let nullable f value = Option.value_map value ~default:`Null ~f
let optional_id of_string to_string = Api_codec.nullable (W.id of_string to_string)
let hold = Api_codec.as_json Planning_ticket_wire.Hold.codec

let history =
  obj
    (req "waivers" W.counter
     ++ req "reassessments" W.counter
     ++ req "prerequisites" W.counter
     ++ req "related" W.counter
     ++ req "labels" W.counter)
;;

let codec =
  obj
    (req "ticket_id" W.ticket
     ++ req "display_key" (Api_codec.text ~max_bytes:96)
     ++ req "title" (Api_codec.text ~max_bytes:65536)
     ++ req "objective" (Api_codec.text ~max_bytes:65536)
     ++ req "acceptance_criteria" (Api_codec.text ~max_bytes:65536)
     ++ req "revision" W.positive
     ++ req "membership_revision" W.positive
     ++ req "project_id" (optional_id Id.Project.of_string Id.Project.to_string)
     ++ req "parent_ticket_id" (Api_codec.nullable W.ticket)
     ++ req "milestone_id" (optional_id Id.Milestone.of_string Id.Milestone.to_string)
     ++ req "assignee_id" (Api_codec.nullable W.actor)
     ++ req "status_id" (optional_id Id.Status.of_string Id.Status.to_string)
     ++ req
          "status"
          (Api_codec.enum
             [ "backlog", Domain_command.Status.Backlog
             ; "todo", Todo
             ; "in_progress", In_progress
             ; "done", Done
             ; "canceled", Canceled
             ]
             ~equal:Domain_command.Status.equal)
     ++ req "archived" Api_codec.boolean
     ++ req "priority" W.counter
     ++ req
          "claim"
          (Api_codec.nullable (Api_codec.as_json Planning_ticket_wire.Ownership.codec))
     ++ req "hold" (Api_codec.nullable hold)
     ++ req "next_token" W.positive
     ++ req "reopened_token" (Api_codec.nullable W.positive)
     ++ req "excluded_arrays" history)
;;

let of_ticket (t : Planning_state.Ticket.t) =
  W.decode_exn
    codec
    (Json.obj
       [ "ticket_id", Id.Ticket.jsonaf_of_t t.id
       ; "display_key", Json.string t.display_key
       ; "title", Json.string t.title
       ; "objective", Json.string t.description
       ; "acceptance_criteria", Json.string t.acceptance_criteria
       ; "revision", Json.int t.revision
       ; "membership_revision", Json.int t.membership_revision
       ; "project_id", nullable Id.Project.jsonaf_of_t t.project
       ; "parent_ticket_id", nullable Id.Ticket.jsonaf_of_t t.parent
       ; "milestone_id", nullable Id.Milestone.jsonaf_of_t t.milestone
       ; "assignee_id", nullable Id.Actor.jsonaf_of_t t.assignee
       ; "status_id", nullable Id.Status.jsonaf_of_t t.status_id
       ; "status", Domain_command.Status.jsonaf_of_t t.status
       ; ("archived", if t.archived then `True else `False)
       ; "priority", Json.int t.priority
       ; "claim", nullable Planning_state.ownership_view_json t.claim
       ; ( "hold"
         , nullable
             (fun (h : Planning_state.Hold.t) ->
                Json.obj
                  [ "actor_id", Id.Actor.jsonaf_of_t h.actor
                  ; "reason", Json.string h.reason
                  ; "timestamp", Json.string h.timestamp
                  ])
             t.hold )
       ; "next_token", Json.int t.next_token
       ; "reopened_token", nullable Json.int t.reopened_token
       ; ( "excluded_arrays"
         , Json.obj
             [ "waivers", Json.int (List.length t.waivers)
             ; "reassessments", Json.int (List.length t.reassessments)
             ; "prerequisites", Json.int (List.length t.prerequisites)
             ; "related", Json.int (List.length t.related)
             ; "labels", Json.int (List.length t.labels)
             ] )
       ])
;;
