open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let actor = ok (Id.Actor.of_string "actor")
let key = ok (Facts.Key.of_string "answer")
let value = ok (Facts.Value.of_json `Null)

let put expected_revision =
  Facts.Command.Put { scope = Workspace; key; expected_revision; value }
;;

let prepare state command sequence =
  Facts.prepare state command ~actor ~run:None ~timestamp:"2026-10-08T12:00:00Z" ~sequence
;;

let show_result result =
  print_s
    (match result with
     | Ok _ -> [%sexp "ok"]
     | Error problem -> [%sexp (problem.Problem.kind : Problem.kind)])
;;

let params fields =
  Json.obj (("scope", Json.obj [ "kind", Json.string "workspace" ]) :: fields)
;;

let%expect_test "guarded null, tombstone, recreation and replay validation" =
  let change, _ = ok (prepare Facts.empty (put 0) 1) in
  let state = ok (Facts.apply Facts.empty change) in
  show_result (prepare state (put 0) 2);
  let deletion = Facts.Command.Delete { scope = Workspace; key; expected_revision = 1 } in
  let deleted, _ = ok (prepare state deletion 2) in
  let state = ok (Facts.apply state deleted) in
  show_result (prepare state (put 0) 3);
  let recreated, _ = ok (prepare state (put 2) 3) in
  let state = ok (Facts.apply state recreated) in
  show_result (Facts.apply state recreated);
  let get =
    ok
      (Facts.query
         state
         ~workspace_revision:3
         ~method_:"fact.get"
         ~params:(params [ "key", Json.string "answer" ]))
  in
  print_endline (Json.canonical (Json.field get "data"));
  let malformed =
    match Facts.Change.to_json deleted with
    | `Object fields -> Json.obj (("value", `Null) :: fields)
    | _ -> assert false
  in
  show_result (Facts.Change.of_json malformed);
  [%expect
    {| 
    Conflict
    Conflict
    Corrupt_store
    {"actor_id":"actor","changed_at_revision":"3","deleted":false,"key":"answer","revision":"3","scope":{"kind":"workspace"},"timestamp":"2026-10-08T12:00:00Z","value":null,"value_type":"null"}
    Invalid_argument |}]
;;

let%expect_test
    "public codecs reject invalid key, depth, duplicate and null-delete ambiguity"
  =
  List.iter
    [ ""; "  "; "x\n"; String.make 129 'x' ]
    ~f:(fun key -> show_result (Facts.Key.of_string key));
  let rec nest n = if n = 0 then `Null else `Array [ nest (n - 1) ] in
  show_result (Facts.Value.of_json (nest 16));
  show_result (Facts.Value.of_json (nest 17));
  show_result (Facts.Value.of_json (`Object [ "x", `Null; "x", `True ]));
  show_result
    (Facts.Command.decode
       ~method_:"fact.delete"
       ~params:
         (params
            [ "key", Json.string "answer"
            ; "expected_revision", Json.int 0
            ; "value", `Null
            ]));
  [%expect
    {| 
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test
    "whole values survive budgets, no-fit is explicit, pagination pins revision"
  =
  let payload =
    ok (Facts.Value.of_json (`Array [ Json.string (String.make 3900 'x') ]))
  in
  let command =
    Facts.Command.Put { scope = Workspace; key; expected_revision = 0; value = payload }
  in
  let change, _ = ok (prepare Facts.empty command 1) in
  let state = ok (Facts.apply Facts.empty change) in
  show_result
    (Facts.query
       state
       ~workspace_revision:1
       ~method_:"fact.list"
       ~params:(params [ "max_bytes", Json.int 4096 ]));
  let get =
    ok
      (Facts.query
         state
         ~workspace_revision:1
         ~method_:"fact.get"
         ~params:(params [ "key", Json.string "answer"; "max_bytes", Json.int 8192 ]))
  in
  print_s
    [%sexp
      (String.length (Json.canonical (Json.field (Json.field get "data") "value")) : int)];
  show_result
    (Facts.query
       state
       ~workspace_revision:1
       ~method_:"fact.list"
       ~params:(params [ "offset", Json.int 1 ]));
  show_result
    (Facts.query
       state
       ~workspace_revision:1
       ~method_:"fact.list"
       ~params:(params [ "offset", Json.int 1; "at_revision", Json.int 0 ]));
  [%expect
    {| 
    Invalid_argument
    3904
    Invalid_argument
    Conflict |}]
;;

let%expect_test "search beyond first hundred, ordered missing keys, exact query schemas" =
  let state =
    List.fold (List.init 105 ~f:Fn.id) ~init:Facts.empty ~f:(fun state index ->
      let key = ok (Facts.Key.of_string (sprintf "entry-%03d" index)) in
      let command =
        Facts.Command.Put
          { scope = Workspace
          ; key
          ; expected_revision = 0
          ; value = ok (Facts.Value.of_json (`String "match"))
          }
      in
      let change, _ = ok (prepare state command (index + 1)) in
      ok (Facts.apply state change))
  in
  let result =
    ok
      (Facts.query
         state
         ~workspace_revision:105
         ~method_:"fact.search"
         ~params:
           (params
              [ "text", Json.string "match"
              ; "offset", Json.int 100
              ; "at_revision", Json.int 105
              ]))
  in
  let page = Json.field result "data" in
  print_s
    [%sexp
      (( List.length (Json.list (Json.field page "items"))
       , Json.integer (Json.field page "remaining") )
       : int * int)];
  let result =
    ok
      (Facts.query
         state
         ~workspace_revision:105
         ~method_:"fact.multi_get"
         ~params:
           (params
              [ ( "keys"
                , `Array
                    [ Json.string "missing"
                    ; Json.string "entry-000"
                    ; Json.string "missing"
                    ] )
              ]))
  in
  print_s
    [%sexp
      (Json.list (Json.field (Json.field result "data") "items")
       |> List.map ~f:(fun item -> Json.text (Json.field item "key"))
       : string list)];
  show_result
    (Facts.query
       state
       ~workspace_revision:105
       ~method_:"fact.get"
       ~params:
         (params
            [ "key", Json.string "entry-000"
            ; "offset", Json.int 1
            ; "at_revision", Json.int 105
            ]));
  show_result (Facts.Key.of_string "a\194\128b");
  [%expect
    {|
    (5 0)
    (missing entry-000 missing)
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "delete twice, absent put value and replay value inconsistency reject" =
  let change, _ = ok (prepare Facts.empty (put 0) 1) in
  let state = ok (Facts.apply Facts.empty change) in
  let deletion = Facts.Command.Delete { scope = Workspace; key; expected_revision = 1 } in
  let change, _ = ok (prepare state deletion 2) in
  let state = ok (Facts.apply state change) in
  show_result
    (prepare
       state
       (Facts.Command.Delete { scope = Workspace; key; expected_revision = 2 })
       3);
  show_result
    (Facts.Command.decode
       ~method_:"fact.put"
       ~params:(params [ "key", Json.string "answer"; "expected_revision", Json.int 0 ]));
  let missing_value =
    match Facts.Change.to_json change with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "deleted" then `False else value))
    | _ -> assert false
  in
  show_result (Facts.Change.of_json missing_value);
  [%expect
    {|
    Conflict
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "prefix schema and response codecs follow actual methods" =
  let state =
    List.fold [ "Alpha"; "alpha"; "alphabet" ] ~init:Facts.empty ~f:(fun state name ->
      let key = ok (Facts.Key.of_string name) in
      let change, _ =
        ok
          (prepare
             state
             (Facts.Command.Put { scope = Workspace; key; expected_revision = 0; value })
             1)
      in
      ok (Facts.apply state change))
  in
  let result =
    ok
      (Facts.query
         state
         ~workspace_revision:1
         ~method_:"fact.keys"
         ~params:(params [ "prefix", Json.string "alpha" ]))
  in
  let data = Json.field result "data" in
  print_s
    [%sexp
      (Json.list (Json.field data "items")
       |> List.map ~f:(fun item -> Json.text (Json.field item "key"))
       : string list)];
  List.iter Facts.query_methods ~f:(fun method_ ->
    let extra =
      match method_ with
      | "fact.get" | "fact.history" -> [ "key", Json.string "alpha" ]
      | "fact.multi_get" ->
        [ "keys", `Array [ Json.string "alpha"; Json.string "missing" ] ]
      | "fact.search" -> [ "text", Json.string "alpha" ]
      | _ -> []
    in
    let result =
      ok (Facts.query state ~workspace_revision:1 ~method_ ~params:(params extra))
    in
    show_result
      (Api_codec.decode (ok (Facts.response_codec method_)) (Json.field result "data")));
  let schema = ok (Facts.request_schema "fact.keys") in
  let structural = Json.field schema "allOf" |> Json.list |> List.hd_exn in
  let properties = Json.field structural "properties" in
  print_s [%sexp (Option.is_some (Json.optional properties "prefix") : bool)];
  show_result
    (Api_codec.decode
       (ok (Facts.query_codec "fact.keys"))
       (params [ "prefix", Json.string "" ]));
  show_result
    (Api_codec.decode
       (ok (Facts.query_codec "fact.get"))
       (params [ "key", Json.string "alpha"; "prefix", Json.string "" ]));
  [%expect
    {|
    (alpha alphabet)
    ok
    ok
    ok
    ok
    ok
    ok
    true
    ok
    Invalid_argument |}]
;;
