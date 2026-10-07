open Core

(** Current tagged communication event representation. Unsupported format
    tags are rejected; no pre-release migration decoder is supported. All
    counters count communication events or entity revisions, not wall time. *)
module Counter : sig
  type t = int [@@deriving sexp, jsonaf]
end

module Recipient : sig
  type t =
    | Actor of Id.Actor.t
    | Run of Id.Run.t
  [@@deriving sexp, equal, compare, jsonaf]

  include Comparable.S with type t := t
end

module Scope : sig
  type t =
    | Workspace
    | Project of Id.Project.t
  [@@deriving sexp, equal, jsonaf]

  val target : t -> Entity_ref.t
end

module Attribution : sig
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Board : sig
  type t =
    { id : Communication_id.Board.t
    ; revision : Counter.t
    ; scope : Scope.t
    ; title : string
    }
  [@@deriving sexp, equal, jsonaf]
end

module Thread : sig
  module State : sig
    type t =
      | Open
      | Awaiting_response
      | Resolved
    [@@deriving sexp, equal, jsonaf]
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

module Team : sig
  type t =
    { id : Communication_id.Team.t
    ; revision : Counter.t
    ; title : string
    ; members : Recipient.t list
    }
  [@@deriving sexp, equal, jsonaf]
end

module Request : sig
  module Kind : sig
    type t =
      | Clarification
      | Review
      | Help
      | Blocker_resolution
      | Handoff
    [@@deriving sexp, equal, jsonaf]
  end

  module Delivery : sig
    type t =
      { recipient : Recipient.t
      ; acknowledged : Attribution.t option
      }
    [@@deriving sexp, equal, jsonaf]
  end

  module Responsibility : sig
    type t =
      | Unaccepted
      | Accepted of
          { recipient : Recipient.t
          ; attribution : Attribution.t
          }
    [@@deriving sexp, equal, jsonaf]
  end

  module Status : sig
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

module Notification : sig
  module Kind : sig
    type t =
      | Thread_changed
      | Request_created
      | Request_acknowledged
      | Request_accepted
      | Request_reassigned
      | Request_resolved
      | Request_cancelled
    [@@deriving sexp, equal, jsonaf]
  end

  module Source : sig
    type t =
      | Thread of Communication_id.Thread.t
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

module Subscription : sig
  module Filter : sig
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

module Update : sig
  type t =
    | Board_put of Board.t
    | Thread_put of Thread.t
    | Team_put of Team.t
    | Request_put of
        { request : Request.t
        ; kind : Notification.Kind.t
        }
    | Subscription_put of Subscription.t
    | Cursor_advanced of
        { recipient : Recipient.t
        ; through : Counter.t
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

(** Strict validating decoder: rejects unknown/duplicate fields, unsupported
    versions, noncanonical counters and invalid lifecycle/replay shapes. State
    dependent transition and delivery validation is performed by Communication.apply. *)
val decode : Jsonaf.t -> (t, Problem.t) Result.t
