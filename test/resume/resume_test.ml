open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let parse s = ok (Json.parse s)
let actor = ok (Id.Actor.of_string "worker")

let empty () =
  ok (State.empty ~workspace:(ok (Id.Workspace.of_string "resume")) ~name:"Resume")
;;

let step ?(actor = actor) ?run state method_ params =
  let command = ok (Domain_command.decode ~method_ ~params) in
  State.candidate
    (ok
       (State.prepare
          state
          command
          ~actor
          ?run
          ~now_unix_ms:100L
          ~timestamp:"2026-10-08T00:00:00Z"))
;;

let write state method_ params = step state method_ (parse params)

let query ?(now = Some 100L) state method_ params =
  ok (State.query ?now_unix_ms:now state ~method_ ~params:(parse params))
;;

let data value = Json.field value "data"
let array value field = Json.field value field |> Json.list

let fixture () =
  write
    (empty ())
    "ticket.create"
    {|{"ticket_id":"task","title":"Recorded task","description":"Objective"}|}
;;

let field value key = Json.field value key

let bool = function
  | `True -> true
  | `False -> false
  | _ -> failwith "expected boolean"
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let entries result = array (data result) "entries"
let cursor result = field (data result) "cursor" |> Json.text
let scope = {|{"kind":"ticket","ticket_id":"task"}|}

