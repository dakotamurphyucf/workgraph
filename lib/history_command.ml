open Core

type t =
  | Create of Session.t
  | Archive of Session_id.t
  | Append of
      { session : Session_id.t
      ; inputs : Session_event.Input.t list
      }

let mutation_methods = History_api.mutation_methods
let query_methods = History_api.query_methods

let decode ~workspace ~actor ?run ?now_unix_ms ~method_ ~params () =
  let open Result.Let_syntax in
  let%bind () =
    if Option.exists now_unix_ms ~f:(fun value -> Int64.(value < 0L))
    then
      Error
        (Problem.create
           Invalid_argument
           "server observation must be nonnegative Unix milliseconds")
    else Ok ()
  in
  let%bind command = History_api.Command.decode ~method_ ~params in
  match command with
  | History_api.Command.Create { id; title; parent; scopes } ->
    Result.map
      (Session.create
         ~workspace
         ~id
         ~title
         ~actor
         ?run
         ?parent
         ?created_at_unix_ms:now_unix_ms
         ~scopes
         ())
      ~f:(fun session -> Create session)
  | Archive id -> Ok (Archive id)
  | Append { session; inputs } -> Ok (Append { session; inputs })
;;

let session_scopes = function
  | Create metadata -> Session.scopes metadata
  | Archive _ | Append _ -> []
;;

let resource_versions = function
  | Create _ | Archive _ -> []
  | Append { inputs; _ } ->
    List.concat_map inputs ~f:Session_event.Input.resource_versions
;;

let execute store command ~actor ?run ?now_unix_ms ~key ~request_hash () =
  let method_, result =
    match command with
    | Create metadata ->
      "session.create", Session_store.create store metadata ~key ~request_hash
    | Archive session ->
      "session.archive", Session_store.archive store ~session ~key ~request_hash
    | Append { session; inputs } ->
      ( "session.append"
      , Session_store.append
          store
          ~session
          ~actor
          ?run
          ?now_unix_ms
          ~inputs
          ~key
          ~request_hash
          () )
  in
  Result.map result ~f:(History_api.mutation_result ~method_)
;;

(* Keep selection and byte/cursor rendering identical for single and batch reads.
   Fit against the complete response before reading, retaining at most its byte budget. *)
let payload_blob capture event_ref part =
  let event = Session_store.Capture.event capture event_ref |> Disk.unwrap in
  match part with
  | History_api.Query.Part.Payload -> Session_event.payload event
  | Searchable_text ->
    (match Session_event.searchable_text event with
     | None -> Json.fail Not_found "event has no searchable text"
     | Some ref_ -> ref_)
  | Attachment attachment ->
    (match List.nth (Session_event.attachments event) attachment with
     | None -> Json.fail Not_found "attachment not found"
     | Some ref_ -> ref_)
;;

let payload_data (blob : Session_event.Blob_ref.t) ~offset ~length ~bytes_base64 =
  Json.obj
    [ "blob", Api_codec.encode History_wire.blob_ref blob |> Disk.unwrap
    ; "offset", Json.int offset
    ; "bytes_base64", Json.string bytes_base64
    ; "next_offset", Json.int (offset + length)
    ; "total_bytes", Json.int blob.size_bytes
    ; ("has_more", if offset + length < blob.size_bytes then `True else `False)
    ]
;;

let fit_payload blob ~offset ~requested ~max_bytes ~render =
  if offset < 0 || offset > blob.Session_event.Blob_ref.size_bytes
  then Json.fail Invalid_argument "history payload offset outside blob";
  let trial length =
    payload_data
      blob
      ~offset
      ~length
      ~bytes_base64:(String.make ((length + 2) / 3 * 4) 'A')
    |> render
    |> Api_response.encoded_size History
  in
  if trial 0 > max_bytes
  then Json.fail Blocked "history payload metadata exceeds byte budget";
  let rec fit low high =
    if low >= high
    then low
    else (
      let middle = low + ((high - low + 1) / 2) in
      if trial middle <= max_bytes then fit middle high else fit low (middle - 1))
  in
  fit 0 (Int.min requested (blob.size_bytes - offset))
;;

let read_payload capture ~fs ~root blob ~offset ~length =
  let bytes, _ =
    Session_store.read_capture_blob capture ~fs ~root blob ~offset ~length |> Disk.unwrap
  in
  payload_data
    blob
    ~offset
    ~length:(String.length bytes)
    ~bytes_base64:(Base64.encode_string bytes)
;;

