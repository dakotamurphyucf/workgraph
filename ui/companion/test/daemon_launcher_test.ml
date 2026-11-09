open Core
open Workgraph
open Workgraph_ui
open State_tests

let identity = Operation.Id.of_string "launch-intention" |> Disk.unwrap
let observer = Daemon_launcher.Context.create ~workspace:None ~project:None ~writer:None

let plan
      root
      ?(context = observer)
      ?(registry = "registry")
      ?(socket = "/tmp/wg-launch-absent.sock")
      ?(intention_id = identity)
      ()
  =
  Daemon_launcher.Plan.create
    ~intention_id
    ~connection:(profile ~socket ())
    ~context
    ~registry:(State_root.path root ^ "/" ^ registry)
    ~log:(State_root.path root ^ "/startup.log")
    ~timeout_seconds:1
  |> Disk.unwrap
;;

let script env root name body =
  let path = State_root.path root ^ "/" ^ name in
  Eio.Path.save
    ~create:(`Exclusive 0o700)
    Eio.Path.(Eio.Stdenv.fs env / path)
    ("#!/bin/sh\n" ^ body);
  path
;;

let version_script env root body =
  script
    env
    root
    "paired-core"
    ("if [ \"$1\" = --version ]; then printf '%s\\n' '"
     ^ Version.value
     ^ "'; exit 0; fi\n"
     ^ body)
;;

let status launch =
  Json.field (Daemon_launcher.Launch.to_json launch) "state"
  |> fun state -> Json.field state "status" |> Json.text
;;

let inspect launcher =
  Daemon_launcher.inspect launcher ~intention_id:identity |> Disk.unwrap
;;

let stored_plan plan state =
  Json.obj
    [ "format", Json.string "ui-daemon-launch-1"
    ; "plan", Json.string (Json.canonical (Daemon_launcher.Plan.to_json plan))
    ; "executable", Json.string "/missing/paired-core"
    ; "revision", Json.string "7"
    ; "state", Json.string (Json.canonical state)
    ; "diagnostic", `Null
    ]
;;

let%expect_test
    "observer context is nullable and every captured field participates in intention \
     equality"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let launcher =
        Daemon_launcher.create ~sw ~env ~root ~executable:"/missing/paired-core"
        |> Disk.unwrap
      in
      let input = plan root () in
      ignore
        (Daemon_launcher.prepare launcher input |> Disk.unwrap : Daemon_launcher.Launch.t);
      let changed =
        [ plan root ~registry:"other" ()
        ; plan
            root
            ~context:
              (Daemon_launcher.Context.create
                 ~workspace:(Some (Id.Workspace.of_string "other" |> Disk.unwrap))
                 ~project:None
                 ~writer:None)
            ()
        ; plan
            root
            ~context:
              (Daemon_launcher.Context.create
                 ~workspace:None
                 ~project:None
                 ~writer:
                   (Some
                      (Writer.create
                         ~actor:(Id.Actor.of_string "actor" |> Disk.unwrap)
                         ~run:None)))
            ()
        ]
      in
      List.iter changed ~f:(fun input -> problem (Daemon_launcher.prepare launcher input));
      printf
        "observer=%s retained=%s\n"
        (Json.canonical (Daemon_launcher.Context.to_json observer))
        (status (inspect launcher));
      problem
        (Daemon_launcher.Context.of_json
           (json {|{"workspace_id":null,"project_id":null,"writer":null,"extra":true}|}))));
  [%expect
    {| 
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    observer={"project_id":null,"workspace_id":null,"writer":null} retained=prepared_unsent
    Invalid_argument
    |}]
;;

let%expect_test
    "independent Starting and Ready storage fixtures survive two reloads with monotone \
     revision"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let input = plan root () in
      State_root.save
        root
        ~name:"launch-launch-intention.json"
        ~value:(stored_plan input (json {|{"status":"starting"}|}))
      |> Disk.unwrap;
      let load () =
        Daemon_launcher.create ~sw ~env ~root ~executable:"/missing/paired-core"
        |> Disk.unwrap
        |> inspect
      in
      List.iter
        [ load (); load () ]
        ~f:(fun launch ->
          printf
            "%s %s\n"
            (status launch)
            (Json.field (Daemon_launcher.Launch.to_json launch) "revision" |> Json.text));
      let listing =
        {|{"data":{"registry_requires_restart":false,"pending_creates":"0","pending_restores":"0","active_exports":"0","workspaces":[]},"meta":{}}|}
      in
      let state =
        Json.obj
          [ "status", Json.string "ready"
          ; "observation", Json.string "startup_attempt_observed_ready"
          ; "ownership", Json.string "unknown"
          ; "listing", Json.string listing
          ]
      in
      State_root.save
        root
        ~name:"launch-launch-intention.json"
        ~value:(stored_plan input state)
      |> Disk.unwrap;
      List.iter
        [ load (); load () ]
        ~f:(fun launch ->
          printf
            "%s %s\n"
            (status launch)
            (Json.field (Daemon_launcher.Launch.to_json launch) "revision" |> Json.text))));
  [%expect
    {| 
    outcome_unknown 8
    outcome_unknown 8
    ready 7
    ready 7
    |}]
