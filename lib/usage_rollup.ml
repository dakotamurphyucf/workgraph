open Core

module Ticket = struct
  type t =
    { id : Id.Ticket.t
    ; project : Id.Project.t option
    ; milestone : Id.Milestone.t option
    }
end

module R = Usage_rollup_api.Request

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let boolean x = if x then `True else `False

let summary reports =
  let t = Workspace_metrics.Usage.of_records reports in
  Json.obj
    [ "observations", Json.int t.observations
    ; "tokens", Json.int64 t.tokens
    ; "elapsed_ms", Json.int64 t.elapsed_ms
    ; "overflow", boolean t.overflow
    ; "metric_series", Json.int t.metric_series
    ; "metric_overflow", boolean t.metric_overflow
    ]
;;

let read ~workspace ~revision ~activity ~reports ~runs ~tickets ~params =
  Json.decode (fun () ->
    let request = Api_codec.decode R.codec params |> unwrap in
    Option.iter (R.at_revision request) ~f:(fun expected ->
      if expected <> revision then Json.fail Conflict "usage capture changed");
    let reports = Usage_record.deduplicate reports |> unwrap in
    let binding report =
      match report.Usage_record.scope with
      | Run run -> run, None, None
      | Attempt id ->
        let attempt =
          match Agent_run.get_attempt runs id with
          | Some x -> x
          | None -> Json.fail Corrupt_store "usage attempt missing"
        in
        let ticket =
          List.find tickets ~f:(fun t -> Id.Ticket.equal t.Ticket.id attempt.ticket)
        in
        if Option.is_none ticket then Json.fail Corrupt_store "usage ticket missing";
        attempt.run, Some id, ticket
    in
    let matches wanted actual equal =
      Option.for_all wanted ~f:(fun want -> Option.exists actual ~f:(equal want))
    in
    let broad report =
      let run, _, _ = binding report in
      matches (R.run request) (Some run) Id.Run.equal
      && matches (R.actor request) (Some report.Usage_record.actor) Id.Actor.equal
    in
    let selected_reports =
      List.filter reports ~f:(fun report ->
        let _, attempt, ticket = binding report in
        broad report
        && matches (R.attempt request) attempt Attempt.Id.equal
        && matches
             (R.ticket request)
             (Option.map ticket ~f:(fun t -> t.Ticket.id))
             Id.Ticket.equal
        && matches
             (R.project request)
             (Option.bind ticket ~f:(fun t -> t.Ticket.project))
             Id.Project.equal
        && matches
             (R.milestone request)
             (Option.bind ticket ~f:(fun t -> t.Ticket.milestone))
             Id.Milestone.equal)
    in
    let unassigned =
      List.filter reports ~f:(fun r ->
        broad r
        &&
        match r.Usage_record.scope with
        | Run _ -> true
        | Attempt _ -> false)
    in
    let unassigned_in_totals =
      Option.is_none (R.project request)
      && Option.is_none (R.milestone request)
      && Option.is_none (R.ticket request)
      && Option.is_none (R.attempt request)
    in
    let group = R.group request in
    let group_key report =
      let run, attempt, ticket = binding report in
      let key kind field value = Json.obj [ "kind", Json.string kind; field, value ] in
      let unassigned reason = key "unassigned" "reason" (Json.string reason) in
      match group with
      | Workspace -> Json.obj [ "kind", Json.string "workspace" ]
      | Run -> key "run" "run_id" (Id.Run.jsonaf_of_t run)
      | Attempt ->
        Option.value_map
          attempt
          ~default:(unassigned "run_scope_has_no_attempt")
          ~f:(fun id -> key "attempt" "attempt_id" (Attempt.Id.jsonaf_of_t id))
      | Ticket ->
        Option.value_map
          ticket
          ~default:(unassigned "run_scope_has_no_attempt")
          ~f:(fun t -> key "ticket" "ticket_id" (Id.Ticket.jsonaf_of_t t.Ticket.id))
      | Project | Milestone ->
        (match ticket with
         | None -> unassigned "run_scope_has_no_attempt"
         | Some t ->
           (match group with
            | Project ->
              Option.value_map
                t.project
                ~default:(unassigned "ticket_has_no_project")
                ~f:(fun id -> key "project" "project_id" (Id.Project.jsonaf_of_t id))
            | Milestone ->
              Option.value_map
                t.milestone
                ~default:(unassigned "ticket_has_no_milestone")
                ~f:(fun id ->
                  key "milestone" "milestone_id" (Id.Milestone.jsonaf_of_t id))
            | _ -> assert false))
    in
    let groups =
      List.fold selected_reports ~init:String.Map.empty ~f:(fun map report ->
        let key = group_key report |> Json.canonical in
        Map.add_multi map ~key ~data:report)
    in
    let rows =
      Map.to_alist groups
      |> List.concat_map ~f:(fun (key, reports) ->
        let key = Json.parse key |> unwrap in
        Json.obj [ "kind", Json.string "usage"; "group", key; "totals", summary reports ]
        :: List.map
             (Usage_record.metric_totals reports |> unwrap)
             ~f:(fun metric ->
               Json.obj
                 [ "kind", Json.string "metric"
                 ; "group", key
                 ; ( "metric"
                   , Api_codec.encode Usage_record.Metric_total.codec metric |> unwrap )
                 ]))
    in
    let filter =
      match params with
      | `Object fields ->
        Json.obj
          (List.filter fields ~f:(fun (k, _) ->
             not
               (List.mem
                  [ "cursor"; "at_revision"; "limit"; "max_bytes" ]
                  k
                  ~equal:String.equal)))
      | _ -> assert false
    in
    let filter_hash = Json.hash (Json.canonical filter) in
    let anchor =
      Planning_lineage.of_activity activity ~through:revision
      |> unwrap
      |> Planning_lineage.digest
    in
    let encode offset =
      let payload =
        Json.obj
          [ "workspace", Id.Workspace.jsonaf_of_t workspace
          ; "revision", Json.int revision
          ; "filter", Json.string filter_hash
          ; "anchor", Json.string anchor
          ; "offset", Json.int offset
          ]
      in
      Json.obj
        [ "payload", payload
        ; "checksum", Json.string (Json.hash (Json.canonical payload))
        ]
      |> Json.canonical
      |> Base64.encode_string
    in
    let offset =
      Option.value_map (R.cursor request) ~default:0 ~f:(fun encoded ->
        let bytes =
          match Base64.decode encoded with
          | Ok s when String.equal encoded (Base64.encode_string s) -> s
          | _ -> Json.fail Invalid_argument "invalid usage cursor"
        in
        let envelope = Json.parse bytes |> unwrap in
        Json.fields envelope ~allowed:[ "payload"; "checksum" ];
        let p = Json.field envelope "payload" in
        Json.fields p ~allowed:[ "workspace"; "revision"; "filter"; "anchor"; "offset" ];
        if
          not
            (String.equal
               (Json.field envelope "checksum" |> Json.text)
               (Json.hash (Json.canonical p)))
        then Json.fail Invalid_argument "usage cursor integrity check failed";
        if
          (not
             (Id.Workspace.equal
                workspace
                (Json.field p "workspace" |> Id.Workspace.t_of_jsonaf)))
          || Json.field p "revision" |> Json.integer <> revision
        then Json.fail Conflict "usage cursor capture changed";
        if
          (not (String.equal (Json.field p "filter" |> Json.text) filter_hash))
          || not (String.equal (Json.field p "anchor" |> Json.text) anchor)
        then Json.fail Conflict "usage cursor scope or lineage changed";
        Json.field p "offset" |> Json.integer)
    in
    if offset > List.length rows
    then Json.fail Conflict "usage cursor position unavailable";
    let remaining = List.drop rows offset in
    let max_bytes = R.max_bytes request
    and limit = R.limit request in
    let totals = summary selected_reports
    and unassigned_totals = summary unassigned in
    let envelope selected ~required_bytes =
      let count = List.length selected in
      let has_more = count < List.length remaining in
      let data =
        Json.obj
          [ "basis", Json.string "externally_reported"
          ; "membership_basis", Json.string "current_capture"
          ; "group_by", Api_codec.encode Usage_rollup_api.Group.codec group |> unwrap
          ; "totals", totals
          ; "unassigned_run_usage", unassigned_totals
          ; "unassigned_in_totals", boolean unassigned_in_totals
          ; "unassigned_scope", Json.string "run_and_actor_filters"
          ; "items", `Array selected
          ; ("cursor", if has_more then Json.string (encode (offset + count)) else `Null)
          ; "has_more", boolean has_more
          ; "needs_larger_budget", boolean (count = 0 && has_more)
          ; "required_bytes", Option.value_map required_bytes ~default:`Null ~f:Json.int
          ]
      in
      ignore (Api_codec.decode Usage_rollup_api.response_codec data |> unwrap : Jsonaf.t);
      Json.obj [ "workspace_revision", Json.int revision; "data", data ]
      |> Query_budget.annotate_whole_items_exn
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items:(Int.min limit (List.length remaining) - count)
    in
    let required =
      Option.map (List.hd remaining) ~f:(fun row ->
        envelope [ row ] ~required_bytes:None |> Api_response.encoded_size Planning_read)
    in
    let rec fit n =
      let result =
        envelope
          (List.take remaining n)
          ~required_bytes:(if n = 0 then required else None)
      in
      if Api_response.encoded_size Planning_read result <= max_bytes
      then result
      else if n > 0
      then fit (n - 1)
      else Json.fail Invalid_argument "usage metadata exceeds byte budget"
    in
    fit (Int.min limit (List.length remaining)))
;;
