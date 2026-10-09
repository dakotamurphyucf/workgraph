open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

(** Current tagged communication event representation. Unsupported format
    tags are rejected; no pre-release migration decoder is supported. All
    counters count communication events or entity revisions, not wall time. *)
module Counter = struct
  type t = int [@@deriving sexp, equal]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Recipient = struct
  type t =
    | Actor of Id.Actor.t
    | Run of Id.Run.t
  [@@deriving sexp, equal, compare]

  let jsonaf_of_t = function
    | Actor id -> Json.obj [ "kind", Json.string "actor"; "id", Id.Actor.jsonaf_of_t id ]
    | Run id -> Json.obj [ "kind", Json.string "run"; "id", Id.Run.jsonaf_of_t id ]
  ;;

  let t_of_jsonaf json =
    Json.fields json ~allowed:[ "kind"; "id" ];
    match Json.text (Json.field json "kind") with
    | "actor" -> Actor (Id.Actor.t_of_jsonaf (Json.field json "id"))
    | "run" -> Run (Id.Run.t_of_jsonaf (Json.field json "id"))
    | _ -> Json.fail Invalid_argument "unknown recipient kind"
  ;;

  module T = struct
    type nonrec t = t [@@deriving sexp, compare]
  end

  include Comparable.Make (T)
end

module Scope = struct
  type t =
    | Workspace
    | Project of Id.Project.t
  [@@deriving sexp, equal]

  let target = function
    | Workspace -> Entity_ref.Workspace
    | Project id -> Entity_ref.Project id
  ;;

  let jsonaf_of_t scope = Entity_ref.jsonaf_of_t (target scope)

  let t_of_jsonaf json =
    match Entity_ref.t_of_jsonaf json with
    | Entity_ref.Workspace -> Workspace
    | Project id -> Project id
    | Milestone _ | Ticket _ | Resource _ ->
      Json.fail Invalid_argument "board scope must be workspace or project"
  ;;
end

