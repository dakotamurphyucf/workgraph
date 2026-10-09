open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both
let counter = Coordination_wire.counter
let positive = Coordination_wire.positive
let text = Api_codec.text ~max_bytes:65536
let timestamp = Api_codec.text ~max_bytes:128
let title = Coordination_wire.nonblank ~max_bytes:512
let display_key = Coordination_wire.nonblank ~max_bytes:96

let category =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

let id of_string to_string = Coordination_wire.id of_string to_string

let unique codec ~max_items ~compare =
  Api_codec.map
    (Api_codec.list codec ~max_items)
    ~decode:(fun values ->
      if List.length values = List.length (List.dedup_and_sort values ~compare)
      then Ok values
      else Error (Problem.create Invalid_argument "duplicate public links"))
    ~encode:Fn.id
    ~description:"Unique typed identities, original order retained."
;;

let validate condition message value =
  if condition then Ok value else Error (Problem.create Invalid_argument message)
;;

module Lease = struct
  type t =
    { epoch : int
    ; revision : int
    ; duration_ms : int64 option
    ; last_unix_ms : int64
    ; deadline_unix_ms : int64 option
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "epoch" positive
          ++ Fields.required "revision" positive
          ++ Fields.required
               "duration_ms"
               (Api_codec.nullable (Api_codec.decimal64 ~max:Int64.max_value))
          ++ Fields.required "last_unix_ms" (Api_codec.decimal64 ~max:Int64.max_value)
          ++ Fields.required
               "deadline_unix_ms"
               (Api_codec.nullable (Api_codec.decimal64 ~max:Int64.max_value)))
         ~decode:
           (fun
             ((((epoch, revision), duration_ms), last_unix_ms), deadline_unix_ms) ->
           { epoch; revision; duration_ms; last_unix_ms; deadline_unix_ms })
         ~encode:
           (fun
             ({ epoch; revision; duration_ms; last_unix_ms; deadline_unix_ms } : t) ->
           (((epoch, revision), duration_ms), last_unix_ms), deadline_unix_ms))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun t ->
        Result.map
          (Api_codec.encode base t |> Result.bind ~f:Allocation_lease.of_json)
          ~f:(fun _ -> t))
      ~encode:Fn.id
      ~description:"Actual Allocation_lease duration/deadline and counter invariants."
  ;;

  let of_domain lease =
    { epoch = Allocation_lease.epoch lease
    ; revision = Allocation_lease.revision lease
    ; duration_ms =
        (match Allocation_lease.policy lease with
         | Indefinite -> None
         | Duration_ms ms -> Some ms)
    ; last_unix_ms = Allocation_lease.last_unix_ms lease
    ; deadline_unix_ms = Allocation_lease.deadline_unix_ms lease
    }
  ;;
end

module Ownership = struct
  type t =
    { actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; token : int
    ; lease : Lease.t
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required
               "run_id"
               (Api_codec.nullable (id Id.Run.of_string Id.Run.to_string))
          ++ Fields.required "token" positive
          ++ Fields.required "lease" Lease.codec)
         ~decode:(fun (((actor_id, run_id), token), lease) ->
           { actor_id; run_id; token; lease })
         ~encode:(fun ({ actor_id; run_id; token; lease } : t) ->
           ((actor_id, run_id), token), lease))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun t ->
        validate (t.token = t.lease.epoch) "ownership token differs from lease epoch" t)
      ~encode:Fn.id
      ~description:"Positive ownership token equals immutable lease epoch."
  ;;
end

module Hold = struct
  type t =
    { actor_id : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required "reason" (Coordination_wire.nonblank ~max_bytes:65536)
          ++ Fields.required "timestamp" timestamp)
         ~decode:(fun ((actor_id, reason), timestamp) -> { actor_id; reason; timestamp })
         ~encode:(fun ({ actor_id; reason; timestamp } : t) ->
           (actor_id, reason), timestamp))
  ;;

  let codec = base
end

