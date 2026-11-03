open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let alice = Id.Actor.of_string "alice" |> unwrap
let bob = Id.Actor.of_string "bob" |> unwrap
let request = Communication_id.Request.of_string (String.make 96 'r') |> unwrap

let empty () =
  State.empty ~workspace:(Id.Workspace.of_string "workspace" |> unwrap) ~name:"Workspace"
  |> unwrap
;;

let ask ?ticket ?(id = request) ?(resolver = alice) ?(body = "Which approach?") () =
  Domain_command.Communication
    (Request_ask
       { id
       ; title = "Choose an approach"
       ; body
       ; recipients = [ Actor bob ]
       ; resolver
       ; ticket
       ; kind = Clarification
       ; priority = 0
       ; deadline_unix_ms = None
       ; related = []
       ; supersedes = []
       })
;;

let prepare ?(actor = alice) state command =
  State.prepare state command ~actor ~timestamp:"2026-10-09"
;;

let query state method_ params = State.query state ~method_ ~params |> unwrap
let get json name = Json.field json name
let same left right = String.equal (Json.canonical left) (Json.canonical right)

let report result =
  match result with
  | Ok _ -> print_endline "ok"
  | Error (problem : Problem.t) -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let%expect_test "ask and answer compose existing events and replay exactly" =
  let initial = empty () in
  let question = prepare initial (ask ()) |> unwrap in
  let asked = State.candidate question in
  let receipt = State.result question in
  Communication_api.validate_result ~method_:"request.ask" receipt;
  let thread = get receipt "thread_id" |> Communication_id.Thread.t_of_jsonaf in
  printf
    "ask: workspace=%d request=%d thread=%d question=%d\n"
    (State.revision asked)
    (get receipt "request_revision" |> Json.integer)
    (get receipt "thread_revision" |> Json.integer)
    (get receipt "question" |> fun json -> get json "revision" |> Json.integer);
  printf
    "derived IDs fit: %b\n"
    (List.for_all
       [ get receipt "board_id"
       ; get receipt "thread_id"
       ; (get receipt "question" |> fun json -> get json "comment_id")
       ]
       ~f:(fun json -> String.length (Json.text json) <= 96));
  let replayed = State.replay initial (State.events question) |> unwrap in
  printf
    "ask replay: %b; original untouched: %d\n"
    (same (State.to_json replayed) (State.to_json asked))
    (State.revision initial);
  let answer =
    prepare
      asked
      (Communication
         (Request_resolve
            { id = request; expected_revision = 1; body = Some "Use the existing model." }))
    |> unwrap
  in
  let answered = State.candidate answer in
  let current =
    query
      answered
      "request.get"
      (Json.obj [ "request_id", Communication_id.Request.jsonaf_of_t request ])
    |> fun json -> get json "record"
  in
  printf
    "answer: workspace=%d request=%d thread=%d messages=%d\n"
    (State.revision answered)
    (get current "revision" |> Json.integer)
    (get current "thread_revision" |> Json.integer)
    (Communication.get_thread (State.communication answered) thread
     |> Option.value_exn
     |> fun (thread : Communication.Thread.t) -> List.length thread.messages);
  let replayed = State.replay replayed (State.events answer) |> unwrap in
  printf "answer replay: %b\n" (same (State.to_json replayed) (State.to_json answered));
  [%expect
    {|
    ask: workspace=1 request=1 thread=2 question=1
    derived IDs fit: true
    ask replay: true; original untouched: 0
    answer: workspace=2 request=2 thread=4 messages=2
    answer replay: true
    |}]
;;

