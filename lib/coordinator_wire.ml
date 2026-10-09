open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let counter = W.counter
let positive = W.positive
let nonnegative64 = Api_codec.decimal64 ~max:Int64.max_value
let nullable = Api_codec.nullable
let text = Api_codec.text
let check condition message = if not condition then Json.fail Invalid_argument message
let enum entries equal = Api_codec.enum entries ~equal

let unique codec compare =
  W.checked (Api_codec.list codec ~max_items:100000) (fun xs ->
    check (not (List.contains_dup xs ~compare)) "duplicate identities")
;;

module Kind = struct
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

  let all =
    [ Active_attempt
    ; Ready_work
    ; Allocation_blocked
    ; Unanswered_request
    ; Stale_run
    ; Stale_ownership
    ; Expired_ownership
    ; Changed_input
    ; Pending_review
    ; Reservation
    ; Reported_usage
    ; Budget_limit
    ; Dependency_bottleneck
    ; Runner_action
    ]
  ;;

  let to_string = function
    | Active_attempt -> "active_attempt"
    | Ready_work -> "ready_work"
    | Allocation_blocked -> "allocation_blocked"
    | Unanswered_request -> "unanswered_request"
    | Stale_run -> "stale_run"
    | Stale_ownership -> "stale_ownership"
    | Expired_ownership -> "expired_ownership"
    | Changed_input -> "changed_input"
    | Pending_review -> "pending_review"
    | Reservation -> "reservation"
    | Reported_usage -> "reported_usage"
    | Budget_limit -> "budget_limit"
    | Dependency_bottleneck -> "dependency_bottleneck"
    | Runner_action -> "runner_action"
  ;;

  let codec =
    enum
      [ "active_attempt", Active_attempt
      ; "ready_work", Ready_work
      ; "allocation_blocked", Allocation_blocked
      ; "unanswered_request", Unanswered_request
      ; "stale_run", Stale_run
      ; "stale_ownership", Stale_ownership
      ; "expired_ownership", Expired_ownership
      ; "changed_input", Changed_input
      ; "pending_review", Pending_review
      ; "reservation", Reservation
      ; "reported_usage", Reported_usage
      ; "budget_limit", Budget_limit
      ; "dependency_bottleneck", Dependency_bottleneck
      ; "runner_action", Runner_action
      ]
      equal
  ;;
end

module Source = struct
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
  [@@deriving equal]

  let tag = function
    | Attempt _ -> "attempt"
    | Ticket _ -> "ticket"
    | Run _ -> "run"
    | Request _ -> "request"
    | Reservation _ -> "reservation"
    | Reconciliation _ -> "reconciliation"
    | Submission _ -> "submission"
    | Usage _ -> "usage"
    | Run_budget _ -> "run_budget"
  ;;

  let branch tag fields decode encode =
    Api_codec.object_
      (F.map
         (req "kind" (Api_codec.literal tag) ++ fields)
         ~decode:(fun ((), value) -> decode value)
         ~encode:(fun value -> (), encode value))
  ;;

  let wrong () = Json.fail Invalid_argument "source kind mismatch"

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "attempt"
          , branch
              "attempt"
              (req "attempt_id" (W.id Attempt.Id.of_string Attempt.Id.to_string))
              (fun v -> Attempt v)
              (function
                | Attempt v -> v
                | _ -> wrong ()) )
        ; ( "ticket"
          , branch
              "ticket"
              (req "ticket_id" W.ticket)
              (fun v -> Ticket v)
              (function
                | Ticket v -> v
                | _ -> wrong ()) )
        ; ( "run"
          , branch
              "run"
              (req "run_id" W.run)
              (fun v -> Run v)
              (function
                | Run v -> v
                | _ -> wrong ()) )
        ; ( "request"
          , branch
              "request"
              (req
                 "request_id"
                 (W.id
                    Communication_id.Request.of_string
                    Communication_id.Request.to_string))
              (fun v -> Request v)
              (function
                | Request v -> v
                | _ -> wrong ()) )
        ; ( "reservation"
          , branch
              "reservation"
              (req "name" (W.id Reservation.Name.of_string Reservation.Name.to_string))
              (fun v -> Reservation v)
              (function
                | Reservation v -> v
                | _ -> wrong ()) )
        ; ( "usage"
          , branch
              "usage"
              (req "usage_id" (W.id Usage_record.Id.of_string Usage_record.Id.to_string))
              (fun v -> Usage v)
              (function
                | Usage v -> v
                | _ -> wrong ()) )
        ; ( "run_budget"
          , branch
              "run_budget"
              (req "run_id" W.run)
              (fun v -> Run_budget v)
              (function
                | Run_budget v -> v
                | _ -> wrong ()) )
        ; ( "reconciliation"
          , branch
              "reconciliation"
              (req "serial" positive
               ++ req "attempt_id" (W.id Attempt.Id.of_string Attempt.Id.to_string))
              (fun (serial, attempt_id) -> Reconciliation { serial; attempt_id })
              (function
                | Reconciliation { serial; attempt_id } -> serial, attempt_id
                | _ -> wrong ()) )
        ; ( "submission"
          , branch
              "submission"
              (req "ticket_id" W.ticket ++ req "generation" positive)
              (fun (ticket_id, generation) -> Submission { ticket_id; generation })
              (function
                | Submission { ticket_id; generation } -> ticket_id, generation
                | _ -> wrong ()) )
        ]
      ~select:tag
  ;;