let%expect_test "digest identifies replayed reopening without relabeling reassessments" =
  let replay state method_ params =
    let command = ok (Domain_command.decode ~method_ ~params:(parse params)) in
    let prepared =
      ok
        (State.prepare
           state
           command
           ~actor
           ~now_unix_ms:100L
           ~timestamp:"2026-10-08T00:00:00Z")
    in
    ok (State.replay state (State.events prepared))
  in
  let state = replay (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  let state = replay state "ticket.start" {|{"ticket_id":"task"}|} in
  let state =
    replay state "ticket.finish" {|{"ticket_id":"task","token":"1","evidence":"checked"}|}
  in
  let state =
    replay state "ticket.create" {|{"ticket_id":"dependent","title":"Dependent"}|}
  in
  let state =
    replay state "dependency.add" {|{"ticket_id":"dependent","prerequisite_id":"task"}|}
  in
  let state = replay state "ticket.start" {|{"ticket_id":"dependent"}|} in
  let state =
    replay
      state
      "ticket.finish"
      {|{"ticket_id":"dependent","token":"1","evidence":"checked"}|}
  in
  let before = State.revision state in
  let state =
    replay
      state
      "ticket.reopen"
      {|{"ticket_id":"task","expected_revision":"3","reason":"Correct the output"}|}
  in
  let page =
    query state "activity.digest" (sprintf {|{"after":"%d","limit":"1"}|} before)
  in
  let state =
    replay
      state
      "ticket.update"
      {|{"ticket_id":"task","expected_revision":"4","title":"Updated title"}|}
  in
  let next =
    query
      state
      "activity.digest"
      (Json.canonical (Json.obj [ "cursor", Json.string (cursor page) ]))
  in
  let task_rows rows =
    List.filter_map rows ~f:(fun row ->
      let item = field row "item" in
      if String.equal (Json.text (field item "kind")) "task"
      then
        Some
          ( Json.text (field (field item "record") "ticket_id")
          , Json.text (field row "category") )
      else None)
  in
  print_s [%sexp (task_rows (entries page @ entries next) : (string * string) list)];
  print_s
    [%sexp
      (Json.integer (field (field (data next) "capture") "through") = before + 1 : bool)];
  let latest =
    query
      state
      "activity.digest"
      (Json.canonical (Json.obj [ "cursor", Json.string (cursor next) ]))
  in
  print_s [%sexp (task_rows (entries latest) : (string * string) list)];
  [%expect
    {|
    ((task reopening) (dependent task_changed))
    true
    ((task task_changed))
    |}]
;;

let%expect_test "resume is deterministic, pinned and budgeted with optional markdown" =
  let state =
    fixture ()
    |> fun t ->
    write
      t
      "comment.add"
      {|{"comment_id":"decision","target":{"kind":"ticket","id":"task"},"body":"Use the recorded decision","kind":"decision"}|}
  in
  let result = query state "ticket.resume" {|{"ticket_id":"task","max_bytes":"4096"}|} in
  let result2 = query state "ticket.resume" {|{"ticket_id":"task","max_bytes":"4096"}|} in
  let view = data result in
  print_s
    [%sexp
      (String.equal (Json.canonical result) (Json.canonical result2) : bool)
    , (Api_response.encoded_size Planning_read result <= 4096 : bool)
    , (Option.is_none (Json.optional view "markdown") : bool)];
  let first = List.hd_exn (array view "items") in
  print_s
    [%sexp
      (Json.text (field first "kind") : string)
    , (List.length (array first "sources") : int)];
  let md =
    query
      state
      "ticket.resume"
      {|{"ticket_id":"task","include_markdown":true,"max_bytes":"65536"}|}
    |> data
    |> fun x -> field x "markdown" |> Json.text
  in
  print_s [%sexp (String.is_substring md ~substring:"Use the recorded decision" : bool)];
  [%expect
    {|
    (true true true)
    (task 2)
    true
    |}]
;;

let%expect_test "one commit splits by ordinal, capture stays fixed and terminal advances" =
  let operations =
    List.init 7 ~f:(fun index ->
      Json.obj
        [ "method", Json.string "comment.add"
        ; ( "params"
          , Json.obj
              [ "comment_id", Json.string ("c" ^ Int.to_string index)
              ; ( "target"
                , Json.obj [ "kind", Json.string "ticket"; "id", Json.string "task" ] )
              ; "body", Json.string ("decision " ^ Int.to_string index)
              ; "kind", Json.string "decision"
              ] )
        ])
  in
  let state =
    step (fixture ()) "transaction.apply" (Json.obj [ "operations", `Array operations ])
  in
  let first =
    query
      state
      "activity.digest"
      (Printf.sprintf {|{"scope":%s,"after":"1","limit":"2"}|} scope)
  in
  let state2 =
    write
      state
      "comment.add"
      {|{"comment_id":"later","target":{"kind":"ticket","id":"task"},"body":"after capture","kind":"decision"}|}
  in
  let next state cursor =
    query
      state
      "activity.digest"
      (Json.canonical
         (Json.obj
            [ "scope", parse scope; "cursor", Json.string cursor; "limit", Json.int 2 ]))
  in
  let rec pages encoded count seen =
    let page = next state2 encoded in
    let seen =
      seen
      @ List.map (entries page) ~f:(fun row -> Json.integer (field row "change_index"))
    in
    if bool (field (data page) "has_more")
    then pages (cursor page) (count + 1) seen
    else page, count, seen
  in
  let terminal, pages_count, seen =
    pages
      (cursor first)
      2
      (List.map (entries first) ~f:(fun row -> Json.integer (field row "change_index")))
  in
  print_s
    [%sexp
      (pages_count : int)
    , (seen : int list)
    , (Json.integer (field (field (data terminal) "capture") "through") : int)];
  let advanced = next state2 (cursor terminal) in
  print_s
    [%sexp
      (List.length (entries advanced) : int)
    , (Json.integer (field (field (data advanced) "capture") "through") : int)];
  [%expect
    {|
    (4 (0 1 2 3 4 5 6) 2)
    (1 3)
    |}]
;;

let%expect_test "selected facts preserve exact JSON and expose missing/deleted keys" =
  let state =
    write
      (fixture ())
      "fact.put"
      {|{"scope":{"kind":"ticket","id":"task"},"key":"decision","expected_revision":"0","value":{"literal":"$opaque","choice":[true,null]}}|}
  in
  let state =
    write
      state
      "fact.put"
      {|{"scope":{"kind":"ticket","id":"task"},"key":"deleted","expected_revision":"0","value":"past"}|}
    |> fun t ->
    write
      t
      "fact.delete"
      {|{"scope":{"kind":"ticket","id":"task"},"key":"deleted","expected_revision":"1"}|}
  in
  let result =
    query
      state
      "ticket.resume"
      {|{"ticket_id":"task","fact_selections":[{"scope":{"kind":"ticket","id":"task"},"key":"decision"},{"scope":{"kind":"ticket","id":"task"},"key":"deleted"},{"scope":{"kind":"ticket","id":"task"},"key":"absent"}]}|}
    |> data
  in
  let fact =
    array result "items"
    |> List.find_exn ~f:(fun x ->
      String.equal (Json.text (field x "kind")) "fact"
      && String.equal (Json.text (field (field x "record") "key")) "decision")
  in
  print_endline (Json.canonical (field (field fact "record") "value"));
  print_s
    [%sexp
      (List.map (array result "warnings") ~f:(fun x -> Json.text (field x "code"))
       |> List.filter ~f:(String.is_prefix ~prefix:"fact_")
       : string list)];
  [%expect
    {|
    {"choice":[true,null],"literal":"$opaque"}
    (fact_deleted fact_missing)
    |}]
;;

let%expect_test "strict counters, clips, cursor scopes and independent restore lineage" =
  let state = fixture () in
  outcome
    (State.query
       state
       ~method_:"ticket.resume"
       ~params:(parse {|{"ticket_id":"task","max_bytes":"4095"}|}));
  let page =
    query state "activity.digest" {|{"scope":{"kind":"ticket","ticket_id":"task"}}|}
  in
  outcome
    (State.query
       state
       ~method_:"activity.digest"
       ~params:(Json.obj [ "cursor", Json.string (cursor page) ]));
  let altered =
    write (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Different capture"}|}
  in
  outcome
    (State.query
       altered
       ~method_:"activity.digest"
       ~params:(Json.obj [ "scope", parse scope; "cursor", Json.string (cursor page) ]));
  let result = query state "ticket.resume" {|{"ticket_id":"task"}|} |> data in
  let bad_count =
    Json.obj
      [ "section", Json.string "fake"
      ; "total", Json.int 1
      ; "returned", Json.int 1
      ; "omitted", Json.int 1
      ]
  in
  let bad =
    match result with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "counts" then `Array [ bad_count ] else value))
    | _ -> assert false
  in
  outcome
    (Api_codec.decode
       (Option.value_exn (Resume_api.response_codec ~method_:"ticket.resume"))
       bad);
  [%expect
    {|
    Invalid_argument
    Conflict
    Conflict
    Invalid_argument
    |}]
;;

let%expect_test
    "workspace coverage differs from serial and same actor replacement token warns"
  =
  let state = write (fixture ()) "ticket.claim" {|{"ticket_id":"task"}|} in
  let state =
    List.fold (List.init 5 ~f:Fn.id) ~init:state ~f:(fun state index ->
      step
        state
        "run.register"
        (Json.obj
           [ "target_run_id", Json.string ("r" ^ Int.to_string index)
           ; "objective", Json.string "unrelated"
           ]))
  in
  let covered = State.revision state in
  let state =
    write
      state
      "handoff.set"
      (Printf.sprintf
         {|{"ticket_id":"task","expected_revision":"0","token":"1","summary":"Saved decision","next_steps":"Continue","evidence":"recorded","covers_through":"%d"}|}
         covered)
  in
  let state =
    write
      state
      "comment.add"
      {|{"comment_id":"after","target":{"kind":"ticket","id":"task"},"body":"After covered workspace revision","kind":"decision"}|}
  in
  let context = query state "ticket.context" {|{"ticket_id":"task"}|} |> data in
  print_s [%sexp (List.length (array (field context "updates") "items") : int)];
  let state =
    write state "ticket.release" {|{"ticket_id":"task","token":"1"}|}
    |> fun t -> write t "ticket.claim" {|{"ticket_id":"task"}|}
  in
  let brief = query state "ticket.resume" {|{"ticket_id":"task"}|} |> data in
  let codes =
    array brief "warnings"
    |> List.map ~f:(fun warning -> Json.text (field warning "code"))
  in
  print_s [%sexp (List.mem codes "handoff_claim_changed" ~equal:String.equal : bool)];
  [%expect
    {|
    1
    true
    |}]
;;

let%expect_test "long prose disclosed and whole fact omitted at small budget" =
  let state =
    step
      (empty ())
      "ticket.create"
      (Json.obj
         [ "ticket_id", Json.string "task"
         ; "title", Json.string (String.make 400 't')
         ; "description", Json.string (String.make 20000 'x')
         ])
  in
  let state =
    step
      state
      "fact.put"
      (Json.obj
         [ "scope", parse {|{"kind":"ticket","id":"task"}|}
         ; "key", Json.string "large"
         ; "expected_revision", Json.int 0
         ; "value", Json.string (String.make 3900 'v')
         ])
  in
  let result =
    query
      state
      "ticket.resume"
      {|{"ticket_id":"task","max_bytes":"4096","fact_selections":[{"scope":{"kind":"ticket","id":"task"},"key":"large"}]}|}
  in
  let brief = data result in
  let task = List.hd_exn (array brief "items") in
  print_s
    [%sexp
      (Api_response.encoded_size Planning_read result <= 4096 : bool)
    , (List.length (array task "clipped_fields") : int)
    , (List.exists (array brief "items") ~f:(fun x ->
         String.equal (Json.text (field x "kind")) "fact")
       : bool)];
  let count =
    array brief "counts"
    |> List.find_exn ~f:(fun count ->
      String.equal (Json.text (field count "section")) "selected_facts")
  in
  print_s [%sexp (Json.integer (field count "omitted") : int)];
  [%expect
    {|
    (true 2 false)
    1
    |}]
;;

let%expect_test "public output rejects invented clips and mismatched row provenance" =
  let state = fixture () in
  let brief = query state "ticket.resume" {|{"ticket_id":"task"}|} |> data in
  let task = List.hd_exn (array brief "items") in
  let replace value field replacement =
    match value with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal field key then replacement else value))
    | _ -> assert false
  in
  let bogus =
    Json.obj
      [ "field", Json.string "priority"
      ; "original_bytes", Json.int 10
      ; "omitted_bytes", Json.int 5
      ]
  in
  outcome
    (Api_codec.decode
       Resume_api.item_codec
       (replace task "clipped_fields" (`Array [ bogus ])));
  let clips =
    Json.obj
      [ "field", Json.string "title"
      ; "original_bytes", Json.int 100
      ; "omitted_bytes", Json.int 1
      ]
  in
  outcome
    (Api_codec.decode
       Resume_api.item_codec
       (replace task "clipped_fields" (`Array [ clips ])));
  let page = query state "activity.digest" {|{}|} in
  let row = List.hd_exn (entries page) in
  outcome
    (Api_codec.decode Resume_api.entry_codec (replace row "change_index" (Json.int 1)));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "a whole first fact row cannot be silently skipped" =
  let state =
    step
      (fixture ())
      "fact.put"
      (Json.obj
         [ "scope", parse {|{"kind":"ticket","id":"task"}|}
         ; "key", Json.string "large"
         ; "expected_revision", Json.int 0
         ; "value", Json.string (String.make 3900 'x')
         ])
  in
  outcome
    (State.query
       state
       ~method_:"activity.digest"
       ~params:
         (parse
            {|{"scope":{"kind":"ticket","ticket_id":"task"},"after":"1","max_bytes":"4096"}|}));
  [%expect {| Invalid_argument |}]
