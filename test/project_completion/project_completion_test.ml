open Core
open Workgraph

let ok = Disk.unwrap

let ticket ?(archived = false) ?(claimed = false) ?(attempts = []) ?problem id status =
  { Project_completion.Ticket.id = Id.Ticket.of_string id |> ok
  ; status
  ; archived
  ; claimed
  ; active_attempts = List.map attempts ~f:(fun s -> Attempt.Id.of_string s |> ok)
  ; completion_problem = problem
  }
;;

let milestone ?(archived = false) id status =
  { Project_completion.Milestone.id = Id.Milestone.of_string id |> ok; status; archived }
;;

let report ?(milestones = []) ?(requests = 0) tickets =
  Project_completion.create
    ~project:(Id.Project.of_string "p" |> ok)
    ~project_revision:2
    ~workspace_revision:10
    ~status:Workflow.Category.In_progress
    ~tickets
    ~milestones
    ~open_requests:requests
;;

let print_report report =
  let report = ok report in
  printf "can_complete=%b\n" (Project_completion.can_complete report);
  print_endline
    (Json.canonical
       (Api_codec.encode
          Project_completion.Counts.codec
          (Project_completion.counts report)
        |> ok));
  print_endline
    (Json.canonical
       (`Array
           (List.map (Project_completion.blockers report) ~f:(fun b ->
              Api_codec.encode Project_completion.Blocker.codec b |> ok))))
;;

let%expect_test "readiness pages are fenced and oversized blockers retain exact position" =
  let state =
    report (List.init 5 ~f:(fun i -> ticket ("t" ^ Int.to_string i) Todo)) |> ok
  in
  let query state params =
    Project_completion_api.query state ~params:(Json.parse params |> ok)
  in
  let first = query state {|{"project_id":"p","limit":"2"}|} |> ok in
  let data = Json.field first "data" in
  let response =
    List.find_map
      Project_completion_api.methods
      ~f:(fun (Api_method.Packed.Pack method_) ->
        if String.equal (Api_method.name method_) "project.readiness"
        then Some (Api_codec.as_json (Api_method.response_codec method_))
        else None)
    |> Option.value_exn
  in
  let replace value key replacement =
    match value with
    | `Object fields ->
      Json.obj (List.Assoc.add fields key replacement ~equal:String.equal)
    | `Array _ | `String _ | `Number _ | `True | `False | `Null -> assert false
  in
  let rows = Json.field data "items" |> Json.list in
  List.iter
    [ List.rev rows; [ List.hd_exn rows; List.hd_exn rows ] ]
    ~f:(fun items ->
      assert (
        Result.is_error (Api_codec.decode response (replace data "items" (`Array items)))));
  assert (Json.integer (Json.field data "remaining") = 3);
  assert (Json.integer (Json.field data "next_offset") = 2);
  let second =
    query state {|{"project_id":"p","offset":"2","at_revision":"10","limit":"3"}|} |> ok
  in
  let items page = Json.field (Json.field page "data") "items" |> Json.list in
  assert (List.length (items first @ items second) = 5);
  assert (Result.is_error (query state {|{"project_id":"p","offset":"2"}|}));
  (match query state {|{"project_id":"p","offset":"2","at_revision":"9"}|} with
   | Error p -> assert (Problem.equal_kind p.kind Conflict)
   | Ok _ -> assert false);
  let large =
    report
      [ ticket ~problem:(Problem.create Blocked (String.make 10000 '"')) "large" Done ]
    |> ok
  in
  let small = query large {|{"project_id":"p","max_bytes":"4096"}|} |> ok in
  let data = Json.field small "data" in
  List.iter [ 1; 1048577 ] ~f:(fun required ->
    assert (
      Result.is_error
        (Api_codec.decode response (replace data "required_bytes" (Json.int required)))));
  assert (List.is_empty (Json.list (Json.field data "items")));
  assert (Json.integer (Json.field data "next_offset") = 0);
  let required = Json.integer (Json.field data "required_bytes") in
  let expanded =
    query
      large
      (sprintf {|{"project_id":"p","at_revision":"10","max_bytes":"%d"}|} required)
    |> ok
  in
  let one_less =
    query
      large
      (sprintf {|{"project_id":"p","at_revision":"10","max_bytes":"%d"}|} (required - 1))
    |> ok
  in
  assert (List.length (items expanded) = 1);
  assert (List.is_empty (items one_less));
  assert (Api_response.encoded_size Planning_read expanded = required);
  let oversized =
    report
      [ ticket ~problem:(Problem.create Blocked (String.make 600000 '"')) "large" Done ]
    |> ok
  in
  (match query oversized {|{"project_id":"p"}|} with
   | Error p ->
     assert (Problem.equal_kind p.kind Invalid_argument);
     assert (String.is_substring p.message ~substring:"1048576-byte query limit")
   | Ok _ -> assert false);
  print_endline
    "exact pages, stale-capture rejection and minimum whole-row budget verified";
  [%expect
    {| exact pages, stale-capture rejection and minimum whole-row budget verified |}]
;;

let%expect_test "terminal cancellations are explicit; requests are observations" =
  print_report
    (report
       ~requests:3
       ~milestones:[ milestone "m" Canceled ]
       [ ticket "c" Canceled; ticket "d" Done ]);
  [%expect
    {|
    can_complete=true
    {"active_attempts":"0","archived_milestones":"0","archived_tickets":"0","canceled_tickets":"1","claimed_tickets":"0","done_tickets":"1","gated_tickets":"0","milestones":"1","open_requests":"3","tickets":"2","unfinished_milestones":"0","unfinished_tickets":"0"}
    []
    |}]
;;

let%expect_test "archival never hides incomplete members or ownership and gates" =
  print_report
    (report
       ~milestones:[ milestone ~archived:true "m" Todo ]
       [ ticket ~claimed:true "done-owned" Done
       ; ticket ~archived:true "archived" Todo
       ; ticket ~attempts:[ "attempt" ] "canceled-active" Canceled
       ; ticket
           ~problem:(Problem.create Blocked "canceled prerequisite not waived")
           "gated"
           Done
       ]);
  let report = report [ ticket "unfinished" Todo ] |> ok in
  (match Project_completion.ensure_can_complete report with
   | Ok () -> assert false
   | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  [%expect
    {|
    can_complete=false
    {"active_attempts":"1","archived_milestones":"1","archived_tickets":"1","canceled_tickets":"1","claimed_tickets":"1","done_tickets":"2","gated_tickets":"1","milestones":"1","open_requests":"0","tickets":"4","unfinished_milestones":"1","unfinished_tickets":"1"}
    [{"kind":"ticket","reasons":[{"kind":"unfinished","status":"todo"}],"ticket_id":"archived"},{"kind":"ticket","reasons":[{"attempt_id":"attempt","kind":"active_attempt"}],"ticket_id":"canceled-active"},{"kind":"ticket","reasons":[{"kind":"claimed"}],"ticket_id":"done-owned"},{"kind":"ticket","reasons":[{"kind":"completion_gate","problem":{"kind":"Blocked","message":"canceled prerequisite not waived"}}],"ticket_id":"gated"},{"kind":"milestone","milestone_id":"m","status":"todo"}]
    Blocked
    |}]
;;

let%expect_test "malformed captures and diagnostic counts reject" =
  List.iter
    [ report [ ticket "same" Done; ticket "same" Canceled ]
    ; report ~milestones:[ milestone "same" Done; milestone "same" Todo ] []
    ; report [ ticket ~attempts:[ "a"; "b" ] "t" Todo ]
    ; report
        [ ticket ~attempts:[ "a" ] "first" Todo; ticket ~attempts:[ "a" ] "second" Todo ]
    ; report ~requests:(-1) []
    ]
    ~f:(fun result -> assert (Result.is_error result));
  let counts = Project_completion.counts (report [ ticket "t" Done ] |> ok) in
  let invalid =
    { counts with Project_completion.Counts.canceled_tickets = Int.max_value }
  in
  assert (Result.is_error (Api_codec.encode Project_completion.Counts.codec invalid));
  let invalid_blocker =
    Project_completion.Blocker.Ticket
      { ticket_id = Id.Ticket.of_string "t" |> ok; reasons = [ Claimed; Claimed ] }
  in
  assert (
    Result.is_error (Api_codec.encode Project_completion.Blocker.codec invalid_blocker));
  let contradictory =
    Project_completion.Blocker.Ticket
      { ticket_id = Id.Ticket.of_string "t" |> ok
      ; reasons = [ Unfinished Todo; Completion_gate (Problem.create Blocked "gate") ]
      }
  in
  assert (
    Result.is_error (Api_codec.encode Project_completion.Blocker.codec contradictory));
  print_endline "invalid identities, multiplicities and counts rejected";
  [%expect {| invalid identities, multiplicities and counts rejected |}]
;;

let patch : Ticket_lifecycle.Handoff.t =
  { summary = "Finished"
  ; next_steps = "Archive when ready"
  ; objective = Some "Deliver"
  ; completed = Some "All work"
  ; decisions = Some "Kept the local design"
  ; blockers = Some ""
  ; resource_ids = Some [ Id.Resource.of_string "proof" |> ok ]
  ; covers_through = Some 10
  }
;;

let handoff ?previous ?(patch = patch) ?(revision = 2) ?(workspace_revision = 10) () =
  Project_completion.Handoff.create
    ~previous
    ~patch
    ~evidence:"Checks passed"
    ~actor:(Id.Actor.of_string "a" |> ok)
    ~run:None
    ~timestamp:"2026-11-03T00:00:00Z"
    ~project_revision:revision
    ~workspace_revision
;;

let%expect_test
    "handoff replacement preserves omitted context and rejects forged coverage"
  =
  let first = handoff () |> ok in
  let partial =
    { patch with
      objective = None
    ; completed = None
    ; decisions = None
    ; blockers = None
    ; resource_ids = None
    ; covers_through = None
    }
  in
  let second =
    handoff ~previous:first ~patch:partial ~revision:4 ~workspace_revision:20 () |> ok
  in
  let wire = Project_completion.Handoff.jsonaf_of_t second in
  let decoded = Project_completion.Handoff.t_of_jsonaf wire in
  assert (
    String.equal
      (Json.canonical wire)
      (Json.canonical (Project_completion.Handoff.jsonaf_of_t decoded)));
  let content = Json.field wire "content" in
  printf
    "objective=%s resources=%d coverage=%d project_revision=%d\n"
    (Json.field content "objective" |> Json.text)
    (List.length (Project_completion.Handoff.resource_ids second))
    (Project_completion.Handoff.covers_through second)
    (Project_completion.Handoff.project_revision second);
  let cleared =
    handoff
      ~previous:second
      ~patch:{ partial with resource_ids = Some []; objective = Some "" }
      ~revision:5
      ~workspace_revision:21
      ()
    |> ok
  in
  assert (List.is_empty (Project_completion.Handoff.resource_ids cleared));
  assert (
    String.is_empty
      (Json.field
         (Json.field (Project_completion.Handoff.jsonaf_of_t cleared) "content")
         "objective"
       |> Json.text));
  assert (Result.is_error (handoff ~previous:first ~revision:2 ()));
  assert (Result.is_error (handoff ~patch:{ patch with covers_through = Some 11 } ()));
  assert (
    Result.is_error
      (handoff
         ~patch:
           { patch with
             resource_ids =
               Some
                 [ Id.Resource.of_string "same" |> ok
                 ; Id.Resource.of_string "same" |> ok
                 ]
           }
         ()));
  printf
    "guards reject; old coverage=%d old revision=%d\n"
    (Project_completion.Handoff.covers_through first)
    (Project_completion.Handoff.project_revision first);
  [%expect
    {|
    objective=Deliver resources=1 coverage=10 project_revision=4
    guards reject; old coverage=10 old revision=2
  |}]
;;
