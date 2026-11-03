open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let json text = Json.parse text |> ok
let actor = Id.Actor.of_string "agent" |> ok

let empty () =
  State.empty ~workspace:(Id.Workspace.of_string "preview" |> ok) ~name:"Preview" |> ok
;;

let step state method_ params =
  Domain_command.decode ~method_ ~params:(json params)
  |> ok
  |> fun command ->
  State.prepare state command ~actor ~timestamp:"fixture" |> ok |> State.candidate
;;

let show = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
;;

let preview state request =
  let next = ref 0 in
  Transaction_preflight.run
    state
    request
    ~timestamp:"fixture"
    ~now_unix_ms:1L
    ~fresh:(fun _ ->
      incr next;
      "provisional_" ^ Int.to_string !next)
;;

let%expect_test "preflight validates atomic resource fact and finish without publishing" =
  let state =
    step (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|}
    |> fun state -> step state "ticket.start" {|{"ticket_id":"task"}|}
  in
  let before = Json.canonical (State.to_json state) in
  let request =
    Api_codec.decode
      Preflight_api.Request.codec
      (json
         {|{
    "actor_id":"agent","operations":[
      {"method":"resource.put_text","params":{"resource_id":"notes","expected_revision":"0","title":"Notes","text":"ok"}},
      {"method":"fact.put","params":{"scope":{"kind":"ticket","id":"task"},"key":"result","expected_revision":"0","value":true,"references":[{"kind":"resource","id":"notes"}]}},
      {"method":"ticket.finish","params":{"ticket_id":"task","token":"1","evidence":"Checked"}}
    ]}|})
    |> ok
  in
  let report = preview state request |> ok in
  printf
    "revision=%d proposed=%d operations=%d blobs=%d bytes=%Ld\n"
    report.workspace_revision
    report.proposed_revision
    report.operation_count
    report.staged_blob_count
    report.staged_blob_bytes;
  printf "unchanged=%b\n" (String.equal before (Json.canonical (State.to_json state)));
  show
    (State.query state ~method_:"resource.get" ~params:(json {|{"resource_id":"notes"}|}));
  let command =
    Api_codec.encode Transaction_api.request request.operations
    |> ok
    |> fun params -> Domain_command.decode ~method_:"transaction.apply" ~params |> ok
  in
  let actual = State.prepare state command ~actor ~timestamp:"fixture" |> ok in
  printf
    "actual-revision=%d replay=%b\n"
    (State.revision (State.candidate actual))
    (String.equal
       (Json.canonical (State.to_json (State.candidate actual)))
       (Json.canonical (State.to_json (State.replay state (State.events actual) |> ok))));
  show (preview state { request with at_revision = Some (State.revision state + 1) });
  show (preview state { request with actor = Id.Actor.of_string "other" |> ok });
  [%expect
    {|
    revision=2 proposed=3 operations=3 blobs=1 bytes=2
    unchanged=true
    Not_found
    actual-revision=3 replay=true
    Conflict
    Stale_claim
    |}]
;;

let%expect_test
    "preflight resolves provisional aliases and applies public transaction limits"
  =
  let request =
    Api_codec.decode
      Preflight_api.Request.codec
      (json
         {|{"actor_id":"agent","operations":[
    {"method":"project.create","as":"project","params":{"title":"Project"}},
    {"method":"ticket.create","as":"task","params":{"title":"Task","project_id":"$project"}},
    {"method":"fact.put","params":{"scope":{"kind":"ticket","id":"$task"},"key":"literal","expected_revision":"0","value":"$task","references":[{"kind":"ticket","id":"$task"}]}}
  ]}|})
    |> ok
  in
  let state = empty () in
  let report = preview state request |> ok in
  print_s
    [%sexp
      (List.map report.generated_ids ~f:(fun id -> id.Preflight_api.Generated_id.id)
       : string list)];
  printf "original-revision=%d\n" (State.revision state);
  show
    (Api_codec.decode
       Preflight_api.Response.codec
       (Api_codec.encode Preflight_api.Response.codec report |> ok));
  show (preview state { request with operations = [] });
  show
    (preview
       state
       { request with
         operations = List.init 33 ~f:(fun _ -> List.hd_exn request.operations)
       });
  show
    (Api_codec.decode
       Preflight_api.Request.codec
       (json
          {|{"actor_id":"agent","operations":[{"method":"daemon.shutdown","params":{}}]}|}));
  show
    (Api_codec.decode
       Preflight_api.Request.codec
       (json
          {|{"actor_id":"agent","operations":[{"method":"transaction.apply","params":{"operations":[]}}]}|}));
  show
    (Api_codec.encode
       Preflight_api.Response.codec
       { report with proposed_revision = report.workspace_revision });
  [%expect
    {|
    (provisional_1 provisional_2)
    original-revision=0
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;
