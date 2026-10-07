open! Core

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
    ; blockers : Jsonaf.t
    ; claim : Claim.t option
    }
end

let require condition kind message = if not condition then Json.fail kind message

let checked = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let bool b = if b then `True else `False
let source kind fields = Json.obj (("type", Json.string kind) :: fields)

type item =
  { kind : string
  ; key : string
  ; source : Jsonaf.t
  ; metadata : Jsonaf.t
  ; projects : Id.Project.t list
  ; runs : Id.Run.t list
  ; actors : Id.Actor.t list
  }

let item_json item =
  Json.obj
    [ "kind", Json.string item.kind; "source", item.source; "metadata", item.metadata ]
;;

let kinds =
  [ "active_attempt"
  ; "ready_work"
  ; "allocation_blocked"
  ; "unanswered_request"
  ; "stale_run"
  ; "stale_ownership"
  ; "expired_ownership"
  ; "changed_input"
  ; "pending_review"
  ; "reservation"
  ; "reported_usage"
  ; "budget_limit"
  ; "dependency_bottleneck"
  ; "runner_action"
  ]
;;

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
    Json.fields
      params
      ~allowed:
        [ "project"
        ; "run"
        ; "actor"
        ; "kinds"
        ; "cursor"
        ; "limit"
        ; "max_bytes"
        ; "stale_after_ms"
        ; "dependency_path_to"
        ];
    require
      (revision >= 0 && Int64.(now_unix_ms >= zero))
      Invalid_argument
      "Coordinator capture has invalid counters";
    let optional key f = Option.map (Json.optional params key) ~f in
    let project_filter = optional "project" Id.Project.t_of_jsonaf in
    let run_filter = optional "run" Id.Run.t_of_jsonaf in
    let actor_filter = optional "actor" Id.Actor.t_of_jsonaf in
    let kind_filter =
      Option.value_map (Json.optional params "kinds") ~default:kinds ~f:(fun j ->
        List.dedup_and_sort (List.map (Json.list j) ~f:Json.text) ~compare:String.compare)
    in
    List.iter kind_filter ~f:(fun kind ->
      require
        (List.mem kinds kind ~equal:String.equal)
        Invalid_argument
        "Unknown coordinator kind filter");
    let path_to = optional "dependency_path_to" Id.Ticket.t_of_jsonaf in
    let stale_after_ms =
      Option.value_map
        (Json.optional params "stale_after_ms")
        ~default:300000L
        ~f:Json.integer64
    in
    require
      Int64.(stale_after_ms > zero)
      Invalid_argument
      "Staleness duration must be positive";
    let limit =
      Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
    in
    let max_bytes =
      Option.value_map (Json.optional params "max_bytes") ~default:65536 ~f:Json.integer
    in
    require
      (limit > 0 && limit <= 100 && max_bytes >= 4096 && max_bytes <= 1048576)
      Invalid_argument
      "Coordinator bounds are invalid";
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
      match Json.optional params "cursor" with
      | None -> 0, now_unix_ms
      | Some cursor ->
        let raw = Json.bounded_text cursor ~max_bytes:2048 in
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
    let allocation_reason = function
      | Allocation.Reason.Not_ready -> Json.obj [ "kind", Json.string "not_ready" ]
      | Claimed -> Json.obj [ "kind", Json.string "claimed" ]
      | Missing_capability capability ->
        Json.obj
          [ "kind", Json.string "missing_capability"
          ; "capability", Json.string capability
          ]
      | Pool_full pool ->
        Json.obj [ "kind", Json.string "pool_full"; "pool", Json.string pool ]
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
    let add kind key source metadata projects item_runs actors =
      output
      := { kind; key; source; metadata; projects; runs = item_runs; actors } :: !output
    in
    List.iter (Agent_run.attempts runs) ~f:(fun attempt ->
      if not (Attempt.State.terminal attempt.Attempt.state)
      then
        add
          "active_attempt"
          (Attempt.Id.to_string attempt.id)
          (source "attempt" [ "id", Attempt.Id.jsonaf_of_t attempt.id ])
          (Json.obj
             [ "ticket", Id.Ticket.jsonaf_of_t attempt.ticket
             ; "run", Id.Run.jsonaf_of_t attempt.run
             ; "state", Attempt.State.jsonaf_of_t attempt.state
             ; "token", Json.int attempt.token
             ; ( "last_checkpoint"
               , Option.value_map
                   (List.last attempt.checkpoints)
                   ~default:`Null
                   ~f:Attempt.Checkpoint.jsonaf_of_t )
             ])
          (ticket_projects attempt.ticket)
          [ attempt.run ]
          (run_actors attempt.run));
    List.iter tickets ~f:(fun ticket ->
      let project = Option.to_list ticket.Ticket.project in
      let src = source "ticket" [ "id", Id.Ticket.jsonaf_of_t ticket.id ] in
      if ticket.ready && Option.is_none ticket.claim
      then (
        let reasons, item_runs, actors =
          match allocation_run with
          | None -> [], [], []
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
                ~f:allocation_reason
            in
            let reasons =
              if Agent_run.Status.terminal record.status
              then Json.obj [ "kind", Json.string "run_terminal" ] :: reasons
              else reasons
            in
            let reasons =
              match Agent_run_policy.validate_allocation policies record.id ~runs with
              | Ok () -> reasons
              | Error problem ->
                Json.obj
                  [ "kind", Json.string "run_budget"; "problem", Problem.to_json problem ]
                :: reasons
            in
            reasons, [ record.id ], [ record.actor ]
        in
        add
          (if List.is_empty reasons then "ready_work" else "allocation_blocked")
          (Id.Ticket.to_string ticket.id)
          src
          (Json.obj
             [ "title", Json.string ticket.title
             ; "blockers", ticket.blockers
             ; ( "eligibility_scope"
               , Json.string (if Option.is_some allocation_run then "run" else "graph") )
             ; "allocation_reasons", `Array reasons
             ])
          project
          item_runs
          actors);
      Option.iter ticket.claim ~f:(fun claim ->
        let status = Allocation_lease.status claim.Claim.lease ~now_unix_ms:clock in
        let stale =
          Option.value_map claim.run ~default:false ~f:(fun id ->
            Option.value_map (run_record id) ~default:true ~f:(fun record ->
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
          add
            kind
            ("ticket:" ^ Id.Ticket.to_string ticket.id)
            src
            (Json.obj
               [ "token", Json.int claim.token
               ; ( "lease_status"
                 , Allocation_lease.Status.sexp_of_t status
                   |> Sexp.to_string
                   |> Json.string )
               ; "lease", Allocation_lease.to_json claim.lease
               ; "run", Option.value_map claim.run ~default:`Null ~f:Id.Run.jsonaf_of_t
               ])
            project
            (Option.to_list claim.run)
            [ claim.actor ])));
    List.iter (Agent_run.runs runs) ~f:(fun record ->
      if
        (not (Agent_run.Status.terminal record.Agent_run.Record.status))
        && Agent_run.stale
             (liveness_record record)
             ~now_unix_ms:clock
             ~after_ms:stale_after_ms
      then
        add
          "stale_run"
          (Id.Run.to_string record.id)
          (source "run" [ "id", Id.Run.jsonaf_of_t record.id ])
          (Json.obj
             [ "status", Agent_run.Status.jsonaf_of_t record.status
             ; ( "last_observed_unix_ms"
               , Option.value_map
                   (liveness_record record).last_observed_unix_ms
                   ~default:`Null
                   ~f:Json.int64 )
             ; "liveness_is_advisory", `True
             ; ( "liveness"
               , Json.string
                   (if Option.is_none (liveness_record record).last_observed_unix_ms
                    then "unobserved"
                    else "stale") )
             ])
          (run_projects record.id)
          [ record.id ]
          [ record.actor ]);
    List.iter (Agent_run.reservations runs) ~f:(fun reservation ->
      let src =
        source
          "reservation"
          [ "name", Reservation.Name.jsonaf_of_t reservation.Reservation.name ]
      in
      let owners = List.map reservation.holders ~f:(fun h -> h.Reservation.Holder.run) in
      let actors =
        List.map reservation.holders ~f:(fun h -> h.Reservation.Holder.actor)
      in
      let projects = List.concat_map owners ~f:run_projects in
      add
        "reservation"
        (Reservation.Name.to_string reservation.name)
        src
        (Reservation.jsonaf_of_t reservation)
        projects
        owners
        actors;
      List.iter reservation.holders ~f:(fun holder ->
        let status =
          Allocation_lease.status holder.Reservation.Holder.lease ~now_unix_ms:clock
        in
        let stale =
          Option.value_map (run_record holder.run) ~default:true ~f:(fun record ->
            Agent_run.stale
              (liveness_record record)
              ~now_unix_ms:clock
              ~after_ms:stale_after_ms)
        in
        match status with
        | Valid when not stale -> ()
        | Valid | Expired | Clock_regressed ->
          add
            (if Allocation_lease.Status.equal status Expired
             then "expired_ownership"
             else "stale_ownership")
            ("reservation:"
             ^ Reservation.Name.to_string reservation.name
             ^ ":"
             ^ Id.Run.to_string holder.run)
            src
            (Json.obj
               [ "run", Id.Run.jsonaf_of_t holder.run
               ; "token", Json.int holder.token
               ; "liveness_is_advisory", bool (Allocation_lease.Status.equal status Valid)
               ; ( "lease_status"
                 , Json.string (Sexp.to_string (Allocation_lease.Status.sexp_of_t status))
                 )
               ])
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
          "unanswered_request"
          (Communication_id.Request.to_string request.id)
          (source "request" [ "id", Communication_id.Request.jsonaf_of_t request.id ])
          (Json.obj
             [ "thread", Communication_id.Thread.jsonaf_of_t request.thread
             ; "message", Id.Comment.jsonaf_of_t request.message
             ; "kind", Communication.Request.Kind.jsonaf_of_t request.kind
             ; "unacknowledged_recipients", Json.int open_delivery
             ; ( "responsibility"
               , Communication.Request.Responsibility.jsonaf_of_t request.responsibility )
             ; ( "deadline_unix_ms"
               , Option.value_map request.deadline_unix_ms ~default:`Null ~f:Json.string )
             ])
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
          "changed_input"
          (Int.to_string reconciliation.serial)
          (source
             "reconciliation"
             [ "serial", Json.int reconciliation.serial
             ; "attempt", Attempt.Id.jsonaf_of_t reconciliation.attempt
             ])
          (Evidence.Reconciliation.jsonaf_of_t reconciliation)
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
          "pending_review"
          (Id.Ticket.to_string submission.ticket)
          (source
             "submission"
             [ "ticket", Id.Ticket.jsonaf_of_t submission.ticket
             ; "generation", Json.int submission.generation
             ])
          (Evidence.Submission.jsonaf_of_t submission)
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
        "reported_usage"
        (Usage_record.Id.to_string usage.id)
        (source "usage" [ "id", Usage_record.Id.jsonaf_of_t usage.id ])
        (Usage_record.to_json usage)
        projects
        item_runs
        [ usage.actor ]);
    List.iter (Agent_run_policy.attention policies ~runs) ~f:(fun row ->
      let id = Id.Run.t_of_jsonaf (Json.field row "run") in
      add
        "budget_limit"
        (Id.Run.to_string id ^ ":" ^ Json.text (Json.field row "kind"))
        (source "run_budget" [ "run", Id.Run.jsonaf_of_t id ])
        row
        (run_projects id)
        [ id ]
        (run_actors id));
    List.iter (Agent_run.pending_actions runs) ~f:(fun action ->
      add
        "runner_action"
        (Id.Run.to_string action.Agent_run.Runner_action.child)
        (source "run" [ "id", Id.Run.jsonaf_of_t action.child ])
        (Agent_run.Runner_action.jsonaf_of_t action)
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
          "dependency_bottleneck"
          (Id.Ticket.to_string key)
          (source "ticket" [ "id", Id.Ticket.jsonaf_of_t key ])
          (Json.obj
             [ ( "waiting_dependents"
               , `Array
                   (List.map
                      (List.sort unresolved ~compare:Id.Ticket.compare)
                      ~f:Id.Ticket.jsonaf_of_t) )
             ; "waiting_count", Json.int (List.length unresolved)
             ])
          (ticket_projects key)
          []
          []);
    let filtered =
      List.filter !output ~f:(fun item ->
        List.mem kind_filter item.kind ~equal:String.equal
        && Option.value_map project_filter ~default:true ~f:(fun id ->
          List.mem item.projects id ~equal:Id.Project.equal)
        && Option.value_map run_filter ~default:true ~f:(fun id ->
          List.mem item.runs id ~equal:Id.Run.equal)
        && Option.value_map actor_filter ~default:true ~f:(fun id ->
          List.mem item.actors id ~equal:Id.Actor.equal))
      |> List.sort ~compare:(fun a b ->
        let kind = String.compare a.kind b.kind in
        if kind <> 0 then kind else String.compare a.key b.key)
    in
    require
      (offset <= List.length filtered)
      Invalid_argument
      "Coordinator cursor offset is outside capture";
    let path =
      match path_to with
      | None -> `Null
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
                List.fold deps ~init:edges ~f:(fun acc prerequisite ->
                  Json.obj
                    [ "ticket", Id.Ticket.jsonaf_of_t id
                    ; "prerequisite", Id.Ticket.jsonaf_of_t prerequisite
                    ]
                  :: acc)
              in
              walk (List.rev_append deps rest) (Set.add visited id) edges)
        in
        `Array (walk [ target ] Id.Ticket.Set.empty [])
    in
    let path, path_omitted =
      match path with
      | `Array edges ->
        let rec fit acc = function
          | [] -> List.rev acc
          | edge :: rest ->
            if String.length (Json.canonical (`Array (List.rev (edge :: acc)))) > 1024
            then List.rev acc
            else fit (edge :: acc) rest
        in
        let selected = fit [] edges in
        `Array selected, List.length edges - List.length selected
      | `Null -> `Null, 0
      | _ -> Json.fail Invalid_argument "Invalid path metadata"
    in
    let remaining = List.drop filtered offset in
    let envelope items next_cursor needs_larger required_bytes =
      Json.obj
        [ "workspace", Id.Workspace.jsonaf_of_t workspace
        ; "revision", Json.int revision
        ; "captured_now_unix_ms", Json.int64 clock
        ; "items", `Array items
        ; "next_cursor", next_cursor
        ; ( "omitted"
          , Json.int (Int.max 0 (List.length filtered - offset - List.length items)) )
        ; "needs_larger_budget", bool needs_larger
        ; ( "next_item_source"
          , if needs_larger then (List.hd_exn remaining).source else `Null )
        ; ("required_bytes", if needs_larger then Json.int required_bytes else `Null)
        ; "dependency_path", path
        ; "dependency_path_omitted", Json.int path_omitted
        ; "critical_path_duration_ms", `Null
        ; "critical_path_reason", Json.string "Task duration estimates are unavailable"
        ]
    in
    let selected = List.take remaining limit in
    let base_bytes = String.length (Json.canonical (envelope [] `Null false 0)) in
    require
      (base_bytes <= max_bytes)
      Invalid_argument
      "Dependency path metadata exceeds query budget; narrow the query";
    let rec fit reversed = function
      | [] -> List.rev reversed
      | item :: rest ->
        let items = List.rev (item_json item :: reversed) in
        let next = offset + List.length items in
        let cursor =
          if next < List.length filtered
          then Json.string (encode_cursor ~offset:next ~clock)
          else `Null
        in
        if String.length (Json.canonical (envelope items cursor false 0)) > max_bytes
        then List.rev reversed
        else fit (item_json item :: reversed) rest
    in
    let items = fit [] selected in
    let next = offset + List.length items in
    let next_cursor =
      if next < List.length filtered
      then Json.string (encode_cursor ~offset:next ~clock)
      else `Null
    in
    let needs_larger = List.is_empty items && not (List.is_empty remaining) in
    let required_bytes =
      if needs_larger
      then
        String.length
          (Json.canonical
             (envelope [ item_json (List.hd_exn remaining) ] next_cursor true 0))
        + 24
      else 0
    in
    envelope items next_cursor needs_larger required_bytes)
;;
