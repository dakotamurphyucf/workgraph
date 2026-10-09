open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let json text = Json.parse text |> ok

let empty () =
  State.empty ~workspace:(Id.Workspace.of_string "facts" |> ok) ~name:"Facts" |> ok
;;

let actor = Id.Actor.of_string "writer" |> ok
let run = Id.Run.of_string "invocation" |> ok

let prepare state method_ params =
  State.prepare
    state
    (Domain_command.decode ~method_ ~params:(json params) |> ok)
    ~actor
    ~run
    ~timestamp:"2026-10-08T00:00:00Z"
;;

let apply state method_ params = prepare state method_ params |> ok |> State.candidate

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let set json key value =
  match json with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (k, v) -> k, if String.equal k key then value else v))
  | _ -> failwith "object required"
;;

let%expect_test "facts survive independent replay and expose scoped discovery and search" =
  let before = apply (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  let prepared =
    prepare
      before
      "fact.put"
      {|{"scope":{"kind":"ticket","id":"task"},"key":"build.command","expected_revision":"0","value":{"argv":["dune","build"],"exit":0}}|}
    |> ok
  in
  let after = State.candidate prepared in
  let replayed = State.replay before (State.events prepared) |> ok in
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json after))
         (Json.canonical (State.to_json replayed))
       : bool)];
  let keys =
    State.query
      replayed
      ~method_:"fact.keys"
      ~params:(json {|{"scope":{"kind":"ticket","id":"task"}}|})
    |> ok
  in
  let key = Json.field (Json.field keys "data") "items" |> Json.list |> List.hd_exn in
  print_s [%sexp (Json.optional key "value" |> Option.is_none : bool)];
  let matches =
    State.query
      replayed
      ~method_:"search.query"
      ~params:(json {|{"text":"dune","kinds":["fact"]}|})
    |> ok
  in
  print_s
    [%sexp
      (String.is_substring (Json.canonical matches) ~substring:"build.command" : bool)];
  let files = State.readable_files replayed |> Sequence.to_list |> List.map ~f:fst in
  print_s [%sexp (List.filter files ~f:(String.is_prefix ~prefix:"facts/") : string list)];
  [%expect
    {| 
    true
    true
    true
    (facts/ticket-task.json) |}]
;;

let%expect_test "fact replay binds attribution to outer transaction" =
  let before = empty () in
  let prepared =
    prepare
      before
      "fact.put"
      {|{"scope":{"kind":"workspace"},"key":"k","expected_revision":"0","value":null}|}
    |> ok
  in
  let event = State.events prepared in
  List.iter
    [ "actor", `String "someone"
    ; "run_id", `String "another"
    ; "timestamp", `String "other"
    ]
    ~f:(fun (key, value) -> outcome (Storage_event.of_json (set event key value)));
  let changes = Json.field event "changes" |> Json.list in
  let change =
    match changes with
    | [ `Array [ tag; payload ] ] ->
      `Array [ tag; set payload "changed_at_revision" (Json.int 2) ]
    | _ -> failwith "one fact event"
  in
  outcome (State.replay before (set event "changes" (`Array [ change ])));
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store |}]
;;

let%expect_test "fact scopes participate in atomic final reference validation" =
  outcome
    (prepare
       (empty ())
       "fact.put"
       {|{"scope":{"kind":"ticket","id":"missing"},"key":"k","expected_revision":"0","value":true}|});
  let prepared =
    prepare
      (empty ())
      "transaction.apply"
      {|{"operations":[{"method":"fact.put","params":{"scope":{"kind":"ticket","id":"$task"},"key":"k","expected_revision":"0","value":{"ticket_id":"$task"}}},{"method":"ticket.create","as":"task","params":{"ticket_id":"task","title":"Task"}}]}|}
  in
  outcome prepared;
  let state = ok prepared |> State.candidate in
  let got =
    State.query
      state
      ~method_:"fact.get"
      ~params:(json {|{"scope":{"kind":"ticket","id":"task"},"key":"k"}|})
    |> ok
  in
  print_endline
    (Json.field (Json.field (Json.field got "data") "value") "ticket_id" |> Json.text);
  [%expect
    {|
    Corrupt_store
    ok
    $task |}]
;;