;;

let%expect_test
    "unpublished plans are hidden and a failed startup barrier cannot spawn or expose \
     unsent"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let executable =
        version_script env root "printf spawned > \"$2/spawned\"\nexit 1\n"
      in
      let launcher = Daemon_launcher.create ~sw ~env ~root ~executable |> Disk.unwrap in
      ignore
        (Daemon_launcher.prepare launcher (plan root ()) |> Disk.unwrap
         : Daemon_launcher.Launch.t);
      Eio.Path.unlink Eio.Path.(State_root.directory root / ".owner.lock");
      problem (Daemon_launcher.start launcher ~intention_id:identity ~retry:false);
      printf
        "retained=%s spawned=%b\n"
        (status (inspect launcher))
        (match
           Eio.Path.kind
             ~follow:false
             Eio.Path.(State_root.directory root / "registry" / "spawned")
         with
         | `Not_found -> false
         | _ -> true)));
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let launcher =
        Daemon_launcher.create ~sw ~env ~root ~executable:"/missing/paired-core"
        |> Disk.unwrap
      in
      Eio.Path.unlink Eio.Path.(State_root.directory root / ".owner.lock");
      problem (Daemon_launcher.prepare launcher (plan root ()));
      problem (Daemon_launcher.inspect launcher ~intention_id:identity);
      printf "published=%d\n" (List.length (Daemon_launcher.list launcher))));
  [%expect
    {| 
    Storage_unavailable
    retained=outcome_unknown spawned=false
    Storage_unavailable
    Conflict
    published=0
    |}]
;;

let%expect_test
    "missing, mismatched and oversized version probes disable only local startup"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let wrong = script env root "wrong-version" "printf 'another-version\\n'\n" in
      let large =
        script
          env
          root
          "oversized-version"
          ("printf '%s' '" ^ String.make 2000 'x' ^ "'\n")
      in
      List.iter [ "/missing/paired-core"; wrong; large ] ~f:(fun executable ->
        let launcher = Daemon_launcher.create ~sw ~env ~root ~executable |> Disk.unwrap in
        let capabilities = Daemon_launcher.capabilities launcher in
        printf "available=%s " (Json.canonical (Json.field capabilities "available"));
        let issue =
          Json.field capabilities "problem" |> Problem_wire.of_json |> Disk.unwrap
        in
        print_s [%sexp (issue.kind : Problem.kind)])));
  [%expect
    {| 
    available=false Storage_unavailable
    available=false Unsupported_version
    available=false Invalid_argument
    |}]
;;

let until env predicate =
  Eio.Time.Timeout.run_exn
    (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 5.)
    (fun () ->
       while not (predicate ()) do
         Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.005
       done)
;;

let present path =
  match Eio.Path.kind ~follow:false path with
  | `Not_found -> false
  | _ -> true
;;

let%expect_test "version probe cancellation propagates and a hanging probe is bounded" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let marker = State_root.path root ^ "/probe-started" in
      let executable =
        script
          env
          root
          "hanging-core"
          ("printf started > '" ^ marker ^ "'\nexec /bin/sleep 30\n")
      in
      let launcher = Daemon_launcher.create ~sw ~env ~root ~executable |> Disk.unwrap in
      Eio.Fiber.first
        (fun () ->
           ignore (Daemon_launcher.capabilities launcher : Jsonaf.t);
           failwith "cancelled version probe returned a domain result")
        (fun () ->
           until env (fun () ->
             present Eio.Path.(State_root.directory root / "probe-started")));
      print_endline "cancelled observer propagated";
      let capabilities = Daemon_launcher.capabilities launcher in
      let problem =
        Json.field capabilities "problem" |> Problem_wire.of_json |> Disk.unwrap
      in
      printf
        "timeout=%b available=%s\n"
        (Problem.equal_kind problem.kind Storage_unavailable)
        (Json.canonical (Json.field capabilities "available"))));
  [%expect
    {|
    cancelled observer propagated
    timeout=true available=false
    |}]
;;

