open Core
open Planning_command
module Fields = Api_codec.Fields

let text = Api_codec.text ~max_bytes:65_536
let decimal = Api_codec.decimal ~max:Int.max_value
let decimal64 = Api_codec.decimal64 ~max:Int64.max_value
let boolean = Api_codec.boolean

let reference =
  Api_codec.map
    (Api_codec.text ~max_bytes:97)
    ~decode:(fun value ->
      let key =
        if String.is_prefix value ~prefix:"$" then String.drop_prefix value 1 else value
      in
      Result.map (Id.Actor.of_string key) ~f:(fun _ -> value))
    ~encode:Fn.id
    ~description:
      "Opaque ID, or $alias within transaction.apply; aliases resolve before command \
       preparation."
;;

let references = Api_codec.list reference ~max_items:65_536

let title =
  Api_codec.map
    (Api_codec.text ~max_bytes:512)
    ~decode:(fun value ->
      if String.is_empty (String.strip value)
      then Error (Problem.create Invalid_argument "empty title")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonblank title."
;;

let date =
  Api_codec.map
    (Api_codec.text ~max_bytes:10)
    ~decode:(fun value ->
      let valid_shape =
        String.length value = 10
        && Char.equal value.[4] '-'
        && Char.equal value.[7] '-'
        && String.for_all
             (String.sub value ~pos:0 ~len:4
              ^ String.sub value ~pos:5 ~len:2
              ^ String.sub value ~pos:8 ~len:2)
             ~f:Char.is_digit
      in
      let valid =
        if not valid_shape
        then false
        else (
          let year = Int.of_string (String.sub value ~pos:0 ~len:4) in
          let month = Int.of_string (String.sub value ~pos:5 ~len:2) in
          let day = Int.of_string (String.sub value ~pos:8 ~len:2) in
          let leap = year mod 4 = 0 && (year mod 100 <> 0 || year mod 400 = 0) in
          let days =
            match month with
            | 1 | 3 | 5 | 7 | 8 | 10 | 12 -> 31
            | 4 | 6 | 9 | 11 -> 30
            | 2 -> if leap then 29 else 28
            | _ -> 0
          in
          day > 0 && day <= days)
      in
      if valid
      then Ok value
      else
        Error
          (Problem.create Invalid_argument "target_date must be a valid YYYY-MM-DD date"))
    ~encode:Fn.id
    ~description:"Valid Gregorian calendar date in YYYY-MM-DD form."
;;

let status =
  Api_codec.enum
    [ "backlog", Status.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Status.equal
;;

let kind =
  Api_codec.enum
    [ "comment", Discussion.Kind.Comment
    ; "progress", Progress
    ; "decision", Decision
    ; "blocker", Blocker
    ; "evidence", Evidence
    ]
    ~equal:Discussion.Kind.equal
;;

let required_id name = function
  | Some value -> value
  | None -> Json.fail Invalid_argument ("unresolved generated ID: " ^ name)
;;

type entry =
  | Entry :
      { name : string
      ; request : 'request Api_codec.t
      ; command : 'request -> Planning_command.t
      ; project : Planning_command.t -> 'request option
      }
      -> entry

let ( ++ ) = Fields.both

module Workspace_update_request = struct
  type t =
    { expected_revision : int
    ; name : string option
    ; description : string option
    ; instructions : string option
    ; summary : string option
    ; archived : bool option
    }
end

module Project_update_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; title : string option
    ; description : string option
    ; status : Status.t option
    ; priority : int option
    ; summary : string option
    ; acceptance_criteria : string option
    ; archived : bool option
    }
end

module Milestone_update_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; title : string option
    ; description : string option
    ; status : Status.t option
    ; archived : bool option
    }
end

module Ticket_create_request = struct
  type t =
    { id : string option
    ; title : string
    ; description : string option
    ; project : string option
    ; parent : string option
    ; milestone : string option
    }
end

module Thread_reply_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; comment_id : string option
    ; reply_to : string option
    ; kind : Discussion.Kind.t option
    ; body : string
    }
end

module Resource_put_text_request = struct
  type t =
    { id : string option
    ; expected_revision : int
    ; title : string
    ; text : string
    ; filename : string option
    ; mime_type : string option
    }
end

module Resource_update_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; title : string option
    ; filename : string option
    ; mime_type : string option
    ; description : string option
    ; archived : bool option
    }
end

module Ticket_metadata_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; priority : int option
    ; assignee : string option option
    ; labels : string list option
    ; acceptance_criteria : string option
    ; status_id : string option option
    }
end

module Handoff_set_request = struct
  type t =
    { ticket : string
    ; expected_revision : int
    ; token : int option
    ; summary : string
    ; next_steps : string
    ; evidence : string
    ; objective : string option
    ; completed : string option
    ; decisions : string option
    ; blockers : string option
    ; resources : string list option
    ; covers_through : int option
    }
end

module Workspace_archive_request = struct
  type t =
    { expected_revision : int
    ; name : string option
    ; description : string option
    ; instructions : string option
    ; summary : string option
    ; archived : bool
    }
end

module Project_archive_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; title : string option
    ; description : string option
    ; status : Status.t option
    ; priority : int option
    ; summary : string option
    ; acceptance_criteria : string option
    ; archived : bool
    }
end

module Milestone_archive_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; title : string option
    ; description : string option
    ; status : Status.t option
    ; archived : bool
    }
end

module Resource_archive_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; title : string option
    ; filename : string option
    ; mime_type : string option
    ; description : string option
    ; archived : bool
    }
end

let resource_request codec =
  Api_codec.map
    codec
    ~decode:(fun (request : Resource_put_text_request.t) ->
      if Option.is_none request.id && request.expected_revision <> 0
      then
        Error
          (Problem.create
             Invalid_argument
             "resource_id is required when expected_revision is nonzero")
      else Ok request)
    ~encode:Fn.id
    ~description:"resource_id may be omitted only to create at expected_revision zero."
;;

