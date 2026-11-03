open Core

module Limits = struct
  type t =
    { max_pages : int
    ; max_bytes : int
    }

  let create ~max_pages ~max_bytes =
    Json.decode (fun () ->
      if
        max_pages < 1
        || max_pages > 1000
        || max_bytes < 4096
        || max_bytes > 64 * 1024 * 1024
      then
        Json.fail
          Invalid_argument
          "pagination limits: pages 1..1000; total bytes 4096..67108864";
      { max_pages; max_bytes })
  ;;

  let default = { max_pages = 100; max_bytes = 16 * 1024 * 1024 }
end

module Family = struct
  type t =
    | Offset of
        { guard : string
        ; metadata : string
        }
    | Cursor of { result_field : string }
    | Current_cursor of
        { result_field : string
        ; guard : string option
        ; observed_clock : bool
        }
    | Inbox
    | History of
        { position : string
        ; result_field : string
        }

  let of_method (Api_method.Packed.Pack definition) =
    if not (Api_method.Mode.equal (Api_method.mode definition) Read)
    then None
    else (
      let fields codec = Option.value (Api_codec.field_names codec) ~default:[] in
      let inputs = fields (Api_method.request_codec definition) in
      let outputs = fields (Api_method.response_codec definition) in
      let has name = List.mem inputs name ~equal:String.equal in
      let output name = List.mem outputs name ~equal:String.equal in
      match Api_method.name definition with
      | "inbox.read" -> Some Inbox
      | "changes.read" | "activity.digest" | "ticket.resume" ->
        Some (Cursor { result_field = "cursor" })
      | "coordinator.overview" -> Some (Cursor { result_field = "next_cursor" })
      | "usage.aggregate" ->
        Some
          (Current_cursor
             { result_field = "cursor"
             ; guard = Some "at_revision"
             ; observed_clock = false
             })
      | "actor.overview" ->
        Some
          (Current_cursor { result_field = "cursor"; guard = None; observed_clock = true })
      | "session.list" ->
        Some (History { position = "offset"; result_field = "next_offset" })
      | "history.payload" ->
        Some (History { position = "offset"; result_field = "next_offset" })
      | "history.read" ->
        Some (History { position = "anchor"; result_field = "next_anchor" })
      | "history.search" ->
        Some (History { position = "after_event"; result_field = "next" })
      | _ when has "offset" && output "items" && output "next_offset" ->
        if has "at_revision"
        then Some (Offset { guard = "at_revision"; metadata = "workspace_revision" })
        else if has "expected_revision"
        then Some (Offset { guard = "expected_revision"; metadata = "query_revision" })
        else if has "revision"
        then Some (Offset { guard = "revision"; metadata = "query_revision" })
        else if has "at_snapshot"
        then Some (Offset { guard = "at_snapshot"; metadata = "snapshot" })
        else None
      | _ -> None)
  ;;

  let name = function
    | Offset { metadata = "snapshot"; _ } -> "snapshot_guard"
    | Offset _ -> "current_revision_guard"
    | Cursor _ -> "opaque_captured_cursor"
    | Current_cursor _ -> "current_revision_cursor"
    | Inbox -> "notification_through"
    | History _ -> "immutable_history_head"
  ;;
end

type t =
  { request : Protocol.Request.t
  ; family : Family.t
  ; limits : Limits.t
  }

let supported_methods () =
  List.filter_map
    Api_catalog.methods
    ~f:(fun (Api_method.Packed.Pack definition as packed) ->
      Option.map (Family.of_method packed) ~f:(fun _ -> Api_method.name definition))
;;

let validate request =
  match Api_catalog.find (Protocol.Request.method_ request) with
  | None -> Json.fail Not_found "pagination method is not in the executable catalog"
  | Some (Api_method.Packed.Pack definition) ->
    Api_codec.decode
      (Api_method.request_codec definition)
      (Protocol.Request.params request)
    |> Disk.unwrap
    |> ignore
;;

let create request ~limits =
  Json.decode (fun () ->
    let family =
      match
        Option.bind
          (Api_catalog.find (Protocol.Request.method_ request))
          ~f:Family.of_method
      with
      | Some family -> family
      | None ->
        Json.fail
          Invalid_argument
          "automatic pagination supports declared read collections only; use help \
           pagination"
    in
    validate request;
    if
      String.equal (Protocol.Request.method_ request) "history.read"
      && String.equal
           (Json.text (Json.field (Protocol.Request.params request) "direction"))
           "around"
    then
      Json.fail
        Invalid_argument
        "automatic history.read requires direction before or after; around is a bounded \
         single view";
    { request; family; limits })
;;