module Waiver = struct
  type t =
    { prerequisite_ticket_id : Id.Ticket.t
    ; actor_id : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required
            "prerequisite_ticket_id"
            (id Id.Ticket.of_string Id.Ticket.to_string)
          ++ Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required "reason" (Coordination_wire.nonblank ~max_bytes:65536)
          ++ Fields.required "timestamp" timestamp)
         ~decode:(fun (((prerequisite_ticket_id, actor_id), reason), timestamp) ->
           { prerequisite_ticket_id; actor_id; reason; timestamp })
         ~encode:(fun ({ prerequisite_ticket_id; actor_id; reason; timestamp } : t) ->
           ((prerequisite_ticket_id, actor_id), reason), timestamp))
  ;;

  let codec = base
end

module Reassessment = struct
  type t =
    { prerequisite_ticket_id : Id.Ticket.t
    ; reopened_revision : int
    ; reason : string
    ; actor_id : Id.Actor.t
    ; timestamp : string
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required
            "prerequisite_ticket_id"
            (id Id.Ticket.of_string Id.Ticket.to_string)
          ++ Fields.required "reopened_revision" positive
          ++ Fields.required "reason" (Coordination_wire.nonblank ~max_bytes:65536)
          ++ Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required "timestamp" timestamp)
         ~decode:
           (fun
             ((((prerequisite_ticket_id, reopened_revision), reason), actor_id), timestamp) ->
           { prerequisite_ticket_id; reopened_revision; reason; actor_id; timestamp })
         ~encode:
           (fun
             ({ prerequisite_ticket_id; reopened_revision; reason; actor_id; timestamp } :
               t) ->
           (((prerequisite_ticket_id, reopened_revision), reason), actor_id), timestamp))
  ;;

  let codec = base
end

