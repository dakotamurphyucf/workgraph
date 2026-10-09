open Core
open Planning_state
module W = Coordination_wire

module Kind = struct
  type t =
    | Completion
    | Reopening
    | Decision
    | Blocker
    | Request
    | Condition
    | Recovery
    | Ownership
    | Progress
    | Fact
    | Task_changed
    | Resource
  [@@deriving sexp, equal]

  let name = function
    | Completion -> "completion"
    | Reopening -> "reopening"
    | Decision -> "decision"
    | Blocker -> "blocker"
    | Request -> "request"
    | Condition -> "condition"
    | Recovery -> "recovery"
    | Ownership -> "ownership"
    | Progress -> "progress"
    | Fact -> "fact"
    | Task_changed -> "task_changed"
    | Resource -> "resource"
  ;;

  let codec =
    Api_codec.enum
      (List.map
         [ Completion
         ; Reopening
         ; Decision
         ; Blocker
         ; Request
         ; Condition
         ; Recovery
         ; Ownership
         ; Progress
         ; Fact
         ; Task_changed
         ; Resource
         ]
         ~f:(fun k -> name k, k))
      ~equal
  ;;
end

type scan =
  { workspace : Id.Workspace.t
  ; revision : int
  ; scope : Resume_api.Scope.t
  ; position : Digest_cursor.Position.t
  ; through : int
  ; lineage : Planning_lineage.t
  ; rows : Jsonaf.t list
  ; requests : Jsonaf.t list
  ; other_changes : int
  }

type t =
  { result : Jsonaf.t
  ; markdown : string
  }

let unwrap = function
  | Ok v -> v
  | Error e -> raise (Json.Decode_error e)
;;

let bool b = if b then `True else `False

let scope_target = function
  | Resume_api.Scope.Workspace -> Entity_ref.Workspace
  | Project id -> Entity_ref.Project id
  | Ticket id -> Entity_ref.Ticket id
;;

let record_item ~kind ~summary ~sources ~record =
  Resume_record.create ~kind ~summary ~sources ~record ~max_field_bytes:512
;;

let source_ticket ticket =
  Resume_source.Ticket { id = ticket.Ticket.id; revision = ticket.revision }
;;

let same_claim =
  Option.equal (fun (a : Claim.t) (b : Claim.t) ->
    Id.Actor.equal a.actor b.actor
    && Option.equal Id.Run.equal a.run_id b.run_id
    && Int.equal a.token b.token
    && Allocation_lease.equal a.lease b.lease)
;;

let same_hold =
  Option.equal (fun (a : Hold.t) (b : Hold.t) ->
    Id.Actor.equal a.actor b.actor
    && String.equal a.reason b.reason
    && String.equal a.timestamp b.timestamp)
;;

