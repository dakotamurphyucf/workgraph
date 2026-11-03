open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let decode params =
  Domain_command.decode ~method_:"resource.put_text" ~params:(Jsonaf.of_string params)
;;

let print_error = function
  | Ok _ -> print_endline "ok"
  | Error error ->
    print_s [%sexp (error.Problem.kind : Problem.kind), (error.message : string)]
;;

let%expect_test "public text publication preserves omission and requires creation title" =
  List.iter
    [ {|{"resource_id":"note","expected_revision":"0","text":"bytes"}|}
    ; {|{"resource_id":"note","expected_revision":"1","text":"bytes"}|}
    ; {|{"resource_id":"note","expected_revision":"1","title":null,"text":"bytes"}|}
    ; {|{"resource_id":"note","expected_revision":"1","title":"","text":"bytes"}|}
    ]
    ~f:(fun params -> print_error (decode params));
  let command =
    decode {|{"resource_id":"note","expected_revision":"1","text":"bytes"}|} |> ok
  in
  let _, encoded = Wire_command.encode command |> ok in
  print_s [%sexp (Option.is_none (Json.optional encoded "title") : bool)];
  [%expect
    {|
    (Invalid_argument "title is required when creating a resource")
    ok
    (Invalid_argument "/title: expected string")
    (Invalid_argument "/title: empty title")
    true
    |}]
;;

let%expect_test "retained metadata and separate entity/content versions survive replay" =
  let workspace = Id.Workspace.of_string "demo" |> ok in
  let actor = Id.Actor.of_string "worker" |> ok in
  let state = State.empty ~workspace ~name:"Text resources" |> ok in
  let prepare state method_ params =
    let command =
      Domain_command.decode ~method_ ~params:(Jsonaf.of_string params) |> ok
    in
    State.prepare state command ~actor ~timestamp:"2026-11-03 00:00:00Z" |> ok
  in
  let replay state method_ params =
    let prepared = prepare state method_ params in
    State.replay state (State.events prepared) |> ok
  in
  let state =
    replay
      state
      "resource.put_text"
      {|{"resource_id":"note","expected_revision":"0","title":"Initial","text":"first\n","filename":"original.txt","mime_type":"text/plain"}|}
  in
  let state =
    replay
      state
      "resource.update"
      {|{"resource_id":"note","expected_revision":"1","title":"Edited title","description":"Retained description"}|}
  in
  let publication =
    prepare
      state
      "resource.put_text"
      {|{"resource_id":"note","expected_revision":"2","text":"second\r\n\n"}|}
  in
  let receipt = State.result publication in
  print_s
    [%sexp
      (Json.integer (Json.field receipt "revision") : int)
    , (Json.integer (Json.field (Json.field receipt "version") "revision") : int)];
  let restored = State.replay state (State.events publication) |> ok in
  let metadata =
    State.query
      restored
      ~method_:"resource.get"
      ~params:(Jsonaf.of_string {|{"resource_id":"note"}|})
    |> ok
    |> fun result -> Json.field result "data"
  in
  print_endline (Json.canonical (Json.field metadata "metadata"));
  print_error
    (State.prepare
       restored
       (decode {|{"resource_id":"note","expected_revision":"2","text":"stale"}|} |> ok)
       ~actor
       ~timestamp:"fixture");
  (* Direct domain construction must not bypass the creation requirement. *)
  print_error
    (State.prepare
       restored
       (Domain_command.Resource_put
          { id = Id.Resource.of_string "missing" |> ok
          ; expected_revision = 0
          ; title = None
          ; text = ""
          ; filename = None
          ; mime_type = None
          })
       ~actor
       ~timestamp:"fixture");
  let batch =
    Domain_command.decode
      ~method_:"transaction.apply"
      ~params:
        (Jsonaf.of_string
           {|{"operations":[{"method":"resource.put_text","params":{"resource_id":"note","expected_revision":"3","text":"new"}},{"method":"resource.put_text","params":{"resource_id":"note","expected_revision":"3","text":"stale later"}}]}|})
    |> ok
  in
  print_error (State.prepare restored batch ~actor ~timestamp:"fixture");
  print_s [%sexp (State.revision restored : int)];
  [%expect
    {|
    (3 2)
    {"archived":false,"description":"Retained description","filename":"original.txt","mime_type":"text/plain","targets":[],"title":"Edited title"}
    (Conflict "revision conflict: expected 2, current 3")
    (Invalid_argument "title is required when creating a resource")
    (Conflict "revision conflict: expected 3, current 4")
    3
    |}]
;;
