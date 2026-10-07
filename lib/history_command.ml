open Core

type t =
  | Create of Session.t
  | Archive of Session_id.t
  | Append of
      { session : Session_id.t
      ; inputs : Session_event.Input.t list
      }

let mutation_methods = [ "session.create"; "session.archive"; "session.append" ]

let query_methods =
  [ "session.get"
  ; "session.list"
  ; "history.get"
  ; "history.read"
  ; "history.search"
  ; "history.payload"
  ]
;;

let field_id params = Session_id.t_of_jsonaf (Json.field params "session_id")
let optional params key f = Option.map (Json.optional params key) ~f

let default_int params key default =
  Option.value (optional params key Json.integer) ~default
;;

let decode ~workspace ~actor ?run ~method_ ~params () =
  Json.decode (fun () ->
    match method_ with
    | "session.create" ->
      Json.fields params ~allowed:[ "session_id"; "title"; "parent"; "scopes" ];
      let parent =
        optional params "parent" (fun json ->
          Session.Event_ref.of_json json |> Disk.unwrap)
      in
      let scopes =
        Option.value_map (Json.optional params "scopes") ~default:[] ~f:(fun json ->
          List.map (Json.list json) ~f:Entity_ref.t_of_jsonaf)
      in
      Create
        (Session.create
           ~workspace
           ~id:(field_id params)
           ~title:(Json.text (Json.field params "title"))
           ~actor
           ?run
           ?parent
           ~scopes
           ()
         |> Disk.unwrap)
    | "session.archive" ->
      Json.fields params ~allowed:[ "session_id" ];
      Archive (field_id params)
    | "session.append" ->
      Json.fields params ~allowed:[ "session_id"; "events" ];
      Append
        { session = field_id params
        ; inputs =
            Json.list (Json.field params "events")
            |> List.map ~f:(fun json -> Session_event.Input.of_json json |> Disk.unwrap)
        }
    | _ -> Json.fail Invalid_argument "unknown history mutation")
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

let execute store command ~actor ?run ~key ~request_hash () =
  match command with
  | Create metadata -> Session_store.create store metadata ~key ~request_hash
  | Archive session -> Session_store.archive store ~session ~key ~request_hash
  | Append { session; inputs } ->
    Session_store.append store ~session ~actor ?run ~inputs ~key ~request_hash ()
;;