let%expect_test "answer validation and collisions publish no candidate" =
  let initial = empty () in
  let question = prepare initial (ask ()) |> unwrap in
  let asked = State.candidate question in
  let resolve ?(actor = alice) ?(revision = 1) body =
    prepare
      ~actor
      asked
      (Communication
         (Request_resolve { id = request; expected_revision = revision; body = Some body }))
    |> report
  in
  resolve ~actor:bob "Answer";
  resolve ~revision:0 "Answer";
  resolve " \n ";
  resolve (String.make 65537 'x');
  resolve "\255";
  report (prepare initial (ask ~body:"" ()));
  report (prepare initial (ask ~ticket:(Id.Ticket.of_string "missing" |> unwrap) ()));
  report (prepare asked (ask ()));
  let board =
    State.result question
    |> fun json -> get json "board_id" |> Communication_id.Board.t_of_jsonaf
  in
  let occupied =
    prepare
      initial
      (Communication
         (Board_put
            { id = board; expected_revision = 0; scope = Workspace; title = "Occupied" }))
    |> unwrap
    |> State.candidate
  in
  report (prepare occupied (ask ()));
  let comment =
    State.result question
    |> fun json -> get (get json "question") "comment_id" |> Id.Comment.t_of_jsonaf
  in
  let occupied =
    prepare
      initial
      (Comment_add
         { id = Some comment
         ; target = Workspace
         ; reply_to = None
         ; kind = Comment
         ; body = "Occupied"
         })
    |> unwrap
    |> State.candidate
  in
  report (prepare occupied (ask ()));
  printf
    "original requests=%d; asked messages=%d\n"
    (List.length (Communication.requests (State.communication initial)))
    (List.length
       (List.hd_exn (Communication.threads (State.communication asked))).messages);
  [%expect
    {|
    Conflict
    Conflict
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Not_found
    Conflict
    Conflict
    Conflict
    original requests=0; asked messages=1
    |}]
;;

let%expect_test "ticket and resolver filters precede pagination and body fitting" =
  let project = Id.Project.of_string "project" |> unwrap in
  let ticket = Id.Ticket.of_string "ticket" |> unwrap in
  let state =
    prepare
      (empty ())
      (Batch
         [ Project_create { id = project; title = "Project"; description = "" }
         ; Ticket_create
             { id = ticket
             ; title = "Task"
             ; description = ""
             ; project = Some project
             ; parent = None
             ; milestone = None
             }
         ])
    |> unwrap
    |> State.candidate
  in
  let state =
    List.fold
      [ "a", None, alice; "b", Some ticket, bob; "c", Some ticket, bob ]
      ~init:state
      ~f:(fun state (id, ticket, resolver) ->
        prepare
          state
          (ask ?ticket ~id:(Communication_id.Request.of_string id |> unwrap) ~resolver ())
        |> unwrap
        |> State.candidate)
  in
  let first =
    query
      state
      "request.list"
      (Json.obj
         [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
         ; "resolver_id", Id.Actor.jsonaf_of_t bob
         ; "limit", Json.int 1
         ; "max_bytes", Json.int 4096
         ])
  in
  let second =
    query
      state
      "request.list"
      (Json.obj
         [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
         ; "resolver_id", Id.Actor.jsonaf_of_t bob
         ; "limit", Json.int 1
         ; "offset", get first "next_offset"
         ; "revision", get first "revision"
         ])
  in
  let ids page =
    get page "items"
    |> Json.list
    |> List.map ~f:(fun item -> get item "request_id" |> Json.text)
  in
  print_s [%sexp (ids first : string list), (ids second : string list)];
  let unmatched =
    query
      state
      "request.list"
      (Json.obj
         [ "ticket_id", Id.Ticket.jsonaf_of_t ticket
         ; "resolver_id", Id.Actor.jsonaf_of_t alice
         ])
  in
  printf "other resolver count=%d\n" (get unmatched "items" |> Json.list |> List.length);
  let scoped_board =
    List.find_exn
      (Communication.boards (State.communication state))
      ~f:(fun (board : Communication.Board.t) ->
        Communication.Scope.equal board.scope (Project project))
  in
  printf
    "ticket scope=%s\n"
    (Communication.Scope.sexp_of_t scoped_board.scope |> Sexp.to_string);
  [%expect
    {|
    ((b) (c))
    other resolver count=0
    ticket scope=(Project project)
    |}]
;;

