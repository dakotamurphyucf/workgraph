open Core
open Workgraph

let unwrap = Disk.unwrap

let request ?guard () =
  Protocol.Request.create
    ~id:"page-test"
    ~method_:"run.list"
    ~params:
      (Json.obj
         ([ "workspace_id", Json.string "w" ]
          @ Option.to_list
              (Option.map guard ~f:(fun n -> "expected_revision", Json.int n))))
  |> unwrap
;;

let page ~next =
  Json.obj
    [ ( "data"
      , Json.obj
          [ "items", `Array []
          ; "next_offset", Option.value_map next ~default:`Null ~f:Json.int
          ; "omitted", Json.int (if Option.is_some next then 1 else 0)
          ] )
    ; "meta", Json.obj [ "query_scope", Json.string "runs"; "query_revision", Json.int 7 ]
    ]
;;

let collect ?(limits = Query_pagination.Limits.default) ?guard fetch =
  Query_pagination.create (request ?guard ()) ~limits
  |> unwrap
  |> fun plan -> Query_pagination.collect plan ~fetch
;;

let summary result =
  match result with
  | Error (problem : Problem.t) ->
    print_s [%sexp (problem.kind : Problem.kind)];
    print_endline problem.message
  | Ok result ->
    let data =
      Query_pagination.Collection.to_json result |> fun x -> Json.field x "data"
    in
    let metadata = Json.field data "pagination" in
    print_endline
      (Json.canonical
         (Json.obj
            [ "complete", Json.field metadata "complete"
            ; "stop", Json.field metadata "stop"
            ; "pages", Json.field metadata "page_count"
            ]))
;;

let%expect_test "exact guard/filter continuation and domain error preserved" =
  let count = ref 0 in
  let problem =
    Problem.create Conflict "unchanged domain problem"
    |> fun p -> Problem.with_details p (Revision { expected = 6; actual = 7 })
  in
  let result =
    collect (fun request ->
      incr count;
      if !count = 1
      then Ok (page ~next:(Some 1))
      else (
        print_endline (Json.canonical (Protocol.Request.params request));
        Error problem))
    |> unwrap
  in
  let metadata =
    Json.field
      (Json.field (Query_pagination.Collection.to_json result) "data")
      "pagination"
  in
  print_endline (Json.canonical (Json.field metadata "problem"));
  summary (Ok result);
  [%expect
    {|
    {"expected_revision":"7","offset":"1","workspace_id":"w"}
    {"details":{"actual":"7","expected":"6","type":"revision"},"kind":"Conflict","message":"unchanged domain problem"}
    {"complete":false,"pages":"1","stop":"error"}
  |}]
;;

let%expect_test "no progress and explicit guard never refresh" =
  summary (collect (fun _ -> Ok (page ~next:(Some 0))));
  summary (collect ~guard:6 (fun _ -> Ok (page ~next:None)));
  [%expect
    {|
    {"complete":false,"pages":"1","stop":"no_progress"}
    Conflict
    pagination capture differs from explicit expected_revision; guard was retained
  |}]
;;

let%expect_test "page and serialized collection byte limits terminate" =
  let limits = Query_pagination.Limits.create ~max_pages:2 ~max_bytes:4096 |> unwrap in
  let fetch request =
    let offset =
      Option.value_map
        (Json.optional (Protocol.Request.params request) "offset")
        ~default:0
        ~f:Json.integer
    in
    Ok (page ~next:(Some (offset + 1)))
  in
  summary (collect ~limits fetch);
  let limits = Query_pagination.Limits.create ~max_pages:1000 ~max_bytes:4096 |> unwrap in
  let result = collect ~limits fetch |> unwrap in
  assert (
    String.length (Json.canonical (Query_pagination.Collection.to_json result)) <= 4096);
  let metadata =
    Json.field
      (Json.field (Query_pagination.Collection.to_json result) "data")
      "pagination"
  in
  assert (Json.integer (Json.field metadata "page_count") > 0);
  print_endline (Json.text (Json.field metadata "stop"));
  [%expect
    {|
    {"complete":false,"pages":"2","stop":"page_limit"}
    byte_limit
  |}]