module Attribution = struct
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Board = struct
  type t =
    { id : Communication_id.Board.t
    ; revision : Counter.t
    ; scope : Scope.t
    ; title : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Thread = struct
  module State = struct
    type t =
      | Open
      | Awaiting_response
      | Resolved
    [@@deriving sexp, equal]

    let jsonaf_of_t = function
      | Open -> Json.string "open"
      | Awaiting_response -> Json.string "awaiting_response"
      | Resolved -> Json.string "resolved"
    ;;

    let t_of_jsonaf json =
      match Json.text json with
      | "open" -> Open
      | "awaiting_response" -> Awaiting_response
      | "resolved" -> Resolved
      | _ -> Json.fail Invalid_argument "unknown communication kind/state"
    ;;
  end

  type t =
    { id : Communication_id.Thread.t
    ; revision : Counter.t
    ; board : Communication_id.Board.t
    ; title : string
    ; participants : Id.Actor.t list
    ; mentions : Id.Actor.t list
    ; links : Entity_ref.t list
    ; state : State.t
    ; pinned : bool
    ; messages : Id.Comment.t list
    ; pinned_messages : Id.Comment.t list
    }
  [@@deriving sexp, equal, jsonaf]
end

module Team = struct
  type t =
    { id : Communication_id.Team.t
    ; revision : Counter.t
    ; title : string
    ; members : Recipient.t list
    }
  [@@deriving sexp, equal, jsonaf]
end

module Request = struct
  module Kind = struct
    type t =
      | Clarification
      | Review
      | Help
      | Blocker_resolution
      | Handoff
    [@@deriving sexp, equal]

    let jsonaf_of_t = function
      | Clarification -> Json.string "clarification"
      | Review -> Json.string "review"
      | Help -> Json.string "help"
      | Blocker_resolution -> Json.string "blocker_resolution"
      | Handoff -> Json.string "handoff"
    ;;

    let t_of_jsonaf json =
      match Json.text json with
      | "clarification" -> Clarification
      | "review" -> Review
      | "help" -> Help
      | "blocker_resolution" -> Blocker_resolution
      | "handoff" -> Handoff
      | _ -> Json.fail Invalid_argument "unknown communication kind/state"
    ;;
  end

  module Delivery = struct
    type t =
      { recipient : Recipient.t
      ; acknowledged : Attribution.t option
      }
    [@@deriving sexp, equal, jsonaf]
  end

  module Responsibility = struct
    type t =
      | Unaccepted
      | Accepted of
          { recipient : Recipient.t
          ; attribution : Attribution.t
          }
    [@@deriving sexp, equal, jsonaf]
  end

  module Status = struct
    type t =
      | Open
      | Resolved of Attribution.t
      | Cancelled of Attribution.t
    [@@deriving sexp, equal, jsonaf]
  end

  type t =
    { id : Communication_id.Request.t
    ; revision : Counter.t
    ; thread : Communication_id.Thread.t
    ; kind : Kind.t
    ; message : Id.Comment.t
    ; correlation_id : string option
    ; reply_to : Communication_id.Request.t option
    ; deadline_unix_ms : string option
    ; resolver : Id.Actor.t
    ; created : Attribution.t
    ; deliveries : Delivery.t list
    ; responsibility : Responsibility.t
    ; status : Status.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Message = struct
  (** Immutable routing metadata. The authored discussion body is pinned to
      comment_revision; recipient expansion is frozen at this event. *)
  type t =
    { message_id : Communication_id.Message.t
    ; revision : Counter.t
    ; comment_id : Id.Comment.t
    ; comment_revision : Counter.t
    ; ticket_id : Id.Ticket.t option
    ; direct_recipients : Recipient.t list
    ; teams : Communication_id.Team.t list
    ; recipients : Recipient.t list
    ; reply_to_message_id : Communication_id.Message.t option
    ; correlation_id : string option
    ; created : Attribution.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Notification = struct
  module Kind = struct
    type t =
      | Thread_changed
      | Message_received
      | Request_created
      | Request_acknowledged
      | Request_accepted
      | Request_reassigned
      | Request_resolved
      | Request_cancelled
    [@@deriving sexp, equal, jsonaf]
  end

  module Source = struct
    type t =
      | Thread of Communication_id.Thread.t
      | Message of Communication_id.Message.t
      | Request of Communication_id.Request.t
    [@@deriving sexp, equal, jsonaf]
  end

  type t =
    { serial : Counter.t
    ; sequence : Counter.t
    ; scope : Scope.t
    ; source : Source.t
    ; source_revision : Counter.t
    ; kind : Kind.t
    ; attribution : Attribution.t
    ; recipients : Recipient.t list
    }
  [@@deriving sexp, equal, jsonaf]
end

module Subscription = struct
  module Filter = struct
    type t =
      { scope : Scope.t option
      ; thread : Communication_id.Thread.t option
      ; kinds : Notification.Kind.t list
      }
    [@@deriving sexp, equal, jsonaf]
  end

  type t =
    { id : Communication_id.Subscription.t
    ; revision : Counter.t
    ; recipient : Recipient.t
    ; filter : Filter.t
    ; active : bool
    }
  [@@deriving sexp, equal, jsonaf]
end

module Update = struct
  type t =
    | Board_put of Board.t
    | Message_put of Message.t
    | Thread_put of Thread.t
    | Team_put of Team.t
    | Request_put of
        { request : Request.t
        ; kind : Notification.Kind.t
        }
    | Subscription_put of Subscription.t
    | Inbox_ack of
        { consumer_id : Communication_id.Consumer.t
        ; recipient : Recipient.t
        ; notification_ids : Counter.t list
        }
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { version : Counter.t
  ; revision : Counter.t
  ; sequence : Counter.t
  ; attribution : Attribution.t
  ; update : Update.t
  ; notifications : Notification.t list
  }
[@@deriving sexp, equal, jsonaf]

let generated_t_of_jsonaf = t_of_jsonaf

let t_of_jsonaf json =
  let event =
    try generated_t_of_jsonaf json with
    | Jsonaf_kernel.Conv.Of_jsonaf_error (exn, _) ->
      Json.fail Invalid_argument ("invalid communication event: " ^ Exn.to_string exn)
  in
  if not (Int.equal event.version 1)
  then Json.fail Unsupported_version "unsupported communication event version";
  if event.revision <= 0 || event.sequence <= 0
  then Json.fail Corrupt_store "invalid communication event counter";
  let entity_revision =
    match event.update with
    | Update.Board_put x -> x.Board.revision
    | Message_put x -> x.Message.revision
    | Thread_put x -> x.Thread.revision
    | Team_put x -> x.Team.revision
    | Request_put { request; _ } -> request.Request.revision
    | Subscription_put x -> x.Subscription.revision
    | Inbox_ack _ -> 1
  in
  if entity_revision <= 0
  then Json.fail Corrupt_store "invalid communication entity revision";
  List.iter event.notifications ~f:(fun n ->
    if
      n.Notification.serial <= 0
      || n.source_revision <= 0
      || not (Int.equal n.sequence event.sequence)
    then Json.fail Corrupt_store "invalid notification counters");
  event
;;

let decode json = Json.decode (fun () -> t_of_jsonaf json)