;;

let%expect_test "ordinal continuation agrees with independent generated reference" =
  let cases = List.init 35 ~f:(fun seed -> 1 + (seed % 13), 1 + (seed % 5)) in
  let valid =
    List.for_all cases ~f:(fun (size, limit) ->
      let operations =
        List.init size ~f:(fun index ->
          Json.obj
            [ "method", Json.string "comment.add"
            ; ( "params"
              , Json.obj
                  [ "comment_id", Json.string ("d" ^ Int.to_string index)
                  ; "target", parse {|{"kind":"ticket","id":"task"}|}
                  ; "kind", Json.string "decision"
                  ; "body", Json.string "recorded"
                  ] )
            ])
      in
      let state =
        step
          (fixture ())
          "transaction.apply"
          (Json.obj [ "operations", `Array operations ])
      in
      let rec collect next acc =
        let params =
          Json.obj
            ([ "scope", parse scope; "limit", Json.int limit ]
             @
             match next with
             | None -> [ "after", Json.int 1 ]
             | Some encoded -> [ "cursor", Json.string encoded ])
        in
        let page = ok (State.query state ~method_:"activity.digest" ~params) in
        let acc =
          acc
          @ List.map (entries page) ~f:(fun row ->
            Json.integer (field row "change_index"))
        in
        if bool (field (data page) "has_more")
        then collect (Some (cursor page)) acc
        else acc
      in
      List.equal Int.equal (collect None []) (List.init size ~f:Fn.id))
  in
  print_s [%sexp (valid : bool), (List.length cases : int)];
  [%expect {| (true 35) |}]
;;

let%expect_test "recovery prefix clears ownership before later run and metadata changes" =
  let run = ok (Id.Run.of_string "run") in
  let state =
    write (fixture ()) "run.register" {|{"target_run_id":"run","objective":"worker"}|}
  in
  let state = step ~run state "ticket.claim" (parse {|{"ticket_id":"task"}|}) in
  let state =
    write
      state
      "ticket.recover"
      {|{"ticket_id":"task","expected_revision":"2","recovery_id":"recovered","old_actor_id":"worker","old_run_id":"run","token":"1","expected_lease_revision":"1","confirmation":"isolated","reason":"old execution stopped"}|}
  in
  let after = State.revision state in
  let state =
    write
      state
      "run.observe"
      {|{"target_run_id":"run","expected_revision":"1","observed_unix_ms":"110"}|}
  in
  let state =
    write
      state
      "ticket.update"
      {|{"ticket_id":"task","expected_revision":"3","title":"Changed after recovery"}|}
  in
  let digest =
    query
      state
      "activity.digest"
      (Printf.sprintf
         {|{"scope":{"kind":"ticket","ticket_id":"task"},"after":"%d"}|}
         after)
  in
  print_s
    [%sexp
      (List.map (entries digest) ~f:(fun row -> Json.text (field row "category"))
       : string list)];
  let task =
    List.hd_exn (entries digest) |> fun row -> field (field row "item") "record"
  in
  print_s
    [%sexp
      ((match field task "claim" with
        | `Null -> true
        | _ -> false)
       : bool)];
  [%expect
    {|
    (task_changed)
    true
    |}]