module Ticket = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; description : string
    ; project_id : Id.Project.t option
    ; membership_revision : int
    ; parent_ticket_id : Id.Ticket.t option
    ; milestone_id : Id.Milestone.t option
    ; archived : bool
    ; status_id : Id.Status.t option
    ; priority : int
    ; assignee_id : Id.Actor.t option
    ; label_ids : Id.Label.t list
    ; acceptance_criteria : string
    ; status : Workflow.Category.t
    ; revision : int
    ; hold : Hold.t option
    ; waivers : Waiver.t list
    ; prerequisite_ticket_ids : Id.Ticket.t list
    ; related_ticket_ids : Id.Ticket.t list
    ; claim : Ownership.t option
    ; created_order : int
    ; reopened_token : int option
    ; reassessments : Reassessment.t list
    ; created_sequence : int
    ; created_at : string
    ; updated_at : string
    ; next_token : int
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "ticket_id" (id Id.Ticket.of_string Id.Ticket.to_string)
          ++ Fields.required "display_key" display_key
          ++ Fields.required "title" title
          ++ Fields.required "description" text
          ++ Fields.required
               "project_id"
               (Api_codec.nullable (id Id.Project.of_string Id.Project.to_string))
          ++ Fields.required "membership_revision" positive
          ++ Fields.required
               "parent_ticket_id"
               (Api_codec.nullable (id Id.Ticket.of_string Id.Ticket.to_string))
          ++ Fields.required
               "milestone_id"
               (Api_codec.nullable (id Id.Milestone.of_string Id.Milestone.to_string))
          ++ Fields.required "archived" Api_codec.boolean
          ++ Fields.required
               "status_id"
               (Api_codec.nullable (id Id.Status.of_string Id.Status.to_string))
          ++ Fields.required "priority" (Api_codec.decimal ~max:4)
          ++ Fields.required
               "assignee_id"
               (Api_codec.nullable (id Id.Actor.of_string Id.Actor.to_string))
          ++ Fields.required
               "label_ids"
               (unique
                  (id Id.Label.of_string Id.Label.to_string)
                  ~max_items:100
                  ~compare:Id.Label.compare)
          ++ Fields.required "acceptance_criteria" text
          ++ Fields.required "status" category
          ++ Fields.required "revision" positive
          ++ Fields.required "hold" (Api_codec.nullable Hold.codec)
          ++ Fields.required "waivers" (Api_codec.list Waiver.codec ~max_items:100000)
          ++ Fields.required
               "prerequisite_ticket_ids"
               (unique
                  (id Id.Ticket.of_string Id.Ticket.to_string)
                  ~max_items:100000
                  ~compare:Id.Ticket.compare)
          ++ Fields.required
               "related_ticket_ids"
               (unique
                  (id Id.Ticket.of_string Id.Ticket.to_string)
                  ~max_items:100000
                  ~compare:Id.Ticket.compare)
          ++ Fields.required "claim" (Api_codec.nullable Ownership.codec)
          ++ Fields.required "created_order" positive
          ++ Fields.required "reopened_token" (Api_codec.nullable positive)
          ++ Fields.required
               "reassessments"
               (Api_codec.list Reassessment.codec ~max_items:100000)
          ++ Fields.required "created_sequence" positive
          ++ Fields.required "created_at" timestamp
          ++ Fields.required "updated_at" timestamp
          ++ Fields.required "next_token" positive)
         ~decode:
           (fun
             ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( (ticket_id, display_key)
                                                               , title )
                                                             , description )
                                                           , project_id )
                                                         , membership_revision )
                                                       , parent_ticket_id )
                                                     , milestone_id )
                                                   , archived )
                                                 , status_id )
                                               , priority )
                                             , assignee_id )
                                           , label_ids )
                                         , acceptance_criteria )
                                       , status )
                                     , revision )
                                   , hold )
                                 , waivers )
                               , prerequisite_ticket_ids )
                             , related_ticket_ids )
                           , claim )
                         , created_order )
                       , reopened_token )
                     , reassessments )
                   , created_sequence )
                 , created_at )
               , updated_at )
             , next_token ) ->
           { ticket_id
           ; display_key
           ; title
           ; description
           ; project_id
           ; membership_revision
           ; parent_ticket_id
           ; milestone_id
           ; archived
           ; status_id
           ; priority
           ; assignee_id
           ; label_ids
           ; acceptance_criteria
           ; status
           ; revision
           ; hold
           ; waivers
           ; prerequisite_ticket_ids
           ; related_ticket_ids
           ; claim
           ; created_order
           ; reopened_token
           ; reassessments
           ; created_sequence
           ; created_at
           ; updated_at
           ; next_token
           })
         ~encode:
           (fun
             ({ ticket_id
              ; display_key
              ; title
              ; description
              ; project_id
              ; membership_revision
              ; parent_ticket_id
              ; milestone_id
              ; archived
              ; status_id
              ; priority
              ; assignee_id
              ; label_ids
              ; acceptance_criteria
              ; status
              ; revision
              ; hold
              ; waivers
              ; prerequisite_ticket_ids
              ; related_ticket_ids
              ; claim
              ; created_order
              ; reopened_token
              ; reassessments
              ; created_sequence
              ; created_at
              ; updated_at
              ; next_token
              } :
               t) ->
           ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( ( (ticket_id, display_key)
                                                             , title )
                                                           , description )
                                                         , project_id )
                                                       , membership_revision )
                                                     , parent_ticket_id )
                                                   , milestone_id )
                                                 , archived )
                                               , status_id )
                                             , priority )
                                           , assignee_id )
                                         , label_ids )
                                       , acceptance_criteria )
                                     , status )
                                   , revision )
                                 , hold )
                               , waivers )
                             , prerequisite_ticket_ids )
                           , related_ticket_ids )
                         , claim )
                       , created_order )
                     , reopened_token )
                   , reassessments )
                 , created_sequence )
               , created_at )
             , updated_at )
           , next_token )))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun t ->
        let counters =
          t.membership_revision <= t.revision
          && t.next_token - 1 <= t.revision
          && Option.for_all t.reopened_token ~f:(fun token -> token <= t.next_token)
          && Option.for_all t.claim ~f:(fun claim -> claim.Ownership.token < t.next_token)
        in
        let waivers =
          List.map t.waivers ~f:(fun value -> value.Waiver.prerequisite_ticket_id)
        in
        let unique_waivers =
          List.length waivers
          = List.length (List.dedup_and_sort waivers ~compare:Id.Ticket.compare)
        in
        validate
          (counters && unique_waivers)
          "ticket membership/ownership counters or duplicate waivers are inconsistent"
          t)
      ~encode:Fn.id
      ~description:
        "Exact canonical ticket identity, counters, ownership and links; prose can \
         disclose bounded prefixes."
  ;;
