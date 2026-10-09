open Core
open Planning_state
module W = Coordination_wire

type t =
  { result : Jsonaf.t
  ; markdown : string
  }

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let boolean b = if b then `True else `False

let item ~kind ~summary ~sources ~record =
  Resume_record.create ~kind ~summary ~sources ~record ~max_field_bytes:256
;;

let warning code detail sources =
  Json.obj
    [ "code", Json.string code
    ; "detail", Json.string detail
    ; "sources", `Array (List.map sources ~f:(W.encode_exn Resume_source.codec))
    ]
;;

module Source_index = struct
  module Key = struct
    module T = struct
      type t =
        | Task of Id.Ticket.t
        | Task_record of Id.Ticket.t
        | Handoff of Id.Ticket.t
        | Run of Id.Run.t
        | Attempt of Attempt.Id.t
        | Paths of Id.Ticket.t
        | Condition of Coordination_id.Condition.t
        | First_claim of Id.Ticket.t * int
      [@@deriving sexp, compare]
    end

    include T
    include Comparable.Make (T)
  end

  type t = Resume_source.t Key.Map.t

  let create state =
    List.fold (List.rev state.activity) ~init:Key.Map.empty ~f:(fun index audit ->
      List.foldi
        (Json.list (Json.field audit "changes"))
        ~init:index
        ~f:(fun change_index index raw ->
          let source =
            Resume_source.Planning_change
              { workspace_revision = Json.integer (Json.field audit "revision")
              ; change_index
              }
          in
          let put index key = Map.set index ~key ~data:source in
          match Event.t_of_jsonaf raw with
          | Ticket_put ticket ->
            let index = put (put index (Task ticket.id)) (Task_record ticket.id) in
            (match ticket.claim with
             | None -> index
             | Some claim ->
               let key = Key.First_claim (ticket.id, claim.token) in
               if Map.mem index key then index else put index key)
          | Ticket_recovered recovery -> put index (Task recovery.request.ticket_id)
          | Handoff_put h -> put index (Handoff h.ticket)
          | Agent_run_changed change ->
            (match change.update with
             | Run_put run -> put index (Run run.id)
             | Attempt_put attempt | Attempt_started { attempt; _ } ->
               put index (Attempt attempt.id)
             | Ticket_paths_put paths -> put index (Paths paths.ticket_id)
             | External_condition_changed (Put d) -> put index (Condition d.condition_id)
             | External_condition_changed (Signal signal) ->
               put index (Condition signal.condition_id)
             | _ -> index)
          | _ -> index))
  ;;

  let get t key = Map.find t key |> Option.to_list
end

let build ?now_unix_ms state request =
  Json.decode (fun () ->
    Option.iter (Resume_api.Resume_request.at_revision request) ~f:(fun revision ->
      expected state.revision revision);
    let id = Resume_api.Resume_request.ticket request in
    let ticket = find_ticket state id in
    let ticket_source = Resume_source.Ticket { id; revision = ticket.revision } in
    let source_index = Source_index.create state in
    let task_sources =
      ticket_source
      :: (Source_index.get source_index (Task id)
          @ Source_index.get source_index (Task_record id))
    in
    let handoff = Map.find state.handoffs id in
    let coverage =
      Option.value_map handoff ~default:0 ~f:(fun h -> h.Handoff.covers_through)
    in
    let scan =
      unwrap
        (Activity_digest.scan
           state
           ~scope:(Resume_api.Scope.Ticket id)
           ~after:(Some coverage)
           ~cursor:None)
    in
    let reasons =
      eligibility_reasons
        ?run:(Resume_api.Resume_request.run request)
        ?now_unix_ms
        state
        ticket
    in
    let public_readiness =
      readiness_view
        ?run:(Resume_api.Resume_request.run request)
        ?now_unix_ms
        state
        ticket
    in
    let shown_reasons = ref (List.take public_readiness.reasons 5) in
    let prose_limit = ref 256 in
    let task () =
      Resume_record.create
        ~kind:"task"
        ~summary:("Task: " ^ ticket.title)
        ~sources:task_sources
        ~record:(Resume_task.of_ticket ticket)
        ~max_field_bytes:!prose_limit
    in
    let readiness () =
      item
        ~kind:"readiness"
        ~summary:"Current readiness"
        ~sources:[ ticket_source ]
        ~record:
          (Json.obj
             [ "ready", boolean (List.is_empty reasons)
             ; "reason_count", Json.int (List.length reasons)
             ; ( "reasons"
               , `Array
                   (List.map
                      !shown_reasons
                      ~f:(W.encode_exn Planning_ticket_wire.Readiness.Reason.codec)) )
             ])
    in
    let warnings = ref [] in
    let warn code detail sources = warnings := warning code detail sources :: !warnings in
    let optional = ref [] in
    let add section x = optional := !optional @ [ section, x ] in
    (match handoff with
     | None ->
       warn
         "handoff_missing"
         "No handoff has been recorded; changes begin at workspace revision zero."
         [ ticket_source ]
     | Some h ->
       let source =
         Resume_source.Handoff
           { ticket = id; revision = h.revision; covers_through = h.covers_through }
       in
       add
         "handoff"
         (item
            ~kind:"handoff"
            ~summary:"Latest recorded handoff"
            ~sources:(source :: Source_index.get source_index (Handoff id))
            ~record:(handoff_view_json h));
       if h.covers_through = 0
       then
         warn
           "handoff_coverage_missing"
           "Recorded handoff has no covered workspace prefix."
           [ source ];
       (match ticket.claim with
        | None -> ()
        | Some claim ->
          let token_after_coverage =
            List.exists
              (Source_index.get source_index (First_claim (id, claim.token)))
              ~f:(function
                | Resume_source.Planning_change pin ->
                  pin.workspace_revision > h.covers_through
                | _ -> false)
          in
          if token_after_coverage
          then
            warn
              "handoff_claim_changed"
              "Current claim token was created after the handoff's recorded coverage."
              [ source; ticket_source ]));
    if not (List.is_empty (Activity_digest.rows scan))
    then (
      let counts =
        List.fold (Activity_digest.rows scan) ~init:String.Map.empty ~f:(fun counts row ->
          let item = Json.field row "item" in
          let kind =
            let kind = Json.text (Json.field item "kind") in
            let category = Json.text (Json.field row "category") in
            if String.equal kind "handoff"
            then "handoff"
            else if String.equal kind "task" && String.equal category "ownership"
            then "claim"
            else if String.equal category "ownership"
            then kind
            else category
          in
          Map.update counts kind ~f:(fun n -> Option.value n ~default:0 + 1))
      in
      let bookkeeping_only =
        List.for_all (Map.keys counts) ~f:(fun kind ->
          String.equal kind "handoff" || String.equal kind "claim")
      in
      warn
        (if bookkeeping_only
         then "handoff_bookkeeping_activity"
         else "handoff_new_activity")
        (Printf.sprintf
           "%d recorded changes follow handoff coverage (%s). %sCoverage is unchanged."
           (List.length (Activity_digest.rows scan))
           (Map.to_alist counts
            |> List.map ~f:(fun (kind, n) -> kind ^ "=" ^ Int.to_string n)
            |> String.concat ~sep:", ")
           (if bookkeeping_only
            then
              "Only handoff/ownership bookkeeping is recorded; inspect ownership before \
               acting. "
            else ""))
        [ ticket_source ]);
    if
      List.exists reasons ~f:(function
        | Eligibility_reason.Coordination_clock_required _ -> true
        | _ -> false)
    then
      warn
        "observation_time_required"
        "Timed ownership diagnostics require an explicit observation time."
        [ ticket_source ];
    let run =
      match Resume_api.Resume_request.run request with
      | Some id -> Some id
      | None -> Option.bind ticket.claim ~f:(fun c -> c.run_id)
    in
    Option.iter run ~f:(fun id ->
      match Agent_run.get_run state.agent_runs id with
      | None ->
        if Option.is_some (Resume_api.Resume_request.run request)
        then Json.fail Not_found "requested run not found"
        else
          warn
            "associated_run_missing"
            ("Claim attribution run has no registered record: " ^ Id.Run.to_string id)
            task_sources
      | Some run ->
        add
          "run"
          (item
             ~kind:"run"
             ~summary:"Associated run"
             ~sources:
               (Resume_source.Run { id; revision = run.revision }
                :: Source_index.get source_index (Run id))
             ~record:(Agent_run_api.run_json run)));
    Option.iter ticket.claim ~f:(fun claim ->
      Option.iter
        (Agent_run.latest_attempt_for_ticket
           state.agent_runs
           ~ticket:id
           ~token:claim.token)
        ~f:(fun attempt ->
          add
            "attempt"
            (item
               ~kind:"attempt"
               ~summary:"Latest attempt for current claim"
               ~sources:
                 (Resume_source.Attempt { id = attempt.id; revision = attempt.revision }
                  :: Source_index.get source_index (Attempt attempt.id))
               ~record:(Agent_run_api.attempt_json attempt))));
    Option.iter (Agent_run.get_ticket_paths state.agent_runs id) ~f:(fun paths ->
      add
        "paths"
        (item
           ~kind:"paths"
           ~summary:"Declared path requirements"
           ~sources:(Source_index.get source_index (Paths id))
           ~record:(Ticket_paths.jsonaf_of_t paths)));
    let conditions = Agent_run.external_conditions state.agent_runs in
    External_condition.declarations conditions
    |> List.filter ~f:(fun d ->
      Id.Ticket.equal d.External_condition.Declaration.ticket_id id)
    |> List.iter ~f:(fun d ->
      add
        "conditions"
        (item
           ~kind:"condition"
           ~summary:("External condition: " ^ d.label)
           ~sources:
             (Resume_source.Condition { id = d.condition_id; revision = d.revision }
              :: Source_index.get source_index (Condition d.condition_id))
           ~record:(Agent_coordination_api.condition_json conditions d)));
    Map.data state.ticket_recoveries
    |> List.filter ~f:(fun r -> Id.Ticket.equal r.Ticket_recovery.request.ticket_id id)
    |> List.iter ~f:(fun r ->
      add
        "recoveries"
        (item
           ~kind:"ticket_recovery"
           ~summary:"Ownership recovery audit"
           ~sources:
             [ Resume_source.Ticket_recovery
                 { id = r.request.recovery_id; sequence = r.sequence }
             ]
           ~record:(Ticket_recovery.jsonaf_of_t r)));
    let policy =
      unwrap
        (Evidence.effective_policy
           state.evidence
           ~ticket_context:(evidence_ticket_context state)
           ~ticket:id)
    in
    add
      "effective_policy"
      (item
         ~kind:"effective_policy"
         ~summary:"Effective acceptance policy"
         ~sources:[ ticket_source ]
         ~record:(W.encode_exn Acceptance_policy.Effective.codec policy));
    add
      "completion"
      (item
         ~kind:"completion"
         ~summary:"Current completion gates"
         ~sources:task_sources
         ~record:
           (W.encode_exn
              Planning_ticket_wire.Completion.codec
              (completion_view state ticket)));
    List.iter (Activity_digest.outstanding_requests scan) ~f:(fun request ->
      add "outstanding_requests" request);
    List.iter (Resume_api.Resume_request.facts request) ~f:(fun selected ->
      validate_target state (Facts.Scope.target selected.Resume_api.Fact_selection.scope);
      match Facts.current state.facts ~scope:selected.scope ~key:selected.key with
      | None ->
        warn
          "fact_missing"
          ("Selected fact does not exist: " ^ Facts.Key.to_string selected.key)
          []
      | Some fact ->
        let source =
          Resume_source.Fact
            { scope = selected.scope
            ; key = selected.key
            ; revision = Facts.Change.revision fact
            ; changed_at_revision = Facts.Change.sequence fact
            }
        in
        if Option.is_none (Facts.Change.value fact)
        then
          warn
            "fact_deleted"
            ("Selected fact was deleted: " ^ Facts.Key.to_string selected.key)
            [ source ];
        add
          "selected_facts"
          (item
             ~kind:"fact"
             ~summary:("Selected fact: " ^ Facts.Key.to_string selected.key)
             ~sources:[ source ]
             ~record:(Facts.current_record fact)));
    let keys_params =
      Json.obj
        ([ "scope", W.encode_exn Facts.Scope.codec (Facts.Scope.Ticket id)
         ; "limit", Json.int 16
         ]
         @ Option.to_list
             (Option.map (Resume_api.Resume_request.fact_prefix request) ~f:(fun p ->
                "prefix", Json.string p)))
    in
    let keys =
      unwrap
        (Facts.query
           state.facts
           ~workspace_revision:state.revision
           ~method_:"fact.keys"
           ~params:keys_params)
    in
    add
      "fact_keys"
      (item
         ~kind:"fact_keys"
         ~summary:"Ticket fact key discovery"
         ~sources:
           (ticket_source
            :: (Facts.current_versions
                  state.facts
                  ~scope:(Facts.Scope.Ticket id)
                  ?prefix:(Resume_api.Resume_request.fact_prefix request)
                  ()
                |> fun versions ->
                List.take versions 16
                |> List.map ~f:(fun change ->
                  Resume_source.Fact
                    { scope = Facts.Change.scope change
                    ; key = Facts.Change.key change
                    ; revision = Facts.Change.revision change
                    ; changed_at_revision = Facts.Change.sequence change
                    })))
         ~record:(Json.field keys "data"));
    let all_changes = Activity_digest.rows scan in
    let selected_changes =
      List.take all_changes (Resume_api.Resume_request.change_limit request)
    in
    let sections =
      List.map !optional ~f:fst |> List.dedup_and_sort ~compare:String.compare
    in
    let include_markdown = Resume_api.Resume_request.include_markdown request in
    let data items changes =
      let cursor, has_more =
        Activity_digest.cursor_after scan ~count:(List.length changes)
      in
      let counts =
        List.map sections ~f:(fun section ->
          Resume_record.count
            ~section
            ~total:(List.count !optional ~f:(fun (s, _) -> String.equal section s))
            ~returned:(List.count items ~f:(fun (s, _) -> String.equal section s)))
      in
      let omitted =
        List.filter counts ~f:(fun count -> Json.integer (Json.field count "omitted") > 0)
      in
      let omitted_warnings =
        List.map omitted ~f:(fun count ->
          warning
            "section_omitted"
            (Printf.sprintf
               "%s: %d complete records omitted by budget"
               (Json.field count "section" |> Json.text)
               (Json.field count "omitted" |> Json.integer))
            [ ticket_source ])
      in
      let fitted_items =
        [ task (); readiness () ]
        @ List.map items ~f:(fun (section, item) ->
          match section, handoff with
          | "handoff", Some h ->
            Resume_record.create
              ~kind:"handoff"
              ~summary:"Latest recorded handoff"
              ~sources:
                (Json.list (Json.field item "sources")
                 |> List.map ~f:(W.decode_exn Resume_source.codec))
              ~record:(handoff_view_json h)
              ~max_field_bytes:!prose_limit
          | _ -> item)
      in
      let warnings = List.rev !warnings @ omitted_warnings in
      let counts =
        counts
        @ [ Resume_record.count
              ~section:"changes"
              ~total:(List.length all_changes)
              ~returned:(List.length changes)
          ; Resume_record.count
              ~section:"readiness_reasons"
              ~total:(List.length reasons)
              ~returned:(List.length !shown_reasons)
          ]
      in
      let markdown =
        if include_markdown
        then (
          let current_handoff_shown =
            List.Assoc.mem items "handoff" ~equal:String.equal
          in
          let rendered_changes =
            List.filter_map changes ~f:(fun row ->
              let item = Json.field row "item" in
              let duplicate =
                current_handoff_shown
                && String.equal (Json.text (Json.field item "kind")) "handoff"
                && Option.value_map handoff ~default:false ~f:(fun h ->
                  Json.integer (Json.field (Json.field item "record") "revision")
                  = h.Handoff.revision)
              in
              if duplicate then None else Some item)
          in
          Resume_record.markdown (fitted_items @ rendered_changes)
          ^ "\n\nObserved UTC Unix milliseconds: "
          ^ Json.canonical (Option.value_map now_unix_ms ~default:`Null ~f:Json.int64)
          ^ "\n\n"
          ^ Resume_record.markdown_context
              ~capture:(Activity_digest.capture scan)
              ~warnings
              ~counts
              ~cursor
              ~has_more)
        else ""
      in
      ( Json.obj
          ([ "ticket_id", Id.Ticket.jsonaf_of_t id
           ; "capture", Activity_digest.capture scan
           ; "observed_unix_ms", Option.value_map now_unix_ms ~default:`Null ~f:Json.int64
           ; "items", `Array fitted_items
           ; "changes", `Array changes
           ; "warnings", `Array warnings
           ; "counts", `Array counts
           ; "cursor", Json.string cursor
           ; "has_more", boolean has_more
           ]
           @ if include_markdown then [ "markdown", Json.string markdown ] else [])
      , markdown )
    in
    let fits items changes =
      let data, _ = data items changes in
      Api_response.encoded_size
        Planning_read
        (Resume_record.envelope ~revision:state.revision data)
      <= Resume_api.Resume_request.max_bytes request
    in
    if not (fits [] []) then shown_reasons := [];
    if not (fits [] [])
    then
      Json.fail
        Invalid_argument
        "Current task/ownership/readiness and source metadata cannot fit; increase \
         max_bytes";
    let fitted =
      List.fold !optional ~init:[] ~f:(fun acc candidate ->
        if List.length acc < 298 && fits (acc @ [ candidate ]) []
        then acc @ [ candidate ]
        else acc)
    in
    let rec prefix acc = function
      | [] -> acc
      | x :: xs -> if fits fitted (acc @ [ x ]) then prefix (acc @ [ x ]) xs else acc
    in
    let changes = prefix [] selected_changes in
    (* Keep all selected records and audit rows. Spend only their remaining
       envelope headroom on exact source prose, including its Markdown copy. *)
    prose_limit := 65536;
    if not (fits fitted changes)
    then (
      let rec largest low high =
        if low >= high
        then low
        else (
          let mid = low + ((high - low + 1) / 2) in
          prose_limit := mid;
          if fits fitted changes then largest mid high else largest low (mid - 1))
      in
      prose_limit := largest 256 65535);
    let data, markdown = data fitted changes in
    let data =
      W.decode_exn
        (Option.value_exn (Resume_api.response_codec ~method_:"ticket.resume"))
        data
    in
    { result = Resume_record.envelope ~revision:state.revision data; markdown })
;;

let result t = t.result
let to_json t = t.result
let markdown t = t.markdown