let entries =
  [ Entry
      { name = "workspace.update"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "expected_revision" decimal
                ++ Fields.optional "name" text
                ++ Fields.optional "description" text
                ++ Fields.optional "instructions" text
                ++ Fields.optional "summary" text
                ++ Fields.optional "archived" boolean)
               ~decode:
                 (fun
                   ( ((((expected_revision, name), description), instructions), summary)
                   , archived ) ->
                 { Workspace_update_request.expected_revision
                 ; name
                 ; description
                 ; instructions
                 ; summary
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ expected_revision
                    ; name
                    ; description
                    ; instructions
                    ; summary
                    ; archived
                    } :
                     Workspace_update_request.t) ->
                 ( ((((expected_revision, name), description), instructions), summary)
                 , archived )))
      ; command =
          (fun ({ expected_revision; name; description; instructions; summary; archived } :
                 Workspace_update_request.t) ->
            Workspace_update
              { expected_revision; name; description; instructions; summary; archived })
      ; project =
          (function
            | Workspace_update
                { expected_revision; name; description; instructions; summary; archived }
              ->
              Some
                { Workspace_update_request.expected_revision
                ; name
                ; description
                ; instructions
                ; summary
                ; archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "project.create"
      ; request =
          Api_codec.object_
            (Fields.optional "project_id" reference
             ++ Fields.required "title" title
             ++ Fields.optional "description" text)
      ; command =
          (fun ((id, title), description) ->
            Project_create
              { id = Id.Project.t_of_jsonaf (Json.string (required_id "project_id" id))
              ; title
              ; description = Option.value description ~default:""
              })
      ; project =
          (function
            | Project_create { id; title; description } ->
              Some ((Some (Id.Project.to_string id), title), Some description)
            | _ -> None)
      }
  ; Entry
      { name = "project.update"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "project_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "title" title
                ++ Fields.optional "description" text
                ++ Fields.optional "status" status
                ++ Fields.optional "priority" decimal
                ++ Fields.optional "summary" text
                ++ Fields.optional "acceptance_criteria" text
                ++ Fields.optional "archived" boolean)
               ~decode:
                 (fun
                   ( ( ( ( ((((id, expected_revision), title), description), status)
                         , priority )
                       , summary )
                     , acceptance_criteria )
                   , archived ) ->
                 { Project_update_request.id
                 ; expected_revision
                 ; title
                 ; description
                 ; status
                 ; priority
                 ; summary
                 ; acceptance_criteria
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ id
                    ; expected_revision
                    ; title
                    ; description
                    ; status
                    ; priority
                    ; summary
                    ; acceptance_criteria
                    ; archived
                    } :
                     Project_update_request.t) ->
                 ( ( ( ( ((((id, expected_revision), title), description), status)
                       , priority )
                     , summary )
                   , acceptance_criteria )
                 , archived )))
      ; command =
          (fun ({ id
                ; expected_revision
                ; title
                ; description
                ; status
                ; priority
                ; summary
                ; acceptance_criteria
                ; archived
                } :
                 Project_update_request.t) ->
            Project_update
              { id = (fun value -> Id.Project.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; description
              ; status
              ; priority
              ; summary
              ; acceptance_criteria
              ; archived
              })
      ; project =
          (function
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
              Some
                { Project_update_request.id = Id.Project.to_string id
                ; expected_revision
                ; title
                ; description
                ; status
                ; priority
                ; summary
                ; acceptance_criteria
                ; archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "milestone.create"
      ; request =
          Api_codec.object_
            (Fields.optional "milestone_id" reference
             ++ Fields.required "project_id" reference
             ++ Fields.required "title" title
             ++ Fields.optional "description" text
             ++ Fields.optional "target_date" date)
      ; command =
          (fun ((((id, project), title), description), target_date) ->
            Milestone_create
              { id =
                  Id.Milestone.t_of_jsonaf (Json.string (required_id "milestone_id" id))
              ; project =
                  (fun value -> Id.Project.t_of_jsonaf (Json.string value)) project
              ; title
              ; description = Option.value description ~default:""
              ; target_date
              })
      ; project =
          (function
            | Milestone_create { id; project; title; description; target_date } ->
              Some
                ( ( ( (Some (Id.Milestone.to_string id), Id.Project.to_string project)
                    , title )
                  , Some description )
                , target_date )
            | _ -> None)
      }
  ; Entry
      { name = "milestone.update"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "milestone_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "title" title
                ++ Fields.optional "description" text
                ++ Fields.optional "status" status
                ++ Fields.optional "archived" boolean)
               ~decode:
                 (fun
                   (((((id, expected_revision), title), description), status), archived) ->
                 { Milestone_update_request.id
                 ; expected_revision
                 ; title
                 ; description
                 ; status
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ id; expected_revision; title; description; status; archived } :
                     Milestone_update_request.t) ->
                 ((((id, expected_revision), title), description), status), archived))
      ; command =
          (fun ({ id; expected_revision; title; description; status; archived } :
                 Milestone_update_request.t) ->
            Milestone_update
              { id = (fun value -> Id.Milestone.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; description
              ; status
              ; archived
              })
      ; project =
          (function
            | Milestone_update
                { id; expected_revision; title; description; status; archived } ->
              Some
                { Milestone_update_request.id = Id.Milestone.to_string id
                ; expected_revision
                ; title
                ; description
                ; status
                ; archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "milestone.schedule"
      ; request =
          Api_codec.object_
            (Fields.required "milestone_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "target_date" (Api_codec.nullable date))
      ; command =
          (fun ((id, expected_revision), target_date) ->
            Milestone_schedule
              { id = (fun value -> Id.Milestone.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; target_date
              })
      ; project =
          (function
            | Milestone_schedule { id; expected_revision; target_date } ->
              Some ((Id.Milestone.to_string id, expected_revision), target_date)
            | _ -> None)
      }
  ; Entry
      { name = "ticket.create"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.optional "ticket_id" reference
                ++ Fields.required "title" title
                ++ Fields.optional "description" text
                ++ Fields.optional "project_id" reference
                ++ Fields.optional "parent_ticket_id" reference
                ++ Fields.optional "milestone_id" reference)
               ~decode:
                 (fun
                   (((((id, title), description), project), parent), milestone) ->
                 { Ticket_create_request.id
                 ; title
                 ; description
                 ; project
                 ; parent
                 ; milestone
                 })
               ~encode:
                 (fun
                   ({ id; title; description; project; parent; milestone } :
                     Ticket_create_request.t) ->
                 ((((id, title), description), project), parent), milestone))
      ; command =
          (fun ({ id; title; description; project; parent; milestone } :
                 Ticket_create_request.t) ->
            Ticket_create
              { id = Id.Ticket.t_of_jsonaf (Json.string (required_id "ticket_id" id))
              ; title
              ; description = Option.value description ~default:""
              ; project =
                  Option.map project ~f:(fun value ->
                    Id.Project.t_of_jsonaf (Json.string value))
              ; parent =
                  Option.map parent ~f:(fun value ->
                    Id.Ticket.t_of_jsonaf (Json.string value))
              ; milestone =
                  Option.map milestone ~f:(fun value ->
                    Id.Milestone.t_of_jsonaf (Json.string value))
              })
      ; project =
          (function
            | Ticket_create { id; title; description; project; parent; milestone } ->
              Some
                { Ticket_create_request.id = Some (Id.Ticket.to_string id)
                ; title
                ; description = Some description
                ; project = Option.map project ~f:Id.Project.to_string
                ; parent = Option.map parent ~f:Id.Ticket.to_string
                ; milestone = Option.map milestone ~f:Id.Milestone.to_string
                }
            | _ -> None)
      }
  ; Entry
      { name = "ticket.update"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.optional "title" title
             ++ Fields.optional "description" text
             ++ Fields.optional "status" status)
      ; command =
          (fun ((((id, expected_revision), title), description), status) ->
            Ticket_update
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; description
              ; status
              })
      ; project =
          (function
            | Ticket_update { id; expected_revision; title; description; status } ->
              Some
                ( (((Id.Ticket.to_string id, expected_revision), title), description)
                , status )
            | _ -> None)
      }
  ; Entry
      { name = "ticket.move"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "project_id" (Api_codec.nullable reference)
             ++ Fields.required "milestone_id" (Api_codec.nullable reference)
             ++ Fields.required "parent_ticket_id" (Api_codec.nullable reference))
      ; command =
          (fun ((((id, expected_revision), project), milestone), parent) ->
            Ticket_move
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; project =
                  Option.map project ~f:(fun value ->
                    Id.Project.t_of_jsonaf (Json.string value))
              ; milestone =
                  Option.map milestone ~f:(fun value ->
                    Id.Milestone.t_of_jsonaf (Json.string value))
              ; parent =
                  Option.map parent ~f:(fun value ->
                    Id.Ticket.t_of_jsonaf (Json.string value))
              })
      ; project =
          (function
            | Ticket_move { id; expected_revision; project; milestone; parent } ->
              Some
                ( ( ( (Id.Ticket.to_string id, expected_revision)
                    , Option.map project ~f:Id.Project.to_string )
                  , Option.map milestone ~f:Id.Milestone.to_string )
                , Option.map parent ~f:Id.Ticket.to_string )
            | _ -> None)
      }
  ; Entry
      { name = "ticket.archive"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "archived" boolean)
      ; command =
          (fun ((id, expected_revision), archived) ->
            Ticket_archive
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; archived
              })
      ; project =
          (function
            | Ticket_archive { id; expected_revision; archived } ->
              Some ((Id.Ticket.to_string id, expected_revision), archived)
            | _ -> None)
      }
  ; Entry
      { name = "ticket.hold"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "reason" (Api_codec.nullable text))
      ; command =
          (fun ((id, expected_revision), reason) ->
            Ticket_hold
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; reason
              })
      ; project =
          (function
            | Ticket_hold { id; expected_revision; reason } ->
              Some ((Id.Ticket.to_string id, expected_revision), reason)
            | _ -> None)
      }
  ; Entry
      { name = "dependency.waive"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "prerequisite_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "reason" (Api_codec.nullable text))
      ; command =
          (fun (((ticket, prerequisite), expected_revision), reason) ->
            Dependency_waive
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; prerequisite =
                  (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) prerequisite
              ; expected_revision
              ; reason
              })
      ; project =
          (function
            | Dependency_waive { ticket; prerequisite; expected_revision; reason } ->
              Some
                ( ( (Id.Ticket.to_string ticket, Id.Ticket.to_string prerequisite)
                  , expected_revision )
                , reason )
            | _ -> None)
      }
  ; Entry
      { name = "dependency.add"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "prerequisite_id" reference)
      ; command =
          (fun (ticket, prerequisite) ->
            Dependency_add
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; prerequisite =
                  (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) prerequisite
              })
      ; project =
          (function
            | Dependency_add { ticket; prerequisite } ->
              Some (Id.Ticket.to_string ticket, Id.Ticket.to_string prerequisite)
            | _ -> None)
      }
  ; Entry
      { name = "dependency.remove"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "prerequisite_id" reference)
      ; command =
          (fun (ticket, prerequisite) ->
            Dependency_remove
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; prerequisite =
                  (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) prerequisite
              })
      ; project =
          (function
            | Dependency_remove { ticket; prerequisite } ->
              Some (Id.Ticket.to_string ticket, Id.Ticket.to_string prerequisite)
            | _ -> None)
      }
  ; Entry
      { name = "related.add"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "related_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "related_expected_revision" decimal)
      ; command =
          (fun (((ticket, related), expected_revision), related_expected_revision) ->
            Related_link
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; related = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) related
              ; expected_revision
              ; related_expected_revision
              ; linked = true
              })
      ; project =
          (function
            | Related_link
                { ticket; related; expected_revision; related_expected_revision; linked }
              when Bool.equal linked true ->
              Some
                ( ( (Id.Ticket.to_string ticket, Id.Ticket.to_string related)
                  , expected_revision )
                , related_expected_revision )
            | _ -> None)
      }
  ; Entry
      { name = "related.remove"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "related_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "related_expected_revision" decimal)
      ; command =
          (fun (((ticket, related), expected_revision), related_expected_revision) ->
            Related_link
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; related = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) related
              ; expected_revision
              ; related_expected_revision
              ; linked = false
              })
      ; project =
          (function
            | Related_link
                { ticket; related; expected_revision; related_expected_revision; linked }
              when Bool.equal linked false ->
              Some
                ( ( (Id.Ticket.to_string ticket, Id.Ticket.to_string related)
                  , expected_revision )
                , related_expected_revision )
            | _ -> None)
      }
  ; Entry
      { name = "ticket.renew_lease"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "token" decimal
             ++ Fields.required "expected_lease_revision" decimal)
      ; command =
          (fun ((id, token), expected_lease_revision) ->
            Ticket_renew_lease
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; token
              ; expected_lease_revision
              })
      ; project =
          (function
            | Ticket_renew_lease { id; token; expected_lease_revision } ->
              Some ((Id.Ticket.to_string id, token), expected_lease_revision)
            | _ -> None)
      }
  ; Entry
      { name = "ticket.release"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference ++ Fields.required "token" decimal)
      ; command =
          (fun (id, token) ->
            Ticket_release
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id; token })
      ; project =
          (function
            | Ticket_release { id; token } -> Some (Id.Ticket.to_string id, token)
            | _ -> None)
      }
  ; Entry
      { name = "ticket.complete"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "token" decimal
             ++ Fields.required "evidence" text)
      ; command =
          (fun ((id, token), evidence) ->
            Ticket_complete
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; token
              ; evidence
              })
      ; project =
          (function
            | Ticket_complete { id; token; evidence } ->
              Some ((Id.Ticket.to_string id, token), evidence)
            | _ -> None)
      }
  ; Entry
      { name = "ticket.progress"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "token" decimal
             ++ Fields.optional "kind" kind
             ++ Fields.required "body" text)
      ; command =
          (fun (((ticket, token), kind), body) ->
            Ticket_progress
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; token
              ; kind = Option.value kind ~default:Discussion.Kind.Progress
              ; body
              })
      ; project =
          (function
            | Ticket_progress { ticket; token; kind; body } ->
              Some (((Id.Ticket.to_string ticket, token), Some kind), body)
            | _ -> None)
      }
  ; Entry
      { name = "thread.reply"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "thread_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "comment_id" reference
                ++ Fields.optional "reply_to_id" reference
                ++ Fields.optional "kind" kind
                ++ Fields.required "body" text)
               ~decode:
                 (fun
                   (((((id, expected_revision), comment_id), reply_to), kind), body) ->
                 { Thread_reply_request.id
                 ; expected_revision
                 ; comment_id
                 ; reply_to
                 ; kind
                 ; body
                 })
               ~encode:
                 (fun
                   ({ id; expected_revision; comment_id; reply_to; kind; body } :
                     Thread_reply_request.t) ->
                 ((((id, expected_revision), comment_id), reply_to), kind), body))
      ; command =
          (fun ({ id; expected_revision; comment_id; reply_to; kind; body } :
                 Thread_reply_request.t) ->
            Thread_reply
              { id =
                  (fun value -> Communication_id.Thread.t_of_jsonaf (Json.string value))
                    id
              ; expected_revision
              ; comment_id =
                  Option.map comment_id ~f:(fun value ->
                    Id.Comment.t_of_jsonaf (Json.string value))
              ; reply_to =
                  Option.map reply_to ~f:(fun value ->
                    Id.Comment.t_of_jsonaf (Json.string value))
              ; kind = Option.value kind ~default:Discussion.Kind.Comment
              ; body
              })
      ; project =
          (function
            | Thread_reply { id; expected_revision; comment_id; reply_to; kind; body } ->
              Some
                { Thread_reply_request.id = Communication_id.Thread.to_string id
                ; expected_revision
                ; comment_id = Option.map comment_id ~f:Id.Comment.to_string
                ; reply_to = Option.map reply_to ~f:Id.Comment.to_string
                ; kind = Some kind
                ; body
                }
            | _ -> None)
      }
  ; Entry
      { name = "ticket.claim_next"
      ; request =
          Api_codec.object_
            (Fields.required "attempt_id" reference
             ++ Fields.required "target_run_id" reference
             ++ Fields.optional "project_id" reference
             ++ Fields.optional "lease_duration_ms" decimal64
             ++ Fields.optional "leaf_only" boolean)
      ; command =
          (fun ((((attempt, run), project), lease_duration_ms), leaf_only) ->
            Claim_next
              { attempt =
                  (fun value -> Attempt.Id.t_of_jsonaf (Json.string value)) attempt
              ; run = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) run
              ; project =
                  Option.map project ~f:(fun value ->
                    Id.Project.t_of_jsonaf (Json.string value))
              ; lease_duration_ms
              ; leaf_only = Option.value leaf_only ~default:false
              })
      ; project =
          (function
            | Claim_next { attempt; run; project; lease_duration_ms; leaf_only } ->
              Some
                ( ( ( (Attempt.Id.to_string attempt, Id.Run.to_string run)
                    , Option.map project ~f:Id.Project.to_string )
                  , lease_duration_ms )
                , Some leaf_only )
            | _ -> None)
      }
  ; Entry
      { name = "resource.put_text"
      ; request =
          resource_request
            (Api_codec.object_
               (Fields.map
                  (Fields.optional "resource_id" reference
                   ++ Fields.required "expected_revision" decimal
                   ++ Fields.required "title" title
                   ++ Fields.required "text" text
                   ++ Fields.optional "filename" text
                   ++ Fields.optional "mime_type" text)
                  ~decode:
                    (fun
                      (((((id, expected_revision), title), text), filename), mime_type) ->
                    { Resource_put_text_request.id
                    ; expected_revision
                    ; title
                    ; text
                    ; filename
                    ; mime_type
                    })
                  ~encode:
                    (fun
                      ({ id; expected_revision; title; text; filename; mime_type } :
                        Resource_put_text_request.t) ->
                    ((((id, expected_revision), title), text), filename), mime_type)))
      ; command =
          (fun ({ id; expected_revision; title; text; filename; mime_type } :
                 Resource_put_text_request.t) ->
            Resource_put
              { id = Id.Resource.t_of_jsonaf (Json.string (required_id "resource_id" id))
              ; expected_revision
              ; title
              ; text
              ; filename
              ; mime_type
              })
      ; project =
          (function
            | Resource_put { id; expected_revision; title; text; filename; mime_type } ->
              Some
                { Resource_put_text_request.id = Some (Id.Resource.to_string id)
                ; expected_revision
                ; title
                ; text
                ; filename
                ; mime_type
                }
            | _ -> None)
      }
  ; Entry
      { name = "resource.update"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "resource_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "title" text
                ++ Fields.optional "filename" text
                ++ Fields.optional "mime_type" text
                ++ Fields.optional "description" text
                ++ Fields.optional "archived" boolean)
               ~decode:
                 (fun
                   ( ( ((((id, expected_revision), title), filename), mime_type)
                     , description )
                   , archived ) ->
                 { Resource_update_request.id
                 ; expected_revision
                 ; title
                 ; filename
                 ; mime_type
                 ; description
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ id
                    ; expected_revision
                    ; title
                    ; filename
                    ; mime_type
                    ; description
                    ; archived
                    } :
                     Resource_update_request.t) ->
                 ( (((((id, expected_revision), title), filename), mime_type), description)
                 , archived )))
      ; command =
          (fun ({ id
                ; expected_revision
                ; title
                ; filename
                ; mime_type
                ; description
                ; archived
                } :
                 Resource_update_request.t) ->
            Resource_metadata
              { id = (fun value -> Id.Resource.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; filename
              ; mime_type
              ; description
              ; archived
              })
      ; project =
          (function
            | Resource_metadata
                { id
                ; expected_revision
                ; title
                ; filename
                ; mime_type
                ; description
                ; archived
                } ->
              Some
                { Resource_update_request.id = Id.Resource.to_string id
                ; expected_revision
                ; title
                ; filename
                ; mime_type
                ; description
                ; archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "ticket.metadata"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "ticket_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "priority" decimal
                ++ Fields.optional "assignee_id" (Api_codec.nullable reference)
                ++ Fields.optional "label_ids" references
                ++ Fields.optional "acceptance_criteria" text
                ++ Fields.optional "status_id" (Api_codec.nullable reference))
               ~decode:
                 (fun
                   ( ( ((((id, expected_revision), priority), assignee), labels)
                     , acceptance_criteria )
                   , status_id ) ->
                 { Ticket_metadata_request.id
                 ; expected_revision
                 ; priority
                 ; assignee
                 ; labels
                 ; acceptance_criteria
                 ; status_id
                 })
               ~encode:
                 (fun
                   ({ id
                    ; expected_revision
                    ; priority
                    ; assignee
                    ; labels
                    ; acceptance_criteria
                    ; status_id
                    } :
                     Ticket_metadata_request.t) ->
                 ( ( ((((id, expected_revision), priority), assignee), labels)
                   , acceptance_criteria )
                 , status_id )))
      ; command =
          (fun ({ id
                ; expected_revision
                ; priority
                ; assignee
                ; labels
                ; acceptance_criteria
                ; status_id
                } :
                 Ticket_metadata_request.t) ->
            Ticket_metadata
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; priority
              ; assignee =
                  Option.map assignee ~f:(fun value ->
                    Option.map value ~f:(fun value ->
                      Id.Actor.t_of_jsonaf (Json.string value)))
              ; labels =
                  Option.map labels ~f:(fun values ->
                    List.map values ~f:(fun value ->
                      Id.Label.t_of_jsonaf (Json.string value)))
              ; acceptance_criteria
              ; status_id =
                  Option.map status_id ~f:(fun value ->
                    Option.map value ~f:(fun value ->
                      Id.Status.t_of_jsonaf (Json.string value)))
              })
      ; project =
          (function
            | Ticket_metadata
                { id
                ; expected_revision
                ; priority
                ; assignee
                ; labels
                ; acceptance_criteria
                ; status_id
                } ->
              Some
                { Ticket_metadata_request.id = Id.Ticket.to_string id
                ; expected_revision
                ; priority
                ; assignee =
                    Option.map assignee ~f:(fun value ->
                      Option.map value ~f:Id.Actor.to_string)
                ; labels =
                    Option.map labels ~f:(fun values ->
                      List.map values ~f:Id.Label.to_string)
                ; acceptance_criteria
                ; status_id =
                    Option.map status_id ~f:(fun value ->
                      Option.map value ~f:Id.Status.to_string)
                }
            | _ -> None)
      }
  ; Entry
      { name = "ticket.reassign"
      ; request =
          Api_codec.object_
            (Fields.required "ticket_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "claimant_id" (Api_codec.nullable reference)
             ++ Fields.optional "claimant_run_id" reference
             ++ Fields.required "reason" text)
      ; command =
          (fun ((((id, expected_revision), claimant), claimant_run), reason) ->
            Ticket_reassign
              { id = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; claimant =
                  Option.map claimant ~f:(fun value ->
                    Id.Actor.t_of_jsonaf (Json.string value))
              ; claimant_run =
                  Option.map claimant_run ~f:(fun value ->
                    Id.Run.t_of_jsonaf (Json.string value))
              ; reason
              })
      ; project =
          (function
            | Ticket_reassign { id; expected_revision; claimant; claimant_run; reason } ->
              Some
                ( ( ( (Id.Ticket.to_string id, expected_revision)
                    , Option.map claimant ~f:Id.Actor.to_string )
                  , Option.map claimant_run ~f:Id.Run.to_string )
                , reason )
            | _ -> None)
      }
  ; Entry
      { name = "handoff.set"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "ticket_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "token" decimal
                ++ Fields.required "summary" text
                ++ Fields.required "next_steps" text
                ++ Fields.required "evidence" text
                ++ Fields.optional "objective" text
                ++ Fields.optional "completed" text
                ++ Fields.optional "decisions" text
                ++ Fields.optional "blockers" text
                ++ Fields.optional "resource_ids" references
                ++ Fields.optional "covers_through" decimal)
               ~decode:
                 (fun
                   ( ( ( ( ( ( ( ( (((ticket, expected_revision), token), summary)
                                 , next_steps )
                               , evidence )
                             , objective )
                           , completed )
                         , decisions )
                       , blockers )
                     , resources )
                   , covers_through ) ->
                 { Handoff_set_request.ticket
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
                 })
               ~encode:
                 (fun
                   ({ ticket
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
                    } :
                     Handoff_set_request.t) ->
                 ( ( ( ( ( ( ( ( (((ticket, expected_revision), token), summary)
                               , next_steps )
                             , evidence )
                           , objective )
                         , completed )
                       , decisions )
                     , blockers )
                   , resources )
                 , covers_through )))
      ; command =
          (fun ({ ticket
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
                } :
                 Handoff_set_request.t) ->
            Handoff_set
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; expected_revision
              ; token
              ; summary
              ; next_steps
              ; evidence
              ; objective = Option.value objective ~default:""
              ; completed = Option.value completed ~default:""
              ; decisions = Option.value decisions ~default:""
              ; blockers = Option.value blockers ~default:""
              ; resources =
                  (fun values ->
                     List.map values ~f:(fun value ->
                       Id.Resource.t_of_jsonaf (Json.string value)))
                    (Option.value resources ~default:[])
              ; covers_through
              })
      ; project =
          (function
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
              Some
                { Handoff_set_request.ticket = Id.Ticket.to_string ticket
                ; expected_revision
                ; token
                ; summary
                ; next_steps
                ; evidence
                ; objective = Some objective
                ; completed = Some completed
                ; decisions = Some decisions
                ; blockers = Some blockers
                ; resources =
                    Some
                      ((fun values -> List.map values ~f:Id.Resource.to_string) resources)
                ; covers_through
                }
            | _ -> None)
      }
  ; Entry
      { name = "comment.edit"
      ; request =
          Api_codec.object_
            (Fields.required "comment_id" reference
             ++ Fields.required "expected_revision" decimal
             ++ Fields.required "body" text)
      ; command =
          (fun ((id, expected_revision), body) ->
            Comment_edit
              { id = (fun value -> Id.Comment.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; body
              ; tombstone = false
              })
      ; project =
          (function
            | Comment_edit { id; expected_revision; body; tombstone }
              when Bool.equal tombstone false ->
              Some ((Id.Comment.to_string id, expected_revision), body)
            | _ -> None)
      }
  ; Entry
      { name = "comment.tombstone"
      ; request =
          Api_codec.object_
            (Fields.required "comment_id" reference
             ++ Fields.required "expected_revision" decimal)
      ; command =
          (fun (id, expected_revision) ->
            Comment_edit
              { id = (fun value -> Id.Comment.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; tombstone = true
              ; body = ""
              })
      ; project =
          (function
            | Comment_edit { id; expected_revision; tombstone; body }
              when Bool.equal tombstone true && String.is_empty body ->
              Some (Id.Comment.to_string id, expected_revision)
            | _ -> None)
      }
  ; Entry
      { name = "workspace.archive"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "expected_revision" decimal
                ++ Fields.optional "name" text
                ++ Fields.optional "description" text
                ++ Fields.optional "instructions" text
                ++ Fields.optional "summary" text
                ++ Fields.required "archived" boolean)
               ~decode:
                 (fun
                   ( ((((expected_revision, name), description), instructions), summary)
                   , archived ) ->
                 { Workspace_archive_request.expected_revision
                 ; name
                 ; description
                 ; instructions
                 ; summary
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ expected_revision
                    ; name
                    ; description
                    ; instructions
                    ; summary
                    ; archived
                    } :
                     Workspace_archive_request.t) ->
                 ( ((((expected_revision, name), description), instructions), summary)
                 , archived )))
      ; command =
          (fun ({ expected_revision; name; description; instructions; summary; archived } :
                 Workspace_archive_request.t) ->
            Workspace_update
              { expected_revision
              ; name
              ; description
              ; instructions
              ; summary
              ; archived = Some archived
              })
      ; project =
          (function
            | Workspace_update
                { expected_revision; name; description; instructions; summary; archived }
              when Option.is_some archived ->
              Some
                { Workspace_archive_request.expected_revision
                ; name
                ; description
                ; instructions
                ; summary
                ; archived = Option.value_exn archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "project.archive"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "project_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "title" title
                ++ Fields.optional "description" text
                ++ Fields.optional "status" status
                ++ Fields.optional "priority" decimal
                ++ Fields.optional "summary" text
                ++ Fields.optional "acceptance_criteria" text
                ++ Fields.required "archived" boolean)
               ~decode:
                 (fun
                   ( ( ( ( ((((id, expected_revision), title), description), status)
                         , priority )
                       , summary )
                     , acceptance_criteria )
                   , archived ) ->
                 { Project_archive_request.id
                 ; expected_revision
                 ; title
                 ; description
                 ; status
                 ; priority
                 ; summary
                 ; acceptance_criteria
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ id
                    ; expected_revision
                    ; title
                    ; description
                    ; status
                    ; priority
                    ; summary
                    ; acceptance_criteria
                    ; archived
                    } :
                     Project_archive_request.t) ->
                 ( ( ( ( ((((id, expected_revision), title), description), status)
                       , priority )
                     , summary )
                   , acceptance_criteria )
                 , archived )))
      ; command =
          (fun ({ id
                ; expected_revision
                ; title
                ; description
                ; status
                ; priority
                ; summary
                ; acceptance_criteria
                ; archived
                } :
                 Project_archive_request.t) ->
            Project_update
              { id = (fun value -> Id.Project.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; description
              ; status
              ; priority
              ; summary
              ; acceptance_criteria
              ; archived = Some archived
              })
      ; project =
          (function
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
                }
              when Option.is_some archived ->
              Some
                { Project_archive_request.id = Id.Project.to_string id
                ; expected_revision
                ; title
                ; description
                ; status
                ; priority
                ; summary
                ; acceptance_criteria
                ; archived = Option.value_exn archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "milestone.archive"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "milestone_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "title" title
                ++ Fields.optional "description" text
                ++ Fields.optional "status" status
                ++ Fields.required "archived" boolean)
               ~decode:
                 (fun
                   (((((id, expected_revision), title), description), status), archived) ->
                 { Milestone_archive_request.id
                 ; expected_revision
                 ; title
                 ; description
                 ; status
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ id; expected_revision; title; description; status; archived } :
                     Milestone_archive_request.t) ->
                 ((((id, expected_revision), title), description), status), archived))
      ; command =
          (fun ({ id; expected_revision; title; description; status; archived } :
                 Milestone_archive_request.t) ->
            Milestone_update
              { id = (fun value -> Id.Milestone.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; description
              ; status
              ; archived = Some archived
              })
      ; project =
          (function
            | Milestone_update
                { id; expected_revision; title; description; status; archived }
              when Option.is_some archived ->
              Some
                { Milestone_archive_request.id = Id.Milestone.to_string id
                ; expected_revision
                ; title
                ; description
                ; status
                ; archived = Option.value_exn archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "resource.archive"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "resource_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.optional "title" text
                ++ Fields.optional "filename" text
                ++ Fields.optional "mime_type" text
                ++ Fields.optional "description" text
                ++ Fields.required "archived" boolean)
               ~decode:
                 (fun
                   ( ( ((((id, expected_revision), title), filename), mime_type)
                     , description )
                   , archived ) ->
                 { Resource_archive_request.id
                 ; expected_revision
                 ; title
                 ; filename
                 ; mime_type
                 ; description
                 ; archived
                 })
               ~encode:
                 (fun
                   ({ id
                    ; expected_revision
                    ; title
                    ; filename
                    ; mime_type
                    ; description
                    ; archived
                    } :
                     Resource_archive_request.t) ->
                 ( (((((id, expected_revision), title), filename), mime_type), description)
                 , archived )))
      ; command =
          (fun ({ id
                ; expected_revision
                ; title
                ; filename
                ; mime_type
                ; description
                ; archived
                } :
                 Resource_archive_request.t) ->
            Resource_metadata
              { id = (fun value -> Id.Resource.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; title
              ; filename
              ; mime_type
              ; description
              ; archived = Some archived
              })
      ; project =
          (function
            | Resource_metadata
                { id
                ; expected_revision
                ; title
                ; filename
                ; mime_type
                ; description
                ; archived
                }
              when Option.is_some archived ->
              Some
                { Resource_archive_request.id = Id.Resource.to_string id
                ; expected_revision
                ; title
                ; filename
                ; mime_type
                ; description
                ; archived = Option.value_exn archived
                }
            | _ -> None)
      }
  ; Entry
      { name = "comment.add"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.both
                     (Fields.both
                        (Fields.optional "comment_id" reference)
                        (Fields.required "target" Planning_target.codec))
                     (Fields.optional "reply_to_id" reference))
                  (Fields.optional "kind" kind))
               (Fields.required "body" text))
      ; command =
          (fun ((((id, target), reply_to), kind), body) ->
            Comment_add
              { id = Option.map id ~f:(fun id -> Id.Comment.t_of_jsonaf (Json.string id))
              ; target =
                  (match Planning_target.to_ref target with
                   | Ok target -> target
                   | Error error -> raise (Json.Decode_error error))
              ; reply_to =
                  Option.map reply_to ~f:(fun id ->
                    Id.Comment.t_of_jsonaf (Json.string id))
              ; kind = Option.value kind ~default:Discussion.Kind.Comment
              ; body
              })
      ; project =
          (function
            | Comment_add { id; target; reply_to; kind; body } ->
              Some
                ( ( ( ( Option.map id ~f:Id.Comment.to_string
                      , Planning_target.of_ref target )
                    , Option.map reply_to ~f:Id.Comment.to_string )
                  , Some kind )
                , body )
            | _ -> None)
      }
  ; Entry
      { name = "resource.link"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.required "resource_id" reference)
                  (Fields.required "expected_revision" decimal))
               (Fields.required "target" Planning_target.codec))
      ; command =
          (fun ((id, expected_revision), target) ->
            Resource_link
              { id = Id.Resource.t_of_jsonaf (Json.string id)
              ; expected_revision
              ; target =
                  (match Planning_target.to_ref target with
                   | Ok target -> target
                   | Error error -> raise (Json.Decode_error error))
              ; remove = false
              })
      ; project =
          (function
            | Resource_link { id; expected_revision; target; remove = false } ->
              Some
                ( (Id.Resource.to_string id, expected_revision)
                , Planning_target.of_ref target )
            | _ -> None)
      }
  ; Entry
      { name = "resource.unlink"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.required "resource_id" reference)
                  (Fields.required "expected_revision" decimal))
               (Fields.required "target" Planning_target.codec))
      ; command =
          (fun ((id, expected_revision), target) ->
            Resource_link
              { id = Id.Resource.t_of_jsonaf (Json.string id)
              ; expected_revision
              ; target =
                  (match Planning_target.to_ref target with
                   | Ok target -> target
                   | Error error -> raise (Json.Decode_error error))
              ; remove = true
              })
      ; project =
          (function
            | Resource_link { id; expected_revision; target; remove = true } ->
              Some
                ( (Id.Resource.to_string id, expected_revision)
                , Planning_target.of_ref target )
            | _ -> None)
      }
  ; Entry
      { name = "actor.put"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.both
                     (Fields.both
                        (Fields.required "target_actor_id" reference)
                        (Fields.required "expected_revision" decimal))
                     (Fields.required "name" title))
                  (Fields.required
                     "kind"
                     (Api_codec.enum
                        [ "person", Workflow.Actor.Person; "agent", Agent ]
                        ~equal:Workflow.Actor.equal_kind)))
               (Fields.optional "archived" boolean))
      ; command =
          (fun ((((id, revision), name), kind), archived) ->
            Settings_put
              (Workflow.Change.Actor
                 { id = Id.Actor.t_of_jsonaf (Json.string id)
                 ; revision
                 ; name
                 ; kind
                 ; archived = Option.value archived ~default:false
                 }))
      ; project =
          (function
            | Settings_put (Workflow.Change.Actor { id; revision; name; kind; archived })
              -> Some ((((Id.Actor.to_string id, revision), name), kind), Some archived)
            | _ -> None)
      }
  ; Entry
      { name = "label.put"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.both
                     (Fields.both
                        (Fields.required "label_id" reference)
                        (Fields.required "expected_revision" decimal))
                     (Fields.required "name" title))
                  (Fields.optional "description" text))
               (Fields.optional "archived" boolean))
      ; command =
          (fun ((((id, revision), name), description), archived) ->
            Settings_put
              (Workflow.Change.Label
                 { id = Id.Label.t_of_jsonaf (Json.string id)
                 ; revision
                 ; name
                 ; description = Option.value description ~default:""
                 ; archived = Option.value archived ~default:false
                 }))
      ; project =
          (function
            | Settings_put
                (Workflow.Change.Label { id; revision; name; description; archived }) ->
              Some
                ( (((Id.Label.to_string id, revision), name), Some description)
                , Some archived )
            | _ -> None)
      }
  ; Entry
      { name = "status.put"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.both
                     (Fields.both
                        (Fields.required "status_id" reference)
                        (Fields.required "expected_revision" decimal))
                     (Fields.required "name" title))
                  (Fields.required "category" status))
               (Fields.optional "archived" boolean))
      ; command =
          (fun ((((id, revision), name), category), archived) ->
            Settings_put
              (Workflow.Change.Status
                 { id = Id.Status.t_of_jsonaf (Json.string id)
                 ; revision
                 ; name
                 ; category
                 ; archived = Option.value archived ~default:false
                 }))
      ; project =
          (function
            | Settings_put
                (Workflow.Change.Status { id; revision; name; category; archived }) ->
              Some ((((Id.Status.to_string id, revision), name), category), Some archived)
            | _ -> None)
      }
  ; Entry
      { name = "template.instantiate"
      ; request =
          Api_codec.object_
            (Fields.both
               (Fields.both
                  (Fields.both
                     (Fields.required "template_id" reference)
                     (Fields.required "template_revision" decimal))
                  (Fields.required "instance_id" reference))
               (Fields.required
                  "parameters"
                  (Api_codec.dictionary
                     (Api_codec.text ~max_bytes:16_384)
                     ~max_items:32
                     ~max_key_bytes:96)))
      ; command =
          (fun (((template, template_revision), id), parameters) ->
            Template_instantiate
              { template = Id.Resource.t_of_jsonaf (Json.string template)
              ; template_revision
              ; id = Workflow_template.Instance_id.t_of_jsonaf (Json.string id)
              ; parameters
              })
      ; project =
          (function
            | Template_instantiate { template; template_revision; id; parameters } ->
              Some
                ( ( (Id.Resource.to_string template, template_revision)
                  , Workflow_template.Instance_id.to_string id )
                , parameters )
            | _ -> None)
      }
  ]