end

module Handoff = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; actor_id : Id.Actor.t
    ; summary : string
    ; next_steps : string
    ; evidence : string
    ; revision : int
    ; objective : string
    ; completed : string
    ; decisions : string
    ; blockers : string
    ; resource_ids : Id.Resource.t list
    ; timestamp : string
    ; covers_through : int
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "ticket_id" (id Id.Ticket.of_string Id.Ticket.to_string)
          ++ Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required "summary" text
          ++ Fields.required "next_steps" text
          ++ Fields.required "evidence" text
          ++ Fields.required "revision" positive
          ++ Fields.required "objective" text
          ++ Fields.required "completed" text
          ++ Fields.required "decisions" text
          ++ Fields.required "blockers" text
          ++ Fields.required
               "resource_ids"
               (unique
                  (id Id.Resource.of_string Id.Resource.to_string)
                  ~max_items:100000
                  ~compare:Id.Resource.compare)
          ++ Fields.required "timestamp" timestamp
          ++ Fields.required "covers_through" counter)
         ~decode:
           (fun
             ( ( ( ( ( ( ( ( ((((ticket_id, actor_id), summary), next_steps), evidence)
                           , revision )
                         , objective )
                       , completed )
                     , decisions )
                   , blockers )
                 , resource_ids )
               , timestamp )
             , covers_through ) ->
           { ticket_id
           ; actor_id
           ; summary
           ; next_steps
           ; evidence
           ; revision
           ; objective
           ; completed
           ; decisions
           ; blockers
           ; resource_ids
           ; timestamp
           ; covers_through
           })
         ~encode:
           (fun
             ({ ticket_id
              ; actor_id
              ; summary
              ; next_steps
              ; evidence
              ; revision
              ; objective
              ; completed
              ; decisions
              ; blockers
              ; resource_ids
              ; timestamp
              ; covers_through
              } :
               t) ->
           ( ( ( ( ( ( ( ( ((((ticket_id, actor_id), summary), next_steps), evidence)
                         , revision )
                       , objective )
                     , completed )
                   , decisions )
                 , blockers )
               , resource_ids )
             , timestamp )
           , covers_through )))
  ;;

  let codec = base
end

let problem_codec =
  let names =
    [ "Invalid_argument", Problem.Invalid_argument
    ; "Not_found", Not_found
    ; "Conflict", Conflict
    ; "Blocked", Blocked
    ; "Dependency_cycle", Dependency_cycle
    ; "Already_claimed", Already_claimed
    ; "Stale_claim", Stale_claim
    ; "Idempotency_conflict", Idempotency_conflict
    ; "Corrupt_store", Corrupt_store
    ; "Storage_unavailable", Storage_unavailable
    ; "Outcome_unknown", Outcome_unknown
    ; "Workspace_closed", Workspace_closed
    ; "Unsupported_version", Unsupported_version
    ]
  in
  let cases =
    List.map names ~f:(fun (name, kind) ->
      ( name
      , Api_codec.object_
          (Fields.map
             (Fields.required "kind" (Api_codec.literal name)
              ++ Fields.required "message" text)
             ~decode:(fun ((), message) -> Problem.create kind message)
             ~encode:(fun (value : Problem.t) ->
               if not (Problem.equal_kind value.kind kind)
               then Json.fail Invalid_argument "wrong problem constructor";
               (), value.message)) ))
  in
  Api_codec.tagged ~discriminator:"kind" ~cases ~select:(fun (value : Problem.t) ->
    List.find_map_exn names ~f:(fun (name, kind) ->
      if Problem.equal_kind kind value.kind then Some name else None))
;;

