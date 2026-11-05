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
    {"details":{"observed":"1","representation":"workspace descriptor","supported":"5","type":"version"},"kind":"Unsupported_version","message":"workspace descriptor requires format 5; observed 1"}
    {"details":{"observed":"1","representation":"planning transaction","supported":"5","type":"version"},"kind":"Unsupported_version","message":"planning transaction requires format 5; observed 1"}
    {"details":{"observed":"1","representation":"planning events","supported":"5","type":"version"},"kind":"Unsupported_version","message":"planning events requires format 5; observed 1"}
    {"details":{"observed":"1","representation":"registry","supported":"5","type":"version"},"kind":"Unsupported_version","message":"registry requires format 5; observed 1"}
    {"details":{"observed":null,"representation":"workspace descriptor","supported":"5","type":"version"},"kind":"Unsupported_version","message":"workspace descriptor requires format 5; observed missing"}
    |}]
;;

let%expect_test "previous API and every changed durable root reject before payload decode"
  =
  List.iter
    [ Current_format.Application_api
    ; Registry
    ; Workspace
    ; Planning_transaction
    ; Planning_events
    ; Workspace_export
    ; Registry_export
    ]
    ~f:(fun format ->
      let previous = if Current_format.equal format Application_api then "0.5" else "4" in
      let root = Json.obj [ Current_format.field format, Json.string previous ] in
      match Current_format.validate format root with
      | Ok () -> print_endline "unexpected success"
      | Error problem ->
        (match problem.details with
         | Some (Version { observed; supported; _ }) ->
           printf
             "%s -> %s: %s\n"
             (Option.value_exn observed)
             supported
             (Sexp.to_string [%sexp (problem.kind : Problem.kind)])
         | _ -> failwith "missing exact version details"));
  let old = json {|{"version":"4","unrelated":"incomplete old payload"}|} in
  List.iter
    [ Storage.Descriptor.of_json old |> Result.map ~f:(fun _ -> ())
    ; Storage.Transaction.of_json old |> Result.map ~f:(fun _ -> ())
    ; Storage_event.of_json old |> Result.map ~f:(fun _ -> ())
    ; Registry.decode (Json.canonical old) |> Result.map ~f:(fun _ -> ())
    ]
    ~f:(function
      | Ok () -> print_endline "unexpected decoded old root"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {|
    0.5 -> 0.6: Unsupported_version
    4 -> 5: Unsupported_version
    4 -> 5: Unsupported_version
    4 -> 5: Unsupported_version
    4 -> 5: Unsupported_version
    4 -> 5: Unsupported_version
    4 -> 5: Unsupported_version
    Unsupported_version
    Unsupported_version
    Unsupported_version
    Unsupported_version
    |}]
;;

let%expect_test "profile is mandatory even at initialize and in saved requests" =
  List.iter
    [ {|{"jsonrpc":"2.0","id":"read","method":"initialize"}|}
    ; {|{"workgraph_api":"future","unknown":true}|}
    ; {|{"workgraph_api":"0.6","jsonrpc":"2.0","id":"read","method":"initialize","params":{}}|}
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
    {"details":{"observed":null,"representation":"application API","supported":"0.6","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.6; observed missing"}
    {"details":{"observed":"future","representation":"application API","supported":"0.6","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.6; observed future"}
    ok
    {"details":{"observed":"old","representation":"application API","supported":"0.6","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.6; observed old"}
    {"details":{"observed":null,"representation":"application API","supported":"0.6","type":"version"},"kind":"Unsupported_version","message":"application API requires format 0.6; observed missing"}
    0.6
    |}]
;;

let%expect_test "malformed current fields stay malformed and unchanged formats keep IDs" =
  List.iter
    [ {|{"workgraph_api":3}|}
    ; {|{"workgraph_api":"0.6","workgraph_api":"0.6"}|}
    ; {|{"workgraph_api":"0.6","jsonrpc":"2.0","id":"x","method":"initialize","params":[]}|}
    ]
    ~f:(fun text ->
      match Protocol.validate_server_request (Jsonaf.of_string text) with
      | Ok _ -> print_endline "unexpected success"
      | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  List.iter
    [ Current_format.Planning_head; History_head; History_batch; Heartbeat_cache ]
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
    true
    |}]
;;