;;

let methods =
  List.map entries ~f:(fun (Entry entry) -> entry.name)
  @ Ticket_lifecycle.mutation_methods
;;

let find method_ =
  List.find entries ~f:(fun (Entry entry) -> String.equal entry.name method_)
;;

let decode_resolved_base ~method_ ~params =
  Option.map (find method_) ~f:(fun (Entry entry) ->
    Result.bind (Api_codec.decode entry.request params) ~f:(fun request ->
      Json.decode (fun () -> entry.command request)))
;;

let encode_base command =
  List.find_map entries ~f:(fun (Entry entry) ->
    Option.map (entry.project command) ~f:(fun request ->
      Result.map (Api_codec.encode entry.request request) ~f:(fun params ->
        entry.name, params)))
;;

let request_codec_base ~method_ =
  Option.map (find method_) ~f:(fun (Entry entry) -> Api_codec.as_json entry.request)
;;

module Operation = struct
  type t =
    { method_ : string
    ; params : Jsonaf.t
    ; alias : string option
    }

  let alias_codec =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:(fun name -> Result.map (Id.Actor.of_string name) ~f:(fun _ -> name))
      ~encode:Fn.id
      ~description:"Unique transaction creation alias."
  ;;

  let codec ~requests ~creation_methods =
    let cases =
      List.map requests ~f:(fun (name, request) ->
        if String.equal name "transaction.apply"
        then invalid_arg "nested transaction codec";
        let fields =
          Fields.both
            (Fields.required "method" (Api_codec.literal name))
            (Fields.required "params" request)
        in
        let fields =
          if List.mem creation_methods name ~equal:String.equal
          then
            Fields.map
              (Fields.both fields (Fields.optional "as" alias_codec))
              ~decode:(fun (((), params), alias) -> { method_ = name; params; alias })
              ~encode:(fun operation -> ((), operation.params), operation.alias)
          else
            Fields.map
              fields
              ~decode:(fun ((), params) -> { method_ = name; params; alias = None })
              ~encode:(fun operation ->
                if Option.is_some operation.alias
                then Json.fail Invalid_argument "aliases require a creation operation";
                (), operation.params)
        in
        name, Api_codec.object_ fields)
    in
    Api_codec.tagged ~discriminator:"method" ~cases ~select:(fun operation ->
      operation.method_)
  ;;

  let batch_codec ~requests ~creation_methods =
    let operations = Api_codec.list (codec ~requests ~creation_methods) ~max_items:32 in
    let operations =
      Api_codec.map
        operations
        ~decode:(fun operations ->
          if List.is_empty operations
          then
            Error
              (Problem.create Invalid_argument "transaction requires 1..32 operations")
          else if
            List.contains_dup
              (List.filter_map operations ~f:(fun operation -> operation.alias))
              ~compare:String.compare
          then Error (Problem.create Invalid_argument "duplicate transaction alias")
          else Ok operations)
        ~encode:Fn.id
        ~description:"1..32 ordered operations with unique creation aliases."
    in
    Api_codec.object_ (Fields.required "operations" operations)
  ;;
