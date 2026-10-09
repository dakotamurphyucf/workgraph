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
let consumer = Communication_id.Consumer.of_string "test-consumer" |> unwrap

let fixture_discussion =
  Discussion.apply
    Discussion.empty
    (Discussion.Change.Create
       { id = message
       ; target = Entity_ref.Workspace
       ; reply_to = None
       ; kind = Comment
       ; origin = Authored
       ; version =
           { revision = 1
           ; serial = 1
           ; sequence = 1
           ; actor = alice
           ; timestamp = "2026-10-07"
           ; body = "Review this"
           ; tombstone = false
           }
       })
    ~sequence:1
;;

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
  let read =
    C.inbox t ~consumer_id:consumer ~recipient:(recipient alice) ~after:0 ~through:None
  in
  let unchanged = C.Request.equal original (request_exn t) in
  print_s
    [%sexp
      (List.length read : int)
    , (unchanged : bool)
    , (Set.length (C.acknowledged t consumer (recipient alice)) : int)];
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
      (Inbox_ack
         { consumer_id = consumer
         ; recipient = recipient bob
         ; notification_ids =
             List.map
               (C.inbox
                  t
                  ~consumer_id:consumer
                  ~recipient:(recipient bob)
                  ~after:0
                  ~through:None)
               ~f:(fun n -> n.C.Notification.serial)
         })
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
    , (Set.length (C.acknowledged restored consumer (recipient bob)) : int)
    , (List.length
         (C.inbox
            restored
            ~consumer_id:consumer
            ~recipient:(recipient bob)
            ~after:0
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
         ; origin = Authored
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
      ~discussion:Discussion.empty
      ~method_:"request.list"
      ~params:(Json.obj [ "unanswered", `True; "overdue_at_unix_ms", Json.string "101" ])
    |> unwrap
  in
  print_s [%sexp (List.length (Json.list (Json.field result "items")) : int)];
  let threads =
    C.query
      t
      ~discussion:Discussion.empty
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
      ~discussion:fixture_discussion
      ~method_:"inbox.read"
      ~params:
        (Json.obj
           [ "consumer_id", Communication_id.Consumer.jsonaf_of_t consumer
           ; "recipient", C.Recipient.jsonaf_of_t (recipient watcher)
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
    , (Set.length (C.acknowledged t consumer (recipient watcher)) : int)];
  print_s
    [%sexp
      (List.length
         (C.inbox
            t
            ~consumer_id:consumer
            ~recipient:(recipient watcher)
            ~after:capture
            ~through:None)
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

let%expect_test
    "related direct reads expose current source versions and guard both captures"
  =
  let t, _ = fixture () in
  let version ~revision ~serial ~body ~tombstone =
    { Discussion.Version.revision
    ; serial
    ; sequence = serial
    ; actor = alice
    ; timestamp = "2026-10-08"
    ; body
    ; tombstone
    }
  in
  let discussion =
    Discussion.apply
      Discussion.empty
      ~sequence:1
      (Create
         { id = message
         ; target = Entity_ref.Workspace
         ; reply_to = None
         ; kind = Comment
         ; origin = Authored
         ; version =
             version ~revision:1 ~serial:1 ~body:"Original question" ~tombstone:false
         })
  in
  let discussion =
    Discussion.apply
      discussion
      ~sequence:2
      (Revise
         { id = message
         ; version =
             version ~revision:2 ~serial:2 ~body:"Corrected question" ~tombstone:false
         })
  in
  let second = Id.Comment.of_string "second" |> unwrap in
  let discussion =
    Discussion.apply
      discussion
      ~sequence:3
      (Create
         { id = second
         ; target = Entity_ref.Workspace
         ; reply_to = None
         ; kind = Comment
         ; origin = Authored
         ; version = version ~revision:1 ~serial:3 ~body:"Reply" ~tombstone:false
         })
  in
  let thread_revision = (Option.value_exn (C.get_thread t thread)).revision in
  let t, _ =
    step
      t
      (Thread_attach
         { id = thread; expected_revision = thread_revision; message = second })
  in
  let discussion =
    Discussion.apply
      discussion
      ~sequence:4
      (Revise
         { id = second; version = version ~revision:2 ~serial:4 ~body:"" ~tombstone:true })
  in
  let first =
    C.query
      t
      ~discussion
      ~method_:"request.get"
      ~params:
        (Json.obj
           [ "request_id", Communication_id.Request.jsonaf_of_t request
           ; "include_messages", `True
           ; "message_limit", Json.int 1
           ])
    |> unwrap
  in
  let related = Json.field (Json.field first "record") "related" in
  let source = Json.field related "source_message" in
  print_s
    [%sexp
      (Json.text (Json.field source "body") : string)
    , (Json.integer (Json.field source "revision") : int)];
  print_endline (Json.canonical (Json.field related "source_message_reference"));
  let capture =
    [ "thread_id", Communication_id.Thread.jsonaf_of_t thread
    ; "include_messages", `True
    ; "message_limit", Json.int 1
    ; "message_offset", Json.int 1
    ; "revision", Json.field first "revision"
    ; "discussion_serial", Json.field related "discussion_serial"
    ]
  in
  let page =
    C.query t ~discussion ~method_:"thread.get" ~params:(Json.obj capture) |> unwrap
  in
  let page = Json.field (Json.field (Json.field page "record") "related") "messages" in
  let item = List.hd_exn (Json.field page "items" |> Json.list) in
  print_endline
    (Json.canonical
       (Json.obj
          [ "comment_id", Json.field item "comment_id"
          ; "revision", Json.field item "revision"
          ; "tombstone", Json.field item "tombstone"
          ; "next_offset", Json.field page "next_offset"
          ]));
  let changed_discussion =
    Discussion.apply
      discussion
      ~sequence:5
      (Revise
         { id = message
         ; version =
             version ~revision:3 ~serial:5 ~body:"Another correction" ~tombstone:false
         })
  in
  print_error
    (C.query
       t
       ~discussion:changed_discussion
       ~method_:"thread.get"
       ~params:(Json.obj capture));
  let changed, _ =
    step
      t
      (Thread_pin_message
         { id = thread
         ; expected_revision = (Option.value_exn (C.get_thread t thread)).revision
         ; message
         ; pinned = true
         })
  in
  print_error
    (C.query changed ~discussion ~method_:"thread.get" ~params:(Json.obj capture));
  [%expect
    {|
    ("Corrected question" 2)
    {"comment_id":"message","revision":null}
    {"comment_id":"second","next_offset":null,"revision":"2","tombstone":true}
    Conflict
    Conflict |}]
;;

let%expect_test
    "related direct codecs reject malformed paging and disclose body omissions"
  =
  let codec = Communication_related.Query.thread_codec in
  let base = [ "thread_id", Json.string "thread"; "include_messages", `True ] in
  List.iter
    [ [ "message_offset", Json.int 1 ]
    ; [ "message_limit", Json.int 0 ]
    ; [ "message_limit", Json.int 101 ]
    ; [ "message_limit", `Number "1" ]
    ; [ "discussion_serial", `Null ]
    ; [ "unexpected", `True ]
    ]
    ~f:(fun fields -> print_error (Api_codec.decode codec (Json.obj (base @ fields))));
  print_error
    (Api_codec.decode
       codec
       (Json.obj
          [ "thread_id", Json.string "thread"
          ; "include_messages", `False
          ; "message_offset", Json.int 0
          ]));
  let t, _ = fixture () in
  let discussion =
    Discussion.apply
      Discussion.empty
      ~sequence:1
      (Create
         { id = message
         ; target = Entity_ref.Workspace
         ; reply_to = None
         ; kind = Comment
         ; origin = Authored
         ; version =
             { revision = 1
             ; serial = 1
             ; sequence = 1
             ; actor = alice
             ; timestamp = "2026-10-08"
             ; body = String.make 50_000 'x'
             ; tombstone = false
             }
         })
  in
  let result =
    C.query
      t
      ~discussion
      ~method_:"thread.get"
      ~params:
        (Json.obj
           [ "thread_id", Communication_id.Thread.jsonaf_of_t thread
           ; "include_messages", `True
           ; "max_bytes", Json.int 4096
           ])
    |> unwrap
  in
  let budget = Json.field result "budget" in
  print_endline (Json.canonical (Json.obj [ "truncated", Json.field budget "truncated" ]));
  let omissions = Json.field budget "details" |> Json.list in
  print_s
    [%sexp
      (List.exists omissions ~f:(fun omission ->
         String.is_suffix (Json.text (Json.field omission "path")) ~suffix:"/body")
       : bool)];
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    {"truncated":true}
    true |}]
;;

let%expect_test "direct messages pin bodies and consumer acknowledgements select IDs" =
  let id = Communication_id.Message.of_string "direct-message" |> unwrap in
  let prepared =
    C.prepare_message
      C.empty
      { message_id = id
      ; body = "initial body"
      ; ticket_id = None
      ; recipients = [ recipient alice; recipient alice; recipient bob ]
      ; teams = []
      ; reply_to_message_id = None
      ; correlation_id = Some "correlation"
      }
      ~discussion:Discussion.empty
      ~actor:resolver
      ~run:None
      ~timestamp:"2026-10-08"
      ~sequence:1
    |> unwrap
  in
  let state = C.Message_prepared.candidate prepared in
  let discussion = C.Message_prepared.discussion prepared in
  let stored = Option.value_exn (C.get_message state id) in
  let discussion =
    Discussion.apply
      discussion
      (Discussion.Change.Revise
         { id = stored.comment_id
         ; version =
             { revision = 2
             ; serial = 2
             ; sequence = 2
             ; actor = resolver
             ; timestamp = "2026-10-09"
             ; body = "edited body"
             ; tombstone = false
             }
         })
      ~sequence:2
  in
  let query consumer_id =
    C.query
      state
      ~discussion
      ~method_:"inbox.read"
      ~params:
        (Json.obj
           [ "consumer_id", Communication_id.Consumer.jsonaf_of_t consumer_id
           ; "recipient", C.Recipient.jsonaf_of_t (recipient alice)
           ])
    |> unwrap
  in
  let packet = List.hd_exn (Json.list (Json.field (query consumer) "items")) in
  print_s
    [%sexp
      (List.length stored.recipients : int)
    , (Json.text (Json.field (Json.field packet "body_source") "body") : string)
    , (Json.text (Json.field (Json.field packet "body_source") "version_kind") : string)];
  let state, event =
    step
      ~actor:alice
      state
      (Inbox_ack
         { consumer_id = consumer; recipient = recipient alice; notification_ids = [ 1 ] })
  in
  let read consumer_id =
    C.inbox state ~consumer_id ~recipient:(recipient alice) ~after:0 ~through:None
  in
  let other = Communication_id.Consumer.of_string "other" |> unwrap in
  print_s [%sexp (List.length (read consumer) : int), (List.length (read other) : int)];
  print_error
    (C.prepare
       state
       (Inbox_ack
          { consumer_id = consumer
          ; recipient = recipient alice
          ; notification_ids = [ 999 ]
          })
       ~actor:alice
       ~run:None
       ~timestamp:"2026-10-08"
       ~sequence:3);
  let forged =
    { event with
      C.Change.update =
        Inbox_ack
          { consumer_id = consumer
          ; recipient = recipient (actor "outsider")
          ; notification_ids = [ 1 ]
          }
    }
  in
  print_error (C.apply (C.Message_prepared.candidate prepared) forged);
  let replay =
    List.fold
      (C.Message_prepared.changes prepared)
      ~init:C.empty
      ~f:(fun state -> function
      | Discussion_change _ -> state
      | Communication_change change ->
        C.apply state (C.Change.decode (C.Change.jsonaf_of_t change) |> unwrap) |> unwrap)
  in
  print_s [%sexp (C.latest_serial replay : int)];
  [%expect
    {|
    (2 "initial body" initial)
    (0 1)
    Invalid_argument
    Conflict
    1
    |}]
;;

let%expect_test "inbox codecs reject malformed selectors and skipped response cursors" =
  let params fields =
    Json.obj
      ([ "consumer_id", Json.string "consumer"
       ; "recipient", Json.obj [ "kind", Json.string "actor"; "id", Json.string "alice" ]
       ]
       @ fields)
  in
  List.iter
    [ [ "after", Json.int 2; "through", Json.int 1 ]
    ; [ "kinds", `Array [ Json.string "made_up" ] ]
    ; [ "limit", Json.int 101 ]
    ]
    ~f:(fun fields ->
      print_error (Api_codec.decode Communication_inbox.Query.read_codec (params fields)));
  print_error
    (Api_codec.decode
       Communication_inbox.Query.wait_codec
       (params [ "timeout_ms", Json.int 25_001 ]));
  print_error
    (Api_codec.decode
       Communication_inbox.Ack.codec
       (params [ "notification_ids", `Array [] ]));
  print_error
    (Api_codec.decode
       Communication_inbox.result_codec
       (params
          [ "after", Json.int 0
          ; "through", Json.int 3
          ; "next_after", Json.int 3
          ; "remaining", Json.int 0
          ; "exclude_self", `False
          ; "items", `Array []
          ]));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "message team routes remain frozen and replies replay with one authored body"
  =
  let state, team_event =
    step
      C.empty
      (Team_put
         { id = team
         ; expected_revision = 0
         ; title = "Reviewers"
         ; members = [ recipient alice ]
         })
  in
  let send state discussion message_id reply_to_message_id recipients teams sequence =
    C.prepare_message
      state
      { message_id
      ; body = "Review reply"
      ; ticket_id = None
      ; recipients
      ; teams
      ; reply_to_message_id
      ; correlation_id = Some "review"
      }
      ~discussion
      ~actor:resolver
      ~run:None
      ~timestamp:"2026-10-08"
      ~sequence
    |> unwrap
  in
  let first_id = Communication_id.Message.of_string "first" |> unwrap in
  let first = send state Discussion.empty first_id None [] [ team ] 2 in
  let state, team_change =
    step
      (C.Message_prepared.candidate first)
      (Team_put
         { id = team
         ; expected_revision = 1
         ; title = "Reviewers"
         ; members = [ recipient bob ]
         })
  in
  let reply_id = Communication_id.Message.of_string "reply" |> unwrap in
  let reply =
    send
      state
      (C.Message_prepared.discussion first)
      reply_id
      (Some first_id)
      []
      [ team ]
      4
  in
  let state = C.Message_prepared.candidate reply in
  let original = Option.value_exn (C.get_message state first_id)
  and response = Option.value_exn (C.get_message state reply_id) in
  print_s
    [%sexp
      (original.recipients : C.Recipient.t list)
    , (response.recipients : C.Recipient.t list)];
  let events =
    [ C.Message_prepared.Communication_change team_event ]
    @ C.Message_prepared.changes first
    @ [ C.Message_prepared.Communication_change team_change ]
    @ C.Message_prepared.changes reply
  in
  let restored, discussion =
    List.fold
      events
      ~init:(C.empty, Discussion.empty)
      ~f:(fun (state, discussion) -> function
      | Discussion_change change ->
        ( state
        , Discussion.apply
            discussion
            change
            ~sequence:
              (match change with
               | Create { version; _ } | Revise { version; _ } -> version.sequence) )
      | Communication_change change ->
        ( C.apply state (C.Change.decode (C.Change.jsonaf_of_t change) |> unwrap) |> unwrap
        , discussion ))
  in
  print_error (C.validate_references restored ~entity_exists:(fun _ -> true) ~discussion);
  print_s
    [%sexp
      (Sequence.length (Discussion.ids discussion) : int)
    , (C.Message.equal original (Option.value_exn (C.get_message restored first_id))
       : bool)
    , (Communication_id.Message.equal
         (Option.value_exn response.reply_to_message_id)
         first_id
       : bool)];
  [%expect
    {|
    (((Actor alice)) ((Actor bob)))
    ok
    (2 true true)
    |}]
;;
