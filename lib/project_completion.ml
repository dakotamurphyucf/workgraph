open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let require condition message = if not condition then Json.fail Invalid_argument message

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

let terminal = function
  | Workflow.Category.Done | Canceled -> true
  | Backlog | Todo | In_progress -> false
;;

let unfinished =
  W.checked category (fun status ->
    require (not (terminal status)) "unfinished category required")
;;

module Ticket = struct
  type t =
    { id : Id.Ticket.t
    ; status : Workflow.Category.t
    ; archived : bool
    ; claimed : bool
    ; active_attempts : Attempt.Id.t list
    ; completion_problem : Problem.t option
    }
end

module Milestone = struct
  type t =
    { id : Id.Milestone.t
    ; status : Workflow.Category.t
    ; archived : bool
    }
end

module Counts = struct
  type t =
    { tickets : int
    ; done_tickets : int
    ; canceled_tickets : int
    ; unfinished_tickets : int
    ; archived_tickets : int
    ; claimed_tickets : int
    ; active_attempts : int
    ; gated_tickets : int
    ; milestones : int
    ; unfinished_milestones : int
    ; archived_milestones : int
    ; open_requests : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "tickets" W.counter
          ++ F.required "done_tickets" W.counter
          ++ F.required "canceled_tickets" W.counter
          ++ F.required "unfinished_tickets" W.counter
          ++ F.required "archived_tickets" W.counter
          ++ F.required "claimed_tickets" W.counter
          ++ F.required "active_attempts" W.counter
          ++ F.required "gated_tickets" W.counter
          ++ F.required "milestones" W.counter
          ++ F.required "unfinished_milestones" W.counter
          ++ F.required "archived_milestones" W.counter
          ++ F.required "open_requests" W.counter)
         ~decode:
           (fun
             ( ( ( ( ( ( ( ( ( ((tickets, done_tickets), canceled_tickets)
                             , unfinished_tickets )
                           , archived_tickets )
                         , claimed_tickets )
                       , active_attempts )
                     , gated_tickets )
                   , milestones )
                 , unfinished_milestones )
               , archived_milestones )
             , open_requests ) ->
           { tickets
           ; done_tickets
           ; canceled_tickets
           ; unfinished_tickets
           ; archived_tickets
           ; claimed_tickets
           ; active_attempts
           ; gated_tickets
           ; milestones
           ; unfinished_milestones
           ; archived_milestones
           ; open_requests
           })
         ~encode:(fun t ->
           ( ( ( ( ( ( ( ( ( ((t.tickets, t.done_tickets), t.canceled_tickets)
                           , t.unfinished_tickets )
                         , t.archived_tickets )
                       , t.claimed_tickets )
                     , t.active_attempts )
                   , t.gated_tickets )
                 , t.milestones )
               , t.unfinished_milestones )
             , t.archived_milestones )
           , t.open_requests )))
    |> fun codec ->
    W.checked codec (fun t ->
      require
        (t.done_tickets <= t.tickets
         && t.canceled_tickets <= t.tickets - t.done_tickets
         && t.unfinished_tickets = t.tickets - t.done_tickets - t.canceled_tickets
         && t.archived_tickets <= t.tickets
         && t.claimed_tickets <= t.tickets
         && t.active_attempts <= t.tickets
         && t.gated_tickets <= t.done_tickets
         && t.unfinished_milestones <= t.milestones
         && t.archived_milestones <= t.milestones)
        "inconsistent project completion counts")
  ;;
end