end

module Allocation_reason = struct
  type t =
    | Allocation of Allocation.Reason.t
    | Run_terminal
    | Run_budget of Problem.t
    | Coordination of Agent_run.Start_blocker.t

  let wrong () = Json.fail Invalid_argument "allocation reason mismatch"

  let branch tag fields decode encode =
    Api_codec.object_
      (F.map
         (req "kind" (Api_codec.literal tag) ++ fields)
         ~decode:(fun ((), v) -> decode v)
         ~encode:(fun v -> (), encode v))
  ;;

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "not_ready"
          , branch
              "not_ready"
              F.empty
              (fun () -> Allocation Not_ready)
              (function
                | Allocation Not_ready -> ()
                | _ -> wrong ()) )
        ; ( "claimed"
          , branch
              "claimed"
              F.empty
              (fun () -> Allocation Claimed)
              (function
                | Allocation Claimed -> ()
                | _ -> wrong ()) )
        ; ( "missing_capability"
          , branch
              "missing_capability"
              (req "capability" (W.nonblank ~max_bytes:96))
              (fun v -> Allocation (Missing_capability v))
              (function
                | Allocation (Missing_capability v) -> v
                | _ -> wrong ()) )
        ; ( "pool_full"
          , branch
              "pool_full"
              (req "pool" (W.nonblank ~max_bytes:96))
              (fun v -> Allocation (Pool_full v))
              (function
                | Allocation (Pool_full v) -> v
                | _ -> wrong ()) )
        ; ( "run_terminal"
          , branch
              "run_terminal"
              F.empty
              (fun () -> Run_terminal)
              (function
                | Run_terminal -> ()
                | _ -> wrong ()) )
        ; ( "run_budget"
          , branch
              "run_budget"
              (req "problem" Planning_ticket_wire.problem_codec)
              (fun v -> Run_budget v)
              (function
                | Run_budget v -> v
                | _ -> wrong ()) )
        ; ( "coordination"
          , branch
              "coordination"
              (req "details" Planning_ticket_wire.start_blocker_codec)
              (fun v -> Coordination v)
              (function
                | Coordination v -> v
                | _ -> wrong ()) )
        ]
      ~select:(function
        | Allocation Not_ready -> "not_ready"
        | Allocation Claimed -> "claimed"
        | Allocation (Missing_capability _) -> "missing_capability"
        | Allocation (Pool_full _) -> "pool_full"
        | Run_terminal -> "run_terminal"
        | Run_budget _ -> "run_budget"
        | Coordination _ -> "coordination")
  ;;