let%expect_test "new public inputs validate authored text and recipient bounds" =
  let params =
    Jsonaf.of_string
      {|{"request_id":"r","title":"Question","body":"Body","recipients":[{"kind":"actor","id":"bob"}],"resolver_id":"alice"}|}
  in
  let set name value =
    match params with
    | `Object fields ->
      Json.obj ((name, value) :: List.Assoc.remove fields name ~equal:String.equal)
    | _ -> assert false
  in
  List.iter
    [ params
    ; set "body" (Json.string " ")
    ; set "body" (Json.string (String.make 65537 'x'))
    ; set "body" (Json.string "\255")
    ; set "recipients" (`Array [])
    ; set "title" (Json.string "")
    ]
    ~f:(fun params ->
      report (Communication_command.decode ~method_:"request.ask" ~params));
  let command = Communication_command.decode ~method_:"request.ask" ~params |> unwrap in
  (match command with
   | Request_ask { kind; ticket; _ } ->
     printf
       "defaults=%s/%b\n"
       (Communication.Request.Kind.sexp_of_t kind |> Sexp.to_string)
       (Option.is_none ticket)
   | _ -> assert false);
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    defaults=Clarification/true
    |}]
;;

let%expect_test "ask creation aliases resolve before atomic answer preparation" =
  let command =
    Domain_command.decode
      ~method_:"transaction.apply"
      ~params:
        (Jsonaf.of_string
           {|{"operations":[{"method":"request.ask","as":"question","params":{"request_id":"alias-question","title":"Alias question","body":"Preserve $question as text","recipients":[{"kind":"actor","id":"bob"}],"resolver_id":"alice"}},{"method":"request.resolve","params":{"request_id":"$question","expected_revision":"1","body":"Preserve $question as answer text"}}]}|})
    |> unwrap
  in
  let prepared = prepare (empty ()) command |> unwrap in
  let state = State.candidate prepared in
  let request = Communication_id.Request.of_string "alias-question" |> unwrap in
  let current =
    query
      state
      "request.get"
      (Json.obj [ "request_id", Communication_id.Request.jsonaf_of_t request ])
    |> fun json -> get json "record"
  in
  printf
    "batch: workspace=%d request=%d thread=%d\n"
    (State.revision state)
    (get current "revision" |> Json.integer)
    (get current "thread_revision" |> Json.integer);
  let codec =
    Communication_api.response_codec ~method_:"request.get" |> Option.value_exn
  in
  report (Api_codec.decode codec current);
  let without_thread_revision =
    match current with
    | `Object fields ->
      Json.obj (List.Assoc.remove fields "thread_revision" ~equal:String.equal)
    | _ -> assert false
  in
  report (Api_codec.decode codec without_thread_revision);
  let thread = get current "thread_id" |> Communication_id.Thread.t_of_jsonaf in
  let thread =
    Communication.get_thread (State.communication state) thread |> Option.value_exn
  in
  List.iter thread.messages ~f:(fun id ->
    query state "comment.get" (Json.obj [ "comment_id", Id.Comment.jsonaf_of_t id ])
    |> fun json -> get (get json "data") "body" |> Json.text |> print_endline);
  [%expect
    {|
    batch: workspace=1 request=2 thread=4
    ok
    Invalid_argument
    Preserve $question as text
    Preserve $question as answer text
    |}]
;;

let%expect_test "ask accepts the full declared recipient and UTF-8 body bounds" =
  let recipients =
    List.init 1000 ~f:(fun index ->
      Communication.Recipient.Actor
        (Id.Actor.of_string ("recipient-" ^ Int.to_string index) |> unwrap))
  in
  let command =
    Domain_command.Communication
      (Request_ask
         { id = request
         ; title = "Question"
         ; body = String.make 65536 'x'
         ; recipients
         ; resolver = alice
         ; ticket = None
         ; kind = Clarification
         ; priority = 0
         ; deadline_unix_ms = None
         ; related = []
         ; supersedes = []
         })
  in
  let prepared = prepare (empty ()) command |> unwrap in
  let state = State.candidate prepared |> State.communication in
  let thread = List.hd_exn (Communication.threads state) in
  let request = List.hd_exn (Communication.requests state) in
  printf
    "deliveries=%d participants=%d\n"
    (List.length request.deliveries)
    (List.length thread.participants);
  [%expect {| deliveries=1000 participants=1 |}]
;;

let%expect_test "answers and causal deliveries retain exact versions after edits" =
  let asked = prepare (empty ()) (ask ()) |> unwrap |> State.candidate in
  let resolution =
    prepare
      asked
      (Communication
         (Request_resolve
            { id = request; expected_revision = 1; body = Some "Pinned answer" }))
    |> unwrap
  in
  let resolved = State.candidate resolution in
  let receipt = State.result resolution in
  let pin = get receipt "answer" in
  let answer_id = get pin "comment_id" |> Id.Comment.t_of_jsonaf in
  let request_record state =
    query
      state
      "request.get"
      (Json.obj [ "request_id", Communication_id.Request.jsonaf_of_t request ])
    |> fun j -> get j "record"
  in
  let question =
    (Communication.get_request (State.communication asked) request |> Option.value_exn)
      .message
  in
  let edit state id body =
    prepare state (Comment_edit { id; expected_revision = 1; body; tombstone = false })
    |> unwrap
    |> State.candidate
  in
  let changed =
    edit resolved question "Rewritten question"
    |> fun state -> edit state answer_id "Rewritten answer"
  in
  let current = request_record changed in
  printf
    "receipt: request=%d thread=%d answer=%d\n"
    (get receipt "request_revision" |> Json.integer)
    (get receipt "thread_revision" |> Json.integer)
    (get pin "revision" |> Json.integer);
  printf
    "direct: %s; question revision=%d\n"
    (get (get current "answer") "body" |> Json.text)
    (get current "comment_revision" |> Json.integer);
  let inbox =
    query
      changed
      "inbox.read"
      (Json.obj
         [ "consumer_id", Json.string "pins"
         ; ( "recipient"
           , Json.obj [ "kind", Json.string "actor"; "id", Id.Actor.jsonaf_of_t alice ] )
         ])
  in
  get inbox "items"
  |> Json.list
  |> List.iter ~f:(fun item ->
    let kind = get item "kind" |> Json.text in
    if String.equal kind "request_created" || String.equal kind "request_resolved"
    then
      printf
        "%s: %s (%s)\n"
        kind
        (get (get item "body_source") "body" |> Json.text)
        (get item "request_status" |> Json.text));
  let metadata_only =
    get inbox "items"
    |> Json.list
    |> List.filter ~f:(fun item ->
      String.equal (get item "kind" |> Json.text) "thread_changed"
      &&
      match get item "body_source" with
      | `Null -> true
      | _ -> false)
  in
  printf "metadata without borrowed body: %d\n" (List.length metadata_only);
  [%expect
    {|
    receipt: request=2 thread=4 answer=1
    direct: Pinned answer; question revision=1
    request_created: Which approach? (resolved)
    request_resolved: Pinned answer (resolved)
    metadata without borrowed body: 2
    |}]
