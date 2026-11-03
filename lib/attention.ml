open Core
open Planning_state
module A = Attention_api
module C = Communication
module N = Communication.Notification

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let bool b = if b then `True else `False

let source revision index =
  Json.obj [ "workspace_revision", Json.int revision; "change_index", Json.int index ]
;;

let selected filter kind = List.mem filter.A.Filter.kinds kind ~equal:A.Kind.equal

let project_matches filter project =
  Option.for_all filter.A.Filter.project ~f:(fun id ->
    Option.exists project ~f:(Id.Project.equal id))
;;

let ticket_matches filter id =
  List.is_empty filter.A.Filter.tickets
  || List.mem filter.tickets id ~equal:Id.Ticket.equal
;;

let source_key = function
  | N.Source.Request id -> "request:" ^ Communication_id.Request.to_string id
  | Thread id -> "thread:" ^ Communication_id.Thread.to_string id
  | Message id -> "message:" ^ Communication_id.Message.to_string id
;;

let self filter (n : N.t) =
  filter.A.Filter.exclude_self
  && Option.exists filter.recipient ~f:(function
    | C.Recipient.Actor actor -> Id.Actor.equal actor n.attribution.actor
    | Run run -> Option.exists n.attribution.run ~f:(Id.Run.equal run))
;;

module Routing = struct
  module Ticket = struct
    type t =
      { id : Id.Ticket.t
      ; project : Id.Project.t option
      ; milestone : Id.Milestone.t option
      ; prerequisites : Id.Ticket.t list
      }
  end

  type t =
    { tickets : Ticket.t Id.Ticket.Map.t
    ; pools : string list Id.Ticket.Map.t
    ; paths : Ticket_paths.Declaration.t list Id.Ticket.Map.t
    }

  let capture events =
    List.fold
      events
      ~init:
        { tickets = Id.Ticket.Map.empty
        ; pools = Id.Ticket.Map.empty
        ; paths = Id.Ticket.Map.empty
        }
      ~f:(fun routing (_, changes) ->
        List.fold changes ~init:routing ~f:(fun routing -> function
          | Event.Ticket_put ticket ->
            let head =
              { Ticket.id = ticket.id
              ; project = ticket.project
              ; milestone = ticket.milestone
              ; prerequisites = ticket.prerequisites
              }
            in
            { routing with tickets = Map.set routing.tickets ~key:ticket.id ~data:head }
          | Agent_run_changed { update = Ticket_policy_put policy; _ } ->
            { routing with
              pools = Map.set routing.pools ~key:policy.ticket ~data:policy.pools
            }
          | Agent_run_changed { update = Ticket_paths_put paths; _ } ->
            { routing with
              paths =
                Map.set
                  routing.paths
                  ~key:paths.ticket_id
                  ~data:(if paths.require_reservations then paths.declarations else [])
            }
          | Facts_changed _
          | Communication_changed _
          | Agent_run_changed _
          | Amendment_unchanged _
          | Amendment_changed _
          | Evidence_changed _
          | Policy_changed _
          | Policy_unchanged _
          | Allocation_empty _
          | Settings_changed _
          | Workspace_updated _
          | Project_put _
          | Milestone_put _
          | Ticket_recovered _
          | Signal_receipt _
          | Comment_changed _
          | Handoff_put _
          | Resource_changed _ -> routing))
  ;;
end

