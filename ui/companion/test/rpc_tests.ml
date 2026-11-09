open Core
open Workgraph
open Workgraph_ui
open State_tests

let request ?(id = "request") method_ params =
  Protocol.Request.create ~id ~method_ ~params:(json params) |> Disk.unwrap
;;

let metadata_request () =
  request
    "ticket.metadata"
    {|{"workspace_id":"demo","actor_id":"author","mutation_id":"saved","ticket_id":"task","expected_revision":"1"}|}
;;

let committed () =
  Api_response.of_json
    (json {|{"data":{"revision":"2"},"meta":{"durable":true,"workspace_revision":"7"}}|})
  |> Disk.unwrap
;;

let empty () =
  let explanation =
    Allocation.Explanation.create ~captured_workspace_revision:7 ~candidates:[] ~limits:[]
    |> Disk.unwrap
    |> Allocation.Explanation.to_json
  in
  Api_response.of_json
    (Json.obj
       [ "data", Json.obj [ "kind", Json.string "empty"; "explanation", explanation ]
       ; "meta", json {|{"workspace_revision":"7","durable":false}|}
       ])
  |> Disk.unwrap
;;

let claim_request () =
  request
    "ticket.claim_next"
    {|{"workspace_id":"demo","actor_id":"author","mutation_id":"saved","target_run_id":"worker","attempt_id":"attempt"}|}
;;

let acknowledgement request response =
  match Acknowledgement.validate request ~response with
  | Ok (Committed _) -> print_endline "committed"
  | Ok (Observed _) -> print_endline "observed"
  | Error p -> print_endline (Problem.wire_name p.kind)
;;

let%expect_test "full method acknowledgement codecs and namespace metadata" =
  let original = metadata_request () in
  acknowledgement original (committed ());
  acknowledgement
    original
    (Api_response.of_json
       (json {|{"data":{},"meta":{"durable":true,"workspace_revision":"7"}}|})
     |> Disk.unwrap);
  acknowledgement
    original
    (Api_response.of_json
       (json
          {|{"data":{"revision":"2"},"meta":{"durable":false,"workspace_revision":"7"}}|})
     |> Disk.unwrap);
  let registry =
    request
      "workspace.open"
      {|{"workspace_id":"demo","actor_id":"author","mutation_id":"saved"}|}
  in
  acknowledgement
    registry
    (Api_response.of_json (json {|{"data":{"opened":true},"meta":{"durable":true}}|})
     |> Disk.unwrap);
  acknowledgement
    registry
    (Api_response.of_json
       (json
          {|{"data":{"opened":true},"meta":{"durable":true,"workspace_revision":"7"}}|})
     |> Disk.unwrap);
  acknowledgement (claim_request ()) (empty ());
  acknowledgement
    (request "daemon.shutdown" {|{}|})
    (Api_response.of_json (json {|{"data":{"stopping":true},"meta":{}}|}) |> Disk.unwrap);
  [%expect
    {|committed
Outcome_unknown
Outcome_unknown
committed
Outcome_unknown
observed
observed|}]
;;

let receipt ~request ~entry ~hash ~response =
  let response =
    Api_response.of_json
      (Json.obj
         [ ( "data"
           , Json.obj
               [ "status", Json.string "committed"
               ; "request_hash", Json.string hash
               ; "response", Api_response.to_json response
               ] )
         ; "meta", Json.obj []
         ])
    |> Disk.unwrap
  in
  match Acknowledgement.receipt request ~entry ~response with
  | Ok (Some (Committed _)) -> print_endline "committed"
  | Ok (Some (Observed _)) -> print_endline "observed"
  | Ok None -> print_endline "absent"
  | Error p -> print_endline (Problem.wire_name p.kind)
;;