module Stop = struct
  type t =
    | Complete
    | Page_limit
    | Byte_limit
    | No_progress
    | Needs_larger_budget
    | Indexing_incomplete
    | Server_field_omissions
    | Server_item_omissions
    | Error
  [@@deriving equal, sexp]

  let to_string = function
    | Complete -> "complete"
    | Page_limit -> "page_limit"
    | Byte_limit -> "byte_limit"
    | No_progress -> "no_progress"
    | Needs_larger_budget -> "needs_larger_budget"
    | Indexing_incomplete -> "indexing_incomplete"
    | Server_field_omissions -> "server_field_omissions"
    | Server_item_omissions -> "server_item_omissions"
    | Error -> "error"
  ;;
end

module Collection = struct
  type t =
    { complete : bool
    ; json : Jsonaf.t
    ; bytes : int
    ; stop : Stop.t
    }

  let complete t = t.complete
  let stop t = t.stop
  let to_json t = t.json
end

let equal_json a b = String.equal (Json.canonical a) (Json.canonical b)
let boolean value = if value then `True else `False

let optional_integer data field =
  Option.value_map (Json.optional data field) ~default:0 ~f:Json.integer
;;

let flag data field =
  Option.exists (Json.optional data field) ~f:(function
    | `True -> true
    | _ -> false)
;;

let set request key value =
  let fields =
    match Protocol.Request.params request with
    | `Object fields -> fields
    | _ -> assert false
  in
  Protocol.Request.with_params
    request
    (Json.obj (List.Assoc.add fields ~equal:String.equal key value))
  |> Disk.unwrap
;;

let pin request key value =
  match Json.optional (Protocol.Request.params request) key with
  | None -> set request key value
  | Some existing when equal_json existing value -> request
  | Some _ ->
    Json.fail
      Conflict
      ("pagination capture differs from explicit " ^ key ^ "; guard was retained")
;;

let with_cursor request cursor =
  let fields =
    match Protocol.Request.params request with
    | `Object fields -> List.Assoc.remove fields "after" ~equal:String.equal
    | _ -> assert false
  in
  Protocol.Request.with_params
    request
    (Json.obj (List.Assoc.add fields ~equal:String.equal "cursor" cursor))
  |> Disk.unwrap
;;

let capture family response =
  let data = Api_response.data response
  and meta = Api_response.meta response in
  match family with
  | Family.Offset { metadata; _ } ->
    Json.obj
      ([ metadata, Json.field meta metadata ]
       @ Option.to_list
           (Option.map (Json.optional meta "query_scope") ~f:(fun scope ->
              "query_scope", scope)))
  | Inbox -> Json.obj [ "through", Json.field data "through" ]
  | History _ ->
    Json.obj [ "head", Json.field (Json.field meta "history_capture") "head" ]
  | Current_cursor { observed_clock; _ } ->
    let revision = Json.field meta "workspace_revision" in
    if observed_clock && not (equal_json revision (Json.field data "workspace_revision"))
    then Json.fail Conflict "actor overview page and metadata captures differ";
    Json.obj
      ([ "workspace_revision", revision ]
       @
       if observed_clock
       then [ "observed_unix_ms", Json.field data "observed_unix_ms" ]
       else [])
  | Cursor _ ->
    if Option.is_some (Json.optional data "captured_now_unix_ms")
    then Json.obj [ "captured_now_unix_ms", Json.field data "captured_now_unix_ms" ]
    else if Option.is_some (Json.optional data "capture")
    then (
      let capture = Json.field data "capture" in
      Json.obj
        [ "through", Json.field capture "through"
        ; "lineage", Json.field capture "lineage"
        ])
    else Json.obj [ "through", Json.field data "through" ]
;;

let pin_request family request response =
  let data = Api_response.data response
  and meta = Api_response.meta response in
  match family with
  | Family.Offset { guard; metadata } -> pin request guard (Json.field meta metadata)
  | Inbox ->
    pin request "through" (Json.field data "through")
    |> fun request -> pin request "after" (Json.field data "after")
  | History _ ->
    (match Json.field (Json.field meta "history_capture") "head" with
     | `Null -> request
     | head -> pin request "head" head)
  | Cursor _ | Current_cursor { guard = None; _ } -> request
  | Current_cursor { guard = Some guard; _ } ->
    pin request guard (Json.field meta "workspace_revision")
;;

