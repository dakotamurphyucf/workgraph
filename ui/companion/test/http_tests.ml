open Core
open Workgraph
open Workgraph_ui
open State_tests

let capability = String.make 64 'a'
let host = "127.0.0.1:48100"
let origin = "http://" ^ host

let router env root ~sw ~host =
  let random = Eio.Stdenv.secure_random env in
  let profiles = Connection_profile.Store.create root |> Disk.unwrap in
  let operations = Operation_store.create ~root ~random |> Disk.unwrap in
  let scheduler = Read_scheduler.create () in
  let rpc =
    Rpc_bridge.create
      ~sw
      ~net:(Eio.Stdenv.net env)
      ~clock:(Eio.Stdenv.mono_clock env)
      ~random
      ~store:operations
      ~scheduler
  in
  ( Http_router.create
      ~host
      ~origin:("http://" ^ host)
      ~capability
      ~profiles
      ~operations
      ~rpc
      ~random
  , profiles
  , operations
  , scheduler )
;;

let with_router f =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let router, profiles, operations, scheduler = router env root ~sw ~host in
      f router profiles operations scheduler))
;;

let with_qualified_router f =
  Rpc_socket_test.with_bridge
    (fun _ -> failwith "this fixture admits qualification only")
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let router, profiles, operations, scheduler = router env root ~sw ~host in
         f router profiles operations scheduler (Connection_profile.socket connection)))
;;

let request ?(method_ = "GET") ?(body = "") ?headers target : Http_router.request =
  let headers =
    Option.value_or_thunk headers ~default:(fun () ->
      [ "Host", host; "X-Workgraph-UI-Capability", capability ]
      @
      if String.equal method_ "POST" || String.equal method_ "PUT"
      then
        [ "Origin", origin
        ; "Content-Type", "application/json"
        ; "Content-Length", Int.to_string (String.length body)
        ]
      else [])
  in
  { method_; target; headers; body }
;;

let data (response : Http_router.response) =
  Json.parse response.body |> Disk.unwrap |> fun body -> Json.field body "data"
;;

let call router ?method_ ?body ?headers target =
  Http_router.dispatch router (request ?method_ ?body ?headers target)
;;

let%expect_test
    "Host Origin Fetch Metadata capability and type checks precede API side effects"
  =
  with_router (fun router profiles _ _ ->
    let cases =
      [ "/", []
      ; "/", [ "Host", "127.0.0.1:9999" ]
      ; "/", [ "Host", host; "Origin", "http://evil.example" ]
      ; "/", [ "Host", host; "Origin", "null" ]
      ; "/", [ "Host", host; "Host", host ]
      ; "/", [ "Host", host; "Sec-Fetch-Site", "cross-site" ]
      ; "/", [ "Host", host; "Sec-Fetch-Site", "same-site" ]
      ; "/ui-api/v1/connections", [ "Host", host ]
      ; ( "/ui-api/v1/connections"
        , [ "Host", host; "X-Workgraph-UI-Capability", String.make 64 'b' ] )
      ]
    in
    List.iter cases ~f:(fun (target, headers) ->
      print_s [%sexp ((call router ~headers target).status : int)]);
    List.iter
      [ [ "Host", host
        ; "X-Workgraph-UI-Capability", capability
        ; "Content-Type", "application/json"
        ]
      ; [ "Host", host
        ; "X-Workgraph-UI-Capability", capability
        ; "Origin", origin
        ; "Content-Type", "text/plain"
        ]
      ; [ "Host", host
        ; "X-Workgraph-UI-Capability", capability
        ; "Origin", origin
        ; "Content-Type", "application/json"
        ; "Content-Length", "2"
        ; "Transfer-Encoding", "chunked"
        ]
      ]
      ~f:(fun headers ->
        print_s
          [%sexp
            ((call router ~method_:"POST" ~body:"{}" ~headers "/ui-api/v1/connections")
               .status
             : int)]);
    print_s [%sexp (List.length (Connection_profile.Store.list profiles) : int)]);
  [%expect
    {|403
403
403
403
403
403
403
403
403
403
403
403
0|}]
;;

let%expect_test
    "embedded assets are exact, bootstrap token no-store, all APIs protected and lean \
     discovery lazy"
  =
  with_router (fun router _ _ _ ->
    let bootstrap = call router "/" in
    print_s
      [%sexp
        (( bootstrap.status
         , List.Assoc.find_exn bootstrap.headers "cache-control" ~equal:String.equal
         , String.is_substring bootstrap.body ~substring:capability
         , String.is_substring
             bootstrap.body
             ~substring:Workgraph_ui_assets.capability_marker )
         : int * string * bool * bool)];
    let asset =
      List.find_exn Workgraph_ui_assets.all ~f:(fun asset ->
        String.is_prefix asset.path ~prefix:"/assets/")
    in
    let static = call router asset.path in
    let notices = call router "/frontend-notices.txt" in
    assert (
      String.equal
        (List.Assoc.find_exn notices.headers "cache-control" ~equal:String.equal)
        "no-store");
    print_s
      [%sexp
        ((static.status, String.equal (Json.hash static.body) asset.sha256) : int * bool)];
    List.iter
      [ "/missing"
      ; "/assets/missing.js"
      ; "/index.html?x=1"
      ; "/../index.html"
      ; "/%2e%2e/index.html"
      ; "//index.html"
      ]
      ~f:(fun path -> print_s [%sexp ((call router path).status : int)]);
    let catalog = call router "/ui-api/v1/catalog" in
    let methods = data catalog |> fun value -> Json.field value "methods" |> Json.list in
    print_s
      [%sexp
        (( String.length catalog.body < 100_000
         , List.length methods = List.length Api_catalog.methods
         , List.for_all methods ~f:(fun method_ ->
             Option.is_none (Json.optional method_ "params")) )
         : bool * bool * bool)];
    let selected = call router "/ui-api/v1/methods/ticket.metadata" |> data in
    print_s
      [%sexp
        (( String.equal
             (Json.field (Json.field selected "method") "name" |> Json.text)
             "ticket.metadata"
         , Option.is_some (Json.optional (Json.field selected "method") "params") )
         : bool * bool)]);
  [%expect
    {|(200 no-store true false)
(200 true)
404
404
400
403
403
403
(true true true)
(true true)|}]
;;

