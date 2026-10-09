open Core

module Kind : sig
  type t =
    | Active_attempt
    | Ready_work
    | Allocation_blocked
    | Unanswered_request
    | Stale_run
    | Stale_ownership
    | Expired_ownership
    | Changed_input
    | Pending_review
    | Reservation
    | Reported_usage
    | Budget_limit
    | Dependency_bottleneck
    | Runner_action
  [@@deriving sexp_of, equal]

  val codec : t Api_codec.t
  val all : t list
  val to_string : t -> string
end

module Source : sig
  type t =
    | Attempt of Attempt.Id.t
    | Ticket of Id.Ticket.t
    | Run of Id.Run.t
    | Request of Communication_id.Request.t
    | Reservation of Reservation.Name.t
    | Reconciliation of
        { serial : int
        ; attempt_id : Attempt.Id.t
        }
    | Submission of
        { ticket_id : Id.Ticket.t
        ; generation : int
        }
    | Usage of Usage_record.Id.t
    | Run_budget of Id.Run.t

  (** Canonical kind discriminator and descriptive ID field names. These are
      captured current-view navigation references, not fabricated version pins. *)
  val codec : t Api_codec.t
end

module Allocation_reason : sig
  type t =
    | Allocation of Allocation.Reason.t
    | Run_terminal
    | Run_budget of Problem.t
    | Coordination of Agent_run.Start_blocker.t

  (** Exact allocator/domain reasons, shared coordination blocker codec and
      current Problem wire kind. No string dispatch on diagnostic prose. *)
  val codec : t Api_codec.t
end

module Ready : sig
  type scope =
    | Graph
    | Run

  type t =
    { title : string
    ; blockers : Planning_ticket_wire.Readiness.t
    ; eligibility_scope : scope
    ; allocation_reasons : Allocation_reason.t list
    }

  val codec : t Api_codec.t
end

module Active_attempt : sig
  type t =
    { ticket_id : Id.Ticket.t
    ; run_id : Id.Run.t
    ; state : Attempt.State.t
    ; token : int
    ; last_checkpoint : Attempt.Checkpoint.t option
    }

  val codec : t Api_codec.t
end

module Stale_run : sig
  type liveness =
    | Unobserved
    | Stale

  type t =
    { status : Agent_run.Status.t
    ; last_observed_unix_ms : int64 option
    ; liveness : liveness
    }

  (** liveness_is_advisory is literal true in the public codec. *)
  val codec : t Api_codec.t
end

module Ownership : sig
  type t =
    | Ticket of
        { token : int
        ; lease_status : Allocation_lease.Status.t
        ; lease : Allocation_lease.t
        ; run_id : Id.Run.t option
        }
    | Reservation of
        { token : int
        ; run_id : Id.Run.t
        ; lease_status : Allocation_lease.Status.t
        ; liveness_is_advisory : bool
        }

  (** Selection follows the typed source kind, never untyped metadata guessing. *)
  val ticket_codec : t Api_codec.t

  val reservation_codec : t Api_codec.t
end

module Request : sig
  type t =
    { thread_id : Communication_id.Thread.t
    ; comment_id : Id.Comment.t
    ; kind : Communication.Request.Kind.t
    ; unacknowledged_recipients : int
    ; responsibility : Communication.Request.Responsibility.t
    ; deadline_unix_ms : int64 option
    }

  val codec : t Api_codec.t
end

module Dependency : sig
  type t =
    { waiting_ticket_ids : Id.Ticket.t list
    ; waiting_count : int
    }

  (** waiting_count agrees with exact unique sorted dependent IDs. *)
  val codec : t Api_codec.t
end

module Budget_attention = Run_budget.Attention

module Item : sig
  type t =
    | Active_attempt of
        { attempt_id : Attempt.Id.t
        ; metadata : Active_attempt.t
        }
    | Ready_work of
        { ticket_id : Id.Ticket.t
        ; metadata : Ready.t
        }
    | Allocation_blocked of
        { ticket_id : Id.Ticket.t
        ; metadata : Ready.t
        }
    | Stale_run of
        { run_id : Id.Run.t
        ; metadata : Stale_run.t
        }
    | Stale_ownership of
        { source : Source.t
        ; metadata : Ownership.t
        }
    | Expired_ownership of
        { source : Source.t
        ; metadata : Ownership.t
        }
    | Unanswered_request of
        { request_id : Communication_id.Request.t
        ; metadata : Request.t
        }
    | Changed_input of Evidence.Reconciliation.t
    | Pending_review of Evidence.Submission.t
    | Reservation of Reservation.t
    | Reported_usage of Usage_record.t
    | Budget_limit of Budget_attention.t
    | Dependency_bottleneck of
        { ticket_id : Id.Ticket.t
        ; metadata : Dependency.t
        }
    | Runner_action of Agent_run.Runner_action.t

  (** Exact actual family codecs: checkpoint/run status/reservation/action,
      Communication responsibility, Evidence reconciliation/submission and Usage.
      Tagged row variants cannot mix source IDs and unrelated metadata families.
      Historical bodies remain available through their own exact canonical routes. *)
  val codec : t Api_codec.t

  val source : t -> Source.t
  val kind : t -> Kind.t

  (** Stable secondary order within a row kind. Raises [Json.Decode_error] for
      invalid manually constructed ownership source/metadata correspondence. *)
  val order_key : t -> string
end

module Edge : sig
  type t =
    { ticket_id : Id.Ticket.t
    ; prerequisite_ticket_id : Id.Ticket.t
    }

  val codec : t Api_codec.t
end

module Response : sig
  type t =
    { workspace_id : Id.Workspace.t
    ; captured_now_unix_ms : int64
    ; items : Item.t list
    ; next_cursor : string option
    ; omitted : int
    ; needs_larger_budget : bool
    ; next_item_source : Source.t option
    ; required_bytes : int option
    ; dependency_path : Edge.t list option
    ; dependency_path_omitted : int
    }

  (** Exact current capture, full whole items, ascending kind/key order. Required
      source/bytes only when first row cannot fit and position retained; critical
      path fields remain explicit null + unavailable reason, not estimates. *)
  val codec : t Api_codec.t
end
