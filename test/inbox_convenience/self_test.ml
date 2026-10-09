open Core
open Workgraph

let context run =
  Cli_context.of_json
    (Json.obj
       ([ "socket", Json.string "/tmp/workgraph-self.sock"
        ; "workspace_id", Json.string "work"
        ; "actor_id", Json.string "alice"
        ]
        @ Option.to_list (Option.map run ~f:(fun run -> "run_id", Json.string run))))
  |> Disk.unwrap
;;

let print = function
  | Ok fields -> print_endline (Json.canonical (Json.obj fields))
  | Error error -> print_endline error.Problem.message
;;

let%expect_test "self addressing is explicit and explicit selectors override context" =
  let current = Some (context (Some "run")) in
  print (Cli_context.apply_self current ~method_:"inbox.read" ~fields:[]);
  print (Cli_context.apply_self current ~method_:"run.get" ~fields:[]);
  print
    (Cli_context.apply_self
       None
       ~method_:"inbox.read"
       ~fields:
         [ "recipient", Json.obj [ "kind", Json.string "actor"; "id", Json.string "bob" ]
         ]);
  print
    (Cli_context.apply_self
       None
       ~method_:"run.get"
       ~fields:[ "target_run_id", Json.string "explicit" ]);
  print (Cli_context.apply_self None ~method_:"inbox.read" ~fields:[]);
  print (Cli_context.apply_self (Some (context None)) ~method_:"run.get" ~fields:[]);
  print (Cli_context.apply_self current ~method_:"request.reassign" ~fields:[]);
  print (Cli_context.apply_self current ~method_:"run.register" ~fields:[]);
  [%expect
    {|
    {"recipient":{"id":"alice","kind":"actor"}}
    {"target_run_id":"run"}
    {"recipient":{"id":"bob","kind":"actor"}}
    {"target_run_id":"explicit"}
    --self for inbox.read requires --context; supply an explicit recipient instead
    --self for run.get requires run_id in --context; supply --target-run-id instead
    --self is unsupported for request.reassign; supply explicit selectors
    --self is unsupported for run.register; supply explicit selectors
    |}]
;;

let%expect_test
    "inbox self filter is optional typed Boolean and long poll cap is explicit"
  =
  let params fields =
    Json.obj
      ([ "consumer_id", Json.string "consumer"
       ; "recipient", Json.obj [ "kind", Json.string "actor"; "id", Json.string "alice" ]
       ]
       @ fields)
  in
  let query =
    Api_codec.decode Communication_inbox.Query.read_codec (params []) |> Disk.unwrap
  in
  print_s [%sexp (Communication_inbox.Query.exclude_self query : bool)];
  let query =
    Api_codec.decode
      Communication_inbox.Query.read_codec
      (params [ "exclude_self", `True ])
    |> Disk.unwrap
  in
  print_s [%sexp (Communication_inbox.Query.exclude_self query : bool)];
  List.iter
    [ Api_codec.decode
        Communication_inbox.Query.read_codec
        (params [ "exclude_self", Json.string "true" ])
    ; Api_codec.decode
        Communication_inbox.Query.wait_codec
        (params [ "timeout_ms", Json.int 25_001 ])
    ; Api_codec.decode
        Communication_inbox.Query.wait_codec
        (params [ "timeout_ms", `True ])
    ]
    ~f:(function
      | Error error -> print_endline error.Problem.message
      | Ok _ -> failwith "invalid inbox parameter accepted");
  [%expect
    {|
    false
    true
    /exclude_self: expected boolean
    /timeout_ms: expected canonical decimal string in 0..25000; inbox.wait timeout_ms: 25-second server cap (1..25000 milliseconds)
    /timeout_ms: expected canonical decimal string in 0..25000; inbox.wait timeout_ms: 25-second server cap (1..25000 milliseconds)
    |}]
;;