let scan t ~scope ~after ~cursor =
  Json.decode (fun () ->
    validate_target t (scope_target scope);
    let position, through =
      match cursor with
      | None ->
        let after = Option.value after ~default:0 in
        if after > t.revision
        then Json.fail Conflict "digest position exceeds current snapshot";
        unwrap (Digest_cursor.Position.after_revision after), t.revision
      | Some encoded ->
        if Option.is_some after
        then Json.fail Invalid_argument "supply after or cursor, not both";
        let cursor = unwrap (Digest_cursor.decode encoded) in
        unwrap
          (Digest_cursor.validate
             cursor
             ~workspace:t.workspace
             ~scope
             ~activity:t.activity);
        let position = Digest_cursor.position cursor in
        ( position
        , if
            Digest_cursor.Position.complete
              position
              ~through:(Digest_cursor.through cursor)
          then t.revision
          else Digest_cursor.through cursor )
    in
    let lineage = unwrap (Planning_lineage.of_activity t.activity ~through) in
    let tickets = ref Id.Ticket.Map.empty in
    let resources = ref Id.Resource.Map.empty in
    let milestones = ref Id.Milestone.Map.empty in
    let discussion = ref Discussion.empty in
    let boards = ref Communication_id.Board.Map.empty in
    let threads = ref Communication_id.Thread.Map.empty in
    let requests = ref Communication_id.Request.Map.empty in
    let rows = ref [] in
    let other_changes = ref 0 in
    let containing_project = function
      | Entity_ref.Ticket id ->
        Option.bind (Map.find !tickets id) ~f:(fun ticket -> ticket.Ticket.project)
      | Milestone id ->
        Option.map (Map.find !milestones id) ~f:(fun milestone ->
          milestone.Milestone.project)
      | Workspace | Project _ | Resource _ -> None
    in
    let parents targets =
      List.concat_map targets ~f:(fun target ->
        let linked =
          match target with
          | Entity_ref.Resource id ->
            Option.value_map (Map.find !resources id) ~default:[] ~f:(fun resource ->
              resource.Resource.metadata.targets)
          | Workspace | Project _ | Milestone _ | Ticket _ -> []
        in
        linked
        @ List.filter_map (target :: linked) ~f:(fun target ->
          Option.map (containing_project target) ~f:(fun id -> Entity_ref.Project id)))
    in
    let matches targets =
      let captured = targets @ parents targets in
      match scope with
      | Resume_api.Scope.Workspace -> true
      | Project id -> List.mem captured (Entity_ref.Project id) ~equal:Entity_ref.equal
      | Ticket id -> List.mem captured (Entity_ref.Ticket id) ~equal:Entity_ref.equal
    in
    let thread_targets thread =
      thread.Communication.Thread.links
      @ Option.value_map (Map.find !boards thread.board) ~default:[] ~f:(fun scope ->
        [ Communication.Scope.target scope ])
    in
    List.iter (List.rev t.activity) ~f:(fun audit ->
      let revision = Json.field audit "revision" |> Json.integer in
      if revision <= through
      then
        List.iteri
          (Json.list (Json.field audit "changes"))
          ~f:(fun change_index raw ->
            let event = Event.t_of_jsonaf raw in
            let relevant =
              Digest_cursor.Position.follows position ~revision ~change_index
            in
            let change_source =
              Resume_source.Planning_change
                { workspace_revision = revision; change_index }
            in
            let emit category kind targets source record summary =
              if relevant && matches targets
              then (
                let item =
                  record_item ~kind ~summary ~sources:(change_source :: source) ~record
                in
                rows
                := W.decode_exn
                     Resume_api.entry_codec
                     (Json.obj
                        [ "workspace_revision", Json.int revision
                        ; "change_index", Json.int change_index
                        ; "category", W.encode_exn Kind.codec category
                        ; "item", item
                        ])
                   :: !rows)
            in
            let skip () =
              if
                relevant
                && matches
                     (Json.list (Json.field audit "targets")
                      |> List.map ~f:Entity_ref.t_of_jsonaf)
              then Int.incr other_changes
            in
            match event with
            | Ticket_put ticket ->
              let old = Map.find !tickets ticket.id in
              let project_targets =
                Option.to_list ticket.project
                @ Option.to_list (Option.bind old ~f:(fun old -> old.Ticket.project))
                |> List.map ~f:(fun id -> Entity_ref.Project id)
              in
              let category =
                match old with
                | Some old
                  when (not (Domain_command.Status.equal old.Ticket.status Done))
                       && Domain_command.Status.equal ticket.status Done ->
                  Kind.Completion
                | Some old
                  when Domain_command.Status.equal ticket.status Todo
                       && Option.is_some ticket.reopened_token
                       && not
                            (Option.equal
                               Int.equal
                               old.Ticket.reopened_token
                               ticket.reopened_token) -> Kind.Reopening
                | Some old when not (same_hold old.hold ticket.hold) -> Blocker
                | None | Some _ -> Task_changed
              in
              emit
                category
                "task"
                (Entity_ref.Ticket ticket.id :: project_targets)
                [ source_ticket ticket ]
                (Resume_task.of_ticket ticket)
                (Printf.sprintf "%s: %s" (Kind.name category) ticket.title);
              tickets := Map.set !tickets ~key:ticket.id ~data:ticket
            | Comment_changed change ->
              discussion := Discussion.apply !discussion change ~sequence:revision;
              let id =
                match change with
                | Discussion.Change.Create p -> p.id
                | Revise p -> p.id
              in
              let private_view = Discussion.get !discussion id in
              let kind = Discussion.Kind.t_of_jsonaf (Json.field private_view "kind") in
              let category =
                match kind with
                | Decision -> Kind.Decision
                | Blocker -> Blocker
                | Comment | Progress | Evidence -> Progress
              in
              let source =
                Resume_source.Comment
                  { id
                  ; revision = Json.integer (Json.field private_view "revision")
                  ; sequence = Json.integer (Json.field private_view "sequence")
                  }
              in
              emit
                category
                "comment"
                [ Discussion.target !discussion id ]
                [ source ]
                (Discussion_wire.comment_json private_view)
                (Printf.sprintf
                   "%s comment %s"
                   (Kind.name category)
                   (Id.Comment.to_string id))
            | Facts_changed fact ->
              let source =
                Resume_source.Fact
                  { scope = Facts.Change.scope fact
                  ; key = Facts.Change.key fact
                  ; revision = Facts.Change.revision fact
                  ; changed_at_revision = Facts.Change.sequence fact
                  }
              in
              emit
                Fact
                "fact"
                [ Facts.Change.target fact ]
                [ source ]
                (Facts.current_record fact)
                ("Fact changed: " ^ Facts.Key.to_string (Facts.Change.key fact))
            | Handoff_put handoff ->
              emit
                Decision
                "handoff"
                [ Entity_ref.Ticket handoff.ticket ]
                [ Resume_source.Handoff
                    { ticket = handoff.ticket
                    ; revision = handoff.revision
                    ; covers_through = handoff.covers_through
                    }
                ]
                (handoff_view_json handoff)
                ("Handoff recorded: " ^ Id.Ticket.to_string handoff.ticket)
            | Ticket_recovered recovery ->
              let id = recovery.request.ticket_id in
              let ticket =
                match Map.find !tickets id with
                | Some ticket -> ticket
                | None -> Json.fail Corrupt_store "Recovery prefix ticket unavailable"
              in
              tickets
              := Map.set
                   !tickets
                   ~key:id
                   ~data:(ticket_after_recovery_exn ticket ~recovery);
              emit
                Recovery
                "ticket_recovery"
                [ Entity_ref.Ticket recovery.request.ticket_id ]
                [ Resume_source.Ticket_recovery
                    { id = recovery.request.recovery_id; sequence = recovery.sequence }
                ]
                (Ticket_recovery.jsonaf_of_t recovery)
                ("Ticket ownership recovered: "
                 ^ Id.Ticket.to_string recovery.request.ticket_id)
            | Resource_changed change ->
              let id =
                match change with
                | Resource.Change.Published p -> p.id
                | Metadata_changed p -> p.id
              in
              let previous = Map.find !resources id in
              let resource = Resource.apply previous change in
              let targets =
                resource.metadata.targets
                @ Option.value_map previous ~default:[] ~f:(fun resource ->
                  resource.Resource.metadata.targets)
              in
              let version = Resource.get_version resource ~revision:None in
              emit
                Resource
                "resource"
                targets
                [ Resume_source.Resource_version
                    { id; revision = version.revision; digest = version.digest }
                ]
                (Resource_wire.summary_json resource)
                ("Resource changed: " ^ resource.metadata.title);
              resources := Map.set !resources ~key:id ~data:resource
            | Communication_changed change ->
              (match change.update with
               | Board_put board ->
                 boards := Map.set !boards ~key:board.id ~data:board.scope;
                 skip ()
               | Thread_put thread ->
                 threads := Map.set !threads ~key:thread.id ~data:thread;
                 skip ()
               | Request_put { request; _ } ->
                 let targets =
                   Option.value_map
                     (Map.find !threads request.thread)
                     ~default:[]
                     ~f:thread_targets
                 in
                 emit
                   Request
                   "request"
                   targets
                   [ Resume_source.Request
                       { id = request.id; revision = request.revision }
                   ]
                   (Communication_wire.request_json request)
                   ("Request changed: " ^ Communication_id.Request.to_string request.id);
                 requests := Map.set !requests ~key:request.id ~data:request
               | Message_put _ | Team_put _ | Subscription_put _ | Inbox_ack _ -> skip ())
            | Agent_run_changed change ->
              (match change.update with
               | Attempt_put attempt | Attempt_started { attempt; _ } ->
                 emit
                   Ownership
                   "attempt"
                   [ Entity_ref.Ticket attempt.ticket ]
                   [ Resume_source.Attempt
                       { id = attempt.id; revision = attempt.revision }
                   ]
                   (Agent_run_api.attempt_json attempt)
                   ("Attempt changed: " ^ Attempt.Id.to_string attempt.id)
               | Run_put run ->
                 let targets =
                   Map.data !tickets
                   |> List.filter_map ~f:(fun ticket ->
                     if
                       Option.exists ticket.Ticket.claim ~f:(fun claim ->
                         Option.exists claim.run_id ~f:(Id.Run.equal run.id))
                     then Some (Entity_ref.Ticket ticket.id)
                     else None)
                 in
                 emit
                   Ownership
                   "run"
                   targets
                   [ Resume_source.Run { id = run.id; revision = run.revision } ]
                   (Agent_run_api.run_json run)
                   ("Run changed: " ^ Id.Run.to_string run.id)
               | Ticket_paths_put policy ->
                 emit
                   Ownership
                   "paths"
                   [ Entity_ref.Ticket policy.ticket_id ]
                   [ Resume_source.Planning_change
                       { workspace_revision = revision; change_index }
                   ]
                   (Ticket_paths.jsonaf_of_t policy)
                   ("Path policy changed: " ^ Id.Ticket.to_string policy.ticket_id)
               | External_condition_changed changed ->
                 (match changed with
                  | External_condition.Change.Put declaration ->
                    emit
                      Condition
                      "condition_declaration"
                      [ Entity_ref.Ticket declaration.ticket_id ]
                      [ Resume_source.Condition
                          { id = declaration.condition_id
                          ; revision = declaration.revision
                          }
                      ]
                      (External_condition.Declaration.jsonaf_of_t declaration)
                      ("External condition declared: " ^ declaration.label)
                  | Signal signal ->
                    (* Signal's immutable declaration determines its ticket, even if a
               later declaration changes. Resolve from exact stored history. *)
                    let declaration =
                      External_condition.history
                        (Agent_run.external_conditions t.agent_runs)
                      |> List.find_exn ~f:(fun d ->
                        Coordination_id.Condition.equal d.condition_id signal.condition_id
                        && d.revision = signal.condition_revision)
                    in
                    emit
                      Condition
                      "condition_signal"
                      [ Entity_ref.Ticket declaration.ticket_id ]
                      [ Resume_source.Condition
                          { id = signal.condition_id
                          ; revision = signal.condition_revision
                          }
                      ]
                      (External_condition.Signal.jsonaf_of_t signal)
                      ("External condition signaled: " ^ declaration.label))
               | Ownership_recovered { recovery; _ } ->
                 (* Reservation audits are workspace-scoped unless a transaction has a
             direct ticket transition. They never borrow current ticket paths. *)
                 if Resume_api.Scope.equal scope Workspace
                 then
                   emit
                     Recovery
                     "reservation_recovery"
                     [ Entity_ref.Workspace ]
                     [ Resume_source.Reservation_recovery
                         { id = recovery.request.recovery_id
                         ; sequence = recovery.sequence
                         }
                     ]
                     (Ownership_recovery.jsonaf_of_t recovery)
                     "Reservation ownership recovered"
                 else skip ()
               | Pool_put _
               | Ticket_policy_put _
               | Reservation_put _
               | Path_reservation_put _
               | Actions_set _ -> skip ())
            | Milestone_put milestone ->
              milestones := Map.set !milestones ~key:milestone.id ~data:milestone;
              skip ()
            | Signal_receipt _
            | Evidence_changed _
            | Policy_changed _
            | Policy_unchanged _
            | Allocation_empty _
            | Settings_changed _
            | Workspace_updated _
            | Project_put _ -> skip ()));
    let outstanding =
      Map.data !requests
      |> List.filter_map ~f:(fun request ->
        let open_ =
          match request.Communication.Request.status with
          | Open -> true
          | Resolved _ | Cancelled _ -> false
        in
        let targets =
          Option.value_map
            (Map.find !threads request.thread)
            ~default:[]
            ~f:thread_targets
        in
        if open_ && matches targets
        then
          Some
            (record_item
               ~kind:"request"
               ~summary:
                 ("Outstanding request: " ^ Communication_id.Request.to_string request.id)
               ~sources:
                 [ Resume_source.Request { id = request.id; revision = request.revision }
                 ]
               ~record:(Communication_wire.request_json request))
        else None)
    in
    { workspace = t.workspace
    ; revision = t.revision
    ; scope
    ; position
    ; through
    ; lineage
    ; rows = List.rev !rows
    ; requests = outstanding
    ; other_changes = !other_changes
    })