let next_request family request data =
  let params = Protocol.Request.params request in
  let numeric position field =
    let next = Json.field data field in
    if Json.integer next <= optional_integer params position
    then `Stopped Stop.No_progress
    else `Next (set request position next)
  in
  match family with
  | Family.Offset _ ->
    if flag data "needs_larger_budget"
    then `Stopped Stop.Needs_larger_budget
    else (
      match Json.field data "next_offset" with
      | `Null -> `Done
      | _ -> numeric "offset" "next_offset")
  | Inbox ->
    if optional_integer data "remaining" = 0 then `Done else numeric "after" "next_after"
  | History { position; result_field } ->
    if flag data "restart_after_indexing"
    then `Stopped Stop.Indexing_incomplete
    else if not (flag data "has_more")
    then `Done
    else if String.equal position "after_event"
    then (
      let next = Json.field data result_field in
      match next with
      | `Null -> `Stopped Stop.No_progress
      | next -> `Next (set request position next))
    else if
      String.equal position "anchor"
      && String.equal (Json.text (Json.field params "direction")) "before"
    then (
      let next = Json.field data result_field in
      let previous = optional_integer params "anchor" in
      if Json.integer next >= previous
      then `Stopped Stop.No_progress
      else `Next (set request position next))
    else numeric position result_field
  | Cursor { result_field } | Current_cursor { result_field; _ } ->
    let has_more =
      if String.equal result_field "next_cursor"
      then not (equal_json (Json.field data result_field) `Null)
      else flag data "has_more"
    in
    if not has_more
    then `Done
    else if flag data "needs_larger_budget"
    then `Stopped Stop.Needs_larger_budget
    else (
      match Json.field data result_field with
      | `Null -> `Stopped Stop.No_progress
      | cursor -> `Next (with_cursor request cursor))
;;

let collect t ~fetch =
  Json.decode (fun () ->
    let finish pages ~stop ~next ~retry ~capture ~problem =
      let complete = Stop.equal stop Complete in
      let page_bytes =
        List.sum (module Int) pages ~f:snd + Int.max 0 (List.length pages - 1)
      in
      let rec render bytes =
        let json =
          Json.obj
            [ ( "data"
              , Json.obj
                  [ "pages", `Array []
                  ; ( "pagination"
                    , Json.obj
                        [ "complete", boolean complete
                        ; "stop", Json.string (Stop.to_string stop)
                        ; "page_count", Json.int (List.length pages)
                        ; "returned_bytes", Json.int bytes
                        ; "max_pages", Json.int t.limits.max_pages
                        ; "max_bytes", Json.int t.limits.max_bytes
                        ; "consistency", Json.string (Family.name t.family)
                        ; "capture", Option.value capture ~default:`Null
                        ; ( "next_request"
                          , Option.value_map
                              next
                              ~default:`Null
                              ~f:Protocol.Request.to_json )
                        ; ( "retry_request"
                          , Option.value_map
                              retry
                              ~default:`Null
                              ~f:Protocol.Request.to_json )
                        ; ( "problem"
                          , Option.value_map problem ~default:`Null ~f:Problem.to_json )
                        ] )
                  ] )
            ; "meta", Json.obj []
            ]
        in
        let size = String.length (Json.canonical json) + page_bytes in
        if size = bytes
        then (
          let data = Json.field json "data" in
          let fields =
            match data with
            | `Object fields -> fields
            | _ -> assert false
          in
          let data =
            Json.obj
              (List.Assoc.add
                 fields
                 ~equal:String.equal
                 "pages"
                 (`Array (List.rev_map pages ~f:fst)))
          in
          { Collection.complete
          ; bytes = size
          ; stop
          ; json = Json.obj [ "data", data; "meta", Json.obj [] ]
          })
        else render size
      in
      render 0
    in
    let fits result = result.Collection.bytes <= t.limits.max_bytes in
    let finish_bounded pages ~stop ~next ~retry ~capture ~problem =
      let result = finish pages ~stop ~next ~retry ~capture ~problem in
      if not (fits result)
      then (
        match problem with
        | Some problem -> raise (Json.Decode_error problem)
        | None ->
          Json.fail
            Invalid_argument
            "pagination metadata exceeds total byte bound; increase --total-bytes or \
             narrow the request");
      result
    in
    let initial =
      finish
        []
        ~stop:Stop.Byte_limit
        ~next:(Some t.request)
        ~retry:None
        ~capture:None
        ~problem:None
    in
    if not (fits initial)
    then Json.fail Invalid_argument "pagination request metadata exceeds total byte bound";
    (match t.family with
     | (Cursor _ | Current_cursor _)
       when Option.is_none (Json.optional (Protocol.Request.params t.request) "cursor") ->
       let response_bound =
         Option.value_map
           (Json.optional (Protocol.Request.params t.request) "max_bytes")
           ~default:65536
           ~f:Json.integer
       in
       let minimum = initial.Collection.bytes + response_bound + 4096 in
       if t.limits.max_bytes < minimum
       then
         Json.fail
           Invalid_argument
           (sprintf
              "initial opaque-cursor pagination requires total bytes >=%d to retain its \
               first captured page; increase --total-bytes or reduce --max-bytes"
              minimum)
     | Offset _ | Inbox | History _ | Cursor _ | Current_cursor _ -> ());
    let rec loop request pages capture_id seen =
      match fetch request with
      | Error problem ->
        finish_bounded
          pages
          ~stop:Stop.Error
          ~next:None
          ~retry:(Some request)
          ~capture:capture_id
          ~problem:(Some problem)
      | Ok page ->
        let response = Api_response.of_json page |> Disk.unwrap in
        let retained_page = page, String.length (Json.canonical page) in
        (match Api_catalog.find (Protocol.Request.method_ request) with
         | Some (Api_method.Packed.Pack definition) ->
           Api_codec.decode
             (Api_method.response_codec definition)
             (Api_response.data response)
           |> Disk.unwrap
           |> ignore
         | None -> assert false);
        let observed = capture t.family response in
        Option.iter capture_id ~f:(fun previous ->
          if not (equal_json previous observed)
          then
            Json.fail Conflict "pagination capture changed; traversal was not restarted");
        let capture_id = Some observed in
        let request = pin_request t.family request response in
        let next = next_request t.family request (Api_response.data response) in
        let budget = Json.optional (Api_response.meta response) "budget" in
        let missing_fields =
          Option.exists budget ~f:(fun b -> optional_integer b "omitted_fields" > 0)
        in
        let positioned_items =
          Option.is_some (Json.optional (Api_response.data response) "offset")
          ||
          match t.family with
          | Current_cursor _ ->
            flag (Api_response.data response) "has_more"
            && not (equal_json (Json.field (Api_response.data response) "cursor") `Null)
          | Offset _ | Inbox | History _ | Cursor _ -> false
        in
        let unsafe_item_omissions =
          Option.exists budget ~f:(fun b ->
            optional_integer b "omitted_items" > 0
            && ((not positioned_items)
                || (not (flag b "details_complete"))
                || List.exists
                     (Json.list (Json.field b "details"))
                     ~f:(fun detail ->
                       not
                         (List.mem
                            [ "/items"; "/data/items" ]
                            (Json.text (Json.field detail "path"))
                            ~equal:String.equal))))
        in
        let next =
          if missing_fields
          then `Stopped Stop.Server_field_omissions
          else (
            match next with
            | `Stopped _ -> next
            | `Done | `Next _ ->
              if unsafe_item_omissions then `Stopped Stop.Server_item_omissions else next)
        in
        let candidate =
          match next with
          | `Done ->
            finish
              (retained_page :: pages)
              ~stop:Stop.Complete
              ~next:None
              ~retry:None
              ~capture:capture_id
              ~problem:None
          | `Stopped stop ->
            let retry =
              match t.family with
              | (Cursor { result_field } | Current_cursor { result_field; _ })
                when flag (Api_response.data response) "needs_larger_budget" ->
                (* A terminal input cursor may have opened a new captured range.
                   The response cursor is bound before its unconsumed oversized row. *)
                Some
                  (with_cursor
                     request
                     (Json.field (Api_response.data response) result_field))
              | (Cursor _ | Current_cursor _)
                when Option.is_none
                       (Json.optional (Protocol.Request.params request) "cursor") ->
                (* An initial request cannot recreate the captured position before
                   already-returned rows. Do not advertise a fresh read as exact retry. *)
                None
              | Offset _ | Inbox | History _ | Cursor _ | Current_cursor _ -> Some request
            in
            finish
              (retained_page :: pages)
              ~stop
              ~next:None
              ~retry
              ~capture:capture_id
              ~problem:None
          | `Next next ->
            finish
              (retained_page :: pages)
              ~stop:Stop.Page_limit
              ~next:(Some next)
              ~retry:None
              ~capture:capture_id
              ~problem:None
        in
        if not (fits candidate)
        then (
          match t.family with
          | (Cursor _ | Current_cursor _)
            when List.is_empty pages
                 && Option.is_none
                      (Json.optional (Protocol.Request.params request) "cursor") ->
            Json.fail
              Blocked
              "first opaque captured page cannot fit total byte bound; no uncaptured \
               continuation was produced"
          | Offset _ | Inbox | History _ | Cursor _ | Current_cursor _ ->
            finish_bounded
              pages
              ~stop:Stop.Byte_limit
              ~next:(Some request)
              ~retry:None
              ~capture:capture_id
              ~problem:None)
        else (
          match next with
          | `Done | `Stopped _ -> candidate
          | `Next next ->
            validate next;
            let key = Json.canonical (Protocol.Request.params next) in
            if Set.mem seen key
            then
              finish_bounded
                (retained_page :: pages)
                ~stop:Stop.No_progress
                ~next:None
                ~retry:(Some request)
                ~capture:capture_id
                ~problem:None
            else if List.length pages + 1 >= t.limits.max_pages
            then candidate
            else loop next (retained_page :: pages) capture_id (Set.add seen key))
    in
    loop
      t.request
      []
      None
      (String.Set.singleton (Json.canonical (Protocol.Request.params t.request))))
;;

let run t ~client = collect t ~fetch:(Client.invoke client)