;;

let%expect_test "cancellation and unexpected exceptions propagate" =
  (try
     ignore
       (collect (fun _ -> raise (Eio.Cancel.Cancelled (Failure "cancel")))
        : (_, _) Result.t)
   with
   | Eio.Cancel.Cancelled _ -> print_endline "cancellation propagated");
  (try ignore (collect (fun _ -> failwith "unexpected") : (_, _) Result.t) with
   | Failure message -> print_endline message);
  [%expect
    {|
    cancellation propagated
    unexpected
  |}]
;;

let%expect_test "unsafe item budget omissions never silently advance" =
  let bounded =
    Json.obj
      [ "data", Json.field (page ~next:(Some 1)) "data"
      ; ( "meta"
        , Json.obj
            [ "query_scope", Json.string "runs"
            ; "query_revision", Json.int 7
            ; ( "budget"
              , Json.obj
                  [ "max_bytes", Json.int 4096
                  ; "returned_bytes", Json.int 200
                  ; "truncated", `True
                  ; "omitted_fields", Json.int 0
                  ; "omitted_items", Json.int 1
                  ; ( "details"
                    , `Array
                        [ Json.obj
                            [ "path", Json.string "/data/items"
                            ; "kind", Json.string "items"
                            ; "omitted", Json.int 1
                            ]
                        ] )
                  ; "details_complete", `True
                  ] )
            ] )
      ]
  in
  let calls = ref 0 in
  summary
    (collect (fun _ ->
       incr calls;
       Ok bounded));
  assert (!calls = 1);
  [%expect {| {"complete":false,"pages":"1","stop":"server_item_omissions"} |}]
;;

let current_request method_ =
  Protocol.Request.create
    ~id:"current"
    ~method_
    ~params:
      (Json.obj
         ([ "workspace_id", Json.string "w"; "max_bytes", Json.int 4096 ]
          @
          if String.equal method_ "actor.overview"
          then [ "actor_id", Json.string "a" ]
          else []))
  |> unwrap
;;

let actor_page
      ?(clock = 123L)
      ?(omitted = false)
      ?(omission_path = "/data/items")
      ~next
      ()
  =
  let data =
    Json.obj
      [ "workspace_revision", Json.int 7
      ; "observed_unix_ms", Json.int64 clock
      ; "items", `Array []
      ; "cursor", Option.value_map next ~default:`Null ~f:Json.string
      ; ("has_more", if Option.is_some next then `True else `False)
      ; "needs_larger_budget", `False
      ; "required_bytes", `Null
      ]
  in
  let budget =
    if omitted
    then
      [ ( "budget"
        , Json.obj
            [ "max_bytes", Json.int 4096
            ; "returned_bytes", Json.int 200
            ; "truncated", `True
            ; "omitted_fields", Json.int 0
            ; "omitted_items", Json.int 1
            ; ( "details"
              , `Array
                  [ Json.obj
                      [ "path", Json.string omission_path
                      ; "kind", Json.string "items"
                      ; "omitted", Json.int 1
                      ]
                  ] )
            ; "details_complete", `True
            ] )
      ]
    else []
  in
  Json.obj
    [ "data", data; "meta", Json.obj ([ "workspace_revision", Json.int 7 ] @ budget) ]
;;

let current_collect ?(limits = Query_pagination.Limits.default) method_ fetch =
  Query_pagination.create (current_request method_) ~limits
  |> unwrap
  |> fun plan -> Query_pagination.collect plan ~fetch
;;

let%expect_test "current-view capture rejects clock drift and repeated cursor positions" =
  let calls = ref 0 in
  summary
    (current_collect "actor.overview" (fun _ ->
       incr calls;
       Ok (actor_page ~next:(Some "same-position") ())));
  assert (!calls = 2);
  let calls = ref 0 in
  summary
    (current_collect "actor.overview" (fun _ ->
       incr calls;
       Ok (actor_page ~clock:(if !calls = 1 then 123L else 124L) ~next:(Some "next") ())));
  [%expect
    {|
    {"complete":false,"pages":"2","stop":"no_progress"}
    Conflict
    pagination capture changed; traversal was not restarted
  |}]
;;

let%expect_test "current whole-row omission needs an exact unconsumed cursor" =
  let calls = ref 0 in
  summary
    (current_collect "actor.overview" (fun _ ->
       incr calls;
       Ok
         (actor_page
            ~omitted:(!calls = 1)
            ~next:(if !calls = 1 then Some "position" else None)
            ())));
  summary
    (current_collect "actor.overview" (fun _ ->
       Ok (actor_page ~omitted:true ~next:None ())));
  summary
    (current_collect "actor.overview" (fun _ ->
       Ok
         (actor_page
            ~omitted:true
            ~omission_path:"/data/readiness/items"
            ~next:(Some "position")
            ())));
  [%expect
    {|
    {"complete":true,"pages":"2","stop":"complete"}
    {"complete":false,"pages":"1","stop":"server_item_omissions"}
    {"complete":false,"pages":"1","stop":"server_item_omissions"}
  |}]
;;

let%expect_test "new current cursors retain cancellation and prefetch bounds" =
  List.iter [ "usage.aggregate"; "actor.overview" ] ~f:(fun method_ ->
    assert (List.mem (Query_pagination.supported_methods ()) method_ ~equal:String.equal);
    (try
       ignore
         (current_collect method_ (fun _ ->
            raise (Eio.Cancel.Cancelled (Failure "cancel")))
          : (_, _) Result.t)
     with
     | Eio.Cancel.Cancelled _ -> print_endline (method_ ^ " cancellation propagated"));
    let called = ref false in
    let limits = Query_pagination.Limits.create ~max_pages:10 ~max_bytes:4096 |> unwrap in
    (match
       current_collect ~limits method_ (fun _ ->
         called := true;
         assert false)
     with
     | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
     | Ok _ -> print_endline "incorrectly fetched");
    assert (not !called));
  assert (
    not
      (List.mem
         (Query_pagination.supported_methods ())
         "attention.read"
         ~equal:String.equal));
  [%expect
    {|
    usage.aggregate cancellation propagated
    Invalid_argument
    actor.overview cancellation propagated
    Invalid_argument
  |}]
;;

let%expect_test "single returned page exposes exact capture and next request" =
  let initial = request () in
  let continuation =
    Query_pagination.Continuation.of_response initial ~response:(page ~next:(Some 1))
    |> unwrap
  in
  let value = Query_pagination.Continuation.to_json continuation in
  print_endline (Json.canonical (Json.field value "capture"));
  let next =
    Query_pagination.Continuation.next_request continuation |> Option.value_exn
  in
  print_endline (Json.canonical (Protocol.Request.params next));
  print_s [%sexp (Query_pagination.Continuation.complete continuation : bool)];
  (match
     Query_pagination.Continuation.of_response
       (request ~guard:6 ())
       ~response:(page ~next:(Some 1))
   with
   | Ok _ -> print_endline "unexpected"
   | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  let complete =
    Query_pagination.Continuation.of_response initial ~response:(page ~next:None)
    |> unwrap
  in
  print_s [%sexp (Query_pagination.Continuation.complete complete : bool)];
  [%expect
    {| {"query_revision":"7","query_scope":"runs"}
 {"expected_revision":"7","offset":"1","workspace_id":"w"}
 false
 Conflict
 true |}]
;;

let%expect_test "client metadata remains strict and separately bounded" =
  let next =
    Protocol.Request.create
      ~id:"metadata"
      ~method_:"ticket.list"
      ~params:
        (Json.obj
           [ "workspace_id", Json.string "w"
           ; "text", Json.string (String.make 70000 'x')
           ])
    |> unwrap
    |> Protocol.Request.to_json
  in
  let metadata =
    Pagination_metadata.create
      ~complete:false
      ~stop:Page_limit
      ~consistency:"current_revision_guard"
      ~capture:(Json.obj [ "workspace_revision", Json.int 7 ])
      ~next_request:(Some next)
      ~retry_request:None
    |> unwrap
  in
  print_s [%sexp (Pagination_metadata.complete metadata : bool)];
  print_s [%sexp (Pagination_metadata.stop metadata : Pagination_metadata.Stop.t)];
  let json = Pagination_metadata.to_json metadata in
  assert (String.length (Json.canonical json) <= 65536);
  assert (
    Json.integer (Json.field json "returned_bytes") = String.length (Json.canonical json));
  assert (Json.integer (Json.field json "required_bytes") > 65536);
  let replace value name field =
    match value with
    | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal name field)
    | _ -> failwith "object expected"
  in
  List.iter
    [ replace json "complete" `True
    ; replace json "returned_bytes" (Json.int 1)
    ; replace json "capture" (Json.obj [ "history_sequence", Json.int 7 ])
    ; replace json "unexpected" `Null
    ]
    ~f:(fun value ->
      match Api_codec.decode Pagination_metadata.codec value with
      | Ok _ -> print_endline "unexpected"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {| false
 Metadata_limit
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument |}]
;;

let%expect_test "metadata construction rejects original malformed request envelopes" =
  let valid = Protocol.Request.to_json (request ()) in
  let replace value name field =
    match value with
    | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal name field)
    | _ -> failwith "object expected"
  in
  let check invalid =
    match
      Pagination_metadata.create
        ~complete:false
        ~stop:Page_limit
        ~consistency:"current_revision_guard"
        ~capture:
          (Json.obj [ "query_revision", Json.int 7; "query_scope", Json.string "runs" ])
        ~next_request:(Some invalid)
        ~retry_request:None
    with
    | Ok _ -> failwith "malformed original request accepted"
    | Error _ -> print_endline "rejected"
  in
  List.iter
    [ "jsonrpc", Json.string "1.0"
    ; "workgraph_api", Json.string "unreleased"
    ; "extra", `True
    ; "method", Json.string ""
    ]
    ~f:(fun (name, value) ->
      check (replace valid name value);
      let oversized =
        replace valid "params" (Json.obj [ "text", Json.string (String.make 70000 'x') ])
      in
      check (replace oversized name value));
  check (replace valid "params" `Null);
  [%expect
    {|
    rejected
    rejected
    rejected
    rejected
    rejected
    rejected
    rejected
    rejected
    rejected
    |}]
;;

let%expect_test "nested metadata stays bounded and rejects ambiguous section paths" =
  let request = request () |> Protocol.Request.to_json in
  let section : Pagination_metadata.Section.t =
    { path = "/data/children"
    ; response_path = None
    ; complete = false
    ; stop = Page_limit
    ; next_request = Some request
    ; retry_request = None
    }
  in
  let create sections =
    Pagination_metadata.create_sections
      ~consistency:"current_revision_guard"
      ~capture:(Json.obj [ "workspace_revision", Json.int 7 ])
      ~sections
  in
  let show result =
    match result with
    | Error (problem : Problem.t) -> print_s [%sexp (problem.kind : Problem.kind)]
    | Ok metadata ->
      let json = Pagination_metadata.to_json metadata in
      printf
        "stop=%s sections=%b bounded=%b\n"
        (Pagination_metadata.Stop.to_string (Pagination_metadata.stop metadata))
        (Option.is_some (Json.optional json "sections"))
        (String.length (Json.canonical json) <= 65536)
  in
  show (create [ section ]);
  show (create [ section; section ]);
  show (create [ { section with complete = true } ]);
  let large =
    Protocol.Request.create
      ~id:"large"
      ~method_:"ticket.context"
      ~params:
        (Json.obj
           [ "workspace_id", Json.string "w"
           ; "text", Json.string (String.make 70000 'x')
           ])
    |> unwrap
    |> Protocol.Request.to_json
  in
  show (create [ { section with next_request = Some large } ]);
  [%expect
    {|
    stop=page_limit sections=true bounded=true
    Invalid_argument
    Invalid_argument
    stop=metadata_limit sections=false bounded=true
    |}]
;;
