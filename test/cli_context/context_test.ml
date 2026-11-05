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
    ; "transaction.preflight"
    ; "transaction.apply"
    ; "ticket.create"
    ; "workspace.create"
    ; "upload.chunk"
    ; "upload.status"
    ; "upload.list"
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
    transaction.preflight {"actor_id":"worker","run_id":"run","workspace_id":"explicit"}
    transaction.apply {"actor_id":"worker","run_id":"run","workspace_id":"explicit"}
    ticket.create {"actor_id":"worker","run_id":"run","workspace_id":"explicit"}
    workspace.create {"actor_id":"worker","workspace_id":"explicit"}
    upload.chunk {"actor_id":"worker","workspace_id":"explicit"}
    upload.status {"actor_id":"worker","workspace_id":"explicit"}
    upload.list {"workspace_id":"explicit"}
    resource.upload {"actor_id":"worker","run_id":"run","workspace_id":"explicit"}
    resource.download {"workspace_id":"explicit"}
    unknown.method {"workspace_id":"explicit"} |}]
;;

let%expect_test "preflight intended writer defaults preserve explicit attribution" =
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
  Cli_context.apply
    context
    ~method_:"transaction.preflight"
    ~fields:[ "actor_id", Json.string "other"; "run_id", Json.string "other-run" ]
  |> Json.obj
  |> Json.canonical
  |> print_endline;
  let observer =
    Cli_context.of_json
      (Json.obj [ "socket", Json.string "/tmp/s"; "workspace_id", Json.string "demo" ])
    |> Disk.unwrap
  in
  print_s
    [%sexp
      (Result.is_error
         (Json.decode (fun () ->
            Cli_context.apply observer ~method_:"transaction.preflight" ~fields:[]))
       : bool)];
  Cli_context.apply
    observer
    ~method_:"transaction.preflight"
    ~fields:[ "actor_id", Json.string "explicit" ]
  |> Json.obj
  |> Json.canonical
  |> print_endline;
  [%expect
    {|
    {"actor_id":"other","run_id":"other-run","workspace_id":"demo"}
    true
    {"actor_id":"explicit","workspace_id":"demo"}
    |}]
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

let%expect_test "reservation self selects ownership independently of attribution" =
  let context =
    Cli_context.of_json
      (Json.obj
         [ "socket", Json.string "/tmp/s"
         ; "workspace_id", Json.string "demo"
         ; "actor_id", Json.string "worker"
         ; "run_id", Json.string "owner-run"
         ])
    |> Disk.unwrap
  in
  List.iter [ "reservation.acquire"; "reservation.paths.acquire" ] ~f:(fun method_ ->
    Cli_context.apply context ~method_ ~fields:[]
    |> Json.obj
    |> Json.canonical
    |> print_endline;
    let fields =
      Cli_context.apply_self
        (Some context)
        ~method_
        ~fields:[ "run_id", Json.string "invocation-run" ]
      |> Disk.unwrap
    in
    Cli_context.apply context ~method_ ~fields
    |> Json.obj
    |> Json.canonical
    |> print_endline;
    Cli_context.apply_self
      None
      ~method_
      ~fields:[ "target_run_id", Json.string "explicit-owner" ]
    |> Disk.unwrap
    |> Json.obj
    |> Json.canonical
    |> print_endline);
  [%expect
    {|
    {"actor_id":"worker","run_id":"owner-run","workspace_id":"demo"}
    {"actor_id":"worker","run_id":"invocation-run","target_run_id":"owner-run","workspace_id":"demo"}
    {"target_run_id":"explicit-owner"}
    {"actor_id":"worker","run_id":"owner-run","workspace_id":"demo"}
    {"actor_id":"worker","run_id":"invocation-run","target_run_id":"owner-run","workspace_id":"demo"}
    {"target_run_id":"explicit-owner"}
    |}]
;;

let%expect_test "reservation self requires actionable run context" =
  let actor_only =
    Cli_context.of_json
      (Json.obj
         [ "socket", Json.string "/tmp/s"
         ; "workspace_id", Json.string "demo"
         ; "actor_id", Json.string "worker"
         ])
    |> Disk.unwrap
  in
  List.iter [ "reservation.acquire"; "reservation.paths.acquire" ] ~f:(fun method_ ->
    List.iter [ None; Some actor_only ] ~f:(fun context ->
      match Cli_context.apply_self context ~method_ ~fields:[] with
      | Ok _ -> print_endline "unexpected success"
      | Error error ->
        print_s [%sexp (error.kind : Problem.kind), (error.message : string)]));
  [%expect
    {|
    (Invalid_argument
     "--self for reservation.acquire requires --context; supply an explicit target_run_id instead")
    (Invalid_argument
     "--self for reservation.acquire requires run_id in --context; supply --target-run-id instead")
    (Invalid_argument
     "--self for reservation.paths.acquire requires --context; supply an explicit target_run_id instead")
    (Invalid_argument
     "--self for reservation.paths.acquire requires run_id in --context; supply --target-run-id instead")
    |}]
;;