let%expect_test
    "strict UI envelopes reject missing null duplicate and undeclared fields while \
     retaining JSON number lexemes"
  =
  let valid =
    {|{"connection_id":"local","generation":"1","method":"fact.put","params":{"number":9007199254740993123456.00e+7}}|}
  in
  let invocation = Wire.Invocation.of_json (json valid) |> Disk.unwrap in
  print_endline (Json.canonical invocation.params);
  List.iter
    [ {|{"connection_id":"local","generation":"1","method":"fact.put","params":null}|}
    ; {|{"connection_id":"local","generation":"1","method":"fact.put"}|}
    ; {|{"connection_id":"local","generation":"1","method":"fact.put","params":{},"future":true}|}
    ; {|{"connection_id":"local","generation":"01","method":"fact.put","params":{}}|}
    ; {|{"connection_id":"local","generation":"1","method":"fact.put","params":{},"lane":"unbounded"}|}
    ]
    ~f:(fun bytes -> problem (Wire.Invocation.of_json (json bytes)));
  problem
    (Wire.Invocation.of_json
       (`Object [ "connection_id", `String "local"; "connection_id", `String "other" ]));
  [%expect
    {|{"number":9007199254740993123456.00e+7}
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument|}]
;;

let%expect_test
    "profile generations, exact preparations, operation routes and body limits preserve \
     semantics"
  =
  with_qualified_router (fun router profiles operations _ socket ->
    let create =
      call
        router
        ~method_:"POST"
        ~body:
          (Json.canonical
             (Json.obj
                [ "id", Json.string "local"
                ; "label", Json.string "Local"
                ; "socket", Json.string socket
                ]))
        "/ui-api/v1/connections"
    in
    print_s [%sexp (create.status : int)];
    let update =
      call
        router
        ~method_:"PUT"
        ~body:
          {|{"expected_generation":"1","label":"Changed","socket":"/tmp/ui-http-other.sock"}|}
        "/ui-api/v1/connections/local"
    in
    print_endline (Json.field (data update) "generation" |> Json.text);
    print_s
      [%sexp
        ((call
            router
            ~method_:"PUT"
            ~body:
              {|{"expected_generation":"1","label":"Changed","socket":"/tmp/ui-http-other.sock"}|}
            "/ui-api/v1/connections/local")
           .status
         : int)];
    print_s
      [%sexp
        (Option.is_some
           (Connection_profile.Store.find
              profiles
              ~id:(Connection_profile.Id.of_string "local" |> Disk.unwrap)
              ~generation:Connection_profile.Generation.initial)
         : bool)];
    let input =
      {|{"intention_id":"intent","connection_id":"local","generation":"1","context":{"workspace_id":"demo","project_id":null,"writer":{"actor_id":"author","run_id":null}},"method":"ticket.metadata","params":{"workspace_id":"demo","actor_id":"author","ticket_id":"task","expected_revision":"1"}}|}
    in
    let prepared =
      call router ~method_:"POST" ~body:input "/ui-api/v1/operations/prepare"
    in
    let original = data prepared in
    let id = Json.field original "operation_id" |> Json.text in
    print_s
      [%sexp
        (( prepared.status
         , String.equal
             (Json.field (Json.field original "connection") "generation" |> Json.text)
             "1"
         , Bool.equal
             (Json.field original "receipt_lookup_supported"
              |> function
              | `True -> true
              | _ -> false)
             true )
         : int * bool * bool)];
    let repeated =
      call router ~method_:"POST" ~body:input "/ui-api/v1/operations/prepare" |> data
    in
    print_s
      [%sexp (String.equal (Json.canonical original) (Json.canonical repeated) : bool)];
    print_s
      [%sexp ((call router ("/ui-api/v1/operations/" ^ id ^ "/execute")).status : int)];
    print_s
      [%sexp
        ((call
            router
            ~method_:"POST"
            ~body:"{\"extra\":true}"
            ("/ui-api/v1/operations/" ^ id ^ "/execute"))
           .status
         : int)];
    print_endline
      (state
         (Operation_store.inspect operations ~id:(Operation.Id.of_string id |> Disk.unwrap)
          |> Disk.unwrap));
    print_s
      [%sexp
        (( (call router "/ui-api/v1/operations?offset=0&limit=1").status
         , (call router "/ui-api/v1/operations?offset=0&offset=1").status
         , (call
              router
              ~method_:"POST"
              ~body:(String.make (Framing.max_bytes + 1) ' ')
              "/ui-api/v1/read")
             .status )
         : int * int * int)]);
  [%expect
    {|200
2
409
true
(200 true true)
true
404
400
prepared_unsent
(200 400 413)|}]
;;