module Blocker = struct
  module Ticket_reason = struct
    type t =
      | Unfinished of Workflow.Category.t
      | Claimed
      | Active_attempt of Attempt.Id.t
      | Completion_gate of Problem.t

    let codec =
      let branch tag fields decode encode =
        Api_codec.object_
          (F.map
             (F.required "kind" (Api_codec.literal tag) ++ fields)
             ~decode:(fun ((), value) -> decode value)
             ~encode:(fun value -> (), encode value))
      in
      Api_codec.tagged
        ~discriminator:"kind"
        ~cases:
          [ ( "unfinished"
            , branch
                "unfinished"
                (F.required "status" unfinished)
                (fun s -> Unfinished s)
                (function
                  | Unfinished s -> s
                  | Claimed | Active_attempt _ | Completion_gate _ ->
                    Json.fail Invalid_argument "unfinished reason required") )
          ; ( "claimed"
            , branch
                "claimed"
                F.empty
                (fun () -> Claimed)
                (function
                  | Claimed -> ()
                  | Unfinished _ | Active_attempt _ | Completion_gate _ ->
                    Json.fail Invalid_argument "claimed reason required") )
          ; ( "active_attempt"
            , branch
                "active_attempt"
                (F.required "attempt_id" (W.id Attempt.Id.of_string Attempt.Id.to_string))
                (fun id -> Active_attempt id)
                (function
                  | Active_attempt id -> id
                  | Unfinished _ | Claimed | Completion_gate _ ->
                    Json.fail Invalid_argument "attempt reason required") )
          ; ( "completion_gate"
            , branch
                "completion_gate"
                (F.required "problem" Problem_wire.codec)
                (fun p -> Completion_gate p)
                (function
                  | Completion_gate p -> p
                  | Unfinished _ | Claimed | Active_attempt _ ->
                    Json.fail Invalid_argument "completion gate required") )
          ]
        ~select:(function
          | Unfinished _ -> "unfinished"
          | Claimed -> "claimed"
          | Active_attempt _ -> "active_attempt"
          | Completion_gate _ -> "completion_gate")
    ;;
  end

  type t =
    | Ticket of
        { ticket_id : Id.Ticket.t
        ; reasons : Ticket_reason.t list
        }
    | Milestone of
        { milestone_id : Id.Milestone.t
        ; status : Workflow.Category.t
        }

  let codec =
    let ticket =
      Api_codec.object_
        (F.map
           (F.required "kind" (Api_codec.literal "ticket")
            ++ F.required "ticket_id" W.ticket
            ++ F.required "reasons" (Api_codec.list Ticket_reason.codec ~max_items:4))
           ~decode:(fun (((), ticket_id), reasons) -> Ticket { ticket_id; reasons })
           ~encode:(function
             | Ticket { ticket_id; reasons } -> ((), ticket_id), reasons
             | Milestone _ -> Json.fail Invalid_argument "ticket blocker required"))
      |> fun codec ->
      W.checked codec (function
        | Ticket { reasons; _ } ->
          require (not (List.is_empty reasons)) "project ticket blocker requires reasons";
          let kinds =
            List.map reasons ~f:(function
              | Ticket_reason.Unfinished _ -> 0
              | Claimed -> 1
              | Active_attempt _ -> 2
              | Completion_gate _ -> 3)
          in
          require
            (List.is_sorted_strictly kinds ~compare:Int.compare)
            "project blocker reasons must be distinct and ordered";
          require
            (not (List.mem kinds 0 ~equal:Int.equal && List.mem kinds 3 ~equal:Int.equal))
            "unfinished tickets cannot have Done-ticket completion gate reasons"
        | Milestone _ -> assert false)
    in
    let milestone =
      Api_codec.object_
        (F.map
           (F.required "kind" (Api_codec.literal "milestone")
            ++ F.required
                 "milestone_id"
                 (W.id Id.Milestone.of_string Id.Milestone.to_string)
            ++ F.required "status" unfinished)
           ~decode:(fun (((), milestone_id), status) ->
             Milestone { milestone_id; status })
           ~encode:(function
             | Milestone { milestone_id; status } -> ((), milestone_id), status
             | Ticket _ -> Json.fail Invalid_argument "milestone blocker required"))
    in
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:[ "ticket", ticket; "milestone", milestone ]
      ~select:(function
        | Ticket _ -> "ticket"
        | Milestone _ -> "milestone")
  ;;
end

type t =
  { project : Id.Project.t
  ; project_revision : int
  ; workspace_revision : int
  ; status : Workflow.Category.t
  ; counts : Counts.t
  ; blockers : Blocker.t list
  }