let%expect_test
    "receipt binds complete saved envelope and server identity, validates nested response"
  =
  with_root (fun env _ ->
    let original = metadata_request () in
    let entry =
      Request_journal.Entry.create original ~fs:(Eio.Stdenv.fs env) |> Disk.unwrap
    in
    let mutation = Request_journal.Entry.mutation entry |> Option.value_exn in
    print_endline
      (Protocol.Request.method_ (Acknowledgement.receipt_request entry |> Disk.unwrap));
    receipt ~request:original ~entry ~hash:mutation.request_hash ~response:(committed ());
    receipt ~request:original ~entry ~hash:(String.make 64 '0') ~response:(committed ());
    receipt
      ~request:original
      ~entry
      ~hash:mutation.request_hash
      ~response:
        (Api_response.of_json
           (json {|{"data":{},"meta":{"durable":true,"workspace_revision":"7"}}|})
         |> Disk.unwrap);
    let changed =
      request
        ~id:"different-envelope"
        "ticket.metadata"
        {|{"workspace_id":"demo","actor_id":"author","mutation_id":"saved","ticket_id":"task","expected_revision":"1"}|}
    in
    receipt ~request:changed ~entry ~hash:mutation.request_hash ~response:(committed ());
    let absent =
      Api_response.of_json (json {|{"data":{"status":"absent"},"meta":{}}|})
      |> Disk.unwrap
    in
    print_s
      [%sexp
        (Option.is_none
           (Acknowledgement.receipt original ~entry ~response:absent |> Disk.unwrap)
         : bool)];
    let history =
      request
        "session.archive"
        {|{"workspace_id":"demo","actor_id":"author","mutation_id":"saved","session_id":"session"}|}
    in
    let entry =
      Request_journal.Entry.create history ~fs:(Eio.Stdenv.fs env) |> Disk.unwrap
    in
    problem (Acknowledgement.receipt_request entry);
    let ephemeral = request "daemon.shutdown" {|{}|} in
    let entry =
      Request_journal.Entry.create ephemeral ~fs:(Eio.Stdenv.fs env) |> Disk.unwrap
    in
    problem (Acknowledgement.receipt_request entry));
  [%expect
    {|workspace.receipt
committed
Idempotency_conflict
Outcome_unknown
Idempotency_conflict
true
Invalid_argument
Invalid_argument|}]
;;

