open Core
open Workgraph
module C = Communication

let unwrap = function
  | Ok x -> x
  | Error p -> failwith (Sexp.to_string_hum (Problem.sexp_of_t p))
;;

let actor name = Id.Actor.of_string name |> unwrap
let board = Communication_id.Board.of_string "board" |> unwrap
let thread = Communication_id.Thread.of_string "thread" |> unwrap
let message = Id.Comment.of_string "message" |> unwrap
let request = Communication_id.Request.of_string "request" |> unwrap
let team = Communication_id.Team.of_string "team" |> unwrap
let alice = actor "alice"
let bob = actor "bob"
let resolver = actor "coordinator"
let recipient actor = C.Recipient.Actor actor

let step ?(actor = resolver) state command =
  let p =
    C.prepare
      state
      command
      ~actor
      ~run:None
      ~timestamp:"2026-10-07"
      ~sequence:(C.revision state + 1)
    |> unwrap
  in
  C.candidate p, List.hd_exn (C.changes p)
;;

let fixture () =
  let t, board_event =
    step
      C.empty
      (Board_put
         { id = board; expected_revision = 0; scope = Workspace; title = "Planning" })
  in
  let t, thread_event =
    step
      t
      (Thread_put
         { id = thread
         ; expected_revision = 0
         ; board
         ; title = "Review contract"
         ; participants = [ alice ]
         ; mentions = [ bob ]
         ; links = [ Entity_ref.Workspace ]
         ; state = Awaiting_response
         ; pinned = false
         })
  in
  let t, attach_event =
    step t (Thread_attach { id = thread; expected_revision = 1; message })
  in
  let t, team_event =
    step
      t
      (Team_put
         { id = team
         ; expected_revision = 0
         ; title = "Reviewers"
         ; members = [ recipient alice; recipient bob ]
         })
  in
  let t, request_event =
    step
      t
      (Request_create
         { id = request
         ; thread
         ; kind = Review
         ; message
         ; recipients = []
         ; teams = [ team ]
         ; resolver
         ; correlation_id = Some "review-1"
         ; reply_to = None
         ; deadline_unix_ms = Some "100"
         })
  in
  t, [ board_event; thread_event; attach_event; team_event; request_event ]
;;

let request_exn t = Option.value_exn (C.get_request t request)

let print_error outcome =
  match outcome with
  | Ok _ -> print_endline "ok"
  | Error (error : Problem.t) -> print_s [%sexp (error.kind : Problem.kind)]
;;

let%expect_test "acknowledgement, reading, acceptance and resolution are independent" =
  let t, _ = fixture () in
  let original = request_exn t in
  let read = C.inbox t ~recipient:(recipient alice) ~after:0 ~through:None in
  let unchanged = C.Request.equal original (request_exn t) in
  print_s
    [%sexp
      (List.length read : int)
    , (unchanged : bool)
    , (C.inbox_position t (recipient alice) : int)];
  let t, _ =
    step
      ~actor:alice
      t
      (Request_acknowledge
         { id = request; expected_revision = 1; recipient = recipient alice })
  in
  let t, _ =
    step
      ~actor:bob
      t
      (Request_acknowledge
         { id = request; expected_revision = 2; recipient = recipient bob })
  in
  let r = request_exn t in
  print_s
    [%sexp
      (List.map r.deliveries ~f:(fun d -> Option.is_some d.acknowledged) : bool list)
    , (r.responsibility : C.Request.Responsibility.t)
    , (r.status : C.Request.Status.t)];
  let t, _ =
    step
      ~actor:alice
      t
      (Request_accept { id = request; expected_revision = 3; recipient = recipient alice })
  in
  print_error
    (C.prepare
       t
       (Request_resolve { id = request; expected_revision = 4 })
       ~actor:alice
       ~run:None
       ~timestamp:"now"
       ~sequence:9);
  let t, _ = step t (Request_resolve { id = request; expected_revision = 4 }) in
  print_s
    [%sexp
      ((Option.value_exn (C.get_thread t thread)).state : C.Thread.State.t)
    , ((request_exn t).status : C.Request.Status.t)];
  [%expect
    {|
    (3 true 0)
    ((true true) Unaccepted Open)
    Conflict
    (Awaiting_response
     (Resolved ((actor coordinator) (run ()) (timestamp 2026-10-07))))
|}]
;;