end

module Ready = struct
  type scope =
    | Graph
    | Run
  [@@deriving equal]

  let scope = enum [ "graph", Graph; "run", Run ] equal_scope

  type t =
    { title : string
    ; blockers : Planning_ticket_wire.Readiness.t
    ; eligibility_scope : scope
    ; allocation_reasons : Allocation_reason.t list
    }

  let base =
    Api_codec.object_
      (F.map
         (req "title" (text ~max_bytes:512)
          ++ req "blockers" Planning_ticket_wire.Readiness.codec
          ++ req "eligibility_scope" scope
          ++ req
               "allocation_reasons"
               (Api_codec.list Allocation_reason.codec ~max_items:100000))
         ~decode:(fun (((title, blockers), eligibility_scope), allocation_reasons) ->
           { title; blockers; eligibility_scope; allocation_reasons })
         ~encode:(fun (t : t) ->
           ((t.title, t.blockers), t.eligibility_scope), t.allocation_reasons))
  ;;

  let codec = base
end

module Active_attempt = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; run_id : Id.Run.t
    ; state : Attempt.State.t
    ; token : int
    ; last_checkpoint : Attempt.Checkpoint.t option
    }

  let base =
    Api_codec.object_
      (F.map
         (req "ticket_id" W.ticket
          ++ req "run_id" W.run
          ++ req "state" Agent_run_wire.attempt_state
          ++ req "token" positive
          ++ req "last_checkpoint" (nullable Agent_run_wire.checkpoint))
         ~decode:(fun ((((ticket_id, run_id), state), token), last_checkpoint) ->
           { ticket_id; run_id; state; token; last_checkpoint })
         ~encode:(fun (t : t) ->
           (((t.ticket_id, t.run_id), t.state), t.token), t.last_checkpoint))
  ;;

  let codec =
    W.checked base (fun t ->
      check (not (Attempt.State.terminal t.state)) "active attempt cannot be terminal")
  ;;
end

module Stale_run = struct
  type liveness =
    | Unobserved
    | Stale
  [@@deriving equal]

  let liveness = enum [ "unobserved", Unobserved; "stale", Stale ] equal_liveness

  type t =
    { status : Agent_run.Status.t
    ; last_observed_unix_ms : int64 option
    ; liveness : liveness
    }

  let fields_base =
    Api_codec.object_
      (F.map
         (req "status" Agent_run_wire.status
          ++ req "last_observed_unix_ms" (nullable nonnegative64)
          ++ req "liveness" liveness)
         ~decode:(fun ((status, last_observed_unix_ms), liveness) ->
           { status; last_observed_unix_ms; liveness })
         ~encode:(fun (t : t) -> (t.status, t.last_observed_unix_ms), t.liveness))
  ;;

  let base =
    Api_codec.map
      (Api_codec.merge_objects
         fields_base
         (Api_codec.object_
            (req
               "liveness_is_advisory"
               (W.checked Api_codec.boolean (fun value ->
                  check value "liveness is advisory")))))
      ~decode:(fun (t, _) -> Ok t)
      ~encode:(fun t -> t, true)
      ~description:"Advisory current run liveness."
  ;;

  let codec =
    W.checked base (fun t ->
      check (not (Agent_run.Status.terminal t.status)) "stale run cannot be terminal";
      check
        (Bool.equal
           (Option.is_none t.last_observed_unix_ms)
           (equal_liveness t.liveness Unobserved))
        "stale run liveness differs from observation")
  ;;
end

let lease_status =
  enum
    [ "valid", Allocation_lease.Status.Valid
    ; "expired", Expired
    ; "clock_regressed", Clock_regressed
    ]
    Allocation_lease.Status.equal
;;