end

let descriptor_base ~method_ =
  match find method_, Planning_result.codec ~method_ with
  | Some (Entry entry), Some response ->
    Some
      (Api_method.Packed.Pack
         (Api_method.create
            ~name:entry.name
            ~summary:("Apply " ^ entry.name ^ " as a durable planning mutation.")
            ~mode:Api_method.Mode.Mutation
            ~request:entry.request
            ~response))
  | None, _ | _, None -> None
;;

let invoke_resolved_base ~method_ ~params ~f =
  match find method_, Planning_result.codec ~method_ with
  | Some (Entry entry), Some response ->
    let descriptor =
      Api_method.create
        ~name:entry.name
        ~summary:("Apply " ^ entry.name ^ " as a durable planning mutation.")
        ~mode:Api_method.Mode.Mutation
        ~request:entry.request
        ~response
    in
    Some
      (Api_method.invoke descriptor ~params ~f:(fun request ->
         Result.bind (Json.decode (fun () -> entry.command request)) ~f))
  | None, _ | _, None -> None
;;

let validate_result_base ~method_ result =
  match find method_, Planning_result.codec ~method_ with
  | Some (Entry entry), Some response ->
    let descriptor =
      Api_method.create
        ~name:entry.name
        ~summary:("Apply " ^ entry.name ^ " as a durable planning mutation.")
        ~mode:Api_method.Mode.Mutation
        ~request:entry.request
        ~response
    in
    ignore (Api_method.encode_response descriptor result : Jsonaf.t);
    Some ()
  | None, _ | _, None -> None
