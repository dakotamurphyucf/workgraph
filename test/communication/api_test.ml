open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let examples =
  [ ( "board.put"
    , {|{"board_id":"board","expected_revision":"0","scope":{"kind":"workspace"},"title":"Board"}|}
    )
  ; ( "team.put"
    , {|{"team_id":"team","expected_revision":"0","title":"Team","members":[{"kind":"actor","id":"bob"}]}|}
    )
  ; ( "subscription.put"
    , {|{"subscription_id":"subscription","expected_revision":"0","recipient":{"kind":"actor","id":"bob"},"filter":{"thread_id":"thread","kinds":["request_created"]},"active":true}|}
    )
  ; ( "thread.put"
    , {|{"thread_id":"thread","expected_revision":"0","board_id":"board","title":"Thread","state":"open"}|}
    )
  ; ( "thread.attach"
    , {|{"thread_id":"thread","expected_revision":"1","comment_id":"comment"}|} )
  ; ( "thread.pin_message"
    , {|{"thread_id":"thread","expected_revision":"2","comment_id":"comment","pinned":true}|}
    )
  ; ( "request.create"
    , {|{"request_id":"request","thread_id":"thread","kind":"review","comment_id":"comment","resolver_id":"alice","recipients":[{"kind":"actor","id":"bob"}],"reply_to_request_id":"previous"}|}
    )
  ; ( "request.acknowledge"
    , {|{"request_id":"request","expected_revision":"1","recipient":{"kind":"actor","id":"bob"}}|}
    )
  ; ( "request.accept"
    , {|{"request_id":"request","expected_revision":"1","recipient":{"kind":"actor","id":"bob"}}|}
    )
  ; ( "request.reassign"
    , {|{"request_id":"request","expected_revision":"1","recipient":null}|} )
  ; "request.resolve", {|{"request_id":"request","expected_revision":"1"}|}
  ; "request.cancel", {|{"request_id":"request","expected_revision":"1"}|}
  ; "board.get", {|{"board_id":"board"}|}
  ; "board.list", {|{"scope":{"kind":"workspace"},"offset":"1","revision":"2"}|}
  ; "team.get", {|{"team_id":"team"}|}
  ; "team.list", {|{}|}
  ; "subscription.get", {|{"subscription_id":"subscription"}|}
  ; "subscription.list", {|{"recipient":{"kind":"actor","id":"bob"}}|}
  ; ( "thread.get"
    , {|{"thread_id":"thread","include_messages":true,"message_offset":"1","revision":"2","discussion_serial":"3"}|}
    )
  ; "thread.list", {|{"board_id":"board","state":"awaiting_response","unresolved":true}|}
  ; "thread.search", {|{"text":"review"}|}
  ; "thread.history", {|{"thread_id":"thread"}|}
  ; "request.get", {|{"request_id":"request","include_messages":true}|}
  ; ( "request.list"
    , {|{"kind":"review","responsible":{"kind":"actor","id":"bob"},"overdue_at_unix_ms":"10"}|}
    )
  ; "request.history", {|{"request_id":"request"}|}
  ; "comment.get", {|{"comment_id":"comment"}|}
  ; "comment.list", {|{"target":{"kind":"workspace"},"include_tombstones":true}|}
  ; "comment.history", {|{"comment_id":"comment","offset":"1","at_revision":"2"}|}
  ]
;;

let request_codec name =
  Option.value_exn
    (match Communication_api.request_codec ~method_:name with
     | Some codec -> Some codec
     | None -> Discussion_api.request_codec ~method_:name)
;;

let report codec json =
  match Api_codec.decode codec json with
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let%expect_test "remaining communication descriptors use executable request codecs" =
  List.iter examples ~f:(fun (name, source) ->
    let codec = request_codec name in
    let params = Jsonaf.of_string source in
    ignore (unwrap (Api_codec.decode codec params) : Jsonaf.t);
    let fields =
      match params with
      | `Object fields -> fields
      | _ -> assert false
    in
    assert (
      Result.is_error (Api_codec.decode codec (Json.obj (("unknown", `Null) :: fields))));
    if List.mem Communication_command.methods name ~equal:String.equal
    then (
      let command = Communication_command.decode ~method_:name ~params |> unwrap in
      let encoded_name, encoded = Communication_command.encode command |> unwrap in
      assert (String.equal name encoded_name);
      ignore (unwrap (Api_codec.decode codec encoded) : Jsonaf.t)));
  printf
    "%d request contracts passed; mutation encoders revalidated\n"
    (List.length examples);
  List.iter
    [ ( "board.put"
      , {|{"board_id":"board","expected_revision":"0","scope":["Workspace"],"title":"Board"}|}
      )
    ; ( "board.put"
      , {|{"board_id":"$alias","expected_revision":"0","scope":{"kind":"workspace"},"title":"Board"}|}
      )
    ; ( "request.create"
      , {|{"request_id":"request","thread_id":"thread","kind":"review","comment_id":"comment","resolver_id":"alice"}|}
      )
    ; ( "request.create"
      , {|{"request_id":"request","thread_id":"thread","kind":"review","comment_id":"comment","resolver_id":"alice","teams":["team"],"reply_to":null}|}
      )
    ; "thread.list", {|{"state":null}|}
    ; "team.list", {|{"offset":"1"}|}
    ; ( "subscription.put"
      , {|{"subscription_id":"s","expected_revision":"0","recipient":{"kind":"actor","id":"bob"},"filter":{"kinds":[["Request_created"]]},"active":true}|}
      )
    ; "comment.list", {|{"ticket_id":"ticket"}|}
    ; "comment.history", {|{"comment_id":"comment","offset":"1"}|}
    ]
    ~f:(fun (name, json) ->
      let codec =
        Option.value
          (Communication_command.request_codec ~method_:name)
          ~default:(request_codec name)
      in
      report codec (Jsonaf.of_string json));
  [%expect
    {|28 request contracts passed; mutation encoders revalidated
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument|}]
;;