let query capture ~fs ~root ~index ~method_ ~params =
  Json.decode (fun () ->
    let max_bytes = default_int params "max_bytes" 65_536 in
    if max_bytes < 4096 || max_bytes > 1024 * 1024
    then Json.fail Invalid_argument "history budget requires 4KiB..1MiB";
    let result =
      match method_ with
      | "session.get" ->
        Json.fields params ~allowed:[ "session_id"; "head"; "max_bytes" ];
        let id = field_id params in
        let metadata =
          List.find (Session_store.Capture.sessions capture) ~f:(fun metadata ->
            Session_id.equal (Session.id metadata) id)
        in
        (match metadata with
         | None -> Json.fail Not_found "session not found"
         | Some metadata ->
           Json.obj
             [ "session", Session.to_json metadata
             ; "through", Json.int (Session_store.Capture.upper_bound capture ~session:id)
             ; "capture", Session_store.Capture.to_json capture
             ])
      | "session.list" ->
        Json.fields
          params
          ~allowed:[ "head"; "max_bytes"; "offset"; "limit"; "include_archived" ];
        let offset = default_int params "offset" 0 in
        let limit = default_int params "limit" 50 in
        if offset < 0 || limit < 1 || limit > 100
        then Json.fail Invalid_argument "invalid session list pagination";
        let include_archived =
          match Json.optional params "include_archived" with
          | None | Some `False -> false
          | Some `True -> true
          | Some _ -> Json.fail Invalid_argument "include_archived requires boolean"
        in
        let candidates =
          Session_store.Capture.sessions capture
          |> List.filter ~f:(fun metadata ->
            include_archived || not (Session.archived metadata))
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
            let item = Session.to_json metadata in
            if
              String.length (Json.canonical (render (List.rev (item :: acc)))) > max_bytes
            then
              if List.is_empty acc
              then Json.fail Blocked "session list item exceeds budget"
              else render (List.rev acc)
            else fit (item :: acc) rest
        in
        fit [] selected
      | "history.get" ->
        Json.fields params ~allowed:[ "ref"; "head"; "max_bytes" ];
        History_query.get
          capture
          (Session.Event_ref.of_json (Json.field params "ref") |> Disk.unwrap)
        |> Disk.unwrap
      | "history.read" ->
        Json.fields
          params
          ~allowed:[ "session_id"; "anchor"; "direction"; "limit"; "max_bytes"; "head" ];
        let direction =
          match Json.text (Json.field params "direction") with
          | "before" -> History_query.Before
          | "after" -> After
          | "around" -> Around
          | _ -> Json.fail Invalid_argument "direction requires before/after/around"
        in
        History_query.read
          capture
          ~session:(field_id params)
          ~anchor:(default_int params "anchor" 0)
          ~direction
          ~limit:(default_int params "limit" 50)
          ~max_bytes
        |> Disk.unwrap
      | "history.search" ->
        Json.fields
          params
          ~allowed:
            [ "text"; "session_id"; "kinds"; "after"; "limit"; "max_bytes"; "head" ];
        History_index.search
          index
          capture
          ~text:(Json.text (Json.field params "text"))
          ?session:(optional params "session_id" Session_id.t_of_jsonaf)
          ?kinds:
            (optional params "kinds" (fun json -> List.map (Json.list json) ~f:Json.text))
          ?after:
            (optional params "after" (fun json ->
               Session.Event_ref.of_json json |> Disk.unwrap))
          ~limit:(default_int params "limit" 50)
          ~max_bytes
          ()
        |> Disk.unwrap
      | "history.payload" ->
        Json.fields
          params
          ~allowed:
            [ "ref"; "part"; "attachment"; "offset"; "length"; "head"; "max_bytes" ];
        let event =
          Session_store.Capture.event
            capture
            (Session.Event_ref.of_json (Json.field params "ref") |> Disk.unwrap)
          |> Disk.unwrap
        in
        let ref_ =
          match Option.value (optional params "part" Json.text) ~default:"payload" with
          | "payload" -> Session_event.payload event
          | "searchable_text" ->
            (match Session_event.searchable_text event with
             | None -> Json.fail Not_found "event has no searchable text"
             | Some ref_ -> ref_)
          | "attachment" ->
            (match
               List.nth
                 (Session_event.attachments event)
                 (default_int params "attachment" 0)
             with
             | None -> Json.fail Not_found "attachment not found"
             | Some ref_ -> ref_)
          | _ ->
            Json.fail Invalid_argument "part requires payload/searchable_text/attachment"
        in
        let offset = default_int params "offset" 0 in
        let requested = default_int params "length" 32_768 in
        if requested < 0 || requested > 262_144
        then Json.fail Invalid_argument "payload chunk length requires 0..262144 bytes";
        let length = Int.min requested ((max_bytes - 2048) * 3 / 4) in
        let bytes, total =
          Session_store.read_capture_blob capture ~fs ~root ref_ ~offset ~length
          |> Disk.unwrap
        in
        Json.obj
          [ "blob", Session_event.Blob_ref.to_json ref_
          ; "offset", Json.int offset
          ; "bytes_base64", Json.string (Base64.encode_string bytes)
          ; "next_offset", Json.int (offset + String.length bytes)
          ; "total_bytes", Json.int total
          ; ("has_more", if offset + String.length bytes < total then `True else `False)
          ]
      | _ -> Json.fail Invalid_argument "unknown history query"
    in
    if String.length (Json.canonical result) > max_bytes
    then Json.fail Blocked "history response exceeds byte budget";
    result)
;;