;;

let lifecycle_method method_ =
  List.mem Ticket_lifecycle.mutation_methods method_ ~equal:String.equal
;;

let lifecycle_request = Ticket_lifecycle.request_codec

let request_codec ~method_ =
  if lifecycle_method method_
  then Result.ok (lifecycle_request method_)
  else request_codec_base ~method_
;;

let request_schema ~method_ =
  if lifecycle_method method_
  then Result.ok (Result.map (lifecycle_request method_) ~f:Api_codec.schema)
  else Option.map (find method_) ~f:(fun (Entry entry) -> Api_codec.schema entry.request)
;;

let validate_request ~method_ ~params =
  Option.map (request_codec ~method_) ~f:(fun codec ->
    Result.map (Api_codec.decode codec params) ~f:(fun _ -> ()))
;;

let decode_resolved ~method_ ~params =
  if lifecycle_method method_
  then
    Some
      (Result.map (Ticket_lifecycle.Command.decode ~method_ ~params) ~f:(fun command ->
         Planning_command.Lifecycle command))
  else decode_resolved_base ~method_ ~params
;;

let encode command =
  match command with
  | Planning_command.Lifecycle command -> Some (Ticket_lifecycle.Command.encode command)
  | Ticket_claim { id; expected_revision } ->
    Some
      (Ticket_lifecycle.Command.encode
         (Claim
            { ticket_id = id
            ; expected_revision = Some expected_revision
            ; lease_duration_ms = None
            }))
  | Ticket_claim_with_lease { id; expected_revision; lease_duration_ms } ->
    Some
      (Ticket_lifecycle.Command.encode
         (Claim
            { ticket_id = id
            ; expected_revision = Some expected_revision
            ; lease_duration_ms = Some lease_duration_ms
            }))
  | _ -> encode_base command