let%expect_test "fact request codecs enforce stateless query invariants" =
  List.iter
    [ "fact.list", {|{"scope":{"kind":"workspace"},"limit":"0"}|}
    ; "fact.get", {|{"scope":{"kind":"workspace"},"key":"k","max_bytes":"0"}|}
    ; "fact.list", {|{"scope":{"kind":"workspace"},"offset":"1"}|}
    ; "fact.search", {|{"scope":{"kind":"workspace"},"text":"  "}|}
    ]
    ~f:(fun (method_, params) ->
      outcome (Api_codec.decode (Facts.query_codec method_ |> ok) (json params)));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "exact fact reads and key discovery isolate all four containing scopes" =
  let state =
    apply (empty ()) "project.create" {|{"project_id":"project","title":"Project"}|}
  in
  let state =
    apply
      state
      "milestone.create"
      {|{"milestone_id":"milestone","project_id":"project","title":"Milestone"}|}
  in
  let state =
    apply
      state
      "ticket.create"
      {|{"ticket_id":"task","title":"Task","project_id":"project","milestone_id":"milestone"}|}
  in
  let scopes =
    [ "workspace", {|{"kind":"workspace"}|}
    ; "project", {|{"kind":"project","id":"project"}|}
    ; "milestone", {|{"kind":"milestone","id":"milestone"}|}
    ; "ticket", {|{"kind":"ticket","id":"task"}|}
    ]
  in
  let state =
    List.fold scopes ~init:state ~f:(fun state (name, scope) ->
      let put state key =
        apply
          state
          "fact.put"
          (sprintf
             {|{"scope":%s,"key":"%s","expected_revision":"0","value":"%s"}|}
             scope
             key
             name)
      in
      put state "shared.key" |> fun state -> put state ("only." ^ name))
  in
  let query method_ scope fields =
    State.query state ~method_ ~params:(json (sprintf {|{"scope":%s%s}|} scope fields))
  in
  List.iter scopes ~f:(fun (name, scope) ->
    let fact =
      query "fact.get" scope {|,"key":"shared.key"|}
      |> ok
      |> fun response -> Json.field response "data"
    in
    let encoded_scope = json scope in
    print_s
      [%sexp
        (( name
         , Json.text (Json.field fact "value")
         , String.equal
             (Json.canonical (Json.field fact "scope"))
             (Json.canonical encoded_scope) )
         : string * string * bool)];
    let keys =
      query "fact.keys" scope ""
      |> ok
      |> fun response -> Json.field (Json.field response "data") "items" |> Json.list
    in
    print_s
      [%sexp
        (( List.map keys ~f:(fun item -> Json.text (Json.field item "key"))
         , List.for_all keys ~f:(fun item ->
             Option.is_none (Json.optional item "value")
             && String.equal
                  (Json.canonical (Json.field item "scope"))
                  (Json.canonical encoded_scope)) )
         : string list * bool)];
    let foreign_key =
      if String.equal name "workspace" then "only.ticket" else "only.workspace"
    in
    outcome (query "fact.get" scope (sprintf {|,"key":"%s"|} foreign_key));
    let multi =
      query
        "fact.multi_get"
        scope
        (sprintf {|,"keys":["shared.key","%s","never.written"]|} foreign_key)
      |> ok
      |> fun response -> Json.field (Json.field response "data") "items" |> Json.list
    in
    print_s
      [%sexp
        (List.map multi ~f:(fun item ->
           ( Json.text (Json.field item "key")
           , match Json.optional item "missing" with
             | Some `True ->
               Option.is_none (Json.optional item "value")
               && String.equal
                    (Json.canonical (Json.field item "scope"))
                    (Json.canonical encoded_scope)
             | Some _ | None -> false ))
         : (string * bool) list)]);
  List.iter [ "milestone"; "ticket" ] ~f:(fun name ->
    let scope = List.Assoc.find_exn scopes name ~equal:String.equal in
    outcome (query "fact.get" scope {|,"key":"only.project"|}));
  outcome
    (query
       "fact.get"
       (List.Assoc.find_exn scopes "ticket" ~equal:String.equal)
       {|,"key":"only.milestone"|});
  [%expect
    {|
    (workspace workspace true)
    ((only.workspace shared.key) true)
    Not_found
    ((shared.key false) (only.ticket true) (never.written true))
    (project project true)
    ((only.project shared.key) true)
    Not_found
    ((shared.key false) (only.workspace true) (never.written true))
    (milestone milestone true)
    ((only.milestone shared.key) true)
    Not_found
    ((shared.key false) (only.workspace true) (never.written true))
    (ticket ticket true)
    ((only.ticket shared.key) true)
    Not_found
    ((shared.key false) (only.workspace true) (never.written true))
    Not_found
    Not_found
    Not_found
    |}]
;;
