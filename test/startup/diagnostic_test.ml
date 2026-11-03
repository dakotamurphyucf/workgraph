open Core
open Workgraph

let%expect_test "socket competition survives transport and validates public details" =
  let request =
    Protocol.Request.create ~id:"health" ~method_:"daemon.health" ~params:(`Object [])
    |> Disk.unwrap
  in
  let problem =
    Problem.with_details
      (Problem.create Conflict "wording may change")
      (Socket_owner { socket_path = "/tmp/workgraph.sock" })
  in
  (match
     Protocol.decode_response request (Protocol.response_json request (Failure problem))
     |> Disk.unwrap
   with
   | Failure restored -> print_endline (Json.canonical (Problem.to_json restored))
   | Success _ -> assert false);
  List.iter
    [ {|{"type":"socket_owner"}|}
    ; {|{"type":"socket_owner","socket_path":123}|}
    ; {|{"type":"socket_owner","socket_path":"/tmp/s","extra":true}|}
    ]
    ~f:(fun text ->
      match Api_codec.decode Problem_wire.details (Json.parse text |> Disk.unwrap) with
      | Ok _ -> print_endline "unexpectedly accepted"
      | Error problem -> print_endline problem.message);
  [%expect
    {|
    {"details":{"socket_path":"/tmp/workgraph.sock","type":"socket_owner"},"kind":"Conflict","message":"wording may change"}
    /socket_path: missing field: socket_path
    /socket_path: expected string
    /extra: unknown field
    |}]
;;