;;

let lifecycle_descriptor method_ =
  Result.bind (lifecycle_request method_) ~f:(fun request ->
    Result.map (Ticket_lifecycle.response_codec method_) ~f:(fun response ->
      Api_method.create
        ~name:method_
        ~summary:("Apply " ^ method_ ^ " as a durable lifecycle mutation.")
        ~mode:Api_method.Mode.Mutation
        ~request
        ~response))
;;

let descriptor ~method_ =
  if lifecycle_method method_
  then
    Result.ok
      (Result.map (lifecycle_descriptor method_) ~f:(fun method_ ->
         Api_method.Packed.Pack method_))
  else descriptor_base ~method_
;;

let validate_result ~method_ result =
  if lifecycle_method method_
  then (
    match lifecycle_descriptor method_ with
    | Ok descriptor ->
      ignore (Api_method.encode_response descriptor result : Jsonaf.t);
      Some ()
    | Error error -> raise (Api_method.Invalid_response (method_, error)))
  else validate_result_base ~method_ result
;;

let invoke_resolved ~method_ ~params ~f =
  if lifecycle_method method_
  then
    Some
      (Result.bind (lifecycle_descriptor method_) ~f:(fun descriptor ->
         Api_method.invoke descriptor ~params ~f:(fun params ->
           Result.bind
             (Ticket_lifecycle.Command.decode ~method_ ~params)
             ~f:(fun command -> f (Planning_command.Lifecycle command)))))
  else invoke_resolved_base ~method_ ~params ~f
;;
