open! Core
module Wire = Coordinator_wire

module Claim = struct
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; token : int
    ; lease : Allocation_lease.t
    }
end

module Ticket = struct
  type t =
    { id : Id.Ticket.t
    ; project : Id.Project.t option
    ; title : string
    ; status : Domain_command.Status.t
    ; prerequisites : Id.Ticket.t list
    ; ready : bool
    ; blockers : Planning_ticket_wire.Readiness.t
    ; claim : Claim.t option
    }
end

let require condition kind message = if not condition then Json.fail kind message

let checked = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

type item =
  { row : Wire.Item.t
  ; projects : Id.Project.t list
  ; runs : Id.Run.t list
  ; actors : Id.Actor.t list
  }

let item_kind item = Wire.Kind.to_string (Wire.Item.kind item.row)

let read
      ~workspace
      ~revision
      ~head
      ~tickets
      ~runs
      ~evidence
      ~communication
      ~policies
      ~heartbeats
      ~now_unix_ms
      ~params
  =
  Json.decode (fun () ->
    let request = Coordination_wire.decode_exn Coordinator_api.Request.codec params in
    require
      (revision >= 0 && Int64.(now_unix_ms >= zero))
      Invalid_argument
      "Coordinator capture has invalid counters";
    let project_filter = Coordinator_api.Request.project request in
    let run_filter = Coordinator_api.Request.run request in
    let actor_filter = Coordinator_api.Request.actor request in
    let kind_filter =
      List.map (Coordinator_api.Request.kinds request) ~f:Wire.Kind.to_string
    in
    let path_to = Coordinator_api.Request.dependency_path_to request in
    let stale_after_ms = Coordinator_api.Request.stale_after_ms request in
    let limit = Coordinator_api.Request.limit request in
    let max_bytes = Coordinator_api.Request.max_bytes request in
    let filter_hash =
      Json.hash
        (Json.canonical
           (Json.obj
              [ ( "project"
                , Option.value_map project_filter ~default:`Null ~f:Id.Project.jsonaf_of_t
                )
              ; "run", Option.value_map run_filter ~default:`Null ~f:Id.Run.jsonaf_of_t
              ; ( "actor"
                , Option.value_map actor_filter ~default:`Null ~f:Id.Actor.jsonaf_of_t )
              ; ( "kinds"
                , `Array
                    (List.map
                       (List.sort kind_filter ~compare:String.compare)
                       ~f:Json.string) )
              ; "stale_after_ms", Json.int64 stale_after_ms
              ; ( "dependency_path_to"
                , Option.value_map path_to ~default:`Null ~f:Id.Ticket.jsonaf_of_t )
              ]))
    in
    require
      (not (List.contains_dup (List.map heartbeats ~f:fst) ~compare:Id.Run.compare))
      Invalid_argument
      "Duplicate run heartbeat";
    List.iter heartbeats ~f:(fun (_, time) ->
      require Int64.(time >= zero) Invalid_argument "Negative heartbeat time");
    let heartbeat_map = Id.Run.Map.of_alist_exn heartbeats in
    let heartbeat_hash =
      Json.hash
        (Json.canonical
           (`Array
               (List.map (Map.to_alist heartbeat_map) ~f:(fun (id, time) ->
                  Json.obj [ "run", Id.Run.jsonaf_of_t id; "time", Json.int64 time ]))))
    in
    let liveness_record record =
      let observation =
        match
          record.Agent_run.Record.last_observed_unix_ms, Map.find heartbeat_map record.id
        with
        | None, None -> None
        | Some time, None | None, Some time -> Some time
        | Some a, Some b -> Some (Int64.max a b)
      in
      { record with Agent_run.Record.last_observed_unix_ms = observation }
    in
    let cursor_payload ~offset ~clock =
      Json.obj
        [ "version", Json.int 1
        ; "workspace", Id.Workspace.jsonaf_of_t workspace
        ; "revision", Json.int revision
        ; "head", Option.value_map head ~default:`Null ~f:Json.string
        ; "filters", Json.string filter_hash
        ; "heartbeats", Json.string heartbeat_hash
        ; "clock", Json.int64 clock
        ; "offset", Json.int offset
        ]
    in
    let encode_cursor ~offset ~clock =
      let payload = cursor_payload ~offset ~clock in
      Base64.encode_string
        (Json.canonical
           (Json.obj
              [ "payload", payload
              ; "checksum", Json.string (Json.hash (Json.canonical payload))
              ]))
    in
    let offset, clock =
      match Coordinator_api.Request.cursor request with
      | None -> 0, now_unix_ms
      | Some cursor ->
        let raw = cursor in
        let decoded =
          match Base64.decode raw with
          | Ok s -> s
          | Error (`Msg _) -> Json.fail Invalid_argument "Invalid coordinator cursor"
        in
        let envelope = checked (Json.parse decoded) in
        Json.fields envelope ~allowed:[ "payload"; "checksum" ];
        let payload = Json.field envelope "payload" in
        Json.fields
          payload
          ~allowed:
            [ "version"
            ; "workspace"
            ; "revision"
            ; "head"
            ; "filters"
            ; "heartbeats"
            ; "clock"
            ; "offset"
            ];
        require
          (String.equal
             (Json.text (Json.field envelope "checksum"))
             (Json.hash (Json.canonical payload)))
          Invalid_argument
          "Coordinator cursor integrity check failed";
        require
          (Json.integer (Json.field payload "version") = 1)
          Unsupported_version
          "Unsupported coordinator cursor";
        require
          (Id.Workspace.equal
             workspace
             (Id.Workspace.t_of_jsonaf (Json.field payload "workspace")))
          Conflict
          "Coordinator cursor belongs to a different workspace";
        require
          (revision = Json.integer (Json.field payload "revision"))
          Conflict
          "Coordinator revision changed; rescan required";
        let captured_head =
          match Json.field payload "head" with
          | `Null -> None
          | value -> Some (Json.text value)
        in
        require
          (Option.equal String.equal head captured_head)
          Conflict
          "Coordinator history head changed; rescan required";
        require
          (String.equal filter_hash (Json.text (Json.field payload "filters")))
          Conflict
          "Coordinator filters changed; rescan required";
        require
          (String.equal heartbeat_hash (Json.text (Json.field payload "heartbeats")))
          Conflict
          "Coordinator heartbeat capture changed; rescan required";
        let clock = Json.integer64 (Json.field payload "clock") in
        require
          Int64.(clock <= now_unix_ms)
          Conflict
          "Coordinator cursor clock is in the future; rescan required";
        Json.integer (Json.field payload "offset"), clock
    in
    let ticket_map =
      Id.Ticket.Map.of_alist_exn (List.map tickets ~f:(fun t -> t.Ticket.id, t))
    in
    let ticket_projects id =
      Option.value_map (Map.find ticket_map id) ~default:[] ~f:(fun t ->
        Option.to_list t.Ticket.project)
    in
    let run_record id = Agent_run.get_run runs id in
    let allocation_run =
      Option.map run_filter ~f:(fun id ->
        match run_record id with
        | Some record -> record
        | None -> Json.fail Not_found "Coordinator run filter is not registered")
    in
    let run_actors id =
      Option.value_map (run_record id) ~default:[] ~f:(fun r ->
        [ r.Agent_run.Record.actor ])
    in
    let run_projects id =
      List.concat_map (Agent_run.attempts_for_run runs id) ~f:(fun a ->
        ticket_projects a.Attempt.ticket)
    in
    let recipient_runs = function
      | Communication.Recipient.Actor _ -> []
      | Run run -> [ run ]
    in
    let recipient_actors = function
      | Communication.Recipient.Actor actor -> [ actor ]
      | Run run -> run_actors run
    in
    let output = ref [] in
    let add row _key projects item_runs actors =
      output := { row; projects; runs = item_runs; actors } :: !output
    in
    List.iter (Agent_run.attempts runs) ~f:(fun attempt ->
      if not (Attempt.State.terminal attempt.Attempt.state)
      then
        add
          (Wire.Item.Active_attempt
             { attempt_id = attempt.id
             ; metadata =
                 { ticket_id = attempt.ticket
                 ; run_id = attempt.run
                 ; state = attempt.state
                 ; token = attempt.token
                 ; last_checkpoint = List.last attempt.checkpoints
                 }
             })
          (Attempt.Id.to_string attempt.id)
          (ticket_projects attempt.ticket)
          [ attempt.run ]
          (run_actors attempt.run));
    List.iter tickets ~f:(fun ticket ->
      let project = Option.to_list ticket.Ticket.project in
      let src = Wire.Source.Ticket ticket.id in
      if ticket.ready && Option.is_none ticket.claim
      then (
        let reasons, item_runs, actors =
          match allocation_run with
          | None ->
            ( List.map
                (Agent_run.start_blockers
                   runs
                   ~ticket:ticket.id
                   ~run:None
                   ~now_unix_ms:clock)
                ~f:(fun value -> Wire.Allocation_reason.Coordination value)
            , []
            , [] )
          | Some record ->
            let candidate =
              Agent_run.allocation_candidate
                runs
                ~ticket:ticket.id
                ~priority:0
                ~creation_sequence:0
                ~ready:ticket.ready
                ~available:(Option.is_none ticket.claim)
            in
            let reasons =
              List.map
                (Allocation.eligibility candidate ~capabilities:record.capabilities)
                ~f:(fun value -> Wire.Allocation_reason.Allocation value)
            in
            let reasons =
              if Agent_run.Status.terminal record.status
              then Wire.Allocation_reason.Run_terminal :: reasons
              else reasons
            in
            let reasons =
              match Agent_run_policy.validate_allocation policies record.id ~runs with
              | Ok () -> reasons
              | Error problem -> Wire.Allocation_reason.Run_budget problem :: reasons
            in
            let reasons =
              reasons
              @ List.map
                  (Agent_run.start_blockers
                     runs
                     ~ticket:ticket.id
                     ~run:(Some record.id)
                     ~now_unix_ms:clock)
                  ~f:(fun value -> Wire.Allocation_reason.Coordination value)
            in
            reasons, [ record.id ], [ record.actor ]
        in
        let metadata : Wire.Ready.t =
          { title = ticket.title
          ; blockers = ticket.blockers
          ; eligibility_scope = (if Option.is_some allocation_run then Run else Graph)
          ; allocation_reasons = reasons
          }
        in
        add
          (if List.is_empty reasons
           then Wire.Item.Ready_work { ticket_id = ticket.id; metadata }
           else Wire.Item.Allocation_blocked { ticket_id = ticket.id; metadata })
          (Id.Ticket.to_string ticket.id)
          project
          item_runs
          actors);
      Option.iter ticket.claim ~f:(fun claim ->
        let status = Allocation_lease.status claim.Claim.lease ~now_unix_ms:clock in
        let stale =
          Option.value_map claim.run ~default:false ~f:(fun id ->
            Option.value_map (run_record id) ~default:false ~f:(fun record ->
              Agent_run.stale
                (liveness_record record)
                ~now_unix_ms:clock
                ~after_ms:stale_after_ms))
        in
        let kind =
          match status with
          | Expired -> Some "expired_ownership"
          | Clock_regressed -> Some "stale_ownership"
          | Valid -> if stale then Some "stale_ownership" else None
        in
        Option.iter kind ~f:(fun kind ->
          let metadata =
            Wire.Ownership.Ticket
              { token = claim.token
              ; lease_status = status
              ; lease = claim.lease
              ; run_id = claim.run
              }
          in
          let row =
            if String.equal kind "expired_ownership"
            then Wire.Item.Expired_ownership { source = src; metadata }
            else Wire.Item.Stale_ownership { source = src; metadata }
          in
          add
            row
            ("ticket:" ^ Id.Ticket.to_string ticket.id)
            project
            (Option.to_list claim.run)
            [ claim.actor ])));
    List.iter (Agent_run.runs runs) ~f:(fun record ->
      if not (Agent_run.Status.terminal record.Agent_run.Record.status)
      then (
        let record = liveness_record record in
        let row =
          match Agent_run.liveness record ~now_unix_ms:clock ~after_ms:stale_after_ms with
          | Fresh -> None
          | Unobserved ->
            Some
              (Wire.Item.Unobserved_run
                 { run_id = record.id
                 ; metadata =
                     { status = record.status
                     ; last_observed_unix_ms = None
                     ; liveness = Unobserved
                     }
                 })
          | Stale ->
            Some
              (Wire.Item.Stale_run
                 { run_id = record.id
                 ; metadata =
                     { status = record.status
                     ; last_observed_unix_ms = record.last_observed_unix_ms
                     ; liveness = Stale
                     }
                 })
        in
        Option.iter row ~f:(fun row ->
          add
            row
            (Id.Run.to_string record.id)
            (run_projects record.id)
            [ record.id ]
            [ record.actor ])));
    List.iter (Agent_run.reservations runs) ~f:(fun reservation ->
      let src = Wire.Source.Reservation reservation.Reservation.name in
      let owners = List.map reservation.holders ~f:(fun h -> h.Reservation.Holder.run) in
      let actors =
        List.map reservation.holders ~f:(fun h -> h.Reservation.Holder.actor)
      in
      let projects = List.concat_map owners ~f:run_projects in
      add
        (Wire.Item.Reservation reservation)
        (Reservation.Name.to_string reservation.name)
        projects
        owners
        actors;
      List.iter reservation.holders ~f:(fun holder ->
        let status =
          Allocation_lease.status holder.Reservation.Holder.lease ~now_unix_ms:clock
        in
        let stale =
          Option.value_map (run_record holder.run) ~default:false ~f:(fun record ->
            Agent_run.stale
              (liveness_record record)
              ~now_unix_ms:clock
              ~after_ms:stale_after_ms)
        in
        match status with
        | Valid when not stale -> ()
        | Valid | Expired | Clock_regressed ->
          let metadata =
            Wire.Ownership.Reservation
              { run_id = holder.run
              ; token = holder.token
              ; liveness_is_advisory = Allocation_lease.Status.equal status Valid
              ; lease_status = status
              }
          in
          let row =
            if Allocation_lease.Status.equal status Expired
            then Wire.Item.Expired_ownership { source = src; metadata }
            else Wire.Item.Stale_ownership { source = src; metadata }
          in
          add
            row
            ("reservation:"
             ^ Reservation.Name.to_string reservation.name
             ^ ":"
             ^ Id.Run.to_string holder.run)
            (run_projects holder.run)
            [ holder.run ]
            [ holder.actor ]));
    List.iter (Communication.requests communication) ~f:(fun request ->
      match request.Communication.Request.status with
      | Resolved _ | Cancelled _ -> ()
      | Open ->
        let thread = Communication.get_thread communication request.thread in
        let projects =
          Option.value_map thread ~default:[] ~f:(fun thread ->
            let scope =
              Option.bind
                (Communication.get_board communication thread.board)
                ~f:(fun board ->
                  match board.Communication.Board.scope with
                  | Workspace -> None
                  | Project id -> Some id)
            in
            Option.to_list scope
            @ List.concat_map thread.links ~f:(function
              | Entity_ref.Project id -> [ id ]
              | Ticket id -> ticket_projects id
              | Workspace | Milestone _ | Resource _ -> []))
        in
        let recipients =
          List.map request.deliveries ~f:(fun d ->
            d.Communication.Request.Delivery.recipient)
        in
        let open_delivery =
          List.count request.deliveries ~f:(fun d ->
            Option.is_none d.Communication.Request.Delivery.acknowledged)
        in
        add
          (Wire.Item.Unanswered_request
             { request_id = request.id
             ; metadata =
                 { thread_id = request.thread
                 ; comment_id = request.message
                 ; kind = request.kind
                 ; unacknowledged_recipients = open_delivery
                 ; responsibility = request.responsibility
                 ; deadline_unix_ms =
                     Option.map request.deadline_unix_ms ~f:(fun time ->
                       Json.integer64 (Json.string time))
                 }
             })
          (Communication_id.Request.to_string request.id)
          projects
          (Option.to_list request.created.run
           @ List.concat_map recipients ~f:recipient_runs)
          (request.resolver
           :: request.created.actor
           :: List.concat_map recipients ~f:recipient_actors));
    List.iter
      (Evidence.pending_reconciliations evidence ~attempt:None)
      ~f:(fun reconciliation ->
        let attempt =
          Agent_run.get_attempt runs reconciliation.Evidence.Reconciliation.attempt
        in
        let item_runs =
          Option.value_map attempt ~default:[] ~f:(fun a -> [ a.Attempt.run ])
        in
        add
          (Wire.Item.Changed_input reconciliation)
          (Int.to_string reconciliation.serial)
          (ticket_projects reconciliation.ticket)
          item_runs
          (List.concat_map item_runs ~f:run_actors));
    let evidence_policies =
      Id.Ticket.Map.of_alist_exn
        (List.map (Evidence.current_policies evidence) ~f:(fun p ->
           p.Evidence.Policy.ticket, p))
    in
    List.iter (Evidence.current_submissions evidence) ~f:(fun submission ->
      match submission.Evidence.Submission.state with
      | Accepted _ | Changes_requested _ -> ()
      | Pending ->
        let reviewers =
          Option.value_map
            (Map.find evidence_policies submission.ticket)
            ~default:[]
            ~f:(fun policy ->
              List.concat_map policy.Evidence.Policy.reviewers ~f:(function
                | Named_actor id -> [ id ]
                | Role { members; _ } -> members))
        in
        add
          (Wire.Item.Pending_review submission)
          (Id.Ticket.to_string submission.ticket)
          (ticket_projects submission.ticket)
          (Option.to_list submission.author.run)
          (submission.author.actor :: reviewers));
    List.iter (Agent_run_policy.usage_records policies) ~f:(fun usage ->
      let item_runs, projects =
        match usage.Usage_record.scope with
        | Run id -> [ id ], run_projects id
        | Attempt id ->
          Option.value_map (Agent_run.get_attempt runs id) ~default:([], []) ~f:(fun a ->
            [ a.Attempt.run ], ticket_projects a.ticket)
      in
      add
        (Wire.Item.Reported_usage usage)
        (Usage_record.Id.to_string usage.id)
        projects
        item_runs
        [ usage.actor ]);
    List.iter (Agent_run_policy.attention policies ~runs) ~f:(fun row ->
      let id = row.Run_budget.Attention.run_id in
      add
        (Wire.Item.Budget_limit row)
        (Id.Run.to_string id ^ ":" ^ Run_budget.Attention.Kind.to_string row.kind)
        (run_projects id)
        [ id ]
        (run_actors id));
    List.iter (Agent_run.pending_actions runs) ~f:(fun action ->
      add
        (Wire.Item.Runner_action action)
        (Id.Run.to_string action.Agent_run.Runner_action.child)
        (run_projects action.child)
        [ action.parent; action.child ]
        (run_actors action.child @ run_actors action.parent));
    let dependent_map =
      List.fold tickets ~init:Id.Ticket.Map.empty ~f:(fun map ticket ->
        List.fold ticket.Ticket.prerequisites ~init:map ~f:(fun map prerequisite ->
          Map.update map prerequisite ~f:(function
            | None -> [ ticket.id ]
            | Some ids -> ticket.id :: ids)))
    in
    Map.iteri dependent_map ~f:(fun ~key ~data ->
      let unresolved =
        List.filter data ~f:(fun id ->
          Option.value_map (Map.find ticket_map id) ~default:false ~f:(fun t ->
            not (Domain_command.Status.equal t.Ticket.status Done)))
      in
      let prerequisite = Map.find ticket_map key in
      if
        (not (List.is_empty unresolved))
        && Option.value_map prerequisite ~default:false ~f:(fun t ->
          not (Domain_command.Status.equal t.Ticket.status Done))
      then
        add
          (Wire.Item.Dependency_bottleneck
             { ticket_id = key
             ; metadata =
                 { waiting_ticket_ids =
                     List.dedup_and_sort unresolved ~compare:Id.Ticket.compare
                 ; waiting_count = List.length unresolved
                 }
             })
          (Id.Ticket.to_string key)
          (ticket_projects key)
          []
          []);
    let filtered =
      List.filter !output ~f:(fun item ->
        List.mem kind_filter (item_kind item) ~equal:String.equal
        && Option.value_map project_filter ~default:true ~f:(fun id ->
          List.mem item.projects id ~equal:Id.Project.equal)
        && Option.value_map run_filter ~default:true ~f:(fun id ->
          List.mem item.runs id ~equal:Id.Run.equal)
        && Option.value_map actor_filter ~default:true ~f:(fun id ->
          List.mem item.actors id ~equal:Id.Actor.equal))
      |> List.sort ~compare:(fun a b ->
        let kind = String.compare (item_kind a) (item_kind b) in
        if kind <> 0
        then kind
        else String.compare (Wire.Item.order_key a.row) (Wire.Item.order_key b.row))
    in
    require
      (offset <= List.length filtered)
      Invalid_argument
      "Coordinator cursor offset is outside capture";
    let path =
      match path_to with
      | None -> None
      | Some target ->
        require
          (Map.mem ticket_map target)
          Not_found
          "Dependency path target does not exist";
        let rec walk queue visited edges =
          match queue with
          | [] -> List.rev edges
          | id :: rest ->
            if Set.mem visited id
            then walk rest visited edges
            else (
              let deps =
                Option.value_map (Map.find ticket_map id) ~default:[] ~f:(fun t ->
                  t.Ticket.prerequisites)
              in
              let edges =
                List.fold deps ~init:edges ~f:(fun edges prerequisite ->
                  { Wire.Edge.ticket_id = id; prerequisite_ticket_id = prerequisite }
                  :: edges)
              in
              walk (List.rev_append deps rest) (Set.add visited id) edges)
        in
        Some (walk [ target ] Id.Ticket.Set.empty [])
    in
    let path, path_omitted =
      match path with
      | None -> None, 0
      | Some edges ->
        let rec fit acc = function
          | [] -> List.rev acc
          | edge :: rest ->
            let candidate = List.rev (edge :: acc) in
            if
              String.length
                (Json.canonical
                   (`Array
                       (List.map
                          candidate
                          ~f:(Coordination_wire.encode_exn Wire.Edge.codec))))
              > 1024
            then List.rev acc
            else fit (edge :: acc) rest
        in
        let selected = fit [] edges in
        Some selected, List.length edges - List.length selected
    in
    let remaining = List.drop filtered offset in
    let envelope items next_cursor needs_larger required_bytes =
      let value : Wire.Response.t =
        { workspace_id = workspace
        ; captured_now_unix_ms = clock
        ; items
        ; next_cursor
        ; omitted = List.length remaining - List.length items
        ; needs_larger_budget = needs_larger
        ; next_item_source =
            (if needs_larger
             then Some (Wire.Item.source (List.hd_exn remaining).row)
             else None)
        ; required_bytes
        ; dependency_path = path
        ; dependency_path_omitted = path_omitted
        }
      in
      match Coordination_wire.encode_exn Wire.Response.codec value with
      | `Object fields -> Json.obj (("revision", Json.int revision) :: fields)
      | _ -> Json.fail Invalid_argument "coordinator response must be an object"
    in
    let cursor_for count =
      if offset + count < List.length filtered
      then Some (encode_cursor ~offset:(offset + count) ~clock)
      else None
    in
    let required_first =
      match remaining with
      | [] -> None
      | item :: _ ->
        Some
          (Api_response.encoded_size
             Workspace_view
             (envelope [ item.row ] (cursor_for 1) false None))
    in
    let empty =
      envelope [] (cursor_for 0) (not (List.is_empty remaining)) required_first
    in
    require
      (Api_response.encoded_size Workspace_view empty <= max_bytes)
      Invalid_argument
      "Dependency path metadata exceeds query budget; narrow the query";
    let rec fit reversed = function
      | [] -> List.rev reversed
      | item :: rest ->
        let items = List.rev (item.row :: reversed) in
        if
          Api_response.encoded_size
            Workspace_view
            (envelope items (cursor_for (List.length items)) false None)
          > max_bytes
        then List.rev reversed
        else fit (item.row :: reversed) rest
    in
    let items = fit [] (List.take remaining limit) in
    let needs_larger = List.is_empty items && not (List.is_empty remaining) in
    envelope
      items
      (cursor_for (List.length items))
      needs_larger
      (if needs_larger then required_first else None))
;;