;;

let%expect_test
    "captured milestone containment and one-hop resource links determine scopes"
  =
  let state =
    write (empty ()) "project.create" {|{"project_id":"p","title":"Project"}|}
  in
  let state =
    write state "ticket.create" {|{"ticket_id":"task","project_id":"p","title":"Task"}|}
  in
  let state =
    write
      state
      "milestone.create"
      {|{"milestone_id":"m","project_id":"p","title":"Milestone"}|}
  in
  let state =
    write
      state
      "resource.put_text"
      {|{"resource_id":"r","expected_revision":"0","title":"Resource","text":"recorded source"}|}
  in
  let state =
    write
      state
      "resource.link"
      {|{"resource_id":"r","expected_revision":"1","target":{"kind":"ticket","id":"task"}}|}
  in
  let after = State.revision state in
  let state =
    write
      state
      "comment.add"
      {|{"comment_id":"milestone","target":{"kind":"milestone","id":"m"},"body":"Milestone decision","kind":"decision"}|}
  in
  let state =
    write
      state
      "fact.put"
      {|{"scope":{"kind":"milestone","id":"m"},"key":"decision","expected_revision":"0","value":"milestone fact"}|}
  in
  let state =
    write
      state
      "comment.add"
      {|{"comment_id":"resource","target":{"kind":"resource","id":"r"},"body":"Resource decision","kind":"decision"}|}
  in
  let page =
    query
      state
      "activity.digest"
      (Printf.sprintf
         {|{"scope":{"kind":"project","project_id":"p"},"after":"%d","limit":"1"}|}
         after)
  in
  let state =
    write
      state
      "resource.unlink"
      {|{"resource_id":"r","expected_revision":"2","target":{"kind":"ticket","id":"task"}}|}
  in
  let state =
    write
      state
      "comment.add"
      {|{"comment_id":"unlinked","target":{"kind":"resource","id":"r"},"body":"No longer belongs to task","kind":"decision"}|}
  in
  let continuation cursor =
    query
      state
      "activity.digest"
      (Json.canonical
         (Json.obj
            [ "scope", parse {|{"kind":"project","project_id":"p"}|}
            ; "cursor", Json.string cursor
            ]))
  in
  let next = continuation (cursor page) in
  print_s
    [%sexp
      (List.map
         (entries page @ entries next)
         ~f:(fun row -> Json.text (field row "category"))
       : string list)];
  let advanced = continuation (cursor next) in
  print_s
    [%sexp
      (List.map (entries advanced) ~f:(fun row -> Json.text (field row "category"))
       : string list)];
  let ticket =
    query
      state
      "activity.digest"
      (Printf.sprintf
         {|{"scope":{"kind":"ticket","ticket_id":"task"},"after":"%d"}|}
         after)
  in
  print_s
    [%sexp
      (List.map (entries ticket) ~f:(fun row -> Json.text (field row "category"))
       : string list)];
  [%expect
    {|
    (decision fact decision)
    (resource)
    (decision resource)
    |}]