let query capture ~fs ~root ~index ~method_ ~params =
  let open Result.Let_syntax in
  let%bind request = History_api.Query.decode ~method_ ~params in
  Json.decode (fun () ->
    let max_bytes = request.max_bytes in
    let result =
      match request.query with
      | History_api.Query.Session_get id ->
        let metadata =
          List.find (Session_store.Capture.sessions capture) ~f:(fun metadata ->
            Session_id.equal (Session.id metadata) id)
        in
        (match metadata with
         | None -> Json.fail Not_found "session not found"
         | Some metadata ->
           Json.obj
             [ "session", History_wire.session_json metadata
             ; "through", Json.int (Session_store.Capture.upper_bound capture ~session:id)
             ; "capture", Session_store.Capture.to_json capture
             ])
      | Session_list { offset; limit; include_archived; order; run } ->
        let candidates =
          Session_store.Capture.sessions capture
          |> List.filter ~f:(fun metadata ->
            (include_archived || not (Session.archived metadata))
            && Option.value_map run ~default:true ~f:(fun expected ->
              Option.equal Id.Run.equal (Session.run metadata) (Some expected)))
          |> List.sort ~compare:(Session.compare_for_order ~order)
        in
        let selected =
          List.drop candidates offset |> fun candidates -> List.take candidates limit
        in
        let render items =
          Json.obj
            [ "capture", Session_store.Capture.to_json capture
            ; "items", `Array items
            ; "next_offset", Json.int (offset + List.length items)
            ; ( "has_more"
              , if offset + List.length items < List.length candidates
                then `True
                else `False )
            ]
        in
        let rec fit acc = function
          | [] -> render (List.rev acc)
          | metadata :: rest ->
            let item = History_wire.session_json metadata in
            if
              Api_response.encoded_size History (render (List.rev (item :: acc)))
              > max_bytes
            then
              if List.is_empty acc
              then Json.fail Blocked "session list item exceeds budget"
              else render (List.rev acc)
            else fit (item :: acc) rest
        in
        fit [] selected
      | Get ref_ ->
        (match History_query.get capture ref_ |> Disk.unwrap with
         | `Object fields ->
           Json.obj (("capture", Session_store.Capture.to_json capture) :: fields)
         | _ -> failwith "history event receipt must be an object")
      | Read { session; anchor; direction; limit } ->
        History_query.read capture ~session ~anchor ~direction ~limit ~max_bytes
        |> Disk.unwrap
      | Search { text; session; kinds; after; limit } ->
        History_index.search
          index
          capture
          ~text
          ?session
          ?kinds
          ?after
          ~limit
          ~max_bytes
          ()
        |> Disk.unwrap
      | Payloads { events; length = requested } ->
        let blobs =
          List.map events ~f:(fun event_ref ->
            event_ref, payload_blob capture event_ref History_api.Query.Part.Payload)
          |> Array.of_list
        in
        let item event_ref payload =
          Json.obj
            [ ( "event_ref"
              , Api_codec.encode History_wire.event_ref event_ref |> Disk.unwrap )
            ; "payload", payload
            ]
        in
        let items =
          Array.map blobs ~f:(fun (event_ref, blob) ->
            item event_ref (payload_data blob ~offset:0 ~length:0 ~bytes_base64:""))
        in
        let render () =
          Json.obj
            [ "capture", Session_store.Capture.to_json capture
            ; "items", `Array (Array.to_list items)
            ]
        in
        if Api_response.encoded_size History (render ()) > max_bytes
        then Json.fail Blocked "history payload batch metadata exceeds byte budget";
        Array.iteri blobs ~f:(fun index (event_ref, blob) ->
          let length =
            fit_payload blob ~offset:0 ~requested ~max_bytes ~render:(fun payload ->
              items.(index) <- item event_ref payload;
              render ())
          in
          items.(index)
          <- item event_ref (read_payload capture ~fs ~root blob ~offset:0 ~length));
        render ()
      | Payload { event = event_ref; part; offset; length = requested } ->
        let blob = payload_blob capture event_ref part in
        let render payload =
          match payload with
          | `Object fields ->
            Json.obj (("capture", Session_store.Capture.to_json capture) :: fields)
          | _ -> failwith "payload result must be an object"
        in
        let length = fit_payload blob ~offset ~requested ~max_bytes ~render in
        if length = 0 && requested > 0 && offset < blob.size_bytes
        then Json.fail Blocked "history payload budget cannot fit one byte";
        read_payload capture ~fs ~root blob ~offset ~length |> render
    in
    if Api_response.encoded_size History result > max_bytes
    then Json.fail Blocked "history response exceeds byte budget";
    History_api.validate_result ~method_ result;
    result)
;;