let%expect_test "resolved deliveries, subscriptions and read cursors survive replay" =
  let t, events = fixture () in
  let sub = Communication_id.Subscription.of_string "subscription" |> unwrap in
  let t, subscription_event =
    step
      ~actor:bob
      t
      (Subscription_put
         { id = sub
         ; expected_revision = 0
         ; recipient = recipient bob
         ; filter =
             { scope = Some Workspace; thread = Some thread; kinds = [ Thread_changed ] }
         ; active = true
         })
  in
  let t, team_event =
    step
      t
      (Team_put
         { id = team
         ; expected_revision = 1
         ; title = "Changed membership"
         ; members = [ recipient resolver ]
         })
  in
  print_s
    [%sexp
      (List.map (request_exn t).deliveries ~f:(fun d -> d.recipient) : C.Recipient.t list)];
  let t, pin_event =
    step
      t
      (Thread_pin_message { id = thread; expected_revision = 2; message; pinned = true })
  in
  let t, cursor_event =
    step
      ~actor:bob
      t
      (Inbox_mark_read { recipient = recipient bob; through = C.latest_serial t })
  in
  let events = events @ [ subscription_event; team_event; pin_event; cursor_event ] in
  let restored =
    List.fold events ~init:C.empty ~f:(fun t event ->
      let decoded = C.Change.decode (C.Change.jsonaf_of_t event) |> unwrap in
      C.apply t decoded |> unwrap)
  in
  print_s
    [%sexp
      (String.equal (Json.canonical (C.to_json t)) (Json.canonical (C.to_json restored))
       : bool)
    , (C.inbox_position restored (recipient bob) : int)
    , (List.length
         (C.inbox
            restored
            ~recipient:(recipient bob)
            ~after:(C.inbox_position restored (recipient bob))
            ~through:None)
       : int)];
  let bad = { pin_event with C.Change.notifications = [] } in
  let before_pin =
    List.take events 7
    |> List.fold ~init:C.empty ~f:(fun t event -> C.apply t event |> unwrap)
  in
  print_error (C.apply before_pin bad);
  [%expect
    {|
    ((Actor alice) (Actor bob))
    (true 4 0)
    Corrupt_store
|}]
;;

let%expect_test
    "thread revisions, attachment scope and frozen decoding reject invalid input"
  =
  let t, events = fixture () in
  print_error
    (C.prepare
       t
       (Thread_attach { id = thread; expected_revision = 1; message })
       ~actor:resolver
       ~run:None
       ~timestamp:"now"
       ~sequence:6);
  let t, _ =
    step
      t
      (Thread_put
         { id = thread
         ; expected_revision = 2
         ; board
         ; title = "Review contract"
         ; participants = [ alice ]
         ; mentions = [ bob ]
         ; links = [ Entity_ref.Workspace ]
         ; state = Resolved
         ; pinned = true
         })
  in
  let reply = Id.Comment.of_string "reply" |> unwrap in
  print_error
    (C.prepare
       t
       (Thread_attach { id = thread; expected_revision = 3; message = reply })
       ~actor:resolver
       ~run:None
       ~timestamp:"now"
       ~sequence:7);
  let discussion =
    Discussion.apply
      Discussion.empty
      (Create
         { id = message
         ; target = Entity_ref.Project (Id.Project.of_string "elsewhere" |> unwrap)
         ; reply_to = None
         ; kind = Comment
         ; version =
             { revision = 1
             ; serial = 1
             ; sequence = 1
             ; actor = alice
             ; timestamp = "now"
             ; body = "Body"
             ; tombstone = false
             }
         })
      ~sequence:1
  in
  print_error (C.validate_references t ~entity_exists:(fun _ -> true) ~discussion);
  let event = List.hd_exn events in
  let json =
    match C.Change.jsonaf_of_t event with
    | `Object fields -> Json.obj (("surprise", `True) :: fields)
    | _ -> assert false
  in
  print_error (C.Change.decode json);
  print_error (C.Change.decode (C.Change.jsonaf_of_t { event with revision = 0 }));
  print_error (C.Change.decode (C.Change.jsonaf_of_t { event with version = 2 }));
  [%expect
    {|
    Conflict
    Conflict
    Conflict
    Invalid_argument
    Corrupt_store
    Unsupported_version
|}]
;;

let%expect_test
    "wire codecs reject unknown fields and queries expose structured attention"
  =
  let t, _ = fixture () in
  let command =
    C.Command.Request_acknowledge
      { id = request; expected_revision = 1; recipient = recipient alice }
  in
  let method_, params = C.encode command |> unwrap in
  let decoded = C.decode ~method_ ~params |> unwrap in
  print_s
    [%sexp
      (String.equal
         (Sexp.to_string (C.Command.sexp_of_t command))
         (Sexp.to_string (C.Command.sexp_of_t decoded))
       : bool)];
  let bad =
    match params with
    | `Object fields -> Json.obj (("unexpected", `True) :: fields)
    | _ -> assert false
  in
  print_error (C.decode ~method_ ~params:bad);
  let result =
    C.query
      t
      ~method_:"request.list"
      ~params:(Json.obj [ "unanswered", `True; "overdue_at_unix_ms", Json.string "101" ])
    |> unwrap
  in
  print_s [%sexp (List.length (Json.list (Json.field result "items")) : int)];
  let threads =
    C.query
      t
      ~method_:"thread.list"
      ~params:(Json.obj [ "actor_id", Id.Actor.jsonaf_of_t bob; "unresolved", `True ])
    |> unwrap
  in
  print_s
    [%sexp
      (List.length (Json.list (Json.field threads "items")) : int)
    , (List.length (C.thread_history t thread) : int)];
  [%expect
    {|
    true
    Invalid_argument
    1
    (1 2)
|}]
;;