let project t = t.project
let project_revision t = t.project_revision
let workspace_revision t = t.workspace_revision
let status t = t.status
let counts t = t.counts
let blockers t = t.blockers
let can_complete t = List.is_empty t.blockers

let create
      ~project
      ~project_revision
      ~workspace_revision
      ~status
      ~tickets
      ~milestones
      ~open_requests
  =
  Json.decode (fun () ->
    require
      (project_revision > 0 && workspace_revision >= 0 && open_requests >= 0)
      "project completion revisions/counts are invalid";
    require
      (not
         (List.contains_dup tickets ~compare:(fun a b ->
            Id.Ticket.compare a.Ticket.id b.id)))
      "duplicate project ticket";
    require
      (not
         (List.contains_dup milestones ~compare:(fun a b ->
            Id.Milestone.compare a.Milestone.id b.id)))
      "duplicate project milestone";
    List.iter tickets ~f:(fun ticket ->
      require
        (List.length ticket.Ticket.active_attempts <= 1)
        "ticket has multiple active attempts");
    let attempts =
      List.concat_map tickets ~f:(fun ticket -> ticket.Ticket.active_attempts)
    in
    require
      (not (List.contains_dup attempts ~compare:Attempt.Id.compare))
      "project attempt belongs to multiple tickets";
    let count status =
      List.count tickets ~f:(fun t -> Workflow.Category.equal t.Ticket.status status)
    in
    let gate ticket =
      Workflow.Category.equal ticket.Ticket.status Done
      && Option.is_some ticket.completion_problem
    in
    let counts =
      { Counts.tickets = List.length tickets
      ; done_tickets = count Done
      ; canceled_tickets = count Canceled
      ; unfinished_tickets =
          List.count tickets ~f:(fun t -> not (terminal t.Ticket.status))
      ; archived_tickets = List.count tickets ~f:(fun t -> t.Ticket.archived)
      ; claimed_tickets = List.count tickets ~f:(fun t -> t.Ticket.claimed)
      ; active_attempts = List.length attempts
      ; gated_tickets = List.count tickets ~f:gate
      ; milestones = List.length milestones
      ; unfinished_milestones =
          List.count milestones ~f:(fun t -> not (terminal t.Milestone.status))
      ; archived_milestones = List.count milestones ~f:(fun t -> t.Milestone.archived)
      ; open_requests
      }
    in
    let ticket_blockers =
      List.sort tickets ~compare:(fun a b -> Id.Ticket.compare a.Ticket.id b.id)
      |> List.filter_map ~f:(fun ticket ->
        let reasons =
          (if terminal ticket.status
           then []
           else [ Blocker.Ticket_reason.Unfinished ticket.status ])
          @ (if ticket.claimed then [ Blocker.Ticket_reason.Claimed ] else [])
          @ List.map ticket.active_attempts ~f:(fun id ->
            Blocker.Ticket_reason.Active_attempt id)
          @
          if gate ticket
          then
            [ Blocker.Ticket_reason.Completion_gate
                (Option.value_exn ticket.completion_problem)
            ]
          else []
        in
        if List.is_empty reasons
        then None
        else Some (Blocker.Ticket { ticket_id = ticket.id; reasons }))
    in
    let milestone_blockers =
      List.sort milestones ~compare:(fun a b -> Id.Milestone.compare a.Milestone.id b.id)
      |> List.filter_map ~f:(fun milestone ->
        if terminal milestone.status
        then None
        else
          Some
            (Blocker.Milestone { milestone_id = milestone.id; status = milestone.status }))
    in
    ignore (Api_codec.encode Counts.codec counts |> unwrap : Jsonaf.t);
    { project
    ; project_revision
    ; workspace_revision
    ; status
    ; counts
    ; blockers = ticket_blockers @ milestone_blockers
    })
;;

let ensure_can_complete t =
  if can_complete t
  then Ok ()
  else
    Error
      (Problem.create
         Blocked
         (sprintf
            "project %s cannot finish: %d unfinished tickets, %d claims, %d active \
             attempts, %d gated tickets, %d unfinished milestones; inspect \
             project.readiness"
            (Id.Project.to_string t.project)
            t.counts.unfinished_tickets
            t.counts.claimed_tickets
            t.counts.active_attempts
            t.counts.gated_tickets
            t.counts.unfinished_milestones))