;;

let%expect_test "automatic closure waits for every sibling and manual threads stay open" =
  let run manual =
    let asked = prepare (empty ()) (ask ()) |> unwrap |> State.candidate in
    let original =
      Communication.get_request (State.communication asked) request |> Option.value_exn
    in
    let thread =
      Communication.get_thread (State.communication asked) original.thread
      |> Option.value_exn
    in
    let asked =
      if manual
      then
        prepare
          asked
          (Communication
             (Thread_put
                { id = thread.id
                ; expected_revision = thread.revision
                ; board = thread.board
                ; title = thread.title
                ; participants = thread.participants
                ; mentions = thread.mentions
                ; links = thread.links
                ; state = thread.state
                ; closure_policy = Some Manual
                ; pinned = thread.pinned
                }))
        |> unwrap
        |> State.candidate
      else asked
    in
    let sibling = Communication_id.Request.of_string "sibling" |> unwrap in
    let asked =
      prepare
        asked
        (Communication
           (Request_create
              { id = sibling
              ; thread = original.thread
              ; kind = Clarification
              ; message = original.message
              ; recipients = [ Actor alice ]
              ; teams = []
              ; resolver = alice
              ; correlation_id = None
              ; reply_to = None
              ; deadline_unix_ms = None
              ; priority = 0
              ; related = []
              ; supersedes = []
              }))
      |> unwrap
      |> State.candidate
    in
    let resolve state id =
      prepare
        state
        (Communication (Request_resolve { id; expected_revision = 1; body = None }))
      |> unwrap
      |> State.candidate
    in
    let first = resolve asked request in
    let state state =
      (Communication.get_thread (State.communication state) original.thread
       |> Option.value_exn)
        .state
    in
    let last = resolve first sibling in
    print_s
      [%sexp
        (state first : Communication.Thread.State.t)
      , (state last : Communication.Thread.State.t)]
  in
  run false;
  run true;
  [%expect
    {|
    (Awaiting_response Resolved)
    (Awaiting_response Awaiting_response)
    |}]