module Ownership = struct
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

  let ticket_codec =
    W.checked
      (Api_codec.object_
         (F.map
            (req "kind" (Api_codec.literal "ticket")
             ++ req "token" positive
             ++ req "lease_status" lease_status
             ++ req "lease" Agent_run_wire.lease
             ++ req "run_id" (nullable W.run))
            ~decode:(fun (((((), token), lease_status), lease), run_id) ->
              Ticket { token; lease_status; lease; run_id })
            ~encode:(function
              | Ticket { token; lease_status; lease; run_id } ->
                ((((), token), lease_status), lease), run_id
              | Reservation _ -> Json.fail Invalid_argument "expected ticket ownership")))
      (function
        | Ticket { token; lease; _ } ->
          check
            (token = Allocation_lease.epoch lease)
            "ticket ownership token differs from lease epoch"
        | Reservation _ -> ())
  ;;

  let reservation_codec =
    W.checked
      (Api_codec.object_
         (F.map
            (req "kind" (Api_codec.literal "reservation")
             ++ req "token" positive
             ++ req "run_id" W.run
             ++ req "lease_status" lease_status
             ++ req "liveness_is_advisory" Api_codec.boolean)
            ~decode:(fun (((((), token), run_id), lease_status), liveness_is_advisory) ->
              Reservation { token; run_id; lease_status; liveness_is_advisory })
            ~encode:(function
              | Reservation { token; run_id; lease_status; liveness_is_advisory } ->
                ((((), token), run_id), lease_status), liveness_is_advisory
              | Ticket _ -> Json.fail Invalid_argument "expected reservation ownership")))
      (function
        | Reservation { lease_status; liveness_is_advisory; _ } ->
          check
            (Bool.equal
               liveness_is_advisory
               (Allocation_lease.Status.equal lease_status Valid))
            "reservation advisory flag differs from lease status"
        | Ticket _ -> ())
  ;;

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:[ "ticket", ticket_codec; "reservation", reservation_codec ]
      ~select:(function
        | Ticket _ -> "ticket"
        | Reservation _ -> "reservation")
  ;;
end

module Request = struct
  type t =
    { thread_id : Communication_id.Thread.t
    ; comment_id : Id.Comment.t
    ; kind : Communication.Request.Kind.t
    ; unacknowledged_recipients : int
    ; responsibility : Communication.Request.Responsibility.t
    ; deadline_unix_ms : int64 option
    }

  let base =
    Api_codec.object_
      (F.map
         (req
            "thread_id"
            (W.id Communication_id.Thread.of_string Communication_id.Thread.to_string)
          ++ req "comment_id" (W.id Id.Comment.of_string Id.Comment.to_string)
          ++ req "kind" Communication_wire.request_kind
          ++ req "unacknowledged_recipients" (Api_codec.decimal ~max:1000)
          ++ req "responsibility" Communication_wire.request_responsibility
          ++ req "deadline_unix_ms" (nullable nonnegative64))
         ~decode:
           (fun
             ( ( (((thread_id, comment_id), kind), unacknowledged_recipients)
               , responsibility )
             , deadline_unix_ms ) ->
           { thread_id
           ; comment_id
           ; kind
           ; unacknowledged_recipients
           ; responsibility
           ; deadline_unix_ms
           })
         ~encode:(fun (t : t) ->
           ( ( (((t.thread_id, t.comment_id), t.kind), t.unacknowledged_recipients)
             , t.responsibility )
           , t.deadline_unix_ms )))
  ;;

  let codec = base
end

module Dependency = struct
  type t =
    { waiting_ticket_ids : Id.Ticket.t list
    ; waiting_count : int
    }

  let base =
    Api_codec.object_
      (F.map
         (req "waiting_ticket_ids" (unique W.ticket Id.Ticket.compare)
          ++ req "waiting_count" counter)
         ~decode:(fun (waiting_ticket_ids, waiting_count) ->
           { waiting_ticket_ids; waiting_count })
         ~encode:(fun (t : t) -> t.waiting_ticket_ids, t.waiting_count))
  ;;

  let codec =
    W.checked base (fun t ->
      check
        (t.waiting_count = List.length t.waiting_ticket_ids
         && t.waiting_count > 0
         && List.is_sorted t.waiting_ticket_ids ~compare:Id.Ticket.compare)
        "waiting count differs from exact sorted dependent IDs")
  ;;
