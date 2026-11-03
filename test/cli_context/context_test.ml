open Core
open Workgraph

let%expect_test "context decoders reject malformed durable defaults" =
  let base =
    [ "socket", Json.string "/tmp/workgraph.sock"
    ; "workspace_id", Json.string "demo"
    ; "actor_id", Json.string "worker"
    ]
  in
  List.iter
    [ "socket", Json.string "relative"
    ; "workspace_id", Json.string "../escape"
    ; "actor_id", Json.string ""
    ; "run_id", `Null
    ; "request_directory", Json.string "relative"
    ; "current_ticket", Json.string "hidden"
    ]
    ~f:(fun (key, value) ->
      let fields =
        (key, value) :: List.filter base ~f:(fun (name, _) -> not (String.equal key name))
      in
      match Cli_context.of_json (Json.obj fields) with
      | Ok _ -> print_endline "unexpected success"
      | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "context attribution does not become a read filter" =
  let context =
    Cli_context.of_json
      (Json.obj
         [ "socket", Json.string "/tmp/s"
         ; "workspace_id", Json.string "demo"
         ; "actor_id", Json.string "worker"
         ; "run_id", Json.string "run"
         ])
    |> Disk.unwrap
  in
  List.iter
    [ "ticket.list"
    ; "coordinator.overview"
    ; "changes.read"
    ; "ticket.create"
    ; "workspace.create"
    ; "upload.chunk"
    ; "resource.upload"
    ; "resource.download"
    ; "unknown.method"
    ]
    ~f:(fun method_ ->
      let fields =
        Cli_context.apply
          context
          ~method_
          ~fields:[ "workspace_id", Json.string "explicit" ]
      in
      print_endline (method_ ^ " " ^ Json.canonical (Json.obj fields)));
  [%expect
    {|
    ticket.list {"workspace_id":"explicit"}
    coordinator.overview {"workspace_id":"explicit"}
    changes.read {"workspace_id":"explicit"}
    ticket.create {"actor_id":"worker","run_id":"run","workspace_id":"explicit"}
    workspace.create {"actor_id":"worker","workspace_id":"explicit"}
    upload.chunk {"actor_id":"worker","workspace_id":"explicit"}
    resource.upload {"actor_id":"worker","run_id":"run","workspace_id":"explicit"}
    resource.download {"workspace_id":"explicit"}
    unknown.method {"workspace_id":"explicit"} |}]
;;

let%expect_test "explicit query selectors override context without implicit filtering" =
  let context =
    Cli_context.of_json
      (Json.obj
         [ "socket", Json.string "/tmp/s"
         ; "workspace_id", Json.string "demo"
         ; "actor_id", Json.string "worker"
         ; "run_id", Json.string "worker-run"
         ])
    |> Disk.unwrap
  in
  Cli_context.apply
    context
    ~method_:"coordinator.overview"
    ~fields:
      [ "actor_id", Json.string "selected-actor"; "run_id", Json.string "selected-run" ]
  |> Json.obj
  |> Json.canonical
  |> print_endline;
  [%expect
    {| {"actor_id":"selected-actor","run_id":"selected-run","workspace_id":"demo"} |}]
;;

let%expect_test "observer defaults omit write identity without granting a security mode" =
  let value =
    Json.obj [ "socket", Json.string "/tmp/s"; "workspace_id", Json.string "demo" ]
  in
  let context = Cli_context.of_json value |> Disk.unwrap in
  print_endline (Json.canonical (Cli_context.to_json context));
  print_endline
    (Json.canonical
       (Json.obj (Cli_context.apply context ~method_:"ticket.list" ~fields:[])));
  print_s
    [%sexp
      (Result.is_error
         (Json.decode (fun () ->
            Cli_context.apply context ~method_:"ticket.create" ~fields:[]))
       : bool)];
  print_endline
    (Json.canonical
       (Json.obj
          (Cli_context.apply
             context
             ~method_:"ticket.create"
             ~fields:[ "actor_id", Json.string "writer" ])));
  print_s
    [%sexp
      (Result.is_error
         (Cli_context.apply_self (Some context) ~method_:"inbox.read" ~fields:[])
       : bool)];
  print_s
    [%sexp
      (Result.is_error
         (Cli_context.of_json
            (Json.obj
               [ "socket", Json.string "/tmp/s"
               ; "workspace_id", Json.string "demo"
               ; "run_id", Json.string "run"
               ]))
       : bool)];
  [%expect
    {|
    {"socket":"/tmp/s","workspace_id":"demo"}
    {"workspace_id":"demo"}
    true
    {"actor_id":"writer","workspace_id":"demo"}
    true
    true
    |}]
;;