let%expect_test "history acknowledgement validates optional capture and actual durability"
  =
  let original =
    request
      "session.archive"
      {|{"workspace_id":"demo","actor_id":"author","mutation_id":"saved","session_id":"session"}|}
  in
  let session =
    Session.create
      ~workspace:(Id.Workspace.of_string "demo" |> Disk.unwrap)
      ~id:(Session_id.of_string "session" |> Disk.unwrap)
      ~title:"Session"
      ~actor:(Id.Actor.of_string "author" |> Disk.unwrap)
      ~scopes:[]
      ()
    |> Disk.unwrap
    |> Session.archive
    |> History_wire.session_json
  in
  let response workspace =
    Api_response.of_json
      (Json.obj
         [ "data", Json.obj [ "session", session ]
         ; ( "meta"
           , Json.obj
               [ "durable", `True
               ; ( "history_capture"
                 , Json.obj
                     [ "workspace_id", Json.string workspace
                     ; "head", Json.string (String.make 64 'a')
                     ; "sequence", Json.int 1
                     ] )
               ] )
         ])
    |> Disk.unwrap
  in
  acknowledgement original (response "demo");
  acknowledgement original (response "other");
  let without_capture durable =
    Api_response.of_json
      (Json.obj
         [ "data", Json.obj [ "session", session ]
         ; "meta", Json.obj [ ("durable", if durable then `True else `False) ]
         ])
    |> Disk.unwrap
  in
  acknowledgement original (without_capture true);
  acknowledgement original (without_capture false);
  acknowledgement
    original
    (Api_response.project
       History
       (Json.obj
          [ "session", session
          ; "durable", `True
          ; "capture", json {|{"workspace_id":"demo","head":"malformed","sequence":"1"}|}
          ]));
  let different_session =
    match session with
    | `Object fields ->
      Json.obj
        (List.Assoc.add fields ~equal:String.equal "workspace_id" (Json.string "other"))
    | _ -> assert false
  in
  acknowledgement
    original
    (Api_response.project
       History
       (Json.obj [ "session", different_session; "durable", `True ]));
  let other_id =
    match session with
    | `Object fields ->
      Json.obj
        (List.Assoc.add fields ~equal:String.equal "session_id" (Json.string "other"))
    | _ -> assert false
  in
  acknowledgement
    original
    (Api_response.project History (Json.obj [ "session", other_id; "durable", `True ]));
  let create =
    request
      "session.create"
      {|{"workspace_id":"demo","actor_id":"author","mutation_id":"create","session_id":"session","title":"Session"}|}
  in
  acknowledgement
    create
    (Api_response.project
       History
       (Json.obj [ "session", other_id; "through", Json.int 0; "durable", `True ]));
  let append =
    request
      "session.append"
      {|{"workspace_id":"demo","actor_id":"author","mutation_id":"append","session_id":"session","events":[{"client_id":"one","role":"user","kind":"message","phase":"completed","payload":{"kind":"inline","bytes_base64":"eA=="},"attachments":[]}]}|}
  in
  let appended returned reference =
    Api_response.of_json
      (Json.obj
         [ ( "data"
           , Json.obj
               [ "session_id", Json.string returned
               ; "through", Json.int 1
               ; ( "events"
                 , `Array
                     [ Json.obj
                         [ "session_id", Json.string reference; "sequence", Json.int 1 ]
                     ] )
               ] )
         ; "meta", Json.obj [ "durable", `True ]
         ])
    |> Disk.unwrap
  in
  acknowledgement append (appended "session" "session");
  acknowledgement append (appended "other" "session");
  acknowledgement append (appended "session" "other");
  [%expect
    {|committed
Outcome_unknown
committed
Outcome_unknown
Outcome_unknown
Outcome_unknown
Outcome_unknown
Outcome_unknown
committed
Outcome_unknown
Outcome_unknown|}]
;;

let%expect_test
    "lane saturation is bounded and separate; queued cancellation releases accounting"
  =
  Eio_main.run (fun _ ->
    Eio.Switch.run (fun sw ->
      let scheduler = Read_scheduler.create () in
      let release, resolve = Eio.Promise.create () in
      let started, started_resolve = Eio.Promise.create () in
      Eio.Fiber.fork ~sw (fun () ->
        ignore
          (Read_scheduler.run scheduler ~lane:Search ~f:(fun () ->
             Eio.Promise.resolve started_resolve ();
             Eio.Promise.await release;
             Ok ())
           : (unit, Problem.t) Result.t));
      Eio.Promise.await started;
      let cancel, cancel_resolve = Eio.Promise.create () in
      let stopped, stopped_resolve = Eio.Promise.create () in
      Eio.Fiber.fork ~sw (fun () ->
        (try
           Eio.Cancel.sub (fun context ->
             Eio.Promise.resolve cancel_resolve context;
             ignore
               (Read_scheduler.run scheduler ~lane:Search ~f:(fun () -> Ok ())
                : (unit, Problem.t) Result.t))
         with
         | Eio.Cancel.Cancelled _ -> ());
        Eio.Promise.resolve stopped_resolve ());
      let context = Eio.Promise.await cancel in
      Eio.Fiber.yield ();
      for _ = 1 to 31 do
        Eio.Fiber.fork ~sw (fun () ->
          ignore
            (Read_scheduler.run scheduler ~lane:Search ~f:(fun () -> Ok ())
             : (unit, Problem.t) Result.t))
      done;
      Eio.Fiber.yield ();
      problem (Read_scheduler.run scheduler ~lane:Search ~f:(fun () -> Ok ()));
      problem (Read_scheduler.run scheduler ~lane:Visible ~f:(fun () -> Ok ()));
      Eio.Cancel.cancel context Exit;
      Eio.Promise.await stopped;
      let search =
        Json.field (Read_scheduler.to_json scheduler) "lanes"
        |> Json.list
        |> List.find_exn ~f:(fun lane ->
          String.equal (Json.text (Json.field lane "lane")) "search")
      in
      print_endline (Json.canonical search);
      Eio.Promise.resolve resolve ()));
  [%expect
    {|Blocked
ok
{"active":"1","active_limit":"1","lane":"search","queue_limit":"32","queued":"31"}|}]
;;

let%expect_test
    "stronger late observations rebase revisions while stale uncertainty cannot erase \
     known results"
  =
  with_root (fun env root ->
    let store =
      Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env) |> Disk.unwrap
    in
    let original = prepared store (preparation ()) in
    let id = Operation.id original in
    let sending = Operation_store.admit store ~id ~retry:false |> Disk.unwrap in
    let uncertain =
      Operation_store.record
        store
        (Operation.with_diagnostic
           (Operation.with_state
              sending
              (Outcome_unknown (Problem.create Outcome_unknown "late transport")))
           (Problem.create Local_io "diagnostic"))
    in
    let known =
      Operation_store.record
        store
        (Operation.with_state sending (Committed (committed ())))
    in
    print_s [%sexp ((Operation.revision uncertain, Operation.revision known) : int * int)];
    let weak =
      Operation_store.record
        store
        (Operation.with_state
           sending
           (Outcome_unknown (Problem.create Outcome_unknown "stale")))
    in
    print_endline (state weak);
    print_s [%sexp (Operation.revision weak = Operation.revision known : bool)]);
  [%expect
    {|(4 5)
committed
true|}]
;;

let%expect_test
    "active lane cancellation and unexpected exceptions preserve control flow and \
     release slots"
  =
  Eio_main.run (fun _ ->
    Eio.Switch.run (fun sw ->
      let scheduler = Read_scheduler.create () in
      let cancel, cancel_resolve = Eio.Promise.create () in
      let stopped, stopped_resolve = Eio.Promise.create () in
      let forever, _ = Eio.Promise.create () in
      Eio.Fiber.fork ~sw (fun () ->
        (try
           Eio.Cancel.sub (fun context ->
             ignore
               (Read_scheduler.run scheduler ~lane:Wait ~f:(fun () ->
                  Eio.Promise.resolve cancel_resolve context;
                  Eio.Promise.await forever;
                  Ok ())
                : (unit, Problem.t) Result.t))
         with
         | Eio.Cancel.Cancelled _ -> print_endline "cancelled");
        Eio.Promise.resolve stopped_resolve ());
      Eio.Cancel.cancel (Eio.Promise.await cancel) Exit;
      Eio.Promise.await stopped;
      (try
         ignore
           (Read_scheduler.run scheduler ~lane:Search ~f:(fun () -> raise Exit)
            : (unit, Problem.t) Result.t)
       with
       | Exit -> print_endline "unexpected preserved");
      let lanes = Json.field (Read_scheduler.to_json scheduler) "lanes" |> Json.list in
      print_s
        [%sexp
          (List.for_all lanes ~f:(fun lane ->
             Json.integer (Json.field lane "active") = 0
             && Json.integer (Json.field lane "queued") = 0)
           : bool)]));
  [%expect
    {|cancelled
unexpected preserved
true|}]
;;

let%expect_test "real history journal replies commit without invented capture metadata" =
  with_root (fun env root ->
    let fs = Eio.Stdenv.fs env in
    let workspace = Id.Workspace.of_string "demo" |> Disk.unwrap in
    let actor = Id.Actor.of_string "author" |> Disk.unwrap in
    let session = Session_id.of_string "session" |> Disk.unwrap in
    Disk.ensure_directory Eio.Path.(fs / State_root.path root / "blobs");
    let store =
      Session_store.open_existing ~fs ~root:(State_root.path root) ~workspace
      |> Disk.unwrap
    in
    let execute method_ mutation command params =
      ignore
        (History_api.Command.decode ~method_ ~params:(Json.obj params) |> Disk.unwrap
         : History_api.Command.t);
      let params =
        Json.obj
          ([ "workspace_id", Id.Workspace.jsonaf_of_t workspace
           ; "actor_id", Id.Actor.jsonaf_of_t actor
           ; "mutation_id", Json.string mutation
           ]
           @ params)
      in
      let original =
        Protocol.Request.create ~id:mutation ~method_ ~params |> Disk.unwrap
      in
      let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
      let response =
        History_command.execute store command ~actor ~key ~request_hash ()
        |> Disk.unwrap
        |> Api_response.project History
      in
      printf
        "%s capture=%b "
        method_
        (Option.is_some (Json.optional (Api_response.meta response) "history_capture"));
      acknowledgement original response;
      let retry =
        History_command.execute store command ~actor ~key ~request_hash ()
        |> Disk.unwrap
        |> Api_response.project History
      in
      printf
        "exact-retry=%b\n"
        (String.equal
           (Json.canonical (Api_response.to_json response))
           (Json.canonical (Api_response.to_json retry)))
    in
    let metadata =
      Session.create ~workspace ~id:session ~title:"Session" ~actor ~scopes:[] ()
      |> Disk.unwrap
    in
    execute
      "session.create"
      "create"
      (History_command.Create metadata)
      [ "session_id", Session_id.jsonaf_of_t session; "title", Json.string "Session" ];
    let event =
      Session_event.Input.create
        ~client_id:"event"
        ~role:"user"
        ~kind:"message"
        ~phase:"completed"
        ~payload:(Session_event.Content.Inline "exact payload")
        ~attachments:[]
        ()
      |> Disk.unwrap
    in
    execute
      "session.append"
      "append"
      (History_command.Append { session; inputs = [ event ] })
      [ "session_id", Session_id.jsonaf_of_t session
      ; "events", `Array [ Api_codec.encode History_wire.input event |> Disk.unwrap ]
      ];
    execute
      "session.archive"
      "archive"
      (History_command.Archive session)
      [ "session_id", Session_id.jsonaf_of_t session ]);
  [%expect
    {|session.create capture=false committed
exact-retry=true
session.append capture=false committed
exact-retry=true
session.archive capture=false committed
exact-retry=true|}]
;;