end

module Budget_attention = Run_budget.Attention

module Item = struct
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

  let source = function
    | Active_attempt { attempt_id; _ } -> Source.Attempt attempt_id
    | Ready_work { ticket_id; _ }
    | Allocation_blocked { ticket_id; _ }
    | Dependency_bottleneck { ticket_id; _ } -> Source.Ticket ticket_id
    | Stale_run { run_id; _ } -> Source.Run run_id
    | Stale_ownership { source; _ } | Expired_ownership { source; _ } -> source
    | Unanswered_request { request_id; _ } -> Source.Request request_id
    | Changed_input r ->
      Source.Reconciliation { serial = r.serial; attempt_id = r.attempt }
    | Pending_review r ->
      Source.Submission { ticket_id = r.ticket; generation = r.generation }
    | Reservation r -> Source.Reservation r.name
    | Reported_usage r -> Source.Usage r.id
    | Budget_limit r -> Source.Run_budget r.run_id
    | Runner_action r -> Source.Run r.child
  ;;

  let kind = function
    | Active_attempt _ -> Kind.Active_attempt
    | Ready_work _ -> Kind.Ready_work
    | Allocation_blocked _ -> Kind.Allocation_blocked
    | Unanswered_request _ -> Kind.Unanswered_request
    | Stale_run _ -> Kind.Stale_run
    | Stale_ownership _ -> Kind.Stale_ownership
    | Expired_ownership _ -> Kind.Expired_ownership
    | Changed_input _ -> Kind.Changed_input
    | Pending_review _ -> Kind.Pending_review
    | Reservation _ -> Kind.Reservation
    | Reported_usage _ -> Kind.Reported_usage
    | Budget_limit _ -> Kind.Budget_limit
    | Dependency_bottleneck _ -> Kind.Dependency_bottleneck
    | Runner_action _ -> Kind.Runner_action
  ;;

  let order_key = function
    | Active_attempt { attempt_id; _ } -> Attempt.Id.to_string attempt_id
    | Ready_work { ticket_id; _ }
    | Allocation_blocked { ticket_id; _ }
    | Dependency_bottleneck { ticket_id; _ } -> Id.Ticket.to_string ticket_id
    | Stale_run { run_id; _ } -> Id.Run.to_string run_id
    | Stale_ownership { source = Source.Ticket id; _ }
    | Expired_ownership { source = Source.Ticket id; _ } ->
      "ticket:" ^ Id.Ticket.to_string id
    | Stale_ownership
        { source = Source.Reservation name
        ; metadata = Ownership.Reservation { run_id; _ }
        }
    | Expired_ownership
        { source = Source.Reservation name
        ; metadata = Ownership.Reservation { run_id; _ }
        } ->
      "reservation:" ^ Reservation.Name.to_string name ^ ":" ^ Id.Run.to_string run_id
    | Stale_ownership _ | Expired_ownership _ ->
      Json.fail Invalid_argument "ownership source mismatch"
    | Unanswered_request { request_id; _ } ->
      Communication_id.Request.to_string request_id
    | Changed_input r -> Int.to_string r.serial
    | Pending_review r -> Id.Ticket.to_string r.ticket
    | Reservation r -> Reservation.Name.to_string r.name
    | Reported_usage r -> Usage_record.Id.to_string r.id
    | Budget_limit r ->
      Id.Run.to_string r.run_id ^ ":" ^ Run_budget.Attention.Kind.to_string r.kind
    | Runner_action r -> Id.Run.to_string r.child
  ;;

  let wrong () = Json.fail Invalid_argument "coordinator row kind mismatch"

  let branch tag metadata decode encode =
    Api_codec.map
      (Api_codec.object_
         (req "kind" (Api_codec.literal tag)
          ++ req "source" Source.codec
          ++ req "metadata" metadata))
      ~decode:(fun (((), source), metadata) ->
        Json.decode (fun () -> decode source metadata))
      ~encode:(fun value ->
        let source, metadata = encode value in
        ((), source), metadata)
      ~description:("Exact typed " ^ tag ^ " source and metadata correspondence.")
  ;;

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "active_attempt"
          , branch
              "active_attempt"
              Active_attempt.codec
              (fun source metadata ->
                 match source with
                 | Source.Attempt attempt_id -> Active_attempt { attempt_id; metadata }
                 | _ -> wrong ())
              (function
                | Active_attempt { attempt_id; metadata } ->
                  Source.Attempt attempt_id, metadata
                | _ -> wrong ()) )
        ; ( "ready_work"
          , branch
              "ready_work"
              Ready.codec
              (fun source metadata ->
                 match source with
                 | Source.Ticket ticket_id ->
                   check
                     (List.is_empty metadata.Ready.allocation_reasons)
                     "ready work cannot retain allocation blockers";
                   Ready_work { ticket_id; metadata }
                 | _ -> wrong ())
              (function
                | Ready_work { ticket_id; metadata } -> Source.Ticket ticket_id, metadata
                | _ -> wrong ()) )
        ; ( "allocation_blocked"
          , branch
              "allocation_blocked"
              Ready.codec
              (fun source metadata ->
                 match source with
                 | Source.Ticket ticket_id ->
                   check
                     (not (List.is_empty metadata.Ready.allocation_reasons))
                     "allocation blocked needs a reason";
                   Allocation_blocked { ticket_id; metadata }
                 | _ -> wrong ())
              (function
                | Allocation_blocked { ticket_id; metadata } ->
                  Source.Ticket ticket_id, metadata
                | _ -> wrong ()) )
        ; ( "stale_run"
          , branch
              "stale_run"
              Stale_run.codec
              (fun source metadata ->
                 match source with
                 | Source.Run run_id -> Stale_run { run_id; metadata }
                 | _ -> wrong ())
              (function
                | Stale_run { run_id; metadata } -> Source.Run run_id, metadata
                | _ -> wrong ()) )
        ; ( "unanswered_request"
          , branch
              "unanswered_request"
              Request.codec
              (fun source metadata ->
                 match source with
                 | Source.Request request_id ->
                   Unanswered_request { request_id; metadata }
                 | _ -> wrong ())
              (function
                | Unanswered_request { request_id; metadata } ->
                  Source.Request request_id, metadata
                | _ -> wrong ()) )
        ; ( "dependency_bottleneck"
          , branch
              "dependency_bottleneck"
              Dependency.codec
              (fun source metadata ->
                 match source with
                 | Source.Ticket ticket_id ->
                   Dependency_bottleneck { ticket_id; metadata }
                 | _ -> wrong ())
              (function
                | Dependency_bottleneck { ticket_id; metadata } ->
                  Source.Ticket ticket_id, metadata
                | _ -> wrong ()) )
        ; ( "stale_ownership"
          , branch
              "stale_ownership"
              Ownership.codec
              (fun source metadata ->
                 (match source, metadata with
                  | Source.Ticket _, Ownership.Ticket _
                  | Source.Reservation _, Ownership.Reservation _ -> ()
                  | _ -> wrong ());
                 let status =
                   match metadata with
                   | Ownership.Ticket { lease_status; _ }
                   | Ownership.Reservation { lease_status; _ } -> lease_status
                 in
                 check
                   (Bool.equal (Allocation_lease.Status.equal status Expired) false)
                   "ownership row differs from observed lease status";
                 Stale_ownership { source; metadata })
              (function
                | Stale_ownership { source; metadata } -> source, metadata
                | _ -> wrong ()) )
        ; ( "expired_ownership"
          , branch
              "expired_ownership"
              Ownership.codec
              (fun source metadata ->
                 (match source, metadata with
                  | Source.Ticket _, Ownership.Ticket _
                  | Source.Reservation _, Ownership.Reservation _ -> ()
                  | _ -> wrong ());
                 let status =
                   match metadata with
                   | Ownership.Ticket { lease_status; _ }
                   | Ownership.Reservation { lease_status; _ } -> lease_status
                 in
                 check
                   (Bool.equal (Allocation_lease.Status.equal status Expired) true)
                   "ownership row differs from observed lease status";
                 Expired_ownership { source; metadata })
              (function
                | Expired_ownership { source; metadata } -> source, metadata
                | _ -> wrong ()) )
        ; ( "changed_input"
          , branch
              "changed_input"
              Evidence_wire.reconciliation
              (fun src metadata ->
                 check
                   (Evidence.Reconciliation.State.equal
                      metadata.Evidence.Reconciliation.state
                      Pending)
                   "changed input must be pending";
                 let row = Changed_input metadata in
                 check
                   (Source.equal src (source row))
                   "source differs from metadata identity";
                 row)
              (function
                | Changed_input metadata as row -> source row, metadata
                | _ -> wrong ()) )
        ; ( "pending_review"
          , branch
              "pending_review"
              Evidence_wire.submission
              (fun src metadata ->
                 (match metadata.Evidence.Submission.state with
                  | Pending -> ()
                  | Accepted _ | Changes_requested _ ->
                    Json.fail Invalid_argument "pending review must be pending");
                 let row = Pending_review metadata in
                 check
                   (Source.equal src (source row))
                   "source differs from metadata identity";
                 row)
              (function
                | Pending_review metadata as row -> source row, metadata
                | _ -> wrong ()) )
        ; ( "reservation"
          , branch
              "reservation"
              Agent_run_wire.reservation
              (fun src metadata ->
                 let row = Reservation metadata in
                 check
                   (Source.equal src (source row))
                   "source differs from metadata identity";
                 row)
              (function
                | Reservation metadata as row -> source row, metadata
                | _ -> wrong ()) )
        ; ( "reported_usage"
          , branch
              "reported_usage"
              Usage_record_wire.record
              (fun src metadata ->
                 let row = Reported_usage metadata in
                 check
                   (Source.equal src (source row))
                   "source differs from metadata identity";
                 row)
              (function
                | Reported_usage metadata as row -> source row, metadata
                | _ -> wrong ()) )
        ; ( "budget_limit"
          , branch
              "budget_limit"
              Run_budget.Attention.codec
              (fun src metadata ->
                 let row = Budget_limit metadata in
                 check
                   (Source.equal src (source row))
                   "source differs from metadata identity";
                 row)
              (function
                | Budget_limit metadata as row -> source row, metadata
                | _ -> wrong ()) )
        ; ( "runner_action"
          , branch
              "runner_action"
              Agent_run_wire.action
              (fun src metadata ->
                 let row = Runner_action metadata in
                 check
                   (Source.equal src (source row))
                   "source differs from metadata identity";
                 row)
              (function
                | Runner_action metadata as row -> source row, metadata
                | _ -> wrong ()) )
        ]
      ~select:(fun t -> Kind.to_string (kind t))
  ;;
