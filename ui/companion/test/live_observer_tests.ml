open Core
open Workgraph
open Workgraph_ui
open State_tests

let plan ?(cursor = `Null) ?(history = true) ?(wait = false) () =
  Live_observer.Plan.of_json
    (Json.obj
       [ "workspace_id", Json.string "w"
       ; "planning_cursor", cursor
       ; ("history", if history then `True else `False)
       ; ("history_cursor", if history then cursor else `Null)
       ; ("wait", if wait then `True else `False)
       ; "runtime", `False
       ; "runtime_signature", `Null
       ])
  |> Disk.unwrap
;;

let reply request =
  let params = Protocol.Request.params request in
  let source = Json.field params "source" in
  let cursor = Json.text source ^ "-cursor" in
  let data =
    Json.obj
      [ "source", source
      ; "through", Json.int 7
      ; "items", `Array []
      ; "cursor", Json.string cursor
      ; "has_more", `False
      ; "needs_larger_budget", `False
      ]
  in
  Some (Protocol.Success (Api_response.project Value data |> Api_response.to_json))
;;

let%expect_test "combined bootstrap establishes exact native heads for both feeds" =
  let calls = ref [] in
  Rpc_socket_test.with_bridge
    (fun request ->
       calls := Protocol.Request.params request :: !calls;
       reply request)
    (fun env _ _ _ profile ->
       let observer =
         Live_observer.create ~net:(Eio.Stdenv.net env) ~clock:(Eio.Stdenv.mono_clock env)
       in
       let result =
         Live_observer.observe observer ~connection:profile (plan ()) |> Disk.unwrap
       in
       print_endline (Json.text (Json.field result "workspace_id"));
       List.iter [ "planning"; "history" ] ~f:(fun source ->
         let requests =
           List.filter !calls ~f:(fun p ->
             String.equal (Json.text (Json.field p "source")) source)
         in
         print_s
           [%sexp
             (source : string)
           , (List.length requests : int)
           , (List.exists requests ~f:(fun p ->
                Option.exists (Json.optional p "after") ~f:(fun n -> Json.integer n = 7))
              : bool)]);
       print_endline (Json.canonical result));
  [%expect
    {|w
(planning 2 true)
(history 2 true)
{"history":{"cursor":"history-cursor","has_more":false,"items":[],"needs_larger_budget":false,"source":"history","through":"7"},"planning":{"cursor":"planning-cursor","has_more":false,"items":[],"needs_larger_budget":false,"source":"planning","through":"7"},"runtime_changed":false,"runtime_signature":null,"workspace_id":"w"}|}]
;;

let%expect_test "invalid plans reject before I/O" =
  let input =
    Json.obj
      [ "workspace_id", Json.string "w"
      ; "planning_cursor", Json.string ""
      ; "history", `False
      ; "history_cursor", `Null
      ; "wait", `True
      ; "runtime", `False
      ; "runtime_signature", `Null
      ]
  in
  problem (Live_observer.Plan.of_json input);
  problem (Live_observer.Plan.of_json (Json.obj [ "unknown", `Null ]));
  [%expect
    {|Invalid_argument
Invalid_argument|}]
;;

let%expect_test
    "more than two observers wait concurrently; cancellation restores all capacity"
  =
  let waits = ref 0 in
  let signal = Eio.Condition.create () in
  let release = ref false in
  Rpc_socket_test.with_bridge
    (fun request ->
       if String.equal (Protocol.Request.method_ request) "changes.wait"
       then (
         incr waits;
         Eio.Condition.loop_no_mutex signal (fun () -> if !release then Some () else None);
         None)
       else reply request)
    (fun env _ _ _ profile ->
       let observer =
         Live_observer.create ~net:(Eio.Stdenv.net env) ~clock:(Eio.Stdenv.mono_clock env)
       in
       let pending = plan ~cursor:(Json.string "existing") ~history:true ~wait:true () in
       Eio.Fiber.first
         (fun () ->
            Eio.Switch.run (fun sw ->
              for _ = 1 to 16 do
                Eio.Fiber.fork ~sw (fun () ->
                  ignore
                    (Live_observer.observe observer ~connection:profile pending
                     : (Jsonaf.t, Problem.t) Result.t))
              done;
              Eio.Fiber.await_cancel ()))
         (fun () ->
            Rpc_socket_test.until env (fun () -> !waits = 32);
            print_s [%sexp (!waits : int)];
            problem (Live_observer.observe observer ~connection:profile pending));
       release := true;
       Eio.Condition.broadcast signal;
       ignore
         (Live_observer.observe observer ~connection:profile (plan ~history:false ())
          |> Disk.unwrap
          : Jsonaf.t);
       print_endline "capacity restored");
  [%expect
    {|32
Blocked
capacity restored|}]
;;

let%expect_test "advisory warning changes invalidate once while increasing ages do not" =
  let clock = ref 400000L in
  let warning = ref true in
  Rpc_socket_test.with_bridge
    (fun request ->
       if not (String.equal (Protocol.Request.method_ request) "coordinator.overview")
       then reply request
       else (
         let items =
           if not !warning
           then []
           else
             [ Coordinator_wire.Item.Stale_run
                 { run_id = Id.Run.of_string "run" |> Disk.unwrap
                 ; metadata =
                     { status = Running
                     ; last_observed_unix_ms = Some 1L
                     ; liveness = Stale
                     ; observation_age_ms = Some Int64.(!clock - one)
                     ; clock_regressed = false
                     ; held_work =
                         { ticket_claim_count = 0
                         ; named_reservation_count = 0
                         ; path_reservation_count = 0
                         ; active_attempt_count = 0
                         }
                     }
                 }
             ]
         in
         let page : Coordinator_wire.Response.t =
           { workspace_id = Id.Workspace.of_string "w" |> Disk.unwrap
           ; captured_now_unix_ms = !clock
           ; items
           ; next_cursor = None
           ; omitted = 0
           ; needs_larger_budget = false
           ; next_item_source = None
           ; required_bytes = None
           ; dependency_path = None
           ; dependency_path_omitted = 0
           }
         in
         let data =
           Api_codec.encode Coordinator_wire.Response.codec page |> Disk.unwrap
         in
         Some (Protocol.Success (Api_response.project Value data |> Api_response.to_json))))
    (fun env _ _ _ profile ->
       let observer =
         Live_observer.create ~net:(Eio.Stdenv.net env) ~clock:(Eio.Stdenv.mono_clock env)
       in
       let observe signature =
         let input =
           Json.obj
             [ "workspace_id", Json.string "w"
             ; "planning_cursor", Json.string "existing"
             ; "history", `False
             ; "history_cursor", `Null
             ; "wait", `False
             ; "runtime", `True
             ; "runtime_signature", signature
             ]
         in
         let plan = Live_observer.Plan.of_json input |> Disk.unwrap in
         Live_observer.observe observer ~connection:profile plan |> Disk.unwrap
       in
       let initial = observe `Null in
       clock := 425000L;
       let next = observe (Json.field initial "runtime_signature") in
       print_endline (Json.canonical (Json.field next "runtime_changed"));
       warning := false;
       let next = observe (Json.field next "runtime_signature") in
       print_endline (Json.canonical (Json.field next "runtime_changed")));
  [%expect
    {|false
true|}]
;;
