open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let actor = Id.Actor.of_string "agent" |> ok
let ticket = Facts.Reference.Ticket (Id.Ticket.of_string "target" |> ok)
let resource = Facts.Reference.Resource (Id.Resource.of_string "target" |> ok)
let json = Json.parse

let prepare state method_ params =
  Result.bind (Domain_command.decode ~method_ ~params) ~f:(fun command ->
    State.prepare state command ~actor ~timestamp:"fixture")
;;

let show = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
;;

let put ?(scope = Facts.Scope.Workspace) ?references state ~key ~revision ~sequence =
  Facts.prepare
    state
    (Facts.Command.Put
       { scope
       ; key = Facts.Key.of_string key |> ok
       ; expected_revision = revision
       ; value = Facts.Value.of_json (`String "literal $target") |> ok
       ; references
       })
    ~actor
    ~run:None
    ~timestamp:"fixture"
    ~sequence
;;

let references change =
  print_s [%sexp (Facts.Change.references change : Facts.Reference.t list)]
;;

let%expect_test "references preserve, clear, retain tombstones and validate direct inputs"
  =
  let first, _ =
    put Facts.empty ~key:"k" ~revision:0 ~sequence:1 ~references:[ ticket; resource ]
    |> ok
  in
  let state = Facts.apply Facts.empty first |> ok in
  let second, _ = put state ~key:"k" ~revision:1 ~sequence:2 |> ok in
  references second;
  let state = Facts.apply state second |> ok in
  let deleted, _ =
    Facts.prepare
      state
      (Delete
         { scope = Workspace; key = Facts.Key.of_string "k" |> ok; expected_revision = 2 })
      ~actor
      ~run:None
      ~timestamp:"fixture"
      ~sequence:3
    |> ok
  in
  references deleted;
  let forged =
    match Facts.Change.to_json deleted with
    | `Object fields ->
      Json.obj (List.Assoc.add fields ~equal:String.equal "references" (`Array []))
    | _ -> assert false
  in
  show (Facts.apply state (Facts.Change.of_json forged |> ok));
  let state = Facts.apply state deleted |> ok in
  let recreated, _ = put state ~key:"k" ~revision:3 ~sequence:4 |> ok in
  references recreated;
  let state = Facts.apply state recreated |> ok in
  let cleared, _ = put state ~key:"k" ~revision:4 ~sequence:5 ~references:[] |> ok in
  references cleared;
  show (put state ~key:"duplicate" ~revision:0 ~sequence:5 ~references:[ ticket; ticket ]);
  show
    (put
       state
       ~key:"large"
       ~revision:0
       ~sequence:5
       ~references:
         (List.init 33 ~f:(fun n ->
            Facts.Reference.Ticket (Id.Ticket.of_string ("t" ^ Int.to_string n) |> ok))));
  show
    (Facts.validate_targets state ~exists:(function
       | Entity_ref.Resource _ -> false
       | _ -> true));
  show (Facts.validate_targets state ~exists:(Fn.const true));
  [%expect
    {|
    ((Ticket target) (Resource target))
    ((Ticket target) (Resource target))
    Corrupt_store
    ((Ticket target) (Resource target))
    ()
    Invalid_argument
    Invalid_argument
    Corrupt_store
    ok
    |}]
;;

let%expect_test "reference public and durable decoders reject malformed sets" =
  List.iter
    [ {|[{"kind":"ticket","id":"t"},{"kind":"ticket","id":"t"}]|}
    ; {|[{"kind":"project","id":"p"}]|}
    ; {|[{"kind":"ticket","id":"$alias"}]|}
    ; {|[{"kind":"resource","id":"r","extra":true}]|}
    ; {|[{"kind":"ticket","id":"same"},{"kind":"resource","id":"same"}]|}
    ]
    ~f:(fun text -> show (Api_codec.decode Facts.Reference.list_codec (json text |> ok)));
  let first, _ = put Facts.empty ~key:"k" ~revision:0 ~sequence:1 |> ok in
  let change =
    match Facts.Change.to_json first with
    | `Object fields ->
      Json.obj
        (List.Assoc.add
           fields
           ~equal:String.equal
           "references"
           (json {|[{"kind":"ticket","id":"t"},{"kind":"ticket","id":"t"}]|} |> ok))
    | _ -> assert false
  in
  show (Facts.Change.of_json change);
  show (Api_codec.decode Facts.Change.codec change);
  show
    (Facts.Command.decode
       ~method_:"fact.put"
       ~params:
         (json
            {|{"scope":{"kind":"workspace"},"key":"k","expected_revision":"0","value":null,"references":null}|}
          |> ok));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "reverse lookup is typed, scoped, active-head only and revision guarded" =
  let project = Facts.Scope.Project (Id.Project.of_string "p" |> ok) in
  let add state scope key refs =
    let change, _ =
      put state ~scope ~key ~revision:0 ~sequence:1 ~references:refs |> ok
    in
    Facts.apply state change |> ok
  in
  let state =
    add Facts.empty Workspace "a" [ ticket ]
    |> fun state ->
    add state project "a" [ ticket ]
    |> fun state ->
    add state Workspace "resource-only" [ resource ]
    |> fun state -> add state Workspace "deleted" [ ticket ]
  in
  let deleted, _ =
    Facts.prepare
      state
      (Delete
         { scope = Workspace
         ; key = Facts.Key.of_string "deleted" |> ok
         ; expected_revision = 1
         })
      ~actor
      ~run:None
      ~timestamp:"fixture"
      ~sequence:2
    |> ok
  in
  let state = Facts.apply state deleted |> ok in
  let query fields =
    Facts.query
      state
      ~workspace_revision:2
      ~method_:"fact.references"
      ~params:
        (Json.obj
           (("reference", Api_codec.encode Facts.Reference.codec ticket |> ok) :: fields))
  in
  let print fields =
    let result = query fields |> ok in
    let data = Json.field result "data" in
    ignore
      (Api_codec.decode (Facts.response_codec "fact.references" |> ok) data |> ok
       : Jsonaf.t);
    let items = Json.list (Json.field data "items") in
    print_s
      [%sexp
        (List.map items ~f:(fun item ->
           ( Api_codec.decode Facts.Scope.codec (Json.field item "scope") |> ok
           , Json.text (Json.field item "key") ))
         : (Facts.Scope.t * string) list)]
  in
  print [];
  print [ "scope", json {|{"kind":"project","id":"p"}|} |> ok ];
  print [ "limit", Json.int 1 ];
  print [ "offset", Json.int 1; "at_revision", Json.int 2 ];
  show (query [ "offset", Json.int 1 ]);
  show (query [ "offset", Json.int 1; "at_revision", Json.int 1 ]);
  show (query [ "include_deleted", `True ]);
  let cleared, _ = put state ~key:"a" ~revision:1 ~sequence:3 ~references:[] |> ok in
  let after = Facts.apply state cleared |> ok in
  let result =
    Facts.query
      after
      ~workspace_revision:3
      ~method_:"fact.references"
      ~params:(json {|{"reference":{"kind":"ticket","id":"target"}}|} |> ok)
    |> ok
  in
  print_s
    [%sexp
      (List.length (Json.list (Json.field (Json.field result "data") "items")) : int)];
  [%expect
    {|
    ((Workspace a) ((Project p) a))
    (((Project p) a))
    ((Workspace a))
    (((Project p) a))
    Invalid_argument
    Conflict
    Invalid_argument
    1
    |}]
;;

let%expect_test
    "fact references resolve aliases, validate staged targets and survive replay"
  =
  let empty =
    State.empty ~workspace:(Id.Workspace.of_string "facts" |> ok) ~name:"Facts" |> ok
  in
  let params =
    json
      {|{"operations":[
    {"method":"ticket.create","as":"task","params":{"ticket_id":"target","title":"Target"}},
    {"method":"resource.put_text","as":"note","params":{"resource_id":"notes","expected_revision":"0","title":"Notes","text":"Exact content"}},
    {"method":"fact.put","params":{"scope":{"kind":"ticket","id":"$task"},"key":"links","expected_revision":"0","value":{"literal":"$task"},"references":[{"kind":"ticket","id":"$task"},{"kind":"resource","id":"$note"}]}}
  ]}|}
    |> ok
  in
  let prepared = prepare empty "transaction.apply" params |> ok in
  let candidate = State.candidate prepared in
  let replayed = State.replay empty (State.events prepared) |> ok in
  printf
    "replay=%b\n"
    (String.equal
       (Json.canonical (State.to_json candidate))
       (Json.canonical (State.to_json replayed)));
  let result =
    State.query
      candidate
      ~method_:"fact.references"
      ~params:(json {|{"reference":{"kind":"resource","id":"notes"}}|} |> ok)
    |> ok
  in
  let item = Json.list (Json.field (Json.field result "data") "items") |> List.hd_exn in
  print_endline (Json.canonical (Json.field item "references"));
  print_endline (Json.canonical (Json.field item "value"));
  let bad_params =
    json
      {|{"scope":{"kind":"workspace"},"key":"bad","expected_revision":"0","value":null,"references":[{"kind":"ticket","id":"missing"}]}|}
    |> ok
  in
  show (prepare candidate "fact.put" bad_params);
  let valid =
    prepare
      candidate
      "fact.put"
      (json
         {|{"scope":{"kind":"workspace"},"key":"second","expected_revision":"0","value":null,"references":[{"kind":"ticket","id":"target"}]}|}
       |> ok)
    |> ok
  in
  let rec forge = function
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "references"
             then
               `Array [ Json.obj [ "kind", `String "ticket"; "id", `String "missing" ] ]
             else forge value )))
    | `Array items -> `Array (List.map items ~f:forge)
    | value -> value
  in
  show (State.replay candidate (forge (State.events valid)));
  let cleared =
    prepare
      candidate
      "fact.put"
      (json
         {|{"scope":{"kind":"ticket","id":"target"},"key":"links","expected_revision":"1","value":null,"references":[]}|}
       |> ok)
    |> ok
  in
  let after = State.replay candidate (State.events cleared) |> ok in
  let data =
    State.query
      after
      ~method_:"fact.references"
      ~params:(json {|{"reference":{"kind":"ticket","id":"target"}}|} |> ok)
    |> ok
  in
  printf
    "after-clear=%d\n"
    (List.length (Json.list (Json.field (Json.field data "data") "items")));
  [%expect
    {|
    replay=true
    [{"id":"target","kind":"ticket"},{"id":"notes","kind":"resource"}]
    {"literal":"$task"}
    Not_found
    Corrupt_store
    after-clear=0
    |}]
;;
