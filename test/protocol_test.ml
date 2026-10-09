open Core
open Workgraph

let%expect_test "invalid envelope rejection requires a strict complete error" =
  let request =
    Protocol.Request.create ~id:"mine" ~method_:"ticket.create" ~params:(Json.obj [])
    |> Disk.unwrap
  in
  List.iter
    [ {|{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"unknown field: workgraph_api","data":{"kind":"Invalid_argument","message":"unknown field: workgraph_api"}}}|}
    ; {|{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}|}
    ; {|{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"x","data":{}}}|}
    ; {|{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"x","data":{"kind":"Invalid_argument","message":"x"}}}|}
    ; {|{"jsonrpc":"2.0","id":null,"result":{},"error":{"code":-32600,"message":"x"}}|}
    ; {|{"jsonrpc":"2.0","id":"other","error":{"code":-32600,"message":"x"}}|}
    ; {|{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"x","data":{"kind":"Invalid_argument","message":"different"}}}|}
    ; {|{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"x","data":{"kind":"Outcome_unknown","message":"x"}}}|}
    ]
    ~f:(fun bytes ->
      match Protocol.decode_response request (Json.parse bytes |> Disk.unwrap) with
      | Ok (Failure problem) -> printf "remote %s\n" (Problem.wire_name problem.kind)
      | Ok (Success _) -> failwith "unexpected success"
      | Error problem -> printf "malformed %s\n" (Problem.wire_name problem.kind));
  [%expect
    {|
    remote Invalid_argument
    remote Invalid_argument
    malformed Invalid_argument
    malformed Invalid_argument
    malformed Invalid_argument
    malformed Invalid_argument
    malformed Invalid_argument
    malformed Invalid_argument |}]
;;

