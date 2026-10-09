open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let json text = ok (Json.parse text)

let report = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_endline (Json.canonical (Problem.to_json p))
;;

let%expect_test "unsupported roots are identified before unrelated payload fields" =
  let unsupported = json {|{"version":"1","future_payload":{}}|} in
  report (Storage.Descriptor.of_json unsupported);
  report (Storage.Transaction.of_json unsupported);
  report (Storage_event.of_json unsupported);
  report (Registry.decode (Json.canonical unsupported));
  report (Storage.Descriptor.of_json (json {|{"name":"missing marker"}|}));
  [%expect
    {|
    {"details":{"observed":"1","representation":"workspace descriptor","supported":"3","type":"version"},"kind":"Unsupported_version","message":"workspace descriptor requires format 3; observed 1"}
    {"details":{"observed":"1","representation":"planning transaction","supported":"3","type":"version"},"kind":"Unsupported_version","message":"planning transaction requires format 3; observed 1"}
    {"details":{"observed":"1","representation":"planning events","supported":"3","type":"version"},"kind":"Unsupported_version","message":"planning events requires format 3; observed 1"}
    {"details":{"observed":"1","representation":"registry","supported":"3","type":"version"},"kind":"Unsupported_version","message":"registry requires format 3; observed 1"}
    {"details":{"observed":null,"representation":"workspace descriptor","supported":"3","type":"version"},"kind":"Unsupported_version","message":"workspace descriptor requires format 3; observed missing"}
    |}]
;;

let%expect_test "profile is mandatory even at initialize and in saved requests" =
  List.iter
    [ {|{"jsonrpc":"2.0","id":"read","method":"initialize"}|}
    ; {|{"workgraph_api":"future","unknown":true}|}
    ; {|{"workgraph_api":"0.4","jsonrpc":"2.0","id":"read","method":"initialize","params":{}}|}
    ]
    ~f:(fun text -> report (Protocol.validate_server_request (json text)));
  report (Protocol.Request.of_json (json {|{"workgraph_api":"old"}|}));
  let request =
    Protocol.Request.create ~id:"read" ~method_:"initialize" ~params:(Json.obj []) |> ok
  in
  report
    (Protocol.decode_response
       request
       (json
          {|{"jsonrpc":"2.0","id":"read","result":{"data":{"protocol_version":"1"},"meta":{}}}|}));
  print_endline
    (Json.text (Json.field (Protocol.Request.to_json request) "workgraph_api"));
  [%expect
    {|
    {"details":{"observed":null,"representation":"application API","supported":"0.4","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.4; observed missing"}
    {"details":{"observed":"future","representation":"application API","supported":"0.4","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.4; observed future"}
    ok
    {"details":{"observed":"old","representation":"application API","supported":"0.4","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.4; observed old"}
    {"details":{"observed":null,"representation":"application API","supported":"0.4","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.4; observed missing"}
    0.4
    |}]
;;

let%expect_test "malformed current fields stay malformed and unchanged formats keep IDs" =
  List.iter
    [ {|{"workgraph_api":3}|}
    ; {|{"workgraph_api":"0.4","workgraph_api":"0.4"}|}
    ; {|{"workgraph_api":"0.4","jsonrpc":"2.0","id":"x","method":"initialize","params":[]}|}
    ]
    ~f:(fun text ->
      match Protocol.validate_server_request (Jsonaf.of_string text) with
      | Ok _ -> print_endline "unexpected success"
      | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  List.iter
    [ Current_format.Planning_head
    ; History_head
    ; History_batch
    ; Upload_plan
    ; Heartbeat_cache
    ]
    ~f:(fun format -> print_endline (Current_format.identifier format));
  print_s
    [%sexp
      (Result.is_ok
         (History_storage.Head.of_json
            (json {|{"version":"1","workspace_id":"w","sequence":"0","digest":null}|}))
       : bool)];
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    1
    1
    1
    1
    1
    true
    |}]
;;
