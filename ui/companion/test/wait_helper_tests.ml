open Core
open Workgraph
open Workgraph_ui
open State_tests

let fault_fs (Eio.Resource.T (directory, ops), path) ~armed ~parent_sync ~stage_syncs =
  let fail_parent = ref false in
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let is_stage name =
    String.is_substring name ~substring:"reservation-wait-"
    && String.is_substring name ~substring:".tmp-"
  in
  let module Wrapped = struct
    include Directory

    let open_out directory ~sw ~append ~create name =
      let (Eio.Resource.T (file, file_ops)) =
        Directory.open_out directory ~sw ~append ~create name
      in
      let module File = (val Eio.Resource.get file_ops Eio.File.Pi.Write) in
      let module Wrapped_file = struct
        include File

        let sync file =
          if is_stage name then incr stage_syncs;
          if !armed && (not parent_sync) && is_stage name
          then (
            armed := false;
            Json.fail Local_io "injected stage file sync failure");
          File.sync file
        ;;
      end
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.File.Pi.Write, (module Wrapped_file))
             :: Eio.Resource.bindings file_ops) )
    ;;

    let rename directory source destination target =
      Directory.rename directory source destination target;
      if !armed && parent_sync && is_stage source then fail_parent := true
    ;;

    let open_in directory ~sw name =
      if !fail_parent
      then (
        fail_parent := false;
        armed := false;
        Json.fail Local_io "injected parent-directory sync acquisition failure");
      Directory.open_in directory ~sw name
    ;;
  end
  in
  ( Eio.Resource.T
      ( directory
      , Eio.Resource.handler
          (Eio.Resource.H (Eio.Fs.Pi.Dir, (module Wrapped)) :: Eio.Resource.bindings ops)
      )
  , path )
;;

