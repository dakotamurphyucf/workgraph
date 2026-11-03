open Core
open Workgraph

let ok = Disk.unwrap
let json = Json.parse

let%expect_test "JSON pointers distinguish missing, null, exact numbers and escaped keys" =
  let value = json {|{"a/b":{"~key":[null,9007199254740993]},"":true,"n":1.0}|} |> ok in
  List.iter
    [ "/a~1b/~0key/0", `Null
    ; "/missing", `Null
    ; "/a~1b/~0key/00", `Null
    ; "/a~1b/~0key/-", `Null
    ; "/a~1b/~0key/1", `Number "9007199254740993"
    ; "/a~1b/~0key/1", `Number "9007199254740992"
    ; "/n", `Number "1"
    ; "/n", `Number "1.0"
    ; "/", `True
    ; "", `Null
    ]
    ~f:(fun (pointer, equals) ->
      let predicate = Fact_predicate.create ~pointer ~equals |> ok in
      printf
        "%S equals %s: %b\n"
        pointer
        (Json.canonical equals)
        (Fact_predicate.matches predicate ~value));
  let root = Fact_predicate.create ~pointer:"" ~equals:`Null |> ok in
  printf "scalar root: %b\n" (Fact_predicate.matches root ~value:`Null);
  [%expect
    {|
    "/a~1b/~0key/0" equals null: true
    "/missing" equals null: false
    "/a~1b/~0key/00" equals null: false
    "/a~1b/~0key/-" equals null: false
    "/a~1b/~0key/1" equals 9007199254740993: true
    "/a~1b/~0key/1" equals 9007199254740992: false
    "/n" equals 1: false
    "/n" equals 1.0: true
    "/" equals true: true
    "" equals null: false
    scalar root: true
    |}]
;;

let%expect_test "predicate boundaries reject malformed pointers and nonscalar comparisons"
  =
  let show result =
    match result with
    | Ok _ -> print_endline "ok"
    | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
  in
  List.iter
    [ "relative"; "/~"; "/~2"; String.make 513 '/'; String.make 17 '/'; "/\255" ]
    ~f:(fun pointer -> show (Fact_predicate.create ~pointer ~equals:`Null));
  show (Fact_predicate.create ~pointer:(String.make 16 '/') ~equals:`Null);
  show (Fact_predicate.create ~pointer:("/" ^ String.make 511 'x') ~equals:`Null);
  show (Fact_predicate.create ~pointer:"" ~equals:(`Array []));
  show (Fact_predicate.create ~pointer:"" ~equals:(`Object []));
  show (Fact_predicate.create ~pointer:"" ~equals:(`String (String.make 4095 'x')));
  let predicate = Json.obj [ "pointer", `String "/x"; "equals", `True ] in
  show
    (Api_codec.decode
       Fact_predicate.conjunction_codec
       (`Array (List.init 8 ~f:(Fn.const predicate))));
  show
    (Api_codec.decode
       Fact_predicate.conjunction_codec
       (`Array (List.init 9 ~f:(Fn.const predicate))));
  show
    (Api_codec.decode
       Fact_predicate.codec
       (Json.obj [ "pointer", `String "/x"; "equals", `True; "extra", `Null ]));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "fact predicates filter before paging, compose with prefix, and exclude tombstones"
  =
  let actor = Id.Actor.of_string "agent" |> ok in
  let put state sequence name body =
    let command =
      Facts.Command.Put
        { scope = Workspace
        ; key = Facts.Key.of_string name |> ok
        ; references = None
        ; expected_revision = 0
        ; value = Facts.Value.of_json (json body |> ok) |> ok
        }
    in
    let change, _ =
      Facts.prepare state command ~actor ~run:None ~timestamp:"fixture" ~sequence |> ok
    in
    Facts.apply state change |> ok
  in
  let state =
    put Facts.empty 1 "a" {|{"status":"waiting","owner":null}|}
    |> fun state ->
    put state 2 "b" {|{"status":"ready","owner":null}|}
    |> fun state ->
    put state 3 "c" {|{"status":"ready","owner":"agent"}|}
    |> fun state ->
    put state 4 "d" {|{"status":"ready","owner":null}|}
    |> fun state -> put state 5 "e" "null"
  in
  let deletion, _ =
    Facts.prepare
      state
      (Delete
         { scope = Workspace; key = Facts.Key.of_string "e" |> ok; expected_revision = 1 })
      ~actor
      ~run:None
      ~timestamp:"fixture"
      ~sequence:6
    |> ok
  in
  let state = Facts.apply state deletion |> ok in
  let query method_ extra =
    Facts.query
      state
      ~workspace_revision:6
      ~method_
      ~params:(Json.obj (("scope", Json.obj [ "kind", `String "workspace" ]) :: extra))
    |> ok
    |> fun result -> Json.field result "data"
  in
  let predicates =
    json {|[{"pointer":"/status","equals":"ready"},{"pointer":"/owner","equals":null}]|}
    |> ok
  in
  let fields = [ "predicates", predicates; "limit", Json.int 1 ] in
  let show_page data =
    let names =
      Json.field data "items"
      |> Json.list
      |> List.map ~f:(fun item -> Json.field item "key" |> Json.text)
    in
    print_s [%sexp (names : string list), (Json.field data "next_offset" : Jsonaf.t)]
  in
  show_page (query "fact.list" fields);
  show_page
    (query "fact.keys" (fields @ [ "offset", Json.int 1; "at_revision", Json.int 6 ]));
  show_page (query "fact.list" (fields @ [ "prefix", `String "d" ]));
  let null = json {|[{"pointer":"","equals":null}]|} |> ok in
  show_page (query "fact.list" [ "predicates", null; "include_deleted", `True ]);
  let search =
    query "fact.search" [ "predicates", predicates; "text", `String "ready" ]
  in
  printf
    "filtered search hits: %d\n"
    (List.length (Json.field search "items" |> Json.list));
  [%expect
    {|
    ((b) (String 1))
    ((d) Null)
    ((d) Null)
    (() Null)
    filtered search hits: 2
    |}]
;;