;;

let rows t = t.rows
let outstanding_requests t = t.requests
let other_changes t = t.other_changes

let capture t =
  Json.obj
    [ "after", Json.int (Digest_cursor.Position.revision t.position)
    ; ( "after_change_index"
      , if Digest_cursor.Position.change_index t.position < 0
        then `Null
        else Json.int (Digest_cursor.Position.change_index t.position) )
    ; "through", Json.int t.through
    ; "lineage", Json.string (Planning_lineage.digest t.lineage)
    ]
;;

let cursor_after t ~count =
  if count < 0 || count > List.length t.rows
  then Json.fail Invalid_argument "digest row count outside capture";
  let position =
    if count = List.length t.rows
    then unwrap (Digest_cursor.Position.after_revision t.through)
    else if count = 0
    then t.position
    else (
      let row = List.nth_exn t.rows (count - 1) in
      unwrap
        (Digest_cursor.Position.create
           ~revision:(Json.integer (Json.field row "workspace_revision"))
           ~change_index:(Json.integer (Json.field row "change_index"))))
  in
  let cursor =
    unwrap
      (Digest_cursor.create
         ~workspace:t.workspace
         ~scope:t.scope
         ~position
         ~lineage:t.lineage)
  in
  Digest_cursor.encode cursor, count < List.length t.rows
;;

let build state request =
  Json.decode (fun () ->
    let scan =
      unwrap
        (scan
           state
           ~scope:(Resume_api.Digest_request.scope request)
           ~after:(Resume_api.Digest_request.after request)
           ~cursor:(Resume_api.Digest_request.cursor request))
    in
    let selected = List.take scan.rows (Resume_api.Digest_request.limit request) in
    let include_markdown = Resume_api.Digest_request.include_markdown request in
    let data entries requests =
      let cursor, has_more = cursor_after scan ~count:(List.length entries) in
      let items = List.map entries ~f:(fun entry -> Json.field entry "item") @ requests in
      let counts =
        [ Resume_record.count
            ~section:"entries"
            ~total:(List.length scan.rows)
            ~returned:(List.length entries)
        ; Resume_record.count
            ~section:"outstanding_requests"
            ~total:(List.length scan.requests)
            ~returned:(List.length requests)
        ; Resume_record.count
            ~section:"other_resolved_changes"
            ~total:scan.other_changes
            ~returned:0
        ]
      in
      let markdown =
        if include_markdown
        then
          Resume_record.markdown items
          ^ "\n\n"
          ^ Resume_record.markdown_context
              ~capture:(capture scan)
              ~warnings:[]
              ~counts
              ~cursor
              ~has_more
        else ""
      in
      let data =
        Json.obj
          ([ "capture", capture scan
           ; "entries", `Array entries
           ; "outstanding_requests", `Array requests
           ; "counts", `Array counts
           ; "cursor", Json.string cursor
           ; "has_more", bool has_more
           ]
           @ if include_markdown then [ "markdown", Json.string markdown ] else [])
      in
      data, markdown
    in
    let fits entries requests =
      let data, _ = data entries requests in
      Api_response.encoded_size
        Planning_read
        (Resume_record.envelope ~revision:state.revision data)
      <= Resume_api.Digest_request.max_bytes request
    in
    let rec prefix acc = function
      | [] -> List.rev acc
      | x :: xs ->
        if fits (List.rev (x :: acc)) [] then prefix (x :: acc) xs else List.rev acc
    in
    let entries = prefix [] selected in
    if (not (List.is_empty selected)) && List.is_empty entries
    then
      Json.fail Invalid_argument "One complete digest row cannot fit; increase max_bytes";
    let rec add_requests acc = function
      | [] -> List.rev acc
      | x :: xs ->
        if fits entries (List.rev (x :: acc))
        then add_requests (x :: acc) xs
        else List.rev acc
    in
    let requests = add_requests [] (List.take scan.requests 100) in
    let data, markdown = data entries requests in
    if not (fits entries requests)
    then
      Json.fail Invalid_argument "Digest capture metadata cannot fit; increase max_bytes";
    let data =
      W.decode_exn
        (Option.value_exn (Resume_api.response_codec ~method_:"activity.digest"))
        data
    in
    { result = Resume_record.envelope ~revision:state.revision data; markdown })
;;

let result t = t.result
let markdown t = t.markdown