;;

module Handoff = struct
  type t =
    { content : Ticket_lifecycle.Handoff.t
    ; evidence : string
    ; actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    ; project_revision : int
    ; workspace_revision : int
    }
  [@@deriving sexp]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "content" Ticket_lifecycle.Handoff.codec
          ++ F.required "evidence" (W.nonblank ~max_bytes:65536)
          ++ F.required "actor_id" W.actor
          ++ F.required "run_id" (Api_codec.nullable W.run)
          ++ F.required "timestamp" (W.nonblank ~max_bytes:128)
          ++ F.required "project_revision" W.positive
          ++ F.required "workspace_revision" W.counter)
         ~decode:
           (fun
             ( (((((content, evidence), actor), run), timestamp), project_revision)
             , workspace_revision ) ->
           { content
           ; evidence
           ; actor
           ; run
           ; timestamp
           ; project_revision
           ; workspace_revision
           })
         ~encode:(fun t ->
           ( ( ((((t.content, t.evidence), t.actor), t.run), t.timestamp)
             , t.project_revision )
           , t.workspace_revision )))
    |> fun codec ->
    W.checked codec (fun t ->
      let c = t.content in
      require
        (Option.is_some c.objective
         && Option.is_some c.completed
         && Option.is_some c.decisions
         && Option.is_some c.blockers
         && Option.is_some c.resource_ids
         && Option.is_some c.covers_through)
        "retained project handoff content must be complete";
      require
        (Option.value_exn c.covers_through <= t.workspace_revision)
        "project handoff coverage exceeds its observed workspace revision";
      require
        (not
           (List.contains_dup
              (Option.value_exn c.resource_ids)
              ~compare:Id.Resource.compare))
        "duplicate project handoff resource")
  ;;

  let create
        ~previous
        ~(patch : Ticket_lifecycle.Handoff.t)
        ~evidence
        ~actor
        ~run
        ~timestamp
        ~project_revision
        ~workspace_revision
    =
    Json.decode (fun () ->
      ignore (Api_codec.encode Ticket_lifecycle.Handoff.codec patch |> unwrap : Jsonaf.t);
      Option.iter previous ~f:(fun old ->
        require
          (old.project_revision < project_revision)
          "project handoff revision did not advance");
      let prior field default =
        Option.value_map previous ~default ~f:(fun t ->
          Option.value (field t.content) ~default)
      in
      let text field value = Some (Option.value value ~default:(prior field "")) in
      let content : Ticket_lifecycle.Handoff.t =
        { summary = patch.summary
        ; next_steps = patch.next_steps
        ; objective = text (fun t -> t.objective) patch.objective
        ; completed = text (fun t -> t.completed) patch.completed
        ; decisions = text (fun t -> t.decisions) patch.decisions
        ; blockers = text (fun t -> t.blockers) patch.blockers
        ; resource_ids =
            Some
              (Option.value
                 patch.resource_ids
                 ~default:(prior (fun t -> t.resource_ids) []))
        ; covers_through =
            Some
              (Option.value
                 patch.covers_through
                 ~default:(prior (fun t -> t.covers_through) 0))
        }
      in
      let t =
        { content; evidence; actor; run; timestamp; project_revision; workspace_revision }
      in
      ignore (Api_codec.encode codec t |> unwrap : Jsonaf.t);
      t)
  ;;

  let resource_ids t = Option.value_exn t.content.resource_ids
  let covers_through t = Option.value_exn t.content.covers_through
  let project_revision t = t.project_revision
  let jsonaf_of_t t = Api_codec.encode codec t |> unwrap
  let t_of_jsonaf json = Api_codec.decode codec json |> unwrap
  let unchecked_t_of_sexp = t_of_sexp

  let t_of_sexp sexp =
    let t = unchecked_t_of_sexp sexp in
    match Api_codec.encode codec t with
    | Ok _ -> t
    | Error p -> Sexplib.Conv.of_sexp_error p.Problem.message sexp
  ;;
end