let current_ready_rows t ~now_unix_ms filter =
  let tickets =
    Planning_state.coordination_tickets ?run:filter.A.Filter.run ~now_unix_ms t
  in
  let fields =
    [ "kinds", `Array [ Json.string "ready_work" ]
    ; "limit", Json.int 100
    ; "max_bytes", Json.int 1048576
    ]
    @ Option.to_list
        (Option.map filter.project ~f:(fun id -> "project_id", Id.Project.jsonaf_of_t id))
    @ Option.to_list
        (Option.map filter.run ~f:(fun id -> "run_id", Id.Run.jsonaf_of_t id))
  in
  let rec read cursor reversed =
    let params =
      Json.obj
        (fields
         @ Option.to_list
             (Option.map cursor ~f:(fun cursor -> "cursor", Json.string cursor)))
    in
    let result =
      Coordinator.read
        ~workspace:t.workspace
        ~revision:t.revision
        ~head:None
        ~tickets
        ~runs:t.agent_runs
        ~evidence:t.evidence
        ~communication:t.communication
        ~policies:t.policies
        ~heartbeats:[]
        ~now_unix_ms
        ~params
      |> unwrap
    in
    let rows =
      Json.field result "items"
      |> Json.list
      |> List.filter ~f:(fun row ->
        ticket_matches
          filter
          (Json.field (Json.field row "source") "ticket_id" |> Id.Ticket.t_of_jsonaf))
    in
    let reversed = List.rev_append rows reversed in
    match Json.field result "next_cursor" with
    | `Null -> List.rev reversed
    | json ->
      if List.is_empty (Json.field result "items" |> Json.list)
      then Json.fail Invalid_argument "eligible-work source requires larger budget";
      read (Some (Json.text json)) reversed
  in
  read None []
;;

let read t ~now_unix_ms ~params =
  Json.decode (fun () ->
    let request =
      Api_codec.decode
        (Option.value_exn (A.Request.codec ~method_:"attention.read"))
        params
      |> unwrap
    in
    let filter = A.Request.filter request in
    Option.iter filter.project ~f:(fun id ->
      if not (Map.mem t.projects id)
      then Json.fail Not_found "attention project not found");
    List.iter filter.tickets ~f:(fun id ->
      if not (Map.mem t.tickets id) then Json.fail Not_found "attention ticket not found");
    Option.iter filter.run ~f:(fun id ->
      if Option.is_none (Agent_run.get_run t.agent_runs id)
      then Json.fail Not_found "attention run not found");
    let filter_json =
      Json.obj
        [ "view", Json.string "attention"
        ; "filter", Coordination_wire.encode_exn A.Filter.codec filter
        ]
    in
    let capture =
      Attention_cursor.capture
        ~workspace:t.workspace
        ~revision:t.revision
        ~activity:t.activity
        ~filter:filter_json
        ~after:(A.Request.after request)
        ~cursor:(A.Request.cursor request)
        ~now_unix_ms
      |> unwrap
    in
    let events =
      List.rev t.activity
      |> List.filter ~f:(fun event ->
        Json.field event "revision" |> Json.integer <= capture.through)
      |> List.map ~f:(fun event ->
        event, Json.field event "changes" |> Json.list |> List.map ~f:Event.t_of_jsonaf)
    in
    (* A frozen routing index determines durable relevance. It contains only
       membership/dependency IDs, pool names and required path declarations;
       current eligibility still comes from the separately labelled live capture. *)
    let routing = Routing.capture events in
    let tickets = ref Id.Ticket.Map.empty in
    let milestones = ref Id.Milestone.Map.empty in
    let threads = ref Communication_id.Thread.Map.empty in
    let requests = ref Communication_id.Request.Map.empty in
    let messages = ref Communication_id.Message.Map.empty in
    let ticket_pools = ref Id.Ticket.Map.empty in
    let acknowledgements = ref Int.Set.empty in
    let rows = ref [] in
    let row revision index kind fields =
      Json.obj ([ "kind", Json.string kind; "source", source revision index ] @ fields)
    in
    let add revision index kind fields =
      rows := row revision index kind fields :: !rows
    in
    let ticket_project id =
      Option.bind (Map.find !tickets id) ~f:(fun ticket -> ticket.Ticket.project)
    in
    let linked_project links =
      Option.for_all filter.project ~f:(fun project ->
        List.exists links ~f:(function
          | Entity_ref.Project id -> Id.Project.equal id project
          | Ticket id -> Option.exists (ticket_project id) ~f:(Id.Project.equal project)
          | Workspace | Milestone _ | Resource _ -> false))
    in
    let linked_tickets links =
      List.filter_map links ~f:(function
        | Entity_ref.Ticket id -> Some id
        | _ -> None)
    in
    let thread_links id =
      Option.value_map (Map.find !threads id) ~default:[] ~f:(fun thread ->
        thread.C.Thread.links)
    in
    let notification_links (n : N.t) =
      match n.source with
      | Thread id -> thread_links id
      | Request id ->
        Option.value_map (Map.find !requests id) ~default:[] ~f:(fun request ->
          thread_links request.C.Request.thread)
      | Message id ->
        Option.value_map (Map.find !messages id) ~default:[] ~f:(fun message ->
          Option.to_list
            (Option.map message.C.Message.ticket_id ~f:(fun id -> Entity_ref.Ticket id)))
    in
    let scope_matches (n : N.t) =
      let links = notification_links n in
      (Option.is_none filter.project
       ||
       match n.scope with
       | Project id -> project_matches filter (Some id)
       | Workspace -> linked_project links)
      && (List.is_empty filter.tickets
          || List.exists (linked_tickets links) ~f:(ticket_matches filter))
    in
    let relevant_ticket id project =
      let rec depends pending seen =
        match pending with
        | [] -> false
        | ticket :: rest ->
          if Id.Ticket.equal ticket id
          then true
          else if Set.mem seen ticket
          then depends rest seen
          else (
            let prerequisites =
              Option.value_map
                (Map.find routing.tickets ticket)
                ~default:[]
                ~f:(fun ticket -> ticket.Routing.Ticket.prerequisites)
            in
            depends (List.rev_append prerequisites rest) (Set.add seen ticket))
      in
      (project_matches filter project && ticket_matches filter id)
      || Map.exists routing.tickets ~f:(fun ticket ->
        project_matches filter ticket.project
        && ticket_matches filter ticket.id
        && depends ticket.prerequisites Id.Ticket.Set.empty)
    in
    let scoped_tickets =
      Map.data routing.tickets
      |> List.filter ~f:(fun ticket ->
        project_matches filter ticket.Routing.Ticket.project
        && ticket_matches filter ticket.id)
    in
    let scoped_pools =
      List.concat_map scoped_tickets ~f:(fun ticket ->
        Option.value (Map.find routing.pools ticket.Routing.Ticket.id) ~default:[])
      |> String.Set.of_list
    in
    let pool_relevant name = Set.mem scoped_pools name in
    let ticket_pool_relevant id =
      (* Occupancy belongs to the policy at this event, not the final policy.
         A later policy removal must not hide a preceding capacity release. *)
      Option.exists (Map.find !ticket_pools id) ~f:(List.exists ~f:pool_relevant)
    in
    let attempt_relevant (attempt : Attempt.t) =
      Option.exists filter.run ~f:(Id.Run.equal attempt.run)
      || relevant_ticket attempt.ticket (ticket_project attempt.ticket)
      || ticket_pool_relevant attempt.ticket
    in
    let path_relevant target =
      List.exists scoped_tickets ~f:(fun ticket ->
        Option.exists
          (Map.find routing.paths ticket.Routing.Ticket.id)
          ~f:(fun declarations ->
            List.exists declarations ~f:(fun declaration ->
              Path_scope.overlaps target declaration.Ticket_paths.Declaration.target)))
    in
    let invalidation revision index reason =
      if selected filter Readiness
      then add revision index "readiness_invalidated" [ "reason", Json.string reason ]
    in
    List.iter events ~f:(fun (event, changes) ->
      let revision = Json.field event "revision" |> Json.integer in
      let emit = revision > capture.after in
      let source_run_matches =
        Option.for_all filter.run ~f:(fun id ->
          match Json.optional event "run_id" with
          | Some (`String _ as json) -> Id.Run.equal id (Id.Run.t_of_jsonaf json)
          | None | Some _ -> false)
      in
      let indexed = List.mapi changes ~f:(fun index change -> index, change) in
      let request_operations =
        List.filter_map indexed ~f:(function
          | ( index
            , Event.Communication_changed { update = Request_put { request; kind }; _ } )
            -> Some (index, request, kind)
          | _ -> None)
      in
      let groups = ref String.Map.empty in
      let group_for index change (n : N.t) =
        match n.source, change.C.Change.update with
        | Request _, _ -> source_key n.source
        | Thread thread, Thread_put record ->
          let matches =
            List.filter request_operations ~f:(fun (_, request, _) ->
              Communication_id.Thread.equal request.C.Request.thread thread)
          in
          let by_body =
            Option.bind n.causal_body ~f:(fun pin ->
              List.find matches ~f:(fun (_, request, _) ->
                Id.Comment.equal request.C.Request.message pin.comment_id
                ||
                match request.status with
                | Resolved { answer = Some answer; _ } ->
                  Id.Comment.equal answer.comment_id pin.comment_id
                | Resolved { answer = None; _ } | Open | Cancelled _ -> false))
          in
          let root =
            match by_body with
            | Some _ as root -> root
            | None when record.revision = 1 ->
              List.find matches ~f:(fun (_, _, kind) -> N.Kind.equal kind Request_created)
            | None
              when C.Thread.State.equal record.state Resolved
                   && C.Thread.Closure_policy.equal
                        record.closure_policy
                        When_all_requests_terminal ->
              List.filter matches ~f:(fun (i, _, kind) ->
                i < index
                && (N.Kind.equal kind Request_resolved
                    || N.Kind.equal kind Request_cancelled))
              |> List.last
            | None -> None
          in
          Option.value_map root ~default:(source_key n.source) ~f:(fun (_, request, _) ->
            "request:" ^ Communication_id.Request.to_string request.id)
        | (Thread _ | Message _), _ -> source_key n.source
      in
      List.iter indexed ~f:(fun (index, change) ->
        match change with
        | Ticket_put ticket ->
          let previous = Map.find !tickets ticket.id in
          tickets := Map.set !tickets ~key:ticket.id ~data:ticket;
          if emit
          then (
            if
              selected filter Ticket
              && (project_matches filter ticket.project
                  || Option.exists previous ~f:(fun old ->
                    project_matches filter old.Ticket.project))
              && source_run_matches
              && ticket_matches filter ticket.id
            then
              add
                revision
                index
                "ticket_changed"
                [ "ticket_id", Id.Ticket.jsonaf_of_t ticket.id
                ; "ticket_revision", Json.int ticket.revision
                ; "status", Workflow.Category.jsonaf_of_t ticket.status
                ];
            let changed =
              Option.value_map previous ~default:true ~f:(fun old ->
                (not (Domain_command.Status.equal old.status ticket.status))
                || (not (Bool.equal old.archived ticket.archived))
                || (not (Option.equal Id.Project.equal old.project ticket.project))
                || (not
                      (List.equal Id.Ticket.equal old.prerequisites ticket.prerequisites))
                || (not
                      (String.equal
                         (Json.canonical
                            (Option.value_map
                               old.claim
                               ~default:`Null
                               ~f:Claim.jsonaf_of_t))
                         (Json.canonical
                            (Option.value_map
                               ticket.claim
                               ~default:`Null
                               ~f:Claim.jsonaf_of_t))))
                || (not
                      (String.equal
                         (Json.canonical
                            (Option.value_map old.hold ~default:`Null ~f:Hold.jsonaf_of_t))
                         (Json.canonical
                            (Option.value_map
                               ticket.hold
                               ~default:`Null
                               ~f:Hold.jsonaf_of_t))))
                || not
                     (String.equal
                        (Json.canonical
                           (`Array (List.map old.waivers ~f:Waiver.jsonaf_of_t)))
                        (Json.canonical
                           (`Array (List.map ticket.waivers ~f:Waiver.jsonaf_of_t)))))
            in
            if
              changed
              && (relevant_ticket ticket.id ticket.project
                  || Option.exists previous ~f:(fun old ->
                    relevant_ticket old.id old.project)
                  || ticket_pool_relevant ticket.id)
            then invalidation revision index "ticket_readiness")
        | Facts_changed fact ->
          if
            emit
            && selected filter Fact
            && source_run_matches
            && Option.for_all
                 filter.fact_scope
                 ~f:(Facts.Scope.equal (Facts.Change.scope fact))
            && Option.for_all filter.fact_prefix ~f:(fun prefix ->
              String.is_prefix (Facts.Key.to_string (Facts.Change.key fact)) ~prefix)
            &&
            match Facts.Change.scope fact with
            | Project id ->
              project_matches filter (Some id) && List.is_empty filter.tickets
            | Ticket id ->
              project_matches filter (ticket_project id) && ticket_matches filter id
            | Milestone id ->
              project_matches
                filter
                (Option.map (Map.find !milestones id) ~f:(fun milestone ->
                   milestone.Milestone.project))
              && List.is_empty filter.tickets
            | Workspace -> Option.is_none filter.project && List.is_empty filter.tickets
          then add revision index "fact_changed" [ "fact", Facts.Change.to_json fact ]
        | Communication_changed change ->
          (match change.update with
           | Thread_put thread -> threads := Map.set !threads ~key:thread.id ~data:thread
           | Request_put { request; _ } ->
             requests := Map.set !requests ~key:request.id ~data:request
           | Message_put message ->
             messages := Map.set !messages ~key:message.message_id ~data:message
           | Inbox_ack ack ->
             if
               Option.exists
                 filter.consumer
                 ~f:(Communication_id.Consumer.equal ack.consumer_id)
               && Option.exists filter.recipient ~f:(C.Recipient.equal ack.recipient)
             then
               acknowledgements
               := Set.union !acknowledgements (Int.Set.of_list ack.notification_ids)
           | Board_put _ | Team_put _ | Subscription_put _ -> ());
          if emit && selected filter Communication
          then
            List.iter change.notifications ~f:(fun n ->
              if
                Option.exists filter.recipient ~f:(fun recipient ->
                  List.mem n.recipients recipient ~equal:C.Recipient.equal)
                && (not (self filter n))
                && scope_matches n
                && Option.for_all filter.run ~f:(fun id ->
                  Option.exists n.attribution.run ~f:(Id.Run.equal id)
                  || Option.exists filter.recipient ~f:(function
                    | Run run -> Id.Run.equal run id
                    | Actor _ -> false))
              then (
                let key = group_for index change n in
                groups
                := Map.update !groups key ~f:(function
                     | None -> index, [ n ]
                     | Some (first, items) -> first, n :: items)))
        | Agent_run_changed change ->
          (match change.update with
           | Ticket_policy_put policy ->
             ticket_pools := Map.set !ticket_pools ~key:policy.ticket ~data:policy.pools
           | _ -> ());
          if emit
          then (
            let relevant =
              match change.update with
              | Ticket_policy_put policy ->
                relevant_ticket policy.ticket (ticket_project policy.ticket)
              | Ticket_paths_put paths ->
                relevant_ticket paths.ticket_id (ticket_project paths.ticket_id)
              | Run_put run -> Option.exists filter.run ~f:(Id.Run.equal run.id)
              | Attempt_started { attempt; _ } | Attempt_put attempt ->
                attempt_relevant attempt
              | Pool_put pool -> pool_relevant pool.name
              | Reservation_put _ -> false
              | Path_reservation_put reservation -> path_relevant reservation.target
              | Claim_paths_reserved { claim; targets; _ }
              | Claim_paths_released { claim; targets } ->
                relevant_ticket claim.ticket (ticket_project claim.ticket)
                || ticket_pool_relevant claim.ticket
                || List.exists targets ~f:path_relevant
              | Ownership_recovered { after = Path reservation; _ } ->
                path_relevant reservation.target
              | Ownership_recovered { after = Named _; _ } -> false
              | External_condition_changed _ -> true
              | Actions_set _ -> false
            in
            if relevant then invalidation revision index "allocation_constraint")
        | Policy_changed { command = Budget_put budget; _ } ->
          if emit && Option.exists filter.run ~f:(Id.Run.equal budget.run)
          then invalidation revision index "run_budget"
        | Policy_changed
            { command = Template_register _ | Instance_register _ | Usage_report _; _ } ->
          ()
        | Settings_changed _ | Workspace_updated _ ->
          if emit then invalidation revision index "workspace_policy"
        | Amendment_changed change ->
          if
            emit
            && List.exists (Ticket_amendment.Change.targets change) ~f:(fun id ->
              relevant_ticket id (ticket_project id))
          then invalidation revision index "amendment"
        | Evidence_changed _ -> ()
        | Project_put project ->
          if emit && project_matches filter (Some project.id)
          then invalidation revision index "project_policy"
        | Milestone_put milestone ->
          milestones := Map.set !milestones ~key:milestone.id ~data:milestone;
          if
            emit
            && List.exists scoped_tickets ~f:(fun ticket ->
              Option.exists ticket.milestone ~f:(Id.Milestone.equal milestone.id))
          then invalidation revision index "milestone_policy"
        | Ticket_recovered recovery ->
          if
            emit
            && relevant_ticket
                 recovery.request.ticket_id
                 (ticket_project recovery.request.ticket_id)
          then invalidation revision index "ticket_recovery"
        | Amendment_unchanged _
        | Policy_unchanged _
        | Allocation_empty _
        | Signal_receipt _
        | Comment_changed _
        | Handoff_put _
        | Resource_changed _ -> ());
      Map.iteri !groups ~f:(fun ~key ~data:(index, notifications) ->
        let notifications =
          List.rev notifications
          |> List.filter ~f:(fun n -> not (Set.mem !acknowledgements n.N.serial))
        in
        let fragments = List.chunks_of notifications ~length:32 in
        List.iteri fragments ~f:(fun fragment_index fragment ->
          add
            revision
            index
            "communication_group"
            [ ( "group_id"
              , Json.string
                  (Id.Workspace.to_string t.workspace
                   ^ ":"
                   ^ Int.to_string revision
                   ^ ":"
                   ^ key) )
            ; "fragment_index", Json.int fragment_index
            ; "fragment_count", Json.int (List.length fragments)
            ; ( "notification_ids"
              , `Array (List.map fragment ~f:(fun n -> Json.int n.N.serial)) )
            ; "notifications", `Array (List.map fragment ~f:A.notification_json)
            ])));
    (* Later acknowledgements within the capture suppress earlier groups too. *)
    let rows =
      List.rev !rows
      |> List.filter_map ~f:(fun row ->
        if String.equal (Json.field row "kind" |> Json.text) "communication_group"
        then (
          let notifications =
            Json.field row "notifications"
            |> Json.list
            |> List.filter ~f:(fun n ->
              not
                (Set.mem
                   !acknowledgements
                   (Json.field n "notification_id" |> Json.integer)))
          in
          if List.is_empty notifications
          then None
          else (
            match row with
            | `Object fields ->
              Some
                (Json.obj
                   (List.map fields ~f:(fun (key, value) ->
                      ( key
                      , if String.equal key "notifications"
                        then `Array notifications
                        else if String.equal key "notification_ids"
                        then
                          `Array
                            (List.map notifications ~f:(fun n ->
                               Json.field n "notification_id"))
                        else value ))))
            | _ -> assert false))
        else Some row)
      |> List.stable_sort ~compare:(fun a b ->
        let a = Json.field a "source"
        and b = Json.field b "source" in
        match
          Int.compare
            (Json.field a "workspace_revision" |> Json.integer)
            (Json.field b "workspace_revision" |> Json.integer)
        with
        | 0 ->
          Int.compare
            (Json.field a "change_index" |> Json.integer)
            (Json.field b "change_index" |> Json.integer)
        | n -> n)
    in
    if capture.offset > List.length rows
    then Json.fail Conflict "attention cursor row position unavailable";
    let remaining = List.drop rows capture.offset in
    let readiness_requested =
      selected filter Readiness
      && (A.Request.initial_readiness request
          || Option.is_some (A.Request.readiness_cursor request)
          || List.exists rows ~f:(fun row ->
            String.equal (Json.field row "kind" |> Json.text) "readiness_invalidated"))
    in
    let ready_filter =
      Json.obj
        [ "view", Json.string "attention.readiness"
        ; "filter", Coordination_wire.encode_exn A.Filter.codec filter
        ]
    in
    let ready =
      if readiness_requested
      then (
        let captured =
          Attention_cursor.capture
            ~workspace:t.workspace
            ~revision:t.revision
            ~activity:t.activity
            ~filter:ready_filter
            ~after:None
            ~cursor:(A.Request.readiness_cursor request)
            ~now_unix_ms
          |> unwrap
        in
        if captured.through <> t.revision
        then Json.fail Conflict "current readiness capture changed; rescan required";
        let all = current_ready_rows t ~now_unix_ms:captured.clock filter in
        if captured.offset > List.length all
        then Json.fail Conflict "current readiness row position unavailable";
        Some (captured, List.drop all captured.offset))
      else None
    in
    let limit = A.Request.limit request
    and max_bytes = A.Request.max_bytes request in
    let envelope count ready_count required ready_required =
      let selected = List.take remaining count in
      let complete = count = List.length remaining in
      let readiness =
        Option.value_map ready ~default:`Null ~f:(fun (captured, remaining) ->
          let complete = ready_count = List.length remaining in
          Json.obj
            [ "workspace_revision", Json.int t.revision
            ; "observed_unix_ms", Json.int64 captured.clock
            ; "items", `Array (List.take remaining ready_count)
            ; ( "cursor"
              , if complete
                then `Null
                else
                  Json.string
                    (Attention_cursor.encode
                       { captured with offset = captured.offset + ready_count }
                       ~workspace:t.workspace
                       ~filter:ready_filter) )
            ; "has_more", bool (not complete)
            ; "needs_larger_budget", bool (ready_count = 0 && not complete)
            ; "required_bytes", Option.value_map ready_required ~default:`Null ~f:Json.int
            ])
      in
      let data =
        Json.obj
          [ "through", Json.int capture.through
          ; "items", `Array selected
          ; ( "cursor"
            , Json.string
                (Attention_cursor.encode
                   (Attention_cursor.advance capture ~count ~complete)
                   ~workspace:t.workspace
                   ~filter:filter_json) )
          ; "has_more", bool (not complete)
          ; "needs_larger_budget", bool (count = 0 && not complete)
          ; "required_bytes", Option.value_map required ~default:`Null ~f:Json.int
          ; "readiness", readiness
          ]
      in
      Json.obj [ "workspace_revision", Json.int t.revision; "data", data ]
      |> Query_budget.annotate_whole_items_exn
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items:(Int.min limit (List.length remaining) - count)
    in
    let ready_total =
      Option.value_map ready ~default:0 ~f:(fun (_, rows) -> List.length rows)
    in
    let required =
      if List.is_empty remaining
      then None
      else Some (Api_response.encoded_size Planning_read (envelope 1 0 None None))
    in
    let ready_required =
      if ready_total = 0
      then None
      else Some (Api_response.encoded_size Planning_read (envelope 0 1 None None))
    in
    let rec fit count ready_count =
      let result =
        envelope
          count
          ready_count
          (if count = 0 then required else None)
          (if ready_count = 0 then ready_required else None)
      in
      if Api_response.encoded_size Planning_read result <= max_bytes
      then result
      else if ready_count > 0
      then fit count (ready_count - 1)
      else if count > 0
      then fit (count - 1) 0
      else
        Json.fail
          Invalid_argument
          "attention metadata exceeds byte budget; narrow filters"
    in
    fit (Int.min limit (List.length remaining)) (Int.min limit ready_total))
;;

let has_attention result =
  let data = Json.field result "data" in
  (not (List.is_empty (Json.field data "items" |> Json.list)))
  || (match Json.field data "needs_larger_budget" with
      | `True -> true
      | _ -> false)
  ||
  match Json.field data "readiness" with
  | `Null -> false
  | _ -> true
;;