let input ?(id = "wait") ?(target = "compiler") connection =
  Operation.Preparation.create
    ~intention_id:id
    ~connection
    ~context:(context ~run:(Some "invocation") ())
    ~method_:"reservation.acquire"
    ~params:
      (Json.obj
         [ "workspace_id", Json.string "demo"
         ; "actor_id", Json.string "author"
         ; "run_id", Json.string "invocation"
         ; "target_run_id", Json.string "waiter"
         ; ( "requests"
           , `Array
               [ Json.obj
                   [ "reservation_id", Json.string target
                   ; "mode", Json.string "exclusive"
                   ]
               ] )
         ])
  |> Disk.unwrap
;;

let plan ?id ?target connection =
  Wait_helper.Plan.create
    ~preparation:(input ?id ?target connection)
    ~timeout_ms:1000
    ~max_attempts:2
    ~wait_slice_ms:5
  |> Disk.unwrap
;;

let id = Operation.Id.of_string "wait" |> Disk.unwrap

let state job =
  Json.field (Wait_helper.Job.to_json job) "state"
  |> fun value -> Json.field value "kind" |> Json.text
;;

let inspect helper = Wait_helper.inspect helper ~id |> Disk.unwrap

let replace value key replacement =
  match value with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key replacement)
  | _ -> assert false
;;

let feed =
  json
    {|{"data":{"source":"planning","through":"5","items":[],"cursor":"cursor","has_more":false,"needs_larger_budget":false},"meta":{"workspace_revision":"5"}}|}
;;

let grant =
  json
    {|{"data":{"coordination_revision":"7","holds":[{"reservation_id":"compiler","holder":{"run_id":"waiter","actor_id":"author","token":"1","mode":"exclusive","lease":{"epoch":"1","revision":"1","duration_ms":null,"last_unix_ms":"0","deadline_unix_ms":null},"origin":{"kind":"manual"}}}]},"meta":{"workspace_revision":"5","durable":true}}|}
;;

let reads request =
  match Protocol.Request.method_ request with
  | "workspace.get" ->
    Some (Protocol.Success (json {|{"data":{},"meta":{"workspace_revision":"5"}}|}))
  | "changes.read" | "changes.wait" -> Some (Success feed)
  | _ -> None
;;

let%expect_test
    "complete plan deduplication, unsent cancellation, replay and exact journals"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
      let original = Wait_helper.prepare helper (plan (profile ())) |> Disk.unwrap in
      let same = Wait_helper.prepare helper (plan (profile ())) |> Disk.unwrap in
      printf
        "same=%b state=%s\n"
        (String.equal
           (Json.canonical (Wait_helper.Job.to_json original))
           (Json.canonical (Wait_helper.Job.to_json same)))
        (state same);
      problem (Wait_helper.prepare helper (plan ~target:"other" (profile ())));
      printf "%s\n" (Wait_helper.cancel helper ~id |> Disk.unwrap |> state);
      printf "%s\n" (Wait_helper.start helper ~id |> Disk.unwrap |> state);
      problem (Wait_helper.retry_exact helper ~id);
      let restored = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
      printf "replay=%s\n" (state (inspect restored));
      let filename = "reservation-wait-wait.json" in
      let stored =
        State_root.read root ~name:filename |> Disk.unwrap |> Option.value_exn
      in
      let initial =
        Json.field stored "initial_request"
        |> Json.text
        |> Json.parse
        |> Disk.unwrap
        |> Protocol.Request.of_json
        |> Disk.unwrap
      in
      let journal =
        Request_journal.path initial ~directory:(State_root.journal_directory root)
        |> Disk.unwrap
      in
      Eio.Path.unlink Eio.Path.(State_root.directory root / journal);
      problem (Wait_helper.create ~sw ~env ~root)));
  [%expect
    {|same=true state=prepared_unsent
Idempotency_conflict
canceled_unsent
canceled_unsent
Conflict
replay=canceled_unsent
Invalid_argument|}]
;;

let%expect_test
    "cancel racing a durable grant preserves acquisition and rejects known-success retry"
  =
  let seen, release_seen = Eio.Promise.create () in
  let release, resolve_release = Eio.Promise.create () in
  let writes = ref 0 in
  Rpc_socket_test.with_bridge
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None ->
         incr writes;
         Eio.Promise.resolve release_seen ();
         Eio.Promise.await release;
         Some (Success grant))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         printf "%s\n" (Wait_helper.start helper ~id |> Disk.unwrap |> state);
         Eio.Promise.await seen;
         printf "%s\n" (Wait_helper.cancel helper ~id |> Disk.unwrap |> state);
         problem (Wait_helper.start helper ~id);
         Eio.Promise.resolve resolve_release ();
         Rpc_socket_test.until env (fun () ->
           String.equal (state (inspect helper)) "completed");
         printf "final=%s writes=%d\n" (state (inspect helper)) !writes;
         problem (Wait_helper.retry_exact helper ~id);
         let restored = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         printf "replay=%s\n" (state (inspect restored))));
  [%expect
    {|running
running
ok
final=completed writes=1
Conflict
replay=completed|}]
;;

let%expect_test
    "uncertain reply stops, exact retry keeps bytes, and the one flight includes retry"
  =
  let writes = ref [] in
  let seen, resolve_seen = Eio.Promise.create () in
  let release, resolve_release = Eio.Promise.create () in
  Rpc_socket_test.with_bridge
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None ->
         writes := Json.canonical (Protocol.Request.to_json request) :: !writes;
         if List.length !writes = 1
         then None
         else (
           Eio.Promise.resolve resolve_seen ();
           Eio.Promise.await release;
           Some (Success grant)))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore
           (Wait_helper.prepare helper (plan ~id:"second" connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           String.equal (state (inspect helper)) "outcome_unknown");
         printf "before=%s writes=%d\n" (state (inspect helper)) (List.length !writes);
         printf "%s\n" (Wait_helper.retry_exact helper ~id |> Disk.unwrap |> state);
         Eio.Promise.await seen;
         problem
           (Wait_helper.start helper ~id:(Operation.Id.of_string "second" |> Disk.unwrap));
         Eio.Promise.resolve resolve_release ();
         Rpc_socket_test.until env (fun () ->
           String.equal (state (inspect helper)) "completed");
         printf
           "after=%s exact=%b\n"
           (state (inspect helper))
           (String.equal (List.hd_exn !writes) (List.last_exn !writes));
         printf
           "replay=%s\n"
           (Wait_helper.create ~sw ~env ~root |> Disk.unwrap |> inspect |> state)));
  [%expect
    {|before=outcome_unknown writes=1
running
Blocked
after=completed exact=true
replay=completed|}]
;;

let%expect_test "failed admission sync never exchanges and restart remains conservative" =
  let armed = ref false in
  let calls = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> fault_fs fs ~armed ~parent_sync:true ~stage_syncs:(ref 0))
    (fun _ ->
       incr calls;
       None)
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         armed := true;
         problem (Wait_helper.start helper ~id);
         printf "state=%s calls=%d\n" (state (inspect helper)) !calls;
         armed := false;
         printf "cancel=%s\n" (Wait_helper.cancel helper ~id |> Disk.unwrap |> state);
         printf
           "new=%s\n"
           (Wait_helper.prepare helper (plan ~id:"after-failure" connection)
            |> Disk.unwrap
            |> state);
         printf
           "restart=%s\n"
           (Wait_helper.create ~sw ~env ~root |> Disk.unwrap |> inspect |> state)));
  [%expect
    {|Local_io
state=outcome_unknown calls=0
cancel=outcome_unknown
new=prepared_unsent
restart=outcome_unknown|}]
;;

(* Pause a real helper metadata file sync while its service mutex is held. No
   production scheduling hook: every competing operation uses the public API. *)
let pausing_fs (Eio.Resource.T (directory, ops), path) pause =
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let module Wrapped = struct
    include Directory

    let open_out directory ~sw ~append ~create name =
      let (Eio.Resource.T (file, file_ops)) =
        Directory.open_out directory ~sw ~append ~create name
      in
      let module File = (val Eio.Resource.get file_ops Eio.File.Pi.Write) in
      let module Wrapped_file = struct
        include File

        let sync file =
          if
            String.is_substring name ~substring:"reservation-wait-"
            && String.is_substring name ~substring:".tmp-"
          then !pause ();
          File.sync file
        ;;
      end
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.File.Pi.Write, (module Wrapped_file))
             :: Eio.Resource.bindings file_ops) )
    ;;
  end
  in
  ( Eio.Resource.T
      ( directory
      , Eio.Resource.handler
          (Eio.Resource.H (Eio.Fs.Pi.Dir, (module Wrapped)) :: Eio.Resource.bindings ops)
      )
  , path )
;;

let block_next_sync pause =
  let entered, signal_entered = Eio.Promise.create () in
  let release, signal_release = Eio.Promise.create () in
  (pause
   := fun () ->
        pause := Fn.ignore;
        Eio.Promise.resolve signal_entered ();
        Eio.Promise.await release);
  entered, fun () -> Eio.Promise.resolve signal_release ()
;;

let%expect_test "queued prepared cancellation cannot be resurrected by delayed admission" =
  let pause = ref Fn.ignore in
  let writes = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> pausing_fs fs pause)
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None ->
         incr writes;
         Some (Success grant))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         let entered, release = block_next_sync pause in
         let other =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.prepare helper (plan ~id:"other" connection) |> Disk.unwrap)
         in
         Eio.Promise.await entered;
         let canceled =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.cancel helper ~id |> Disk.unwrap)
         in
         Eio.Fiber.yield ();
         let started =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.start helper ~id |> Disk.unwrap)
         in
         Eio.Fiber.yield ();
         release ();
         ignore (Eio.Promise.await_exn other : Wait_helper.Job.t);
         printf
           "cancel=%s start=%s\n"
           (Eio.Promise.await_exn canceled |> state)
           (Eio.Promise.await_exn started |> state);
         Eio.Fiber.yield ();
         printf "final=%s writes=%d\n" (state (inspect helper)) !writes));
  [%expect
    {|cancel=canceled_unsent start=canceled_unsent
final=canceled_unsent writes=0|}]
;;

let%expect_test "cancel queued before write barrier prevents an unsent acquisition" =
  let pause = ref Fn.ignore in
  let feed_seen, signal_feed = Eio.Promise.create () in
  let feed_release, release_feed = Eio.Promise.create () in
  let writes = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> pausing_fs fs pause)
    (fun request ->
       if String.equal (Protocol.Request.method_ request) "changes.read"
       then (
         Eio.Promise.resolve signal_feed ();
         Eio.Promise.await feed_release;
         Some (Success feed))
       else (
         match reads request with
         | Some response -> Some response
         | None ->
           incr writes;
           Some (Success grant)))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Eio.Promise.await feed_seen;
         let entered, release = block_next_sync pause in
         let other =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.prepare helper (plan ~id:"other" connection) |> Disk.unwrap)
         in
         Eio.Promise.await entered;
         let canceled =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.cancel helper ~id |> Disk.unwrap)
         in
         Eio.Fiber.yield ();
         Eio.Promise.resolve release_feed ();
         (* Wait until the released feed has returned and the acquisition is
           contending on the mutex behind cancellation. *)
         Eio.Fiber.yield ();
         release ();
         ignore (Eio.Promise.await_exn other : Wait_helper.Job.t);
         ignore (Eio.Promise.await_exn canceled : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           not (String.equal (state (inspect helper)) "running"));
         printf "final=%s writes=%d\n" (state (inspect helper)) !writes));
  [%expect {|final=stopped writes=0|}]
;;

let%expect_test "completion inspection waits for local publication before fresh replay" =
  let pause = ref Fn.ignore in
  let seen, signal_seen = Eio.Promise.create () in
  let grant_release, release_grant = Eio.Promise.create () in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> pausing_fs fs pause)
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None ->
         Eio.Promise.resolve signal_seen ();
         Eio.Promise.await grant_release;
         Some (Success grant))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Eio.Promise.await seen;
         let entered, release = block_next_sync pause in
         Eio.Promise.resolve release_grant ();
         Eio.Promise.await entered;
         let observed = Eio.Fiber.fork_promise ~sw (fun () -> inspect helper) in
         Eio.Fiber.yield ();
         printf "inspection_pending=%b\n" (Option.is_none (Eio.Promise.peek observed));
         release ();
         printf "observed=%s\n" (Eio.Promise.await_exn observed |> state);
         printf
           "replay=%s\n"
           (Wait_helper.create ~sw ~env ~root |> Disk.unwrap |> inspect |> state)));
  [%expect
    {|inspection_pending=true
observed=completed
replay=completed|}]
;;

let%expect_test
    "failed exact-retry started publication preserves uncertainty and service usability"
  =
  let pause = ref Fn.ignore in
  let writes = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> pausing_fs fs pause)
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None ->
         incr writes;
         None)
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           String.equal (state (inspect helper)) "outcome_unknown");
         let syncs = ref 0 in
         (pause
          := fun () ->
               incr syncs;
               if !syncs = 2
               then (
                 pause := Fn.ignore;
                 Json.fail Local_io "injected exact-retry started publication failure"));
         ignore (Wait_helper.retry_exact helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           String.equal (state (inspect helper)) "outcome_unknown");
         printf "final=%s writes=%d syncs=%d\n" (state (inspect helper)) !writes !syncs;
         printf "cancel=%s\n" (Wait_helper.cancel helper ~id |> Disk.unwrap |> state);
         printf
           "new=%s\n"
           (Wait_helper.prepare helper (plan ~id:"after-retry" connection)
            |> Disk.unwrap
            |> state)));
  [%expect
    {|final=outcome_unknown writes=1 syncs=2
cancel=outcome_unknown
new=prepared_unsent|}]
;;

let%expect_test "canceling an unsent exact retry preserves the original unknown on replay"
  =
  let pause = ref Fn.ignore in
  let writes = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> pausing_fs fs pause)
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None ->
         incr writes;
         None)
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           String.equal (state (inspect helper)) "outcome_unknown");
         let exact_journal job =
           Json.field (Wait_helper.Job.to_json job) "state"
           |> fun value -> Json.field value "exact_journal" |> Json.text
         in
         let original = exact_journal (inspect helper) in
         let original_bytes =
           Eio.Path.load Eio.Path.(State_root.directory root / original)
         in
         let entered, release = block_next_sync pause in
         let retry =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.retry_exact helper ~id |> Disk.unwrap)
         in
         Eio.Promise.await entered;
         let canceled =
           Eio.Fiber.fork_promise ~sw (fun () ->
             Wait_helper.cancel helper ~id |> Disk.unwrap)
         in
         Eio.Fiber.yield ();
         release ();
         ignore (Eio.Promise.await_exn retry : Wait_helper.Job.t);
         ignore (Eio.Promise.await_exn canceled : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           not (String.equal (state (inspect helper)) "running"));
         let final = inspect helper in
         printf "final=%s writes=%d\n" (state final) !writes;
         printf
           "same_journal=%b\n"
           (match state final with
            | "outcome_unknown" -> String.equal original (exact_journal final)
            | _ -> false);
         printf
           "same_request_bytes=%b\n"
           (String.equal
              original_bytes
              (Eio.Path.load Eio.Path.(State_root.directory root / original)));
         printf
           "replay=%s\n"
           (Wait_helper.create ~sw ~env ~root |> Disk.unwrap |> inspect |> state)));
  [%expect
    {|final=outcome_unknown writes=1
same_journal=true
same_request_bytes=true
replay=outcome_unknown|}]
;;

let%expect_test "wait list admits only its bounded GET pagination query" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
      let router, _, _, _ = Http_tests.router env root ~sw ~host:Http_tests.host in
      let router = Http_router.with_wait_helper router helper in
      List.iter
        [ "/ui-api/v1/reservation-waits"
        ; "/ui-api/v1/reservation-waits?limit=100"
        ; "/ui-api/v1/reservation-waits?offset=0&limit=1"
        ; "/ui-api/v1/reservation-waits?limit=1&limit=2"
        ; "/ui-api/v1/reservation-waits?other=1"
        ; "/ui-api/v1/reservation-waits?limit=101"
        ]
        ~f:(fun target -> printf "%d\n" (Http_tests.call router target).status);
      printf
        "post=%d\n"
        (Http_tests.call
           router
           ~method_:"POST"
           ~body:"{}"
           "/ui-api/v1/reservation-waits/prepare?limit=1")
          .status));
  [%expect
    {|200
200
200
400
400
400
post=400|}]
;;

let%expect_test "a native deadline after journal save replays with zero started exchanges"
  =
  Rpc_socket_test.with_bridge reads (fun env root _ _ connection ->
    Eio.Switch.run (fun sw ->
      let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
      ignore
        (Wait_helper.prepare helper (plan connection) |> Disk.unwrap : Wait_helper.Job.t);
      let name = "reservation-wait-wait.json" in
      let stored = State_root.read root ~name |> Disk.unwrap |> Option.value_exn in
      let latest = Json.field stored "latest" |> Json.text |> Json.parse |> Disk.unwrap in
      let request =
        Json.field latest "request" |> Protocol.Request.of_json |> Disk.unwrap
      in
      let path = Json.field latest "path" |> Json.text in
      let limits =
        Reservation_wait.Limits.create ~timeout_ms:1000 ~max_attempts:2 ~wait_slice_ms:5
        |> Disk.unwrap
      in
      let core = Reservation_wait.create request ~limits |> Disk.unwrap in
      let now = ref 0. in
      let exchanges = ref 0 in
      let outcome =
        Reservation_wait.collect
          core
          ~now:(fun () -> !now)
          ~max_exchange_seconds:60.
          ~fresh_mutation:(fun () -> failwith "no second attempt")
          ~save:(fun _ ->
            now := 2.;
            Ok path)
          ~exchange:(fun ~timeout_seconds:_ request ->
            match reads request with
            | Some response -> Protocol.result response
            | None ->
              incr exchanges;
              failwith "deadline must prevent exchange")
        |> Disk.unwrap
        |> Reservation_wait.Outcome.to_json
      in
      let wait = Json.field (Json.field outcome "data") "wait" in
      printf
        "stop=%s started=%d saved=%d exchanges=%d\n"
        (Json.field wait "stop" |> Json.text)
        (Json.field wait "attempt_count" |> Json.integer)
        (Json.field wait "journals" |> Json.list |> List.length)
        !exchanges;
      let saved =
        stored
        |> fun value ->
        replace value "attempts" (Json.int 1)
        |> fun value ->
        replace value "journals" (Json.string (Json.canonical (`Array [ latest ])))
        |> fun value ->
        replace
          value
          "state"
          (Json.string
             (Json.canonical
                (Json.obj [ "kind", Json.string "stopped"; "outcome", outcome ])))
      in
      State_root.save root ~name ~value:saved |> Disk.unwrap;
      let restored = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
      printf "replay=%s\n" (inspect restored |> state)));
  [%expect
    {|stop=deadline started=0 saved=1 exchanges=0
replay=stopped|}]
;;