let%expect_test
    "eight service-owned startup flights bound probing and coalesce at capacity"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let marker = State_root.path root ^ "/probes" in
      let executable =
        script
          env
          root
          "hanging-core"
          ("printf x >> '" ^ marker ^ "'\nexec /bin/sleep 30\n")
      in
      let launcher = Daemon_launcher.create ~sw ~env ~root ~executable |> Disk.unwrap in
      let ids =
        List.init 9 ~f:(fun index ->
          Operation.Id.of_string ("bounded-" ^ Int.to_string index) |> Disk.unwrap)
      in
      List.iter ids ~f:(fun intention_id ->
        ignore
          (Daemon_launcher.prepare launcher (plan root ~intention_id ()) |> Disk.unwrap
           : Daemon_launcher.Launch.t));
      let finished =
        List.take ids 8
        |> List.map ~f:(fun intention_id ->
          let finished, resolve = Eio.Promise.create () in
          Eio.Fiber.fork ~sw (fun () ->
            Eio.Promise.resolve
              resolve
              (Daemon_launcher.start launcher ~intention_id ~retry:false));
          finished)
      in
      until env (fun () ->
        let path = Eio.Path.(State_root.directory root / "probes") in
        present path && String.length (Disk.read path) = 8);
      problem
        (Daemon_launcher.start launcher ~intention_id:(List.last_exn ids) ~retry:false);
      let coalesced, resolve = Eio.Promise.create () in
      Eio.Fiber.fork ~sw (fun () ->
        Eio.Promise.resolve
          resolve
          (Daemon_launcher.start launcher ~intention_id:(List.hd_exn ids) ~retry:false));
      List.iter finished ~f:(fun promise ->
        ignore
          (Eio.Promise.await promise : (Daemon_launcher.Launch.t, Problem.t) Result.t));
      problem (Eio.Promise.await coalesced);
      printf
        "probes=%d last=%s\n"
        (String.length (Disk.read Eio.Path.(State_root.directory root / "probes")))
        (Daemon_launcher.inspect launcher ~intention_id:(List.last_exn ids)
         |> Disk.unwrap
         |> status)));
  [%expect
    {|
    Blocked
    Storage_unavailable
    probes=8 last=prepared_unsent
    |}]
;;

let%expect_test
    "competing readiness precedes child exit without proving ownership; final sync fault \
     retains observation"
  =
  List.iter [ false; true ] ~f:(fun final_fault ->
    with_root (fun env root ->
      Eio.Switch.run (fun sw ->
        let base = State_root.path root in
        let release = Eio.Path.(State_root.directory root / "release-child") in
        let exited = Eio.Path.(State_root.directory root / "child-exited") in
        let executable =
          version_script
            env
            root
            (sprintf
               "printf started > '%s/child-started'\n\
                while [ ! -f '%s/release-child' ]; do /bin/sleep 0.01; done\n\
                printf exited > '%s/child-exited'\n\
                exit 42\n"
               base
               base
               base)
        in
        let socket = base ^ "/s" in
        let listener =
          Platform.listen_unix ~sw ~path:socket ~backlog:8 ~on_cleanup_error:failwith
        in
        let stop, stop_resolve = Eio.Promise.create () in
        let requests = ref 0 in
        let listing =
          json
            {|{"data":{"registry_requires_restart":false,"pending_creates":"0","pending_restores":"0","active_exports":"0","workspaces":[]},"meta":{}}|}
        in
        Eio.Fiber.fork ~sw (fun () ->
          Eio.Net.run_server ~stop ~on_error:raise listener (fun flow _ ->
            let request = Framing.read flow |> Protocol.Request.of_json |> Disk.unwrap in
            if String.equal (Protocol.Request.method_ request) "initialize"
            then
              Framing.write
                flow
                (Protocol.response_json request (Rpc_socket_test.initialization ()))
            else (
              assert (String.equal (Protocol.Request.method_ request) "workspace.list");
              incr requests;
              if !requests > 1
              then (
                until env (fun () ->
                  present Eio.Path.(State_root.directory root / "child-started"));
                if final_fault
                then Eio.Path.unlink Eio.Path.(State_root.directory root / ".owner.lock");
                Framing.write flow (Protocol.response_json request (Success listing))))));
        Exn.protect
          ~finally:(fun () ->
            Eio.Path.save ~create:(`If_missing 0o600) release "release";
            until env (fun () -> present exited);
            Eio.Promise.resolve stop_resolve ())
          ~f:(fun () ->
            let launcher =
              Daemon_launcher.create ~sw ~env ~root ~executable |> Disk.unwrap
            in
            ignore
              (Daemon_launcher.prepare launcher (plan root ~socket ()) |> Disk.unwrap
               : Daemon_launcher.Launch.t);
            ignore
              (Daemon_launcher.start launcher ~intention_id:identity ~retry:false
               |> Disk.unwrap
               : Daemon_launcher.Launch.t);
            until env (fun () ->
              let observed = Daemon_launcher.Launch.to_json (inspect launcher) in
              String.equal (status (inspect launcher)) "ready"
              && ((not final_fault)
                  ||
                  match Json.field observed "diagnostic" with
                  | `Null -> false
                  | _ -> true));
            let observation = Daemon_launcher.Launch.to_json (inspect launcher) in
            printf
              "fault=%b state=%s ownership=%s child_exited=%b diagnostic=%b\n"
              final_fault
              (Json.field (Json.field observation "state") "observation" |> Json.text)
              (Json.field (Json.field observation "state") "ownership" |> Json.text)
              (present exited)
              (match Json.field observation "diagnostic" with
               | `Null -> false
               | _ -> true)))));
  [%expect
    {|
    fault=false state=startup_attempt_observed_ready ownership=unknown child_exited=false diagnostic=false
    fault=true state=startup_attempt_observed_ready ownership=unknown child_exited=false diagnostic=true
    |}]
;;