module Completion = struct
  module Check = struct
    type kind =
      | Hold
      | Prerequisites
      | Children
      | Configured_policy
    [@@deriving equal]

    type t =
      { kind : kind
      ; passed : bool
      }

    let kind =
      Api_codec.enum
        [ "hold", Hold
        ; "prerequisites", Prerequisites
        ; "children", Children
        ; "configured_policy", Configured_policy
        ]
        ~equal:equal_kind
    ;;

    let codec =
      Api_codec.object_
        (Fields.map
           (Fields.required "kind" kind ++ Fields.required "passed" Api_codec.boolean)
           ~decode:(fun (kind, passed) -> { kind; passed })
           ~encode:(fun { kind; passed } -> kind, passed))
    ;;
  end

  type t =
    { can_complete : bool
    ; checks : Check.t list
    ; policy : Acceptance_policy.Effective.t
    ; blocked_prerequisite_count : int
    ; unfinished_child_count : int
    ; blocked_prerequisite_ids : Id.Ticket.t list
    ; unfinished_child_ids : Id.Ticket.t list
    ; problem : Problem.t option
    }

  let links =
    unique
      (id Id.Ticket.of_string Id.Ticket.to_string)
      ~max_items:100000
      ~compare:Id.Ticket.compare
  ;;

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "can_complete" Api_codec.boolean
          ++ Fields.required "checks" (Api_codec.list Check.codec ~max_items:4)
          ++ Fields.required "policy" Acceptance_policy.Effective.codec
          ++ Fields.required "blocked_prerequisite_count" counter
          ++ Fields.required "unfinished_child_count" counter
          ++ Fields.required "blocked_prerequisite_ids" links
          ++ Fields.required "unfinished_child_ids" links
          ++ Fields.required "problem" (Api_codec.nullable problem_codec))
         ~decode:
           (fun
             ( ( ( ( (((can_complete, checks), policy), blocked_prerequisite_count)
                   , unfinished_child_count )
                 , blocked_prerequisite_ids )
               , unfinished_child_ids )
             , problem ) ->
           { can_complete
           ; checks
           ; policy
           ; blocked_prerequisite_count
           ; unfinished_child_count
           ; blocked_prerequisite_ids
           ; unfinished_child_ids
           ; problem
           })
         ~encode:
           (fun
             { can_complete
             ; checks
             ; policy
             ; blocked_prerequisite_count
             ; unfinished_child_count
             ; blocked_prerequisite_ids
             ; unfinished_child_ids
             ; problem
             } ->
           ( ( ( ( (((can_complete, checks), policy), blocked_prerequisite_count)
                 , unfinished_child_count )
               , blocked_prerequisite_ids )
             , unfinished_child_ids )
           , problem )))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun t ->
        let checks =
          List.for_all
            [ Check.Hold; Prerequisites; Children; Configured_policy ]
            ~f:(fun kind ->
              List.count t.checks ~f:(fun check -> Check.equal_kind check.Check.kind kind)
              = 1)
        in
        validate
          (checks
           && t.blocked_prerequisite_count = List.length t.blocked_prerequisite_ids
           && t.unfinished_child_count = List.length t.unfinished_child_ids
           && Bool.equal t.can_complete (Option.is_none t.problem)
           && Bool.equal
                t.can_complete
                (List.for_all t.checks ~f:(fun check -> check.Check.passed)))
          "inconsistent completion readiness checks/counts/problem"
          t)
      ~encode:Fn.id
      ~description:
        "Four exact completion checks with retained IDs and matching counts/problem."
  ;;
end