let%expect_test "malformed metadata is uncertain and never becomes a forged grant" =
  let padded =
    replace
      grant
      "meta"
      (Json.obj
         [ "workspace_revision", Json.int 5
         ; "durable", `True
         ; "padding", Json.string "unsupported"
         ])
  in
  Rpc_socket_test.with_bridge
    (fun request ->
       match reads request with
       | Some response -> Some response
       | None -> Some (Success padded))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           not (String.equal (inspect helper |> state) "running"));
         let page = Wait_helper.list helper ~offset:0 ~limit:1 |> Disk.unwrap in
         let bytes = String.length (Json.canonical page) in
         printf
           "unknown=%b fits_16MiB=%b no_false_grant=%b\n"
           (String.equal (inspect helper |> state) "outcome_unknown")
           (bytes < 16 * 1024 * 1024)
           (let job = Wait_helper.Job.to_json (inspect helper) in
            let outcome = Json.field (Json.field job "state") "outcome" in
            let response = Json.field (Json.field outcome "data") "daemon_response" in
            match response with
            | `Null -> true
            | _ -> false)));
  [%expect {|unknown=true fits_16MiB=true no_false_grant=true|}]
;;

let%expect_test
    "failed new-journal metadata sync retains conservative unknown and replays"
  =
  let pause = ref Fn.ignore in
  let calls = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(fun fs -> pausing_fs fs pause)
    (fun request ->
       if String.equal (Protocol.Request.method_ request) "workspace.get"
       then (
         pause
         := fun () ->
              pause := Fn.ignore;
              Json.fail Local_io "injected saved-journal metadata sync failure");
       match reads request with
       | Some response -> Some response
       | None ->
         incr calls;
         Some (Success grant))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         ignore (Wait_helper.start helper ~id |> Disk.unwrap : Wait_helper.Job.t);
         Rpc_socket_test.until env (fun () ->
           not (String.equal (inspect helper |> state) "running"));
         printf "final=%s writes=%d\n" (inspect helper |> state) !calls;
         let public = Wait_helper.Job.to_json (inspect helper) in
         let journal =
           Json.field (Json.field public "state") "exact_journal" |> Json.text
         in
         let stored =
           State_root.read root ~name:"reservation-wait-wait.json"
           |> Disk.unwrap
           |> Option.value_exn
         in
         let history =
           Json.field stored "journals"
           |> Json.text
           |> Json.parse
           |> Disk.unwrap
           |> Json.list
         in
         printf
           "saved=%d started=%b same_journal=%b\n"
           (List.length history)
           (match Json.field (List.hd_exn history) "started" with
            | `True -> true
            | `False -> false
            | _ -> assert false)
           (String.equal journal (Json.field (List.hd_exn history) "path" |> Json.text));
         printf
           "replay=%s\n"
           (Wait_helper.create ~sw ~env ~root |> Disk.unwrap |> inspect |> state)));
  [%expect
    {|final=outcome_unknown writes=0
saved=1 started=false same_journal=true
replay=outcome_unknown|}]
;;