;;

let%expect_test "replay rejects forged answer pins and missing automatic closure" =
  let asked = prepare (empty ()) (ask ()) |> unwrap |> State.candidate in
  let request_record =
    Communication.get_request (State.communication asked) request |> Option.value_exn
  in
  let answer =
    prepare
      asked
      (Communication
         (Request_resolve { id = request; expected_revision = 1; body = Some "Answer" }))
    |> unwrap
  in
  let payload = State.events answer in
  let events =
    get payload "changes" |> Json.list |> List.map ~f:Planning_state.Event.t_of_jsonaf
  in
  let replace events =
    match payload with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "changes"
             then `Array (List.map events ~f:Planning_state.Event.jsonaf_of_t)
             else value )))
    | _ -> assert false
  in
  let forged =
    List.map events ~f:(function
      | Planning_state.Event.Communication_changed
          ({ update =
               Request_put ({ request = resolved; kind = Request_resolved } as update)
           ; _
           } as change) ->
        let pin =
          { Communication_event.Comment_ref.comment_id = request_record.message
          ; revision = 1
          }
        in
        let status =
          match resolved.status with
          | Resolved resolution ->
            Communication.Request.Status.Resolved { resolution with answer = Some pin }
          | Open | Cancelled _ -> assert false
        in
        Planning_state.Event.Communication_changed
          { change with
            update = Request_put { update with request = { resolved with status } }
          ; notifications =
              List.map change.notifications ~f:(fun n ->
                { n with causal_body = Some pin })
          }
      | event -> event)
  in
  report (State.replay asked (replace forged));
  report (State.replay asked (replace (List.drop_last_exn events)));
  let zero_pin =
    List.find_map events ~f:(function
      | Planning_state.Event.Communication_changed
          ({ notifications = n :: _; _ } as change)
        when Option.is_some n.causal_body ->
        Some
          { change with
            notifications =
              [ { n with
                  causal_body =
                    Option.map n.causal_body ~f:(fun p -> { p with revision = 0 })
                }
              ]
          }
      | _ -> None)
    |> Option.value_exn
  in
  report (Communication_event.decode (Communication_event.jsonaf_of_t zero_pin));
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Corrupt_store
    |}]
;;

let%expect_test "request scheduling links resolve typed aliases and reject cyclic replay" =
  let command =
    Domain_command.decode
      ~method_:"transaction.apply"
      ~params:
        (Jsonaf.of_string
           {|{"operations":[{"method":"request.ask","as":"old","params":{"request_id":"old","title":"Old","body":"Old question","recipients":[{"kind":"actor","id":"bob"}],"resolver_id":"alice"}},{"method":"request.ask","as":"new","params":{"request_id":"new","title":"New","body":"Literal $old","recipients":[{"kind":"actor","id":"bob"}],"resolver_id":"alice","priority":"1","deadline_unix_ms":"42","related_request_ids":["$old"],"supersedes_request_ids":["$old"]}},{"method":"request.metadata","params":{"request_id":"$new","expected_revision":"1","priority":"2","deadline_unix_ms":null}}]}|})
    |> unwrap
  in
  let initial = empty () in
  let prepared = prepare initial command |> unwrap in
  let state = State.candidate prepared in
  let id = Communication_id.Request.of_string "new" |> unwrap in
  let current =
    Communication.get_request (State.communication state) id |> Option.value_exn
  in
  printf
    "priority=%d deadline=%b links=%s supersedes=%s\n"
    current.priority
    (Option.is_some current.deadline_unix_ms)
    (Communication_id.Request.to_string (List.hd_exn current.related))
    (Communication_id.Request.to_string (List.hd_exn current.supersedes));
  let replayed = State.replay initial (State.events prepared) |> unwrap in
  printf "replay equal=%b\n" (same (State.to_json state) (State.to_json replayed));
  let old = Communication_id.Request.of_string "old" |> unwrap in
  let cyclic =
    Domain_command.Communication
      (Request_metadata
         { id = old
         ; expected_revision = 1
         ; priority = None
         ; deadline_unix_ms = None
         ; related = None
         ; supersedes = Some [ id ]
         })
  in
  report (prepare state cyclic);
  let old_record =
    Communication.get_request (State.communication state) old |> Option.value_exn
  in
  let mutation =
    prepare
      state
      (Communication
         (Request_metadata
            { id
            ; expected_revision = 2
            ; priority = Some 4
            ; deadline_unix_ms = None
            ; related = None
            ; supersedes = None
            }))
    |> unwrap
  in
  let payload = State.events mutation in
  let events =
    get payload "changes" |> Json.list |> List.map ~f:Planning_state.Event.t_of_jsonaf
  in
  let forged =
    List.map events ~f:(function
      | Planning_state.Event.Communication_changed
          ({ update = Request_put update; _ } as change) ->
        Planning_state.Event.Communication_changed
          { change with
            update =
              Request_put
                { update with
                  request =
                    { old_record with revision = 2; priority = 4; supersedes = [ id ] }
                }
          ; notifications =
              List.map change.notifications ~f:(fun n ->
                { n with source = Request old; source_revision = 2 })
          }
      | event -> event)
  in
  let payload =
    match payload with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "changes"
             then `Array (List.map forged ~f:Planning_state.Event.jsonaf_of_t)
             else value )))
    | _ -> assert false
  in
  report (State.replay state payload);
  List.iter
    [ {|{"request_id":"new","expected_revision":"2","priority":"5"}|}
    ; {|{"request_id":"new","expected_revision":"2","related_request_ids":["old","old"]}|}
    ; {|{"request_id":"new","expected_revision":"2"}|}
    ]
    ~f:(fun json ->
      report
        (Communication.decode ~method_:"request.metadata" ~params:(Jsonaf.of_string json)));
  [%expect
    {|
    priority=2 deadline=false links=old supersedes=old
    replay equal=true
    Conflict
    Conflict
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "bounded answer expansion keeps exact refs and rejects inconsistent public bodies"
  =
  let asked = prepare (empty ()) (ask ()) |> unwrap |> State.candidate in
  let resolved =
    prepare
      asked
      (Communication
         (Request_resolve
            { id = request; expected_revision = 1; body = Some (String.make 60000 'x') }))
    |> unwrap
    |> State.candidate
  in
  let bounded =
    query
      resolved
      "request.get"
      (Json.obj
         [ "request_id", Communication_id.Request.jsonaf_of_t request
         ; "max_bytes", Json.int 4096
         ])
  in
  let record = get bounded "record" in
  let answer = get record "answer" in
  printf
    "bounded=%b answer_revision=%d clipped=%b\n"
    (match get (get bounded "budget") "truncated" with
     | `True -> true
     | _ -> false)
    (get answer "revision" |> Json.integer)
    (String.length (get answer "body" |> Json.text) < 60000);
  let broken_answer =
    match answer with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "revision" then Json.int 2 else value))
    | _ -> assert false
  in
  let broken =
    match record with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "answer" then broken_answer else value))
    | _ -> assert false
  in
  report (Api_codec.decode Communication_wire.request_current broken);
  [%expect
    {|
    bounded=true answer_revision=1 clipped=true
    Invalid_argument
    |}]
;;