;;

let%expect_test
    "unregistered attribution run is disclosed, explicit missing selector rejects"
  =
  let run = ok (Id.Run.of_string "unregistered") in
  let state = step ~run (fixture ()) "ticket.start" (parse {|{"ticket_id":"task"}|}) in
  let brief = query state "ticket.resume" {|{"ticket_id":"task"}|} |> data in
  let warning =
    List.find_exn (array brief "warnings") ~f:(fun warning ->
      String.equal (Json.text (field warning "code")) "associated_run_missing")
  in
  let task = List.hd_exn (array brief "items") |> fun item -> field item "record" in
  print_s
    [%sexp
      (Json.text (field (field task "claim") "run_id") : string)
    , (List.is_empty (array warning "sources") : bool)];
  outcome
    (State.query
       state
       ~method_:"ticket.resume"
       ~params:(parse {|{"ticket_id":"task","run_id":"unregistered"}|}));
  [%expect
    {|
    (unregistered false)
    Not_found
    |}]
;;

let%expect_test
    "markdown carries exact controls, warnings, counts and fits both representations"
  =
  let run = ok (Id.Run.of_string "attribution") in
  let state = step ~run (fixture ()) "ticket.start" (parse {|{"ticket_id":"task"}|}) in
  let result =
    query
      state
      "ticket.resume"
      {|{"ticket_id":"task","include_markdown":true,"max_bytes":"12000"}|}
  in
  let markdown = Json.text (field (data result) "markdown") in
  print_s
    [%sexp
      (Api_response.encoded_size Planning_read result <= 12000 : bool)
    , (String.is_substring markdown ~substring:{|"run_id":"attribution"|} : bool)
    , (String.is_substring markdown ~substring:"associated_run_missing" : bool)
    , (String.is_substring markdown ~substring:"Section counts:" : bool)
    , (String.is_substring markdown ~substring:"Current readiness" : bool)
    , (String.is_substring markdown ~substring:"Observed UTC Unix milliseconds: \"100\""
       : bool)];
  [%expect {| (true true true true true true) |}]