end

module Edge = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; prerequisite_ticket_id : Id.Ticket.t
    }

  let base =
    Api_codec.object_
      (F.map
         (req "ticket_id" W.ticket ++ req "prerequisite_ticket_id" W.ticket)
         ~decode:(fun (ticket_id, prerequisite_ticket_id) ->
           { ticket_id; prerequisite_ticket_id })
         ~encode:(fun (t : t) -> t.ticket_id, t.prerequisite_ticket_id))
  ;;

  let codec = base
end

let unavailable_duration =
  W.checked (nullable nonnegative64) (fun value ->
    check (Option.is_none value) "duration estimates unavailable")
;;

module Response = struct
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

  let base =
    Api_codec.object_
      (F.map
         (req "workspace_id" (W.id Id.Workspace.of_string Id.Workspace.to_string)
          ++ req "captured_now_unix_ms" nonnegative64
          ++ req "items" (Api_codec.list Item.codec ~max_items:100)
          ++ req "next_cursor" (nullable (W.nonblank ~max_bytes:2048))
          ++ req "omitted" counter
          ++ req "needs_larger_budget" Api_codec.boolean
          ++ req "next_item_source" (nullable Source.codec)
          ++ req "required_bytes" (nullable positive)
          ++ req
               "dependency_path"
               (nullable (Api_codec.list Edge.codec ~max_items:100000))
          ++ req "dependency_path_omitted" counter)
         ~decode:
           (fun
             ( ( ( ( ( ( (((workspace_id, captured_now_unix_ms), items), next_cursor)
                       , omitted )
                     , needs_larger_budget )
                   , next_item_source )
                 , required_bytes )
               , dependency_path )
             , dependency_path_omitted ) ->
           { workspace_id
           ; captured_now_unix_ms
           ; items
           ; next_cursor
           ; omitted
           ; needs_larger_budget
           ; next_item_source
           ; required_bytes
           ; dependency_path
           ; dependency_path_omitted
           })
         ~encode:(fun (t : t) ->
           ( ( ( ( ( ( (((t.workspace_id, t.captured_now_unix_ms), t.items), t.next_cursor)
                     , t.omitted )
                   , t.needs_larger_budget )
                 , t.next_item_source )
               , t.required_bytes )
             , t.dependency_path )
           , t.dependency_path_omitted )))
  ;;

  let full =
    Api_codec.map
      (Api_codec.merge_objects
         base
         (Api_codec.object_
            (req "critical_path_duration_ms" unavailable_duration
             ++ req
                  "critical_path_reason"
                  (Api_codec.literal "Task duration estimates are unavailable"))))
      ~decode:(fun (t, _) -> Ok t)
      ~encode:(fun t -> t, (None, ()))
      ~description:"No inferred duration estimates."
  ;;

  let codec =
    W.checked full (fun t ->
      List.iter t.items ~f:(function
        | Item.Stale_ownership
            { metadata = Ownership.Ticket { lease; lease_status; _ }; _ }
        | Item.Expired_ownership
            { metadata = Ownership.Ticket { lease; lease_status; _ }; _ } ->
          check
            (Allocation_lease.Status.equal
               lease_status
               (Allocation_lease.status lease ~now_unix_ms:t.captured_now_unix_ms))
            "ticket lease status differs from captured clock"
        | Item.Active_attempt _
        | Ready_work _
        | Allocation_blocked _
        | Stale_run _
        | Stale_ownership _
        | Expired_ownership _
        | Unanswered_request _
        | Changed_input _
        | Pending_review _
        | Reservation _
        | Reported_usage _
        | Budget_limit _
        | Dependency_bottleneck _
        | Runner_action _ -> ());
      let keys =
        List.map t.items ~f:(fun row ->
          Kind.to_string (Item.kind row), Item.order_key row)
      in
      let compare (ak, ai) (bk, bi) =
        let kind = String.compare ak bk in
        if kind = 0 then String.compare ai bi else kind
      in
      check
        (List.is_sorted keys ~compare && not (List.contains_dup keys ~compare))
        "coordinator rows must have distinct ascending kind/key order";
      check
        (Bool.equal (Option.is_some t.next_cursor) (t.omitted > 0))
        "remaining rows differ from cursor";
      check
        (Bool.equal t.needs_larger_budget (t.omitted > 0 && List.is_empty t.items))
        "oversized row disclosure inconsistent";
      check
        (Bool.equal (Option.is_some t.next_item_source) t.needs_larger_budget
         && Bool.equal (Option.is_some t.required_bytes) t.needs_larger_budget)
        "oversized source/bytes disclosure inconsistent";
      check
        (Option.is_some t.dependency_path || t.dependency_path_omitted = 0)
        "missing dependency path cannot omit edges")
  ;;
end