module Readiness = struct
  module Reason = struct
    type t =
      | Archived_scope
      | Status of Workflow.Category.t
      | Hold of Hold.t
      | Claimed of
          { details : Ownership.t
          ; revision : int
          }
      | Prerequisite of Id.Ticket.t
      | Coordination of Agent_run.Start_blocker.t
      | Observation_time_required of Path_scope.t

    let wrong () = Json.fail Invalid_argument "wrong readiness reason constructor"

    let branch tag fields ~decode ~encode =
      Api_codec.map
        (Api_codec.object_
           (Fields.both (Fields.required "kind" (Api_codec.literal tag)) fields))
        ~decode:(fun ((), fields) -> Ok (decode fields))
        ~encode:(fun value -> (), encode value)
        ~description:("Exact readiness reason " ^ tag)
    ;;

    let none =
      branch
        "archived_scope"
        Fields.empty
        ~decode:(fun () -> Archived_scope)
        ~encode:(function
          | Archived_scope -> ()
          | _ -> wrong ())
    ;;

    let status =
      branch
        "status"
        (Fields.required "category" category)
        ~decode:(fun value -> Status value)
        ~encode:(function
          | Status value -> value
          | _ -> wrong ())
    ;;

    let hold =
      branch
        "hold"
        (Fields.required "details" Hold.codec)
        ~decode:(fun value -> Hold value)
        ~encode:(function
          | Hold value -> value
          | _ -> wrong ())
    ;;

    let claimed =
      branch
        "claimed"
        (Fields.required "details" Ownership.codec ++ Fields.required "revision" positive)
        ~decode:(fun (details, revision) -> Claimed { details; revision })
        ~encode:(function
          | Claimed { details; revision } -> details, revision
          | _ -> wrong ())
    ;;

    let prerequisite =
      branch
        "prerequisite"
        (Fields.required "ticket_id" (id Id.Ticket.of_string Id.Ticket.to_string))
        ~decode:(fun value -> Prerequisite value)
        ~encode:(function
          | Prerequisite value -> value
          | _ -> wrong ())
    ;;

    let run_required =
      branch
        "run_required"
        (Fields.required "target" Path_scope.codec)
        ~decode:(fun value -> Coordination (Run_required value))
        ~encode:(function
          | Coordination (Run_required value) -> value
          | _ -> wrong ())
    ;;

    let path_fields =
      Fields.required "target" Path_scope.codec
      ++ Fields.required "reservation" Path_scope.codec
      ++ Fields.required "holder" Agent_run_wire.holder
    ;;

    let path_conflict =
      branch
        "path_conflict"
        path_fields
        ~decode:(fun ((target, reservation), holder) ->
          Coordination (Path_conflict { target; reservation; holder }))
        ~encode:(function
          | Coordination (Path_conflict { target; reservation; holder }) ->
            (target, reservation), holder
          | _ -> wrong ())
    ;;

    let expired =
      branch
        "expired_required_ownership"
        path_fields
        ~decode:(fun ((target, reservation), holder) ->
          Coordination (Expired_required_ownership { target; reservation; holder }))
        ~encode:(function
          | Coordination (Expired_required_ownership { target; reservation; holder }) ->
            (target, reservation), holder
          | _ -> wrong ())
    ;;

    let ownership_mode =
      branch
        "ownership_mode"
        (Fields.required "target" Path_scope.codec
         ++ Fields.required "holder" Agent_run_wire.holder)
        ~decode:(fun (target, holder) -> Coordination (Ownership_mode { target; holder }))
        ~encode:(function
          | Coordination (Ownership_mode { target; holder }) -> target, holder
          | _ -> wrong ())
    ;;

    let external_condition =
      branch
        "external_condition"
        (Fields.required
           "condition_id"
           (id Coordination_id.Condition.of_string Coordination_id.Condition.to_string)
         ++ Fields.required "revision" positive
         ++ Fields.required
              "operation_id"
              (id Coordination_id.Operation.of_string Coordination_id.Operation.to_string)
         ++ Fields.required "artifact" Evidence_wire.pin
         ++ Fields.required "label" (Coordination_wire.nonblank ~max_bytes:512))
        ~decode:(fun ((((condition_id, revision), operation_id), artifact), label) ->
          Coordination
            (External_condition { condition_id; revision; operation_id; artifact; label }))
        ~encode:(function
          | Coordination
              (External_condition
                 { condition_id; revision; operation_id; artifact; label }) ->
            (((condition_id, revision), operation_id), artifact), label
          | _ -> wrong ())
    ;;

    let observation =
      branch
        "observation_time_required"
        (Fields.required "target" Path_scope.codec)
        ~decode:(fun value -> Observation_time_required value)
        ~encode:(function
          | Observation_time_required value -> value
          | _ -> wrong ())
    ;;

    let codec =
      Api_codec.tagged
        ~discriminator:"kind"
        ~cases:
          [ "archived_scope", none
          ; "status", status
          ; "hold", hold
          ; "claimed", claimed
          ; "prerequisite", prerequisite
          ; "run_required", run_required
          ; "path_conflict", path_conflict
          ; "expired_required_ownership", expired
          ; "ownership_mode", ownership_mode
          ; "external_condition", external_condition
          ; "observation_time_required", observation
          ]
        ~select:(function
          | Archived_scope -> "archived_scope"
          | Status _ -> "status"
          | Hold _ -> "hold"
          | Claimed _ -> "claimed"
          | Prerequisite _ -> "prerequisite"
          | Observation_time_required _ -> "observation_time_required"
          | Coordination (Run_required _) -> "run_required"
          | Coordination (Path_conflict _) -> "path_conflict"
          | Coordination (Expired_required_ownership _) -> "expired_required_ownership"
          | Coordination (Ownership_mode _) -> "ownership_mode"
          | Coordination (External_condition _) -> "external_condition")
    ;;
  end

  type t =
    { ready : bool
    ; reasons : Reason.t list
    ; reason_count : int
    ; reassessments : Reassessment.t list
    ; completion : Completion.t
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "ready" Api_codec.boolean
          ++ Fields.required "reasons" (Api_codec.list Reason.codec ~max_items:100000)
          ++ Fields.required "reason_count" counter
          ++ Fields.required
               "reassessments"
               (Api_codec.list Reassessment.codec ~max_items:100000)
          ++ Fields.required "completion" Completion.codec)
         ~decode:(fun ((((ready, reasons), reason_count), reassessments), completion) ->
           { ready; reasons; reason_count; reassessments; completion })
         ~encode:(fun { ready; reasons; reason_count; reassessments; completion } ->
           (((ready, reasons), reason_count), reassessments), completion))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun t ->
        validate
          (t.reason_count = List.length t.reasons
           && Bool.equal t.ready (List.is_empty t.reasons))
          "readiness flag/count differs from retained reasons"
          t)
      ~encode:Fn.id
      ~description:"Complete reasons retain ownership/control fields and exact count."
  ;;