;;

let%expect_test "resume retains a 289 byte description and spends remaining prose budget" =
  let make description =
    step
      (empty ())
      "ticket.create"
      (Json.obj
         [ "ticket_id", Json.string "task"
         ; "title", Json.string "Task"
         ; "description", Json.string description
         ])
  in
  let short = String.make 289 'x' in
  let result =
    query (make short) "ticket.resume" {|{"ticket_id":"task","max_bytes":"65536"}|}
  in
  let item = List.hd_exn (array (data result) "items") in
  print_s
    [%sexp
      (String.equal short (Json.text (field (field item "record") "objective")) : bool)
    , (List.is_empty (array item "clipped_fields") : bool)];
  let long = String.concat (List.init 20000 ~f:(fun _ -> "é")) in
  let result =
    query
      (make long)
      "ticket.resume"
      {|{"ticket_id":"task","max_bytes":"16384","include_markdown":true}|}
  in
  let item = List.hd_exn (array (data result) "items") in
  let excerpt = Json.text (field (field item "record") "objective") in
  let clip =
    List.find_exn (array item "clipped_fields") ~f:(fun row ->
      String.equal (Json.text (field row "field")) "objective")
  in
  let valid =
    Uutf.String.fold_utf_8
      (fun valid _ -> function
         | `Uchar _ -> valid
         | `Malformed _ -> false)
      true
      excerpt
  in
  print_s
    [%sexp
      (String.length excerpt > 256 : bool)
    , (String.is_prefix long ~prefix:excerpt : bool)
    , (valid : bool)
    , (Json.integer (field clip "omitted_bytes")
       = String.length long - String.length excerpt
       : bool)
    , (Api_response.encoded_size Planning_read result <= 16384 : bool)];
  [%expect
    {|
    (true true)
    (true true true true true)
    |}]