let%expect_test "public projections remain separate from durable replay encodings" =
  let board =
    { Communication_event.Board.id = Communication_id.Board.of_string "board" |> unwrap
    ; revision = 1
    ; scope = Workspace
    ; title = "Board"
    }
  in
  let public = Communication_wire.board_json board in
  print_endline (Json.canonical public);
  ignore (unwrap (Api_codec.decode Communication_wire.board public) : Jsonaf.t);
  report Communication_wire.board (Communication_event.Board.jsonaf_of_t board);
  let change =
    { Communication_event.version = 1
    ; revision = 1
    ; sequence = 1
    ; attribution =
        { actor = Id.Actor.of_string "alice" |> unwrap; run = None; timestamp = "now" }
    ; update = Board_put board
    ; notifications = []
    }
  in
  let replay = Communication.apply Communication.empty change |> unwrap in
  printf "replayed revision=%d\n" (Communication.revision replay);
  let malformed =
    Json.obj
      [ "items", `Array [ public ]
      ; "offset", Json.int 0
      ; "remaining", Json.int 1
      ; "next_offset", Json.int 2
      ]
  in
  report (Communication_wire.page Communication_wire.board) malformed;
  [%expect
    {|{"board_id":"board","revision":"1","scope":{"kind":"workspace"},"title":"Board"}
Invalid_argument
replayed revision=1
Invalid_argument|}]
;;

let%expect_test "raw references remain explicit and do not rewrite opaque text" =
  let params =
    Jsonaf.of_string
      {|{"thread_id":"thread","expected_revision":"0","board_id":"$board","title":"$board stays opaque","state":"open","links":[{"kind":"ticket","id":"$ticket"}]}|}
  in
  let raw =
    Option.value_exn (Communication_command.raw_request_codec ~method_:"thread.put")
  in
  let checked = Api_codec.decode raw params |> unwrap in
  printf
    "raw preserved=%b\n"
    (String.equal (Json.canonical params) (Json.canonical checked));
  report
    (Option.value_exn (Communication_command.request_codec ~method_:"thread.put"))
    params;
  let request_codec =
    Option.value_exn (Communication_command.raw_request_codec ~method_:"request.create")
  in
  report
    request_codec
    (Jsonaf.of_string
       {|{"request_id":"request","thread_id":"$thread","kind":"review","comment_id":"$comment","resolver_id":"alice","teams":["$team"],"reply_to_request_id":"$previous","correlation_id":"$opaque"}|});
  report
    request_codec
    (Jsonaf.of_string
       {|{"request_id":"request","thread_id":"$thread","kind":"review","comment_id":"$comment","resolver_id":"alice"}|});
  report
    raw
    (Jsonaf.of_string
       {|{"thread_id":"thread","expected_revision":"0","board_id":"$","title":"Thread","state":"open"}|});
  report
    (Option.value_exn
       (Communication_command.raw_request_codec ~method_:"subscription.put"))
    (Jsonaf.of_string
       {|{"subscription_id":"subscription","expected_revision":"0","recipient":{"kind":"run","id":"$run"},"filter":{"scope":{"kind":"project","id":"$project"},"thread_id":"$thread"},"active":true}|});
  [%expect
    {|
    raw preserved=true
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    ok |}]
;;

let%expect_test "transaction aliases resolve canonical request reply references" =
  let params =
    Jsonaf.of_string
      {|{"operations":[
    {"method":"board.put","as":"board","params":{"board_id":"b","expected_revision":"0","scope":{"kind":"workspace"},"title":"Board"}},
    {"method":"thread.put","as":"thread","params":{"thread_id":"t","expected_revision":"0","board_id":"$board","title":"Thread","state":"open"}},
    {"method":"comment.add","as":"comment","params":{"comment_id":"c","target":{"kind":"workspace"},"body":"$thread is text"}},
    {"method":"thread.attach","params":{"thread_id":"$thread","expected_revision":"1","comment_id":"$comment"}},
    {"method":"request.create","as":"first","params":{"request_id":"first","thread_id":"$thread","kind":"review","comment_id":"$comment","recipients":[{"kind":"actor","id":"bob"}],"resolver_id":"alice"}},
    {"method":"request.create","params":{"request_id":"second","thread_id":"$thread","kind":"help","comment_id":"$comment","recipients":[{"kind":"actor","id":"bob"}],"resolver_id":"alice","reply_to_request_id":"$first"}}
  ]}|}
  in
  let commands =
    match Domain_command.decode ~method_:"transaction.apply" ~params |> unwrap with
    | Batch commands -> commands
    | _ -> assert false
  in
  (match List.last_exn commands with
   | Communication (Request_create { reply_to = Some id; _ }) ->
     print_endline (Communication_id.Request.to_string id)
   | _ -> assert false);
  (match List.nth_exn commands 2 with
   | Comment_add { body; _ } -> print_endline body
   | _ -> assert false);
  [%expect
    {|
    first
    $thread is text |}]
;;
