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
    answer: workspace=2 request=2 thread=3 messages=2
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
    batch: workspace=1 request=2 thread=3
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