;;

let%expect_test
    "resume Markdown deduplicates latest handoff while keeping exact history and coverage"
  =
  let state = write (fixture ()) "ticket.start" {|{"ticket_id":"task"}|} in
  let state =
    write
      state
      "handoff.set"
      {|{"ticket_id":"task","token":"1","expected_revision":"0","summary":"Saved","next_steps":"Continue","evidence":"Reviewed","objective":"HANDOFF_OBJECTIVE_UNIQUE","covers_through":"2"}|}
  in
  let state = write state "ticket.release" {|{"ticket_id":"task","token":"1"}|} in
  let result =
    query
      state
      "ticket.resume"
      {|{"ticket_id":"task","max_bytes":"65536","include_markdown":true}|}
  in
  let view = data result in
  let markdown = Json.text (field view "markdown") in
  let occurrences =
    String.substr_index_all
      markdown
      ~pattern:"HANDOFF_OBJECTIVE_UNIQUE"
      ~may_overlap:false
  in
  let handoff =
    List.find_exn (array view "items") ~f:(fun item ->
      String.equal (Json.text (field item "kind")) "handoff")
  in
  let history =
    List.filter (array view "changes") ~f:(fun row ->
      String.equal (Json.text (field (field row "item") "kind")) "handoff")
  in
  let warning =
    List.find_exn (array view "warnings") ~f:(fun w ->
      String.equal (Json.text (field w "code")) "handoff_bookkeeping_activity")
  in
  print_s
    [%sexp
      (List.length occurrences : int)
    , (List.length history : int)
    , (Json.integer (field (field handoff "record") "covers_through") : int)
    , (String.is_substring markdown ~substring:"Ticket description:" : bool)
    , (String.is_substring markdown ~substring:"Handoff objective:" : bool)];
  print_endline (Json.text (field warning "detail"));
  let saved = Json.canonical result in
  let later =
    write
      state
      "comment.add"
      {|{"target":{"kind":"ticket","id":"task"},"body":"Later work"}|}
  in
  print_s [%sexp (String.equal saved (Json.canonical result) : bool)];
  let later_resume = query later "ticket.resume" {|{"ticket_id":"task"}|} in
  let warnings = array (data later_resume) "warnings" in
  print_s
    [%sexp
      (List.exists warnings ~f:(fun w ->
         String.equal (Json.text (field w "code")) "handoff_new_activity")
       : bool)
    , (List.exists warnings ~f:(fun w ->
         String.equal (Json.text (field w "code")) "handoff_bookkeeping_activity")
       : bool)];
  [%expect
    {|
    (1 1 2 true true)
    2 recorded changes follow handoff coverage (claim=1, handoff=1). Only handoff/ownership bookkeeping is recorded; inspect ownership before acting. Coverage is unchanged.
    true
    (true false)
    |}]
;;