let%expect_test
    "subscriptions filter sources and stable inbox captures do not skip delivery"
  =
  let t, _ = fixture () in
  let watcher = actor "watcher" in
  let sub = Communication_id.Subscription.of_string "watcher_sub" |> unwrap in
  let t, _ =
    step
      ~actor:watcher
      t
      (Subscription_put
         { id = sub
         ; expected_revision = 0
         ; recipient = recipient watcher
         ; filter =
             { scope = Some Workspace; thread = Some thread; kinds = [ Thread_changed ] }
         ; active = true
         })
  in
  let before = C.latest_serial t in
  let t, _ =
    step
      ~actor:alice
      t
      (Request_acknowledge
         { id = request; expected_revision = 1; recipient = recipient alice })
  in
  let t, _ =
    step
      t
      (Thread_pin_message { id = thread; expected_revision = 2; message; pinned = true })
  in
  let capture = C.latest_serial t in
  let t, _ =
    step
      t
      (Thread_pin_message { id = thread; expected_revision = 3; message; pinned = false })
  in
  let read =
    C.query
      t
      ~method_:"inbox.read"
      ~params:
        (Json.obj
           [ "recipient", C.Recipient.jsonaf_of_t (recipient watcher)
           ; "after", Json.int before
           ; "through", Json.int capture
           ; "limit", Json.int 1
           ])
    |> unwrap
  in
  print_s
    [%sexp
      (List.length (Json.list (Json.field read "items")) : int)
    , (Json.integer (Json.field read "next_after") : int)
    , (C.inbox_position t (recipient watcher) : int)];
  print_s
    [%sexp
      (List.length (C.inbox t ~recipient:(recipient watcher) ~after:capture ~through:None)
       : int)];
  [%expect
    {|
    (1 5 0)
    1
    |}]
;;

let%expect_test "run recipients require run attribution and cancellation stays terminal" =
  let t, _ = fixture () in
  let run = Id.Run.of_string "worker_run" |> unwrap in
  let id = Communication_id.Request.of_string "run_request" |> unwrap in
  let t, _ =
    step
      t
      (Request_create
         { id
         ; thread
         ; kind = Help
         ; message
         ; recipients = [ Run run ]
         ; teams = []
         ; resolver
         ; correlation_id = None
         ; reply_to = Some request
         ; deadline_unix_ms = None
         })
  in
  let ack =
    C.Command.Request_acknowledge { id; expected_revision = 1; recipient = Run run }
  in
  print_error (C.prepare t ack ~actor:alice ~run:None ~timestamp:"now" ~sequence:7);
  let prepared =
    C.prepare t ack ~actor:alice ~run:(Some run) ~timestamp:"now" ~sequence:7 |> unwrap
  in
  let t = C.candidate prepared in
  let t, _ =
    step t (Request_reassign { id; expected_revision = 2; recipient = Some (Run run) })
  in
  let t, _ = step t (Request_cancel { id; expected_revision = 3 }) in
  print_error
    (C.prepare
       t
       (Request_accept { id; expected_revision = 4; recipient = Run run })
       ~actor:alice
       ~run:(Some run)
       ~timestamp:"now"
       ~sequence:10);
  print_s [%sexp (List.length (C.request_history t id) : int)];
  [%expect
    {|
    Conflict
    Conflict
    4
    |}]
;;

let%expect_test "communication event wire round trips and replay match original state" =
  Quickcheck.test
    ~trials:50
    (Quickcheck.Generator.list_with_length 20 Bool.quickcheck_generator)
    ~f:(fun pins ->
      let t, events = fixture () in
      let t, events =
        List.fold pins ~init:(t, events) ~f:(fun (t, events) pinned ->
          let revision = (Option.value_exn (C.get_thread t thread)).revision in
          let next, event =
            step
              t
              (Thread_pin_message
                 { id = thread; expected_revision = revision; message; pinned })
          in
          next, events @ [ event ])
      in
      let restored =
        List.fold events ~init:C.empty ~f:(fun t event ->
          C.apply t (C.Change.decode (C.Change.jsonaf_of_t event) |> unwrap) |> unwrap)
      in
      if
        not
          (String.equal
             (Json.canonical (C.to_json t))
             (Json.canonical (C.to_json restored)))
      then failwith "replay differs");
  print_endline "50 deterministic replay properties passed";
  [%expect {| 50 deterministic replay properties passed |}]
;;
