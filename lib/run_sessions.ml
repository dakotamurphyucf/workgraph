open Core
module R = Run_sessions_api.Request

type t =
  { workspace : Id.Workspace.t
  ; head : string option
  ; sequence : int
  ; by_run : Session_id.t list Id.Run.Map.t
  }

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let create capture =
  { workspace = Session_store.Capture.workspace capture
  ; head = Session_store.Capture.head capture
  ; sequence = Session_store.Capture.sequence capture
  ; by_run =
      List.fold
        (Session_store.Capture.sessions capture)
        ~init:Id.Run.Map.empty
        ~f:(fun by_run session ->
          match Session.run session with
          | None -> by_run
          | Some run -> Map.add_multi by_run ~key:run ~data:(Session.id session))
  }
;;

let history_head t = t.head

let capture_json t =
  (* This view reads session metadata, not event bodies. There are no event
     watermarks in this bounded capture header; omission is explicit. *)
  Json.obj
    [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
    ; "head", Option.value_map t.head ~default:`Null ~f:Json.string
    ; "sequence", Json.int t.sequence
    ]
;;

let with_capture t = function
  | `Object fields -> Json.obj (fields @ [ "capture", capture_json t ])
  | _ -> assert false
;;

let associations t (run : Agent_run_event.Record.t) =
  Set.to_list
    (Session_id.Set.of_list
       (run.sessions @ Option.value (Map.find t.by_run run.id) ~default:[]))
;;

let next_request t (run : Agent_run_event.Record.t) ~after ~limit ~max_bytes =
  Json.obj
    [ "method", Json.string "run.sessions"
    ; ( "params"
      , Json.obj
          [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
          ; "target_run_id", Id.Run.jsonaf_of_t run.id
          ; "head", Option.value_map t.head ~default:`Null ~f:Json.string
          ; "expected_run_revision", Json.int run.revision
          ; "after_session_id", Session_id.jsonaf_of_t after
          ; "limit", Json.int limit
          ; "max_bytes", Json.int max_bytes
          ] )
    ]
  |> Api_codec.decode Run_sessions_api.next_request_codec
  |> unwrap
;;

let project t (run : Agent_run_event.Record.t) =
  Json.decode (fun () ->
    Agent_run_event.Record.validate run;
    let all = associations t run in
    let sessions = List.take all 100 in
    let omitted = List.length all - List.length sessions in
    let next =
      if omitted = 0
      then `Null
      else next_request t run ~after:(List.last_exn sessions) ~limit:100 ~max_bytes:65536
    in
    let association =
      Json.obj
        [ "basis", Json.string "explicit_and_history_run"
        ; "history_head", Option.value_map t.head ~default:`Null ~f:Json.string
        ; "explicit_session_ids", `Array (List.map run.sessions ~f:Session_id.jsonaf_of_t)
        ; "total", Json.int (List.length all)
        ; "omitted", Json.int omitted
        ; "next_request", next
        ]
    in
    let fields =
      match Api_codec.encode Agent_run_wire.run { run with sessions } |> unwrap with
      | `Object fields -> fields
      | _ -> assert false
    in
    Api_codec.decode
      Run_sessions_api.run_view_codec
      (Json.obj (fields @ [ "session_associations", association ]))
    |> unwrap)
;;

let validate_head t params =
  match Json.optional params "head" with
  | None -> ()
  | Some json ->
    let expected =
      Api_codec.decode (Api_codec.nullable Run_sessions_api.head_codec) json |> unwrap
    in
    if not (Option.equal String.equal expected t.head)
    then Json.fail Conflict "run session history capture changed"
;;

let read t ~run ~workspace_revision ~params =
  Json.decode (fun () ->
    let request = Api_codec.decode R.codec params |> unwrap in
    Agent_run_event.Record.validate run;
    if not (Id.Run.equal run.id (R.run request))
    then Json.fail Invalid_argument "run session query run mismatch";
    validate_head t params;
    Option.iter (R.expected_run_revision request) ~f:(fun expected ->
      if expected <> run.revision then Json.fail Conflict "run session links changed");
    let all = associations t run in
    let remaining =
      match R.after request with
      | None -> all
      | Some after ->
        (match
           List.split_while all ~f:(fun id -> Session_id.compare id after < 0) |> snd
         with
         | id :: rest when Session_id.equal id after -> rest
         | [] | _ :: _ ->
           Json.fail Invalid_argument "after_session_id is not associated with this run")
    in
    let limit = R.limit request in
    let max_bytes = R.max_bytes request in
    let selected = List.take remaining limit in
    let envelope sessions =
      let omitted = List.length remaining - List.length sessions in
      let has_more = omitted > 0 in
      let next =
        if has_more
        then Some (next_request t run ~after:(List.last_exn sessions) ~limit ~max_bytes)
        else None
      in
      let data =
        Json.obj
          [ "run_id", Id.Run.jsonaf_of_t run.id
          ; "run_revision", Json.int run.revision
          ; "history_head", Option.value_map t.head ~default:`Null ~f:Json.string
          ; "session_ids", `Array (List.map sessions ~f:Session_id.jsonaf_of_t)
          ; "total", Json.int (List.length all)
          ; "remaining", Json.int omitted
          ; ( "next_after_session_id"
            , if has_more then Session_id.jsonaf_of_t (List.last_exn sessions) else `Null
            )
          ; "next_request", Option.value next ~default:`Null
          ; ("has_more", if has_more then `True else `False)
          ]
        |> Api_codec.decode Run_sessions_api.response_codec
        |> unwrap
      in
      with_capture
        t
        (Json.obj [ "workspace_revision", Json.int workspace_revision; "data", data ])
      |> Query_budget.annotate_whole_items_exn
           ~items_path:"/data/session_ids"
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items:(List.length selected - List.length sessions)
    in
    let rec fit sessions =
      let result = envelope sessions in
      if Api_response.encoded_size Planning_read result <= max_bytes
      then result
      else (
        match List.drop_last sessions with
        | Some (_ :: _ as shorter) -> fit shorter
        | Some [] | None ->
          Json.fail Invalid_argument "run session metadata cannot fit; increase max_bytes")
    in
    fit selected)
;;

let query t ~runs ~method_ ~params =
  Json.decode (fun () ->
    let query = Agent_run_api.Query.decode ~method_ ~params |> unwrap in
    validate_head t params;
    match query with
    | Agent_run_api.Query.Run_get { id; max_bytes } ->
      let run =
        match Agent_run.get_run runs id with
        | Some run -> run
        | None -> Json.fail Not_found "run not found"
      in
      let result = project t run |> unwrap |> with_capture t in
      if Api_response.encoded_size (Domain_record Runs) result > max_bytes
      then
        Json.fail
          Invalid_argument
          "complete associated run record cannot fit; increase max_bytes";
      result
    | Runs { limit; max_bytes; offset; expected_revision } ->
      Option.iter expected_revision ~f:(fun expected ->
        if expected <> Agent_run.revision runs
        then Json.fail Conflict "run collection changed");
      if offset > 0 && Option.is_none (Json.optional params "head")
      then Json.fail Invalid_argument "run list continuation requires head";
      let all = Agent_run.runs runs in
      let selected =
        List.take (List.drop all offset) limit
        |> List.map ~f:(fun run -> project t run |> unwrap)
      in
      let envelope items =
        with_capture
          t
          (Json.obj
             [ "revision", Json.int (Agent_run.revision runs)
             ; "items", `Array items
             ; ( "next_offset"
               , if offset + List.length items < List.length all
                 then Json.int (offset + List.length items)
                 else `Null )
             ; ( "omitted"
               , Json.int (Int.max 0 (List.length all - offset - List.length items)) )
             ])
      in
      let rec fit items =
        let result = envelope items in
        if Api_response.encoded_size (Domain_query Runs) result <= max_bytes
        then result
        else (
          match List.drop_last items with
          | Some (_ :: _ as shorter) -> fit shorter
          | Some [] | None ->
            Json.fail
              Invalid_argument
              "one complete associated run record cannot fit; increase max_bytes")
      in
      fit selected
    | Attempt_get _
    | Reservation_get _
    | Pools _
    | Ticket_policies _
    | Attempts _
    | Reservations _
    | Actions _ -> Json.fail Invalid_argument "not a run association read")
;;
