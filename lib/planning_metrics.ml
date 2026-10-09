open Core
open Planning_state

let categories = [ Workflow.Category.Backlog; Todo; In_progress; Done; Canceled ]

let index = function
  | Workflow.Category.Backlog -> 0
  | Todo -> 1
  | In_progress -> 2
  | Done -> 3
  | Canceled -> 4
;;

let timestamp_ms timestamp =
  (* The server records explicit UTC. Pure clients may supply other text; keep
     those intervals unavailable. This decoder's documented malformed-sexp
     exception is the only failure converted to an absent observation. *)
  let timestamp = String.substr_replace_first timestamp ~pattern:"T" ~with_:" " in
  try
    let time = Time_ns.Alternate_sexp.t_of_sexp (Sexp.Atom timestamp) in
    let ns =
      Time_ns.to_span_since_epoch time |> Time_ns.Span.to_int63_ns |> Int63.to_int64
    in
    if Int64.(ns < 0L) then None else Some Int64.(ns / 1_000_000L)
  with
  | Sexplib.Conv.Of_sexp_error _ -> None
;;

let capture (state : Planning_state.t) ~observed_unix_ms =
  let rows =
    Array.of_list
      (List.map categories ~f:(fun status ->
         { Workspace_metrics.Status.status
         ; tickets = 0
         ; elapsed_ms = 0L
         ; closed_intervals = 0
         ; open_intervals = 0
         ; unknown_intervals = 0
         ; overflow = false
         }))
  in
  let interval status start finish ~open_ =
    let i = index status in
    let row = rows.(i) in
    let known =
      match start, finish with
      | Some start, Some finish when Int64.(finish >= start) ->
        Some Int64.(finish - start)
      | Some _, Some _ | None, _ | _, None -> None
    in
    let elapsed_ms, overflow =
      match known with
      | None -> row.elapsed_ms, row.overflow
      | Some duration ->
        if Int64.(row.elapsed_ms > max_value - duration)
        then Int64.max_value, true
        else Int64.(row.elapsed_ms + duration), row.overflow
    in
    rows.(i)
    <- { row with
         elapsed_ms
       ; overflow
       ; tickets = (row.tickets + if open_ then 1 else 0)
       ; closed_intervals = (row.closed_intervals + if open_ then 0 else 1)
       ; open_intervals = (row.open_intervals + if open_ then 1 else 0)
       ; unknown_intervals =
           (row.unknown_intervals + if Option.is_none known then 1 else 0)
       }
  in
  let latest = ref Id.Ticket.Map.empty in
  let completion_transitions = ref 0
  and reopenings = ref 0 in
  let completion_evidence = ref Id.Ticket.Set.empty
  and manifests = ref Id.Ticket.Set.empty in
  List.iter (List.rev state.activity) ~f:(fun audit ->
    let observed = timestamp_ms (Json.text (Json.field audit "timestamp")) in
    List.iter
      (Json.list (Json.field audit "changes"))
      ~f:(fun json ->
        match Event.t_of_jsonaf json with
        | Ticket_put ticket ->
          (match Map.find !latest ticket.id with
           | None -> latest := Map.set !latest ~key:ticket.id ~data:(ticket, observed)
           | Some (previous, started) ->
             if not (Workflow.Category.equal previous.Ticket.status ticket.status)
             then (
               interval previous.status started observed ~open_:false;
               if Workflow.Category.equal ticket.status Done
               then Int.incr completion_transitions;
               if
                 (not
                    (Option.equal Int.equal previous.reopened_token ticket.reopened_token))
                 && Option.is_some ticket.reopened_token
               then Int.incr reopenings;
               latest := Map.set !latest ~key:ticket.id ~data:(ticket, observed))
             else latest := Map.set !latest ~key:ticket.id ~data:(ticket, started))
        | Comment_changed
            (Discussion.Change.Create { target = Ticket id; origin = Completion; _ }) ->
          completion_evidence := Set.add !completion_evidence id
        | Evidence_changed { update = Manifest_put manifest; _ } ->
          manifests := Set.add !manifests manifest.ticket
        | Ticket_recovered _
        | Signal_receipt _
        | Workspace_updated _
        | Project_put _
        | Milestone_put _
        | Comment_changed _
        | Handoff_put _
        | Resource_changed _
        | Agent_run_changed _
        | Policy_changed _
        | Policy_unchanged _
        | Allocation_empty _
        | Evidence_changed _
        | Communication_changed _
        | Settings_changed _
        | Facts_changed _ -> ()));
  Map.iter !latest ~f:(fun (ticket, started) ->
    interval ticket.Ticket.status started (Some observed_unix_ms) ~open_:true);
  let completed_tickets_with_evidence =
    Map.count state.tickets ~f:(fun t ->
      Workflow.Category.equal t.Ticket.status Done && Set.mem !completion_evidence t.id)
  in
  { Workspace_metrics.Planning.revision = state.revision
  ; statuses = Array.to_list rows
  ; completion_transitions = !completion_transitions
  ; reopenings = !reopenings
  ; completed_tickets_with_evidence
  ; tickets_with_recorded_manifest = Set.length !manifests
  ; stored_assertions = List.length (Evidence.assertions state.evidence)
  ; stored_accepted_submissions =
      List.count (Evidence.current_submissions state.evidence) ~f:(fun s ->
        match s.Evidence.Submission.state with
        | Accepted _ -> true
        | Pending | Changes_requested _ -> false)
  ; reported_usage =
      Workspace_metrics.Usage.of_records (Agent_run_policy.usage_records state.policies)
  ; admission = Planning_state.admission state
  }
;;
