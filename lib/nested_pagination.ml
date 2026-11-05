open Core

let methods = [ "ticket.context"; "thread.get"; "request.get" ]
let unwrap = Disk.unwrap
let field = Json.field
let count json key = Json.integer (field json key)
let equal_json a b = String.equal (Json.canonical a) (Json.canonical b)

let ticket_sections =
  [ [ "related" ]
  ; [ "resources" ]
  ; [ "communication"; "threads" ]
  ; [ "communication"; "requests" ]
  ; [ "amendments" ]
  ; [ "pending_amendment_acknowledgements" ]
  ; [ "attempts" ]
  ; [ "recoveries" ]
  ; [ "children" ]
  ; [ "updates" ]
  ; [ "activity_since_handoff" ]
  ]
;;

let validate_request request =
  match Api_catalog.find (Protocol.Request.method_ request) with
  | None -> Json.fail Not_found "unknown nested pagination method"
  | Some (Api_method.Packed.Pack definition) ->
    ignore
      (Api_codec.decode
         (Api_method.request_codec definition)
         (Protocol.Request.params request)
       |> unwrap)
;;

let set request fields =
  let original =
    match Protocol.Request.params request with
    | `Object fields -> fields
    | _ -> assert false
  in
  List.fold fields ~init:original ~f:(fun fields (key, value) ->
    List.Assoc.add fields ~equal:String.equal key value)
  |> Json.obj
  |> Protocol.Request.with_params request
  |> unwrap
;;

let pin request fields =
  List.iter fields ~f:(fun (key, value) ->
    Option.iter
      (Json.optional (Protocol.Request.params request) key)
      ~f:(fun original ->
        if not (equal_json original value)
        then Json.fail Conflict ("nested pagination capture differs from explicit " ^ key)));
  set request fields
;;

let of_response request ~response =
  Json.decode (fun () ->
    let method_ = Protocol.Request.method_ request in
    if not (List.mem methods method_ ~equal:String.equal)
    then None
    else (
      validate_request request;
      let response = Api_response.of_json response |> unwrap in
      let data = Api_response.data response
      and meta = Api_response.meta response in
      (match Api_catalog.find method_ with
       | Some (Api_method.Packed.Pack definition) ->
         ignore (Api_codec.decode (Api_method.response_codec definition) data |> unwrap)
       | None -> assert false);
      let planning = String.equal method_ "ticket.context" in
      let paths, position, capture, guards =
        if planning
        then
          ( ticket_sections
          , "offset"
          , Json.obj [ "workspace_revision", field meta "workspace_revision" ]
          , [ "at_revision", field meta "workspace_revision" ] )
        else (
          let revision = field meta "query_revision" in
          let base =
            [ "query_revision", revision; "query_scope", field meta "query_scope" ]
          in
          match Json.optional data "related" with
          | None ->
            if
              Option.exists
                (Json.optional (Protocol.Request.params request) "include_messages")
                ~f:(fun value -> equal_json value `True)
            then
              Json.fail Invalid_argument "expanded response is missing related messages";
            [], "message_offset", Json.obj base, []
          | Some related ->
            let serial = field related "discussion_serial" in
            ( [ [ "related"; "messages" ] ]
            , "message_offset"
            , Json.obj (base @ [ "discussion_serial", serial ])
            , [ "revision", revision; "discussion_serial", serial ] ))
      in
      let pinned = pin request guards in
      let budget = Json.optional meta "budget" in
      let path_of keys = "/data/" ^ String.concat ~sep:"/" keys in
      let unsafe_items =
        Option.exists budget ~f:(fun budget ->
          count budget "omitted_items" > 0
          && ((not (equal_json (field budget "details_complete") `True))
              || List.exists
                   (Json.list (field budget "details"))
                   ~f:(fun detail ->
                     String.equal (Json.text (field detail "kind")) "items"
                     && not
                          (List.exists
                             (paths @ if planning then [ [ "fact_keys" ] ] else [])
                             ~f:(fun keys ->
                               String.equal
                                 (Json.text (field detail "path"))
                                 (path_of keys ^ "/items"))))))
      in
      let missing_fields =
        Option.exists budget ~f:(fun b -> count b "omitted_fields" > 0)
      in
      let sections =
        List.map paths ~f:(fun keys ->
          let page = List.fold keys ~init:data ~f:field in
          let offset = count page "offset" in
          let expected_offset =
            Option.value_map
              (Json.optional (Protocol.Request.params request) position)
              ~default:0
              ~f:Json.integer
          in
          if offset <> expected_offset
          then Json.fail Invalid_argument "nested page offset differs from request";
          let next =
            Json.optional page "next_offset"
            |> Option.bind ~f:(function
              | `Null -> None
              | value -> Some (Json.integer value))
          in
          let stop, next_request, retry_request =
            if missing_fields
            then Pagination_metadata.Stop.Server_field_omissions, None, Some pinned
            else if unsafe_items
            then Server_item_omissions, None, Some pinned
            else (
              match next with
              | Some next when next <= offset -> No_progress, None, Some pinned
              | Some next ->
                if next - offset <> List.length (Json.list (field page "items"))
                then
                  Json.fail
                    Invalid_argument
                    "nested page continuation skips returned rows";
                let next_request = set pinned [ position, Json.int next ] in
                validate_request next_request;
                Page_limit, Some next_request, None
              | None -> Complete, None, None)
          in
          { Pagination_metadata.Section.path = path_of keys
          ; response_path = None
          ; complete = Pagination_metadata.Stop.equal stop Complete
          ; stop
          ; next_request = Option.map next_request ~f:Protocol.Request.to_json
          ; retry_request = Option.map retry_request ~f:Protocol.Request.to_json
          })
      in
      let sections =
        if not planning
        then sections
        else (
          let facts = field data "fact_keys" in
          let selected = List.length (Json.list (field facts "items")) in
          let request_at offset =
            let params = Protocol.Request.params request in
            let fields =
              [ "workspace_id", field params "workspace_id"
              ; ( "scope"
                , Json.obj
                    [ "kind", Json.string "ticket"; "id", field params "ticket_id" ] )
              ; "offset", Json.int offset
              ; "at_revision", field meta "workspace_revision"
              ]
              @ List.filter_map [ "limit"; "max_bytes" ] ~f:(fun name ->
                Option.map (Json.optional params name) ~f:(fun value -> name, value))
            in
            let next =
              Protocol.Request.create
                ~id:(field (Protocol.Request.to_json request) "id" |> Json.text)
                ~method_:"fact.keys"
                ~params:(Json.obj fields)
              |> unwrap
            in
            validate_request next;
            Protocol.Request.to_json next
          in
          let stop, next_request, retry_request =
            if count facts "remaining" = 0
            then Pagination_metadata.Stop.Complete, None, None
            else if selected = 0
            then No_progress, None, Some (request_at 0)
            else Page_limit, Some (request_at selected), None
          in
          sections
          @ [ { Pagination_metadata.Section.path = "/data/fact_keys"
              ; response_path = Some "/data"
              ; complete = Pagination_metadata.Stop.equal stop Complete
              ; stop
              ; next_request
              ; retry_request
              }
            ])
      in
      Some
        (if List.is_empty sections
         then
           Pagination_metadata.create
             ~complete:((not missing_fields) && not unsafe_items)
             ~stop:
               (if missing_fields
                then Server_field_omissions
                else if unsafe_items
                then Server_item_omissions
                else Complete)
             ~consistency:"current_revision_guard"
             ~capture
             ~next_request:None
             ~retry_request:None
           |> unwrap
         else
           Pagination_metadata.create_sections
             ~consistency:"current_revision_guard"
             ~capture
             ~sections
           |> unwrap)))
;;
