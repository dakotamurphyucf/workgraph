open Core
open Workgraph

let ok = Disk.unwrap
let workspace = ok (Id.Workspace.of_string "run-sessions")
let actor = ok (Id.Actor.of_string "agent")
let run_id = ok (Id.Run.of_string "run")
let json s = ok (Json.parse s)
let session id = ok (Session_id.of_string id)

let with_store f =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let nonce = Cstruct.create 16 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let root = "/tmp/wg-run-sessions-" ^ Json.hash (Cstruct.to_string nonce) in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / root);
    Disk.ensure_directory Eio.Path.(fs / root / "blobs");
    let store = ok (Session_store.open_existing ~fs ~root ~workspace) in
    Exn.protect
      ~f:(fun () -> f fs root store)
      ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / root)))
;;

let create store ?run id =
  let metadata =
    ok (Session.create ~workspace ~id:(session id) ~title:id ~actor ?run ~scopes:[] ())
  in
  ignore
    (ok
       (Session_store.create
          store
          metadata
          ~key:("agent:" ^ id)
          ~request_hash:(Json.hash id))
     : Jsonaf.t)
;;

let record sessions : Agent_run_event.Record.t =
  { id = run_id
  ; revision = 7
  ; parent = None
  ; parent_stop_policy = Continue
  ; objective = "Work"
  ; actor
  ; capabilities = []
  ; sessions = List.map sessions ~f:session
  ; process_ref = None
  ; worktree_ref = None
  ; status = Running
  ; last_observed_unix_ms = None
  ; evidence = ""
  }
;;

let ids json = Json.field json "session_ids" |> Json.list |> List.map ~f:Json.text
let data response = Json.field response "data"
let view store = ok (Session_store.capture store) |> Run_sessions.create

let error result =
  match result with
  | Ok _ -> print_endline "unexpected success"
  | Error e -> print_s [%sexp (e.Problem.kind : Problem.kind)]
;;