let%expect_test "diagnostic envelopes bound escaped messages and typed field detail" =
  let long = String.make 1_500_000 '\001' in
  let problem =
    Problem.create Invalid_argument long
    |> fun p ->
    Problem.with_details
      p
      (Field { path = [ "params"; long ]; expected = long; suggestion = Some long })
  in
  let response =
    Protocol.error_response_json
      ~id:(Json.string "mine")
      ~code:Application_failure
      problem
  in
  let bytes = Json.canonical response in
  let problem =
    Json.field (Json.field response "error") "data" |> Problem_wire.of_json |> Disk.unwrap
  in
  printf
    "bounded=%b typed=%b message_truncated=%b\n"
    (String.length bytes <= 65536)
    (match problem.details with
     | Some (Field _) -> true
     | _ -> false)
    (String.is_suffix problem.message ~suffix:"...");
  (match problem.details with
   | Some (Field { path; expected; suggestion }) ->
     printf
       "outer=%s inner_bytes=%d expected_bytes=%d suggestion_bytes=%d\n"
       (List.hd_exn path)
       (String.length (List.nth_exn path 1))
       (String.length expected)
       (String.length (Option.value_exn suggestion))
   | _ -> failwith "typed field detail lost");
  List.iter
    [ Json.obj [ "id", Json.string "kept"; "unexpected", `True ]
    ; Json.obj [ "id", `Number "7" ]
    ; Json.obj [ "id", Json.string "a"; "id", Json.string "b" ]
    ; Json.obj [ "id", Json.string (String.make 257 'x') ]
    ; Json.obj [ "id", `Number "1e999" ]
    ; Json.obj [ "id", `Number ("0." ^ String.make 1_500_000 '0' ^ "1") ]
    ]
    ~f:(fun json ->
      printf
        "%s\n"
        (Option.value_map
           (Protocol.server_request_id json)
           ~default:"invalid ID"
           ~f:Json.canonical));
  let numeric_request zeroes =
    Json.obj
      [ "jsonrpc", Json.string "2.0"
      ; "workgraph_api", Current_format.value Application_api
      ; "id", `Number ("0." ^ String.make zeroes '0' ^ "1")
      ; "method", Json.string "daemon.health"
      ]
  in
  printf
    "numeric boundary accepted=%b oversized rejected=%b\n"
    (Result.is_ok (Protocol.validate_server_request (numeric_request 253)))
    (Result.is_error (Protocol.validate_server_request (numeric_request 1_500_000)));
  [%expect
    {|
    bounded=true typed=true message_truncated=true
    outer=params inner_bytes=128 expected_bytes=2048 suggestion_bytes=256
    "kept"
    7
    invalid ID
    invalid ID
    invalid ID
    invalid ID
    numeric boundary accepted=true oversized rejected=true |}]
;;

let%expect_test "v1 error names are fixed, round trip, and reject code mismatches" =
  let request =
    Protocol.Request.create ~id:"fixture" ~method_:"initialize" ~params:(Json.obj [])
    |> Disk.unwrap
  in
  let cases =
    [ "Invalid_argument", Problem.Invalid_argument
    ; "Not_found", Not_found
    ; "Conflict", Conflict
    ; "Blocked", Blocked
    ; "Dependency_cycle", Dependency_cycle
    ; "Already_claimed", Already_claimed
    ; "Stale_claim", Stale_claim
    ; "Idempotency_conflict", Idempotency_conflict
    ; "Corrupt_store", Corrupt_store
    ; "Storage_unavailable", Storage_unavailable
    ; "Outcome_unknown", Outcome_unknown
    ; "Workspace_closed", Workspace_closed
    ; "Unsupported_version", Unsupported_version
    ]
  in
  List.iter cases ~f:(fun (name, kind) ->
    let encoded =
      Protocol.response_json request (Failure (Problem.create kind "fixture"))
    in
    let actual =
      Json.field (Json.field (Json.field encoded "error") "data") "kind" |> Json.text
    in
    if not (String.equal name actual) then failwith "changed wire error name";
    match Protocol.decode_response request encoded |> Disk.unwrap with
    | Failure error when Problem.equal_kind kind error.kind -> ()
    | Failure _ | Success _ -> failwith "changed error kind");
  printf "%d fixed error names round trip\n" (List.length cases);
  List.iter [ "-32601"; "-32600"; "-32000" ] ~f:(fun code ->
    let json =
      Json.parse
        (sprintf
           {|{"jsonrpc":"2.0","id":"fixture","error":{"code":%s,"message":"x","data":{"kind":"Conflict","message":"x"}}}|}
           code)
      |> Disk.unwrap
    in
    match Protocol.decode_response request json with
    | Ok (Failure error) -> print_s [%sexp (error.kind : Problem.kind)]
    | Ok (Success _) -> assert false
    | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect
    {|
    13 fixed error names round trip
    Unsupported_version
    Invalid_argument
    Conflict |}]
;;

let%expect_test "client rejects ambiguous or mismatched response envelopes" =
  let request =
    Protocol.Request.create ~id:"mine" ~method_:"ticket.create" ~params:(Json.obj [])
    |> Disk.unwrap
  in
  let report bytes =
    match Protocol.decode_response request (Json.parse bytes |> Disk.unwrap) with
    | Ok (Success _) -> print_endline "success"
    | Ok (Failure error) ->
      printf "remote %s\n" (Sexp.to_string (Problem.sexp_of_kind error.kind))
    | Error error -> print_s [%sexp (error.kind : Problem.kind)]
  in
  report {|{"jsonrpc":"2.0","id":"mine","result":{"data":{},"meta":{}}}|};
  report {|{"jsonrpc":"2.0","id":"other","result":{}}|};
  report {|{"jsonrpc":"2.0","id":"mine","result":{},"error":{}}|};
  report
    {|{"jsonrpc":"2.0","id":"mine","error":{"code":-32000,"message":"stale","data":{"kind":"Conflict","message":"stale"}}}|};
  report
    {|{"jsonrpc":"2.0","id":"mine","error":{"code":-32000,"message":"new","data":{"kind":"Future_error","message":"new"}}}|};
  [%expect
    {|
    success
    Invalid_argument
    Invalid_argument
    remote Conflict
    Unsupported_version |}]
;;

let%expect_test "typed wire mutation preserves nullable clears and optional patches" =
  let id = Id.Ticket.of_string "ticket" |> Disk.unwrap in
  let method_, params =
    Wire_command.encode
      (Ticket_metadata
         { id
         ; expected_revision = 7
         ; priority = None
         ; assignee = Some None
         ; labels = Some []
         ; acceptance_criteria = None
         ; status_id = None
         })
    |> Disk.unwrap
  in
  print_endline method_;
  print_endline (Json.canonical params);
  let method_, params =
    Wire_command.encode
      (Comment_add
         { id = None
         ; target = Workspace
         ; reply_to = None
         ; kind = Decision
         ; body = "Preserve history"
         })
    |> Disk.unwrap
  in
  print_endline method_;
  print_endline (Json.canonical params);
  [%expect
    {|
    ticket.metadata
    {"assignee_id":null,"expected_revision":"7","label_ids":[],"ticket_id":"ticket"}
    comment.add
    {"body":"Preserve history","kind":"decision","target":{"kind":"workspace"}} |}]
;;