end

let start_blocker_codec =
  let open Readiness.Reason in
  Api_codec.map
    (Api_codec.tagged
       ~discriminator:"kind"
       ~cases:
         [ "run_required", run_required
         ; "path_conflict", path_conflict
         ; "expired_required_ownership", expired
         ; "ownership_mode", ownership_mode
         ; "external_condition", external_condition
         ]
       ~select:(function
         | Coordination (Run_required _) -> "run_required"
         | Coordination (Path_conflict _) -> "path_conflict"
         | Coordination (Expired_required_ownership _) -> "expired_required_ownership"
         | Coordination (Ownership_mode _) -> "ownership_mode"
         | Coordination (External_condition _) -> "external_condition"
         | _ -> Json.fail Invalid_argument "expected coordination blocker"))
    ~decode:(function
      | Coordination value -> Ok value
      | _ -> Error (Problem.create Invalid_argument "expected coordination blocker"))
    ~encode:(fun value -> Coordination value)
    ~description:"Shared exact coordination blocker cases from authoritative readiness."
;;

module Summary = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; revision : int
    ; status : Workflow.Category.t
    ; priority : int
    ; readiness : Readiness.t
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "ticket_id" (id Id.Ticket.of_string Id.Ticket.to_string)
          ++ Fields.required "display_key" display_key
          ++ Fields.required "title" title
          ++ Fields.required "revision" positive
          ++ Fields.required "status" category
          ++ Fields.required "priority" (Api_codec.decimal ~max:4)
          ++ Fields.required "readiness" Readiness.codec)
         ~decode:
           (fun
             ( (((((ticket_id, display_key), title), revision), status), priority)
             , readiness ) ->
           { ticket_id; display_key; title; revision; status; priority; readiness })
         ~encode:
           (fun
             { ticket_id; display_key; title; revision; status; priority; readiness } ->
           (((((ticket_id, display_key), title), revision), status), priority), readiness))
  ;;
end