let continuation response =
  match
    Json.field (data response) "next_request" |> fun next -> Json.field next "params"
  with
  | `Object fields ->
    Json.obj (List.Assoc.remove fields ~equal:String.equal "workspace_id")
  | _ -> assert false
;;

let set json key value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key value)
  | _ -> assert false
;;

let%expect_test "incomplete run previews cannot skip known explicit prefix links" =
  let next =
    json
      {|{"method":"run.sessions","params":{"workspace_id":"run-sessions","target_run_id":"run","head":null,"expected_run_revision":"7","after_session_id":"b","limit":"100","max_bytes":"65536"}}|}
  in
  let response explicit =
    set
      (Agent_run_api.run_json (record [ "b" ]))
      "session_associations"
      (Json.obj
         [ "basis", Json.string "explicit_and_history_run"
         ; "history_head", `Null
         ; "explicit_session_ids", `Array [ Json.string explicit ]
         ; "total", Json.int 2
         ; "omitted", Json.int 1
         ; "next_request", next
         ])
  in
  List.iter [ "a"; "b"; "c" ] ~f:(fun explicit ->
    printf
      "%s accepted=%b\n"
      explicit
      (Result.is_ok
         (Api_codec.decode Run_sessions_api.run_view_codec (response explicit))));
  [%expect
    {|
    a accepted=false
    b accepted=true
    c accepted=true
    |}]
;;

let%expect_test
    "read union includes automatic, explicit and archived links without changing run \
     receipts"
  =
  with_store (fun _fs _root store ->
    create store ~run:run_id "auto";
    create store ~run:run_id "both";
    create store ~run:run_id "archived";
    create store ~run:(ok (Id.Run.of_string "other")) "explicit";
    create store "unlinked";
    ignore
      (ok
         (Session_store.archive
            store
            ~session:(session "archived")
            ~key:"agent:archive"
            ~request_hash:(Json.hash "archive"))
       : Jsonaf.t);
    let original = record [ "explicit"; "both" ] in
    let captured = view store in
    let projected = ok (Run_sessions.project captured original) in
    print_s [%sexp (ids projected : string list)];
    print_s [%sexp (List.map original.sessions ~f:Session_id.to_string : string list)];
    print_s
      [%sexp
        (ok (Run_receipt.of_record original)
         |> Run_receipt.sessions
         |> List.map ~f:Session_id.to_string
         : string list)];
    print_s
      [%sexp
        (Json.field projected "revision" : Jsonaf.t)
      , (Json.field (Json.field projected "session_associations") "total" : Jsonaf.t)];
    create store ~run:run_id "later";
    print_s [%sexp (ids (ok (Run_sessions.project captured original)) : string list)];
    print_s [%sexp (ids (ok (Run_sessions.project (view store) original)) : string list)];
    let first =
      ok
        (Run_sessions.read
           captured
           ~run:original
           ~workspace_revision:11
           ~params:(json {|{"target_run_id":"run","limit":"2"}|}))
    in
    let second =
      ok
        (Run_sessions.read
           captured
           ~run:original
           ~workspace_revision:12
           ~params:(continuation first))
    in
    print_s [%sexp (ids (data first) @ ids (data second) : string list)];
    print_s [%sexp (Json.field (data second) "has_more" : Jsonaf.t)];
    error
      (Run_sessions.read
         (view store)
         ~run:original
         ~workspace_revision:12
         ~params:(continuation first));
    error
      (Run_sessions.read
         captured
         ~run:{ original with revision = 8 }
         ~workspace_revision:12
         ~params:(continuation first)));
  [%expect
    {|
    (archived auto both explicit)
    (explicit both)
    (explicit both)
    ((String 7) (String 4))
    (archived auto both explicit)
    (archived auto both explicit later)
    (archived auto both explicit)
    False
    Conflict
    Conflict
    |}]
;;

let%expect_test
    "large read previews are explicit and bounded continuation returns the complete union"
  =
  with_store (fun _fs _root store ->
    for i = 0 to 104 do
      create store ~run:run_id (sprintf "s%03d%s" i (String.make 86 '_'))
    done;
    let captured = view store in
    let original = record [] in
    let projected = ok (Run_sessions.project captured original) in
    let association = Json.field projected "session_associations" in
    print_s
      [%sexp
        (List.length (ids projected) : int)
      , (Json.field association "total" : Jsonaf.t)
      , (Json.field association "omitted" : Jsonaf.t)];
    let first =
      ok
        (Run_sessions.read
           captured
           ~run:original
           ~workspace_revision:0
           ~params:(json {|{"target_run_id":"run","limit":"100","max_bytes":"4096"}|}))
    in
    let detail =
      Json.field (Json.field first "budget") "details" |> Json.list |> List.hd_exn
    in
    print_endline (Json.field detail "path" |> Json.text);
    let rec collect response acc pages =
      assert (Api_response.encoded_size Planning_read response <= 4096);
      let acc = acc @ ids (data response) in
      match Json.field (data response) "next_request" with
      | `Null -> acc, pages
      | _ ->
        collect
          (ok
             (Run_sessions.read
                captured
                ~run:original
                ~workspace_revision:0
                ~params:(continuation response)))
          acc
          (pages + 1)
    in
    let all, pages = collect first [] 1 in
    print_s
      [%sexp
        (List.length all : int)
      , (pages > 1 : bool)
      , (List.is_sorted_strictly all ~compare:String.compare : bool)
      , (Option.is_none (Json.optional (Json.field first "capture") "sessions") : bool)];
    let preview_next =
      Json.field association "next_request" |> fun next -> Json.field next "params"
    in
    let params =
      match preview_next with
      | `Object fields ->
        Json.obj (List.Assoc.remove fields ~equal:String.equal "workspace_id")
      | _ -> assert false
    in
    let rest =
      ok (Run_sessions.read captured ~run:original ~workspace_revision:0 ~params)
    in
    print_s
      [%sexp
        (List.length (ids (data rest)) : int)
      , (Json.field (data rest) "has_more" : Jsonaf.t)]);
  [%expect
    {|
    (100 (String 105) (String 5))
    /data/session_ids
    (105 true true true)
    (5 False)
    |}]
;;

let%expect_test
    "association request and result decoders enforce continuation and complete previews"
  =
  List.iter
    [ {|{"target_run_id":"run","after_session_id":"a"}|}
    ; {|{"target_run_id":"run","after_session_id":"a","head":null}|}
    ; {|{"target_run_id":"run","head":"bad"}|}
    ; {|{"target_run_id":"run","limit":"0"}|}
    ]
    ~f:(fun params ->
      print_s
        [%sexp
          (Result.is_error (Api_codec.decode Run_sessions_api.Request.codec (json params))
           : bool)]);
  with_store (fun _fs _root store ->
    create store ~run:run_id "auto";
    let projected = ok (Run_sessions.project (view store) (record [])) in
    print_s
      [%sexp
        (Result.is_error
           (Api_codec.decode
              Run_sessions_api.run_view_codec
              (Agent_run_api.run_json (record [])))
         : bool)];
    let association = Json.field projected "session_associations" in
    print_s
      [%sexp
        (Result.is_error
           (Api_codec.decode
              Run_sessions_api.run_view_codec
              (set
                 projected
                 "session_associations"
                 (set association "omitted" (Json.int 1))))
         : bool)];
    error
      (Run_sessions.read
         (view store)
         ~run:(record [])
         ~workspace_revision:0
         ~params:
           (json
              (sprintf
                 {|{"target_run_id":"run","head":"%s","expected_run_revision":"7","after_session_id":"missing"}|}
                 (Option.value_exn (Run_sessions.history_head (view store)))))));
  [%expect
    {|
    true
    true
    true
    true
    true
    true
    Invalid_argument
    |}]
;;

let%expect_test
    "derived links agree with a set-union model across explicit-link combinations"
  =
  with_store (fun _fs _root store ->
    let names = List.init 10 ~f:(sprintf "s%d") in
    List.iteri names ~f:(fun i name ->
      create store ?run:(if i % 2 = 0 then Some run_id else None) name);
    let captured = view store in
    let automatic = List.filteri names ~f:(fun i _ -> i % 2 = 0) in
    Quickcheck.test
      (Quickcheck.Generator.list_with_length 10 Bool.quickcheck_generator)
      ~trials:100
      ~f:(fun chosen ->
        let explicit =
          List.filter_map (List.zip_exn names chosen) ~f:(fun (name, include_) ->
            if include_ then Some name else None)
        in
        let original = record (List.rev explicit) in
        let projected = ok (Run_sessions.project captured original) in
        let expected = Set.to_list (String.Set.of_list (automatic @ explicit)) in
        assert (List.equal String.equal expected (ids projected));
        assert (
          List.equal
            Session_id.equal
            original.sessions
            (List.map (List.rev explicit) ~f:session)));
    print_endline "100 explicit-link combinations agree");
  [%expect {| 100 explicit-link combinations agree |}]
;;

let%expect_test "whole-item budget locations validate JSON pointers" =
  List.iter [ "items"; "/bad~2escape"; "/trailing~"; "/\255" ] ~f:(fun items_path ->
    print_s
      [%sexp
        (Result.is_error
           (Json.decode (fun () ->
              Query_budget.annotate_whole_items_exn
                ~items_path
                ~max_bytes:4096
                ~omitted_items:1
                (Json.obj [])))
         : bool)]);
  let valid =
    Query_budget.annotate_whole_items_exn
      ~items_path:"/a~1b/~0key"
      ~max_bytes:4096
      ~omitted_items:1
      (Json.obj [])
  in
  let detail =
    Json.field (Json.field valid "budget") "details" |> Json.list |> List.hd_exn
  in
  print_endline (Json.field detail "path" |> Json.text);
  [%expect
    {|
    true
    true
    true
    true
    /a~1b/~0key
    |}]
;;

let%expect_test "byte-fitted association IDs retain an exact client continuation" =
  with_store (fun _fs _root store ->
    let names =
      List.init 100 ~f:(fun i -> Printf.sprintf "s%03d_%s" i (String.make 90 'x'))
    in
    let original = record names in
    let captured = view store in
    let initial =
      Protocol.Request.create
        ~id:"fitted-links"
        ~method_:"run.sessions"
        ~params:
          (Json.obj
             [ "workspace_id", Id.Workspace.jsonaf_of_t workspace
             ; "target_run_id", Id.Run.jsonaf_of_t run_id
             ; "limit", Json.int 100
             ; "max_bytes", Json.int 4096
             ])
      |> ok
    in
    let fetch request =
      Json.decode (fun () ->
        let params =
          match Protocol.Request.params request with
          | `Object fields ->
            Json.obj (List.Assoc.remove fields ~equal:String.equal "workspace_id")
          | _ -> assert false
        in
        Run_sessions.read captured ~run:original ~workspace_revision:9 ~params
        |> ok
        |> Api_response.project Planning_read
        |> Api_response.to_json)
    in
    let first = fetch initial |> ok in
    let budget = Json.field (Json.field first "meta") "budget" in
    printf
      "first page shortened=%b path=%s within4096=%b\n"
      (Json.field budget "omitted_items" |> Json.integer |> fun n -> n > 0)
      (Json.field budget "details"
       |> Json.list
       |> List.hd_exn
       |> fun detail -> Json.field detail "path" |> Json.text)
      (String.length (Json.canonical first) <= 4096);
    let continuation =
      Query_pagination.Continuation.of_response initial ~response:first |> ok
    in
    let next =
      Query_pagination.Continuation.next_request continuation |> Option.value_exn
    in
    printf
      "continuation stop=%s null head pinned=%b run revision=%s\n"
      (Query_pagination.Continuation.to_json continuation
       |> fun value -> Json.field value "stop" |> Json.text)
      (match Json.field (Protocol.Request.params next) "head" with
       | `Null -> true
       | _ -> false)
      (Json.field (Protocol.Request.params next) "expected_run_revision" |> Json.text);
    let collection =
      Query_pagination.create initial ~limits:Query_pagination.Limits.default
      |> ok
      |> fun plan ->
      Query_pagination.collect plan ~fetch |> ok |> Query_pagination.Collection.to_json
    in
    let data = Json.field collection "data" in
    let recovered =
      Json.field data "pages"
      |> Json.list
      |> List.concat_map ~f:(fun page -> ids (Json.field page "data"))
    in
    printf
      "all100 exact=%b complete=%b\n"
      (List.equal String.equal names recovered)
      (match Json.field (Json.field data "pagination") "complete" with
       | `True -> true
       | _ -> false);
    (* A different omitted location remains unsafe for this family. *)
    let replace json field value =
      match json with
      | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal field value)
      | _ -> assert false
    in
    let wrong_budget =
      replace
        budget
        "details"
        (`Array
            [ Json.obj
                [ "path", Json.string "/data/items"
                ; "kind", Json.string "items"
                ; "omitted", Json.field budget "omitted_items"
                ]
            ])
    in
    let malformed =
      replace first "meta" (replace (Json.field first "meta") "budget" wrong_budget)
    in
    let stopped =
      Query_pagination.Continuation.of_response initial ~response:malformed |> ok
    in
    printf
      "other path stop=%s\n"
      (Query_pagination.Continuation.to_json stopped
       |> fun value -> Json.field value "stop" |> Json.text));
  [%expect
    {|
    first page shortened=true path=/data/session_ids within4096=true
    continuation stop=page_limit null head pinned=true run revision=7
    all100 exact=true complete=true
    other path stop=server_item_omissions
    |}]
;;
