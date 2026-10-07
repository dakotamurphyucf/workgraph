open Core
open Workgraph

let%expect_test "workspace constructors and ID sexp decoding validate invariants" =
  let workspace = Id.Workspace.of_string "demo" |> Disk.unwrap in
  (match State.empty ~workspace ~name:" " with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  (try
     ignore (Id.Ticket.t_of_sexp (Sexp.Atom "../escape") : Id.Ticket.t);
     print_endline "unexpected success"
   with
   | Sexplib.Conv.Of_sexp_error _ -> print_endline "invalid ID rejected");
  [%expect
    {|
    Invalid_argument
    invalid ID rejected |}]
;;

let%expect_test "canonical JSON rejects duplicate keys" =
  (match Json.parse {|{"title":"one","title":"two"}|} with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]);
  [%expect {| Invalid_argument |}]
;;

let actor = Id.Actor.of_string "agent" |> Disk.unwrap

let empty () =
  State.empty ~workspace:(Id.Workspace.of_string "demo" |> Disk.unwrap) ~name:"Demo"
  |> Disk.unwrap
;;

let prepare state method_ params =
  let command =
    Domain_command.decode ~method_ ~params:(Json.parse params |> Disk.unwrap)
    |> Disk.unwrap
  in
  let wire_method, wire_params = Wire_command.encode command |> Disk.unwrap in
  let decoded =
    Domain_command.decode ~method_:wire_method ~params:wire_params |> Disk.unwrap
  in
  if
    not (Sexp.equal (Domain_command.sexp_of_t command) (Domain_command.sexp_of_t decoded))
  then failwith "typed command encoding changed command semantics";
  State.prepare state command ~actor ~timestamp:"2026-10-07T00:00:00Z"
;;

let apply state method_ params =
  prepare state method_ params |> Disk.unwrap |> State.candidate
;;

let outcome result =
  match result with
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let%expect_test "atomic batch resolves forward creation aliases at final validation" =
  let state = empty () in
  let prepared =
    prepare
      state
      "transaction.apply"
      {|
    {"operations":[
      {"method":"ticket.create","as":"task","params":{"ticket_id":"a","title":"A","project_id":"$plan"}},
      {"method":"project.create","as":"plan","params":{"project_id":"p","title":"P"}},
      {"method":"comment.add","params":{"ticket_id":"$task","body":"Created together"}}
    ]}|}
    |> Disk.unwrap
  in
  let candidate = State.candidate prepared in
  printf "before %d; after %d\n" (State.revision state) (State.revision candidate);
  let replayed = State.replay state (State.events prepared) |> Disk.unwrap in
  printf
    "replay matches: %b\n"
    (String.equal
       (Json.canonical (State.to_json candidate))
       (Json.canonical (State.to_json replayed)));
  let context =
    State.query
      candidate
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  let ticket = Json.field (Json.field context "data") "ticket" in
  printf "project %s\n" (Json.text (Json.field ticket "project"));
  [%expect
    {|
    before 0; after 1
    replay matches: true
    project p |}]
;;

let%expect_test "atomic batch rejects cycles without publishing a prefix" =
  let state = empty () in
  outcome
    (prepare
       state
       "transaction.apply"
       {|
    {"operations":[
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.create","params":{"ticket_id":"b","title":"B"}},
      {"method":"dependency.add","params":{"ticket_id":"a","prerequisite_id":"b"}},
      {"method":"dependency.add","params":{"ticket_id":"b","prerequisite_id":"a"}}
    ]}|});
  printf "unchanged revision: %d\n" (State.revision state);
  outcome
    (Domain_command.decode
       ~method_:"transaction.apply"
       ~params:
         (Json.parse
            {|{"operations":[{"method":"transaction.apply","params":{"operations":[]}}]}|}
          |> Disk.unwrap));
  [%expect
    {|
    Dependency_cycle
    unchanged revision: 0
    Invalid_argument |}]
;;

let%expect_test
    "final batch cannot add an unresolved prerequisite to a newly completed ticket"
  =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state = apply state "ticket.create" {|{"ticket_id":"b","title":"B"}|} in
  outcome
    (prepare
       state
       "transaction.apply"
       {|
    {"operations":[
      {"method":"ticket.update","params":{"ticket_id":"a","expected_revision":"1","status":"done"}},
      {"method":"dependency.add","params":{"ticket_id":"a","prerequisite_id":"b"}}
    ]}|});
  [%expect {| Blocked |}]
;;

let%expect_test "milestone project invariant and subtree moves are atomic" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"project.create","params":{"project_id":"p","title":"P"}},
      {"method":"project.create","params":{"project_id":"q","title":"Q"}},
      {"method":"milestone.create","params":{"milestone_id":"m","project_id":"p","title":"M","target_date":"2026-12-01"}},
      {"method":"ticket.create","params":{"ticket_id":"root","title":"Root","project_id":"p","milestone_id":"m"}},
      {"method":"ticket.create","params":{"ticket_id":"child","title":"Child","project_id":"p","parent_id":"root","milestone_id":"m"}}
    ]}|}
  in
  outcome
    (prepare
       state
       "ticket.create"
       {|{"ticket_id":"bad","title":"Bad","project_id":"q","milestone_id":"m"}|});
  let state =
    apply
      state
      "ticket.move"
      {|{"ticket_id":"root","expected_revision":"1","project_id":"q","milestone_id":null,"parent_id":null}|}
  in
  let tickets =
    State.query
      state
      ~method_:"ticket.list"
      ~params:(Json.obj [ "project_id", Json.string "q" ])
    |> Disk.unwrap
  in
  Json.field (Json.field tickets "data") "items"
  |> Json.list
  |> List.iter ~f:(fun ticket ->
    printf
      "%s: project=%s milestone=%s\n"
      (Json.text (Json.field ticket "id"))
      (Json.text (Json.field ticket "project"))
      (Json.canonical (Json.field ticket "milestone")));
  outcome
    (prepare
       state
       "ticket.move"
       {|{"ticket_id":"root","expected_revision":"2","project_id":"q","milestone_id":null,"parent_id":"child"}|});
  [%expect
    {|
    Conflict
    child: project=q milestone=null
    root: project=q milestone=null
    Dependency_cycle |}]
;;

let%expect_test "archival cannot hide active prerequisites and keeps history" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.create","params":{"ticket_id":"b","title":"B"}},
      {"method":"dependency.add","params":{"ticket_id":"b","prerequisite_id":"a"}}
    ]}|}
  in
  outcome
    (prepare
       state
       "ticket.archive"
       {|{"ticket_id":"a","expected_revision":"1","archived":true}|});
  let state =
    apply
      state
      "ticket.archive"
      {|{"ticket_id":"b","expected_revision":"2","archived":true}|}
  in
  List.iter [ false; true ] ~f:(fun include_archived ->
    let response =
      State.query
        state
        ~method_:"ticket.list"
        ~params:
          (Json.obj [ ("include_archived", if include_archived then `True else `False) ])
      |> Disk.unwrap
    in
    printf
      "include archived %b: %d tickets\n"
      include_archived
      (Json.field (Json.field response "data") "items" |> Json.list |> List.length));
  [%expect
    {|
    Conflict
    include archived false: 1 tickets
    include archived true: 2 tickets |}]
;;

let%expect_test "revision conflicts and comments do not overwrite ticket edits" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"First"}|} in
  let state = apply state "comment.add" {|{"ticket_id":"a","body":"Progress"}|} in
  outcome
    (prepare
       state
       "ticket.update"
       {|{"ticket_id":"a","expected_revision":"1","title":"Updated"}|});
  outcome
    (prepare
       state
       "ticket.update"
       {|{"ticket_id":"a","expected_revision":"0","title":"Stale"}|});
  printf "original workspace revision: %d\n" (State.revision state);
  [%expect
    {|
    ok
    Conflict
    original workspace revision: 2 |}]
;;

let%expect_test "dependency cycles, cancellation and competing claims" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state = apply state "ticket.create" {|{"ticket_id":"b","title":"B"}|} in
  let state = apply state "dependency.add" {|{"ticket_id":"b","prerequisite_id":"a"}|} in
  outcome (prepare state "dependency.add" {|{"ticket_id":"a","prerequisite_id":"b"}|});
  outcome (prepare state "ticket.claim" {|{"ticket_id":"b","expected_revision":"2"}|});
  let state =
    apply
      state
      "ticket.update"
      {|{"ticket_id":"a","expected_revision":"1","status":"canceled"}|}
  in
  outcome (prepare state "ticket.claim" {|{"ticket_id":"b","expected_revision":"2"}|});
  let state =
    apply
      state
      "ticket.update"
      {|{"ticket_id":"a","expected_revision":"2","status":"todo"}|}
  in
  let state = apply state "ticket.claim" {|{"ticket_id":"a","expected_revision":"3"}|} in
  outcome (prepare state "ticket.claim" {|{"ticket_id":"a","expected_revision":"4"}|});
  outcome
    (prepare
       state
       "ticket.complete"
       {|{"ticket_id":"a","token":"0","evidence":"tests passed"}|});
  let state =
    apply
      state
      "ticket.complete"
      {|{"ticket_id":"a","token":"1","evidence":"tests passed"}|}
  in
  outcome (prepare state "ticket.claim" {|{"ticket_id":"b","expected_revision":"2"}|});
  [%expect
    {|
    Dependency_cycle
    Blocked
    Blocked
    Already_claimed
    Stale_claim
    ok |}]
;;

let%expect_test "handoff context resumes at its coverage cursor" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state = apply state "comment.add" {|{"ticket_id":"a","body":"Before"}|} in
  let state =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"a","expected_revision":"0","summary":"Ready to test","next_steps":"Run suite","evidence":"build passed"}|}
  in
  let state = apply state "comment.add" {|{"ticket_id":"a","body":"After"}|} in
  let context =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  let items =
    Json.field (Json.field (Json.field context "data") "updates") "items" |> Json.list
  in
  List.iter items ~f:(fun item -> print_endline (Json.text (Json.field item "body")));
  outcome
    (prepare
       state
       "handoff.set"
       {|{"ticket_id":"a","expected_revision":"0","summary":"Stale","next_steps":"Overwrite","evidence":"none"}|});
  let changes =
    State.query state ~method_:"activity.since" ~params:(Json.obj []) |> Disk.unwrap
  in
  let changes = Json.field (Json.field changes "data") "items" |> Json.list in
  printf "audit transactions: %d\n" (List.length changes);
  [%expect
    {|
    After
    Conflict
    audit transactions: 4 |}]
;;

let%expect_test "resolved event replay matches candidate across arbitrary UTF-8 titles" =
  let titles =
    Quickcheck.Generator.filter String.quickcheck_generator ~f:(fun title ->
      String.length title <= 200
      && Uutf.String.fold_utf_8
           (fun valid _ -> function
              | `Uchar _ -> valid
              | `Malformed _ -> false)
           true
           title)
  in
  Quickcheck.test titles ~trials:100 ~f:(fun title ->
    let title = "Ticket " ^ title in
    let params =
      Json.obj [ "ticket_id", Json.string "a"; "title", Json.string title ]
      |> Json.canonical
    in
    let state = empty () in
    let prepared = prepare state "ticket.create" params |> Disk.unwrap in
    let replayed = State.replay state (State.events prepared) |> Disk.unwrap in
    assert (
      String.equal
        (Json.canonical (State.to_json replayed))
        (Json.canonical (State.to_json (State.candidate prepared)))));
  print_endline "100 replay equivalence cases passed";
  [%expect {| 100 replay equivalence cases passed |}]
;;

let%expect_test "invalid wire data and unsupported storage version" =
  outcome
    (Domain_command.decode
       ~method_:"ticket.create"
       ~params:
         (Json.obj [ "ticket_id", Json.string "../escape"; "title", Json.string "A" ]));
  outcome
    (Domain_command.decode
       ~method_:"ticket.create"
       ~params:
         (Json.obj
            [ "ticket_id", Json.string "a"; "title", Json.string "A"; "typo", `True ]));
  let prepared =
    prepare (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} |> Disk.unwrap
  in
  let events =
    match State.events prepared with
    | `Object fields ->
      Json.obj (List.Assoc.add fields ~equal:String.equal "version" (Json.int 99))
    | _ -> assert false
  in
  outcome (State.replay (empty ()) events);
  printf "sha256 abc: %s\n" (Json.hash "abc");
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Unsupported_version
    sha256 abc: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad |}]
;;

let%expect_test "catalog semantics and metadata references survive renaming and archive" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"actor.put","params":{"target_actor_id":"worker","name":"Worker","kind":"agent","expected_revision":"0"}},
      {"method":"label.put","params":{"label_id":"backend","name":"Backend","expected_revision":"0"}},
      {"method":"status.put","params":{"status_id":"ready","name":"Ready for implementation","category":"todo","expected_revision":"0"}},
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.metadata","params":{"ticket_id":"a","expected_revision":"1","assignee_id":"worker","label_ids":["backend"],"priority":"1","status_id":"ready","acceptance_criteria":"Tests pass"}}
    ]}|}
  in
  outcome
    (prepare
       state
       "status.put"
       {|{"status_id":"ready","name":"Finished","category":"done","expected_revision":"1"}|});
  outcome
    (prepare
       state
       "ticket.metadata"
       {|{"ticket_id":"a","expected_revision":"2","label_ids":["missing"]}|});
  outcome
    (prepare
       state
       "ticket.metadata"
       {|{"ticket_id":"a","expected_revision":"2","priority":"5"}|});
  let state =
    apply
      state
      "status.put"
      {|{"status_id":"ready","name":"Ready now","category":"todo","expected_revision":"1","archived":true}|}
  in
  outcome
    (prepare
       state
       "ticket.metadata"
       {|{"ticket_id":"a","expected_revision":"2","status_id":"ready"}|});
  let data =
    State.query state ~method_:"ticket.ready" ~params:(Json.obj [])
    |> Disk.unwrap
    |> fun j -> Json.field j "data"
  in
  printf
    "ready after catalog archive: %d\n"
    (Json.list (Json.field data "items") |> List.length);
  let state =
    apply
      state
      "ticket.metadata"
      {|{"ticket_id":"a","expected_revision":"2","assignee_id":null,"status_id":null}|}
  in
  let context =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  let ticket = Json.field (Json.field context "data") "ticket" in
  printf
    "assignee %s; status ID %s\n"
    (Json.canonical (Json.field ticket "assignee"))
    (Json.canonical (Json.field ticket "status_id"));
  [%expect
    {|
    Conflict
    Not_found
    Invalid_argument
    Conflict
    ready after catalog archive: 1
    assignee null; status ID null |}]
;;

let%expect_test
    "custom done status uses completion invariants and atomic final validation"
  =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"status.put","params":{"status_id":"verified","name":"Verified","category":"done","expected_revision":"0"}},
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.create","params":{"ticket_id":"b","title":"B"}}
    ]}|}
  in
  outcome
    (prepare
       state
       "transaction.apply"
       {|
    {"operations":[
      {"method":"ticket.metadata","params":{"ticket_id":"a","expected_revision":"1","status_id":"verified"}},
      {"method":"dependency.add","params":{"ticket_id":"a","prerequisite_id":"b"}}
    ]}|});
  outcome
    (State.query
       (empty ())
       ~method_:"ticket.list"
       ~params:(Json.obj [ "status", Json.string "nonsense" ]));
  [%expect
    {|
    Blocked
    Invalid_argument |}]
;;

let%expect_test
    "holds and dependency waivers preserve separate lifecycle and graph semantics"
  =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.create","params":{"ticket_id":"b","title":"B"}},
      {"method":"dependency.add","params":{"ticket_id":"a","prerequisite_id":"b"}},
      {"method":"ticket.update","params":{"ticket_id":"b","expected_revision":"1","status":"canceled"}}
    ]}|}
  in
  outcome (prepare state "ticket.claim" {|{"ticket_id":"a","expected_revision":"2"}|});
  let state =
    apply
      state
      "dependency.waive"
      {|{"ticket_id":"a","prerequisite_id":"b","expected_revision":"2","reason":"Out of this delivery scope"}|}
  in
  let state =
    apply
      state
      "ticket.archive"
      {|{"ticket_id":"b","expected_revision":"2","archived":true}|}
  in
  let state =
    apply
      state
      "ticket.hold"
      {|{"ticket_id":"a","expected_revision":"3","reason":"Awaiting decision"}|}
  in
  outcome (prepare state "ticket.claim" {|{"ticket_id":"a","expected_revision":"4"}|});
  outcome
    (prepare
       state
       "ticket.update"
       {|{"ticket_id":"a","expected_revision":"4","status":"done"}|});
  let state =
    apply state "ticket.hold" {|{"ticket_id":"a","expected_revision":"4","reason":null}|}
  in
  outcome (prepare state "ticket.claim" {|{"ticket_id":"a","expected_revision":"5"}|});
  outcome
    (prepare
       state
       "dependency.waive"
       {|{"ticket_id":"a","prerequisite_id":"b","expected_revision":"5","reason":null}|});
  (match prepare state "dependency.add" {|{"ticket_id":"b","prerequisite_id":"a"}|} with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_endline error.message);
  let state =
    apply state "dependency.remove" {|{"ticket_id":"a","prerequisite_id":"b"}|}
  in
  outcome
    (prepare
       state
       "ticket.update"
       {|{"ticket_id":"a","expected_revision":"6","status":"done"}|});
  [%expect
    {|
    Blocked
    Blocked
    Blocked
    ok
    Conflict
    dependency cycle: a -> b -> a
    ok |}]
;;

let%expect_test "reassignment revokes stale fencing tokens without assigning ticket" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state = apply state "ticket.claim" {|{"ticket_id":"a","expected_revision":"1"}|} in
  let state =
    apply
      state
      "ticket.reassign"
      {|{"ticket_id":"a","expected_revision":"2","claimant_id":"other","reason":"Handing off interrupted session"}|}
  in
  outcome
    (prepare
       state
       "ticket.complete"
       {|{"ticket_id":"a","token":"1","evidence":"old work"}|});
  outcome
    (prepare
       state
       "ticket.reassign"
       {|{"ticket_id":"a","expected_revision":"2","claimant_id":"agent","reason":"stale race"}|});
  let command =
    Domain_command.decode
      ~method_:"ticket.complete"
      ~params:
        (Json.parse {|{"ticket_id":"a","token":"2","evidence":"new work"}|} |> Disk.unwrap)
    |> Disk.unwrap
  in
  outcome
    (State.prepare
       state
       command
       ~actor:(Id.Actor.of_string "other" |> Disk.unwrap)
       ~timestamp:"2026-10-07T00:00:00Z");
  let context =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  let ticket = Json.field (Json.field context "data") "ticket" in
  printf "assignment: %s\n" (Json.canonical (Json.field ticket "assignee"));
  [%expect
    {|
    Stale_claim
    Conflict
    ok
    assignment: null |}]
;;

let%expect_test "dependency graph agrees with independent transitive closure model" =
  Quickcheck.test
    (Int.gen_incl 0 ((1 lsl 25) - 1))
    ~trials:80
    ~f:(fun mask ->
      let ids = Array.init 5 ~f:(fun i -> "node" ^ Int.to_string i) in
      let state = ref (empty ()) in
      Array.iter ids ~f:(fun id ->
        state
        := apply
             !state
             "ticket.create"
             (Json.canonical
                (Json.obj [ "ticket_id", Json.string id; "title", Json.string id ])));
      let edges = Array.init 5 ~f:(fun _ -> Array.create ~len:5 false) in
      let finished = Array.create ~len:5 false in
      let verify_ready () =
        let query =
          State.query !state ~method_:"ticket.ready" ~params:(Json.obj []) |> Disk.unwrap
        in
        let actual =
          Json.list (Json.field (Json.field query "data") "items")
          |> List.map ~f:(fun j -> Json.text (Json.field j "id"))
          |> String.Set.of_list
        in
        let expected =
          Array.to_list
            (Array.mapi ids ~f:(fun i id ->
               if
                 (not finished.(i))
                 && Array.for_alli edges.(i) ~f:(fun j edge -> (not edge) || finished.(j))
               then Some id
               else None))
          |> List.filter_opt
          |> String.Set.of_list
        in
        assert (Set.equal actual expected)
      in
      for i = 0 to 4 do
        for j = 0 to 4 do
          if mask land (1 lsl ((i * 5) + j)) <> 0
          then (
            let closure = Array.map edges ~f:Array.copy in
            for k = 0 to 4 do
              for x = 0 to 4 do
                for y = 0 to 4 do
                  closure.(x).(y)
                  <- closure.(x).(y) || (closure.(x).(k) && closure.(k).(y))
                done
              done
            done;
            let cycle = i = j || closure.(j).(i) in
            let params =
              Json.obj
                [ "ticket_id", Json.string ids.(i)
                ; "prerequisite_id", Json.string ids.(j)
                ]
              |> Json.canonical
            in
            match prepare !state "dependency.add" params with
            | Error error ->
              assert (cycle && Problem.equal_kind error.kind Dependency_cycle)
            | Ok prepared ->
              assert (not cycle);
              edges.(i).(j) <- true;
              state := State.candidate prepared;
              verify_ready ())
        done
      done;
      for _pass = 0 to 4 do
        for i = 0 to 4 do
          if not finished.(i)
          then (
            let context =
              State.query
                !state
                ~method_:"ticket.context"
                ~params:(Json.obj [ "ticket_id", Json.string ids.(i) ])
              |> Disk.unwrap
            in
            let ticket = Json.field (Json.field context "data") "ticket" in
            let params =
              Json.obj
                [ "ticket_id", Json.string ids.(i)
                ; "expected_revision", Json.field ticket "revision"
                ; "status", Json.string "done"
                ]
              |> Json.canonical
            in
            let satisfied =
              Array.for_alli edges.(i) ~f:(fun j edge -> (not edge) || finished.(j))
            in
            match prepare !state "ticket.update" params with
            | Error error ->
              assert ((not satisfied) && Problem.equal_kind error.kind Blocked)
            | Ok prepared ->
              assert satisfied;
              finished.(i) <- true;
              state := State.candidate prepared;
              verify_ready ())
        done
      done;
      assert (Array.for_all finished ~f:Fn.id));
  print_endline "80 graph models agree on cycles, readiness and completion";
  [%expect {| 80 graph models agree on cycles, readiness and completion |}]
;;

let%expect_test "editing completed ticket content does not rerun completion policy" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.create","params":{"ticket_id":"b","title":"B"}},
      {"method":"dependency.add","params":{"ticket_id":"a","prerequisite_id":"b"}},
      {"method":"ticket.update","params":{"ticket_id":"b","expected_revision":"1","status":"done"}},
      {"method":"ticket.update","params":{"ticket_id":"a","expected_revision":"2","status":"done"}}
    ]}|}
  in
  let state =
    apply
      state
      "ticket.update"
      {|{"ticket_id":"b","expected_revision":"2","status":"todo"}|}
  in
  outcome
    (prepare
       state
       "ticket.update"
       {|{"ticket_id":"a","expected_revision":"3","title":"Corrected title"}|});
  outcome
    (prepare
       state
       "ticket.metadata"
       {|{"ticket_id":"a","expected_revision":"3","priority":"2"}|});
  outcome
    (prepare
       state
       "ticket.update"
       {|{"ticket_id":"a","expected_revision":"3","status":"done"}|});
  [%expect
    {|
    ok
    ok
    Blocked |}]
;;

let%expect_test "comment revisions, replies and tombstones keep recoverable history" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state =
    apply
      state
      "comment.add"
      {|{"ticket_id":"a","comment_id":"note","kind":"decision","body":"Original decision"}|}
  in
  let state =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"a","expected_revision":"0","summary":"Decision recorded","next_steps":"Test","evidence":"Note","covers_through":"2"}|}
  in
  let state =
    apply
      state
      "comment.edit"
      {|{"comment_id":"note","expected_revision":"1","body":"Revised decision"}|}
  in
  outcome
    (prepare
       state
       "comment.edit"
       {|{"comment_id":"note","expected_revision":"1","body":"Stale edit"}|});
  let state =
    apply
      state
      "comment.add"
      {|{"ticket_id":"a","comment_id":"reply","reply_to":"note","body":"Follow-up"}|}
  in
  let state =
    apply state "comment.tombstone" {|{"comment_id":"note","expected_revision":"2"}|}
  in
  outcome
    (prepare
       state
       "comment.add"
       {|{"ticket_id":"a","reply_to":"note","body":"Late reply"}|});
  let context =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  let data = Json.field context "data" in
  let updates = Json.field (Json.field data "updates") "items" |> Json.list in
  List.iter updates ~f:(fun j ->
    printf
      "%s r%s: %s; tombstone %s\n"
      (Json.text (Json.field j "comment_id"))
      (Json.text (Json.field j "revision"))
      (Json.text (Json.field j "body"))
      (Json.canonical (Json.field j "tombstone")));
  printf
    "ticket revision %s\n"
    (Json.text (Json.field (Json.field data "ticket") "revision"));
  let history =
    State.query
      state
      ~method_:"comment.history"
      ~params:(Json.obj [ "comment_id", Json.string "note" ])
    |> Disk.unwrap
  in
  printf
    "retained versions: %d\n"
    (Json.list (Json.field (Json.field history "data") "items") |> List.length);
  [%expect
    {|
    Conflict
    Conflict
    note r2: Revised decision; tombstone false
    reply r1: Follow-up; tombstone false
    note r3: ; tombstone true
    ticket revision 1
    retained versions: 3 |}]
;;

let%expect_test "discussion scope and protected handoff invariants are atomic" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"ticket.create","params":{"ticket_id":"a","title":"A"}},
      {"method":"ticket.create","params":{"ticket_id":"b","title":"B"}},
      {"method":"comment.add","params":{"ticket_id":"a","comment_id":"note","body":"Note"}}
    ]}|}
  in
  outcome
    (prepare
       state
       "comment.add"
       {|{"ticket_id":"b","reply_to":"note","body":"Wrong target"}|});
  outcome
    (prepare
       state
       "comment.add"
       {|{"target":{"kind":"project","id":"missing"},"body":"Dangling"}|});
  let state = apply state "ticket.claim" {|{"ticket_id":"a","expected_revision":"1"}|} in
  outcome
    (prepare
       state
       "handoff.set"
       {|{"ticket_id":"a","expected_revision":"0","summary":"x","next_steps":"x","evidence":"x"}|});
  outcome
    (prepare state "ticket.progress" {|{"ticket_id":"a","token":"2","body":"Stale"}|});
  outcome
    (prepare
       state
       "transaction.apply"
       {|
    {"operations":[
      {"method":"ticket.progress","params":{"ticket_id":"a","token":"1","body":"Current progress"}},
      {"method":"handoff.set","params":{"ticket_id":"a","token":"1","expected_revision":"0","summary":"Updated","next_steps":"Test","evidence":"Progress","covers_through":"100"}}
    ]}|});
  let state =
    apply
      state
      "transaction.apply"
      {|
    {"operations":[
      {"method":"ticket.progress","params":{"ticket_id":"a","token":"1","body":"Current progress"}},
      {"method":"handoff.set","params":{"ticket_id":"a","token":"1","expected_revision":"0","summary":"Updated","next_steps":"Test","evidence":"Progress","objective":"Finish MVP","decisions":"Use CLI"}}
    ]}|}
  in
  let context =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  let data = Json.field context "data" in
  printf
    "same-transaction updates remain visible: %d\n"
    (Json.list (Json.field (Json.field data "updates") "items") |> List.length);
  [%expect
    {|
    Conflict
    Not_found
    Stale_claim
    Stale_claim
    Conflict
    same-transaction updates remain visible: 1 |}]
;;

let%expect_test "handoff history preserves provenance and explicit coverage" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"a","expected_revision":"0","summary":"First","next_steps":"Build","evidence":"Plan","covers_through":"0"}|}
  in
  let state =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"a","expected_revision":"1","summary":"Second","next_steps":"Test","evidence":"Build passed","objective":"Ship","completed":"Build","decisions":"Local","blockers":"None"}|}
  in
  let history =
    State.query
      state
      ~method_:"handoff.history"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  List.iter
    (Json.list (Json.field (Json.field history "data") "items"))
    ~f:(fun handoff ->
      printf
        "%s by %s covers %s\n"
        (Json.text (Json.field handoff "summary"))
        (Json.text (Json.field handoff "actor"))
        (Json.text (Json.field handoff "covers_through")));
  let current =
    State.query
      state
      ~method_:"handoff.get"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  printf
    "objective: %s\n"
    (Json.text (Json.field (Json.field current "data") "objective"));
  [%expect
    {|
    First by agent covers 0
    Second by agent covers 2
    objective: Ship |}]
;;

let%expect_test "typed target aliases resolve before final entity validation" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"comment.add","params":{"comment_id":"note","target":{"kind":"resource","id":"$design"},"body":"Review design"}},
      {"method":"resource.put_text","as":"design","params":{"resource_id":"design","expected_revision":"0","title":"Design","text":"Local only"}}
    ]}|}
  in
  let comment =
    State.query
      state
      ~method_:"comment.get"
      ~params:(Json.obj [ "comment_id", Json.string "note" ])
    |> Disk.unwrap
  in
  printf "%s\n" (Json.canonical (Json.field (Json.field comment "data") "target"));
  [%expect {| {"id":"design","kind":"resource"} |}]
;;

let%expect_test
    "resource metadata revisions preserve immutable version metadata and links"
  =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state =
    apply
      state
      "resource.put_text"
      {|{"resource_id":"r","expected_revision":"0","title":"Research","filename":"notes.md","mime_type":"text/markdown","text":"v1"}|}
  in
  let state =
    apply
      state
      "resource.link"
      {|{"resource_id":"r","expected_revision":"1","target":{"kind":"ticket","id":"a"}}|}
  in
  let state =
    apply
      state
      "resource.update"
      {|{"resource_id":"r","expected_revision":"2","description":"Review evidence","filename":"renamed.md"}|}
  in
  outcome
    (prepare
       state
       "resource.put_text"
       {|{"resource_id":"r","expected_revision":"1","title":"Research","text":"stale"}|});
  let state =
    apply
      state
      "resource.put_text"
      {|{"resource_id":"r","expected_revision":"3","title":"Research","filename":"renamed.md","mime_type":"text/markdown","text":"v2"}|}
  in
  let history =
    State.query
      state
      ~method_:"resource.history"
      ~params:(Json.obj [ "resource_id", Json.string "r" ])
    |> Disk.unwrap
  in
  List.iter
    (Json.list (Json.field (Json.field history "data") "items"))
    ~f:(fun version ->
      printf
        "v%s %s %s bytes\n"
        (Json.text (Json.field version "revision"))
        (Json.text (Json.field version "filename"))
        (Json.text (Json.field version "size_bytes")));
  let context =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a" ])
    |> Disk.unwrap
  in
  printf
    "attachments: %d\n"
    (Json.list (Json.field (Json.field (Json.field context "data") "resources") "items")
     |> List.length);
  outcome
    (prepare
       state
       "resource.link"
       {|{"resource_id":"r","expected_revision":"4","target":{"kind":"ticket","id":"missing"}}|});
  outcome
    (prepare
       state
       "resource.update"
       {|{"resource_id":"r","expected_revision":"4","filename":"../escape"}|});
  let state =
    apply
      state
      "resource.archive"
      {|{"resource_id":"r","expected_revision":"4","archived":true}|}
  in
  outcome
    (prepare
       state
       "resource.put_text"
       {|{"resource_id":"r","expected_revision":"5","title":"Research","text":"v3"}|});
  let visible =
    State.query state ~method_:"resource.list" ~params:(Json.obj []) |> Disk.unwrap
  in
  printf
    "visible: %d\n"
    (Json.list (Json.field (Json.field visible "data") "items") |> List.length);
  [%expect
    {|
    Conflict
    v1 notes.md 2 bytes
    v2 renamed.md 2 bytes
    attachments: 1
    Not_found
    Invalid_argument
    Conflict
    visible: 0 |}]
;;

let%expect_test "query budgets preserve UTF-8, identity and resumable page offsets" =
  let description = String.concat (List.init 10_000 ~f:(fun _ -> "界")) in
  let state =
    List.fold (List.init 10 ~f:Fn.id) ~init:(empty ()) ~f:(fun state index ->
      apply
        state
        "ticket.create"
        (Json.obj
           [ "ticket_id", Json.string ("t" ^ Int.to_string index)
           ; "title", Json.string "Ticket"
           ; "description", Json.string description
           ]
         |> Json.canonical))
  in
  let params = Json.obj [ "max_bytes", Json.int 4096; "limit", Json.int 10 ] in
  let result = State.query state ~method_:"ticket.list" ~params |> Disk.unwrap in
  let encoded = Json.canonical result in
  printf
    "within budget: %b; reported size correct: %b\n"
    (String.length encoded <= 4096)
    (Json.integer (Json.field (Json.field result "budget") "returned_bytes")
     = String.length encoded);
  let page = Json.field result "data" in
  let items = Json.list (Json.field page "items") in
  printf
    "nonempty partial page: %b\n"
    ((not (List.is_empty items)) && List.length items < 10);
  List.iter items ~f:(fun item ->
    assert (not (String.is_empty (Json.text (Json.field item "id"))));
    assert (String.length (Json.text (Json.field item "description")) mod 3 = 0));
  let next = Json.integer (Json.field page "next_offset") in
  printf "cursor counts returned items: %b\n" (next = List.length items);
  let next_page =
    State.query
      state
      ~method_:"ticket.list"
      ~params:
        (Json.obj
           [ "max_bytes", Json.int 4096
           ; "offset", Json.int next
           ; "at_revision", Json.int (State.revision state)
           ])
    |> Disk.unwrap
  in
  let first =
    Json.list (Json.field (Json.field next_page "data") "items") |> List.hd_exn
  in
  printf
    "next identity matches cursor: %b\n"
    (String.equal (Json.text (Json.field first "id")) ("t" ^ Int.to_string next));
  [%expect
    {|
    within budget: true; reported size correct: true
    nonempty partial page: true
    cursor counts returned items: true
    next identity matches cursor: true |}]
;;

let%expect_test "context budget discloses omissions and rejects invalid budgets" =
  let body = String.make 65_536 'x' in
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let state =
    apply
      state
      "comment.add"
      (Json.obj [ "ticket_id", Json.string "a"; "body", Json.string body ]
       |> Json.canonical)
  in
  let result =
    State.query
      state
      ~method_:"ticket.context"
      ~params:(Json.obj [ "ticket_id", Json.string "a"; "max_bytes", Json.int 4096 ])
    |> Disk.unwrap
  in
  let budget = Json.field result "budget" in
  printf
    "truncated: %s; omitted fields positive: %b\n"
    (Json.canonical (Json.field budget "truncated"))
    (Json.integer (Json.field budget "omitted_fields") > 0);
  outcome
    (State.query
       state
       ~method_:"workspace.overview"
       ~params:(Json.obj [ "max_bytes", Json.int 1 ]));
  [%expect
    {|
    truncated: true; omitted fields positive: true
    Invalid_argument |}]
;;

let%expect_test "lexical search reports stable source revisions across current memory" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|
    {"operations":[
      {"method":"project.create","params":{"project_id":"p","title":"Needle project"}},
      {"method":"milestone.create","params":{"milestone_id":"m","project_id":"p","title":"Needle milestone"}},
      {"method":"ticket.create","params":{"ticket_id":"a","project_id":"p","title":"Needle ticket"}},
      {"method":"comment.add","params":{"comment_id":"c","ticket_id":"a","body":"A NEEDLE decision"}},
      {"method":"handoff.set","params":{"ticket_id":"a","expected_revision":"0","summary":"Needle handoff","next_steps":"Next","evidence":"Tests"}},
      {"method":"resource.put_text","params":{"resource_id":"r","expected_revision":"0","title":"Needle research","text":"Needle content"}},
      {"method":"resource.link","params":{"resource_id":"r","expected_revision":"1","target":{"kind":"project","id":"p"}}}
    ]}|}
  in
  let result =
    State.query
      state
      ~method_:"search.query"
      ~params:(Json.obj [ "text", Json.string "needle"; "project_id", Json.string "p" ])
    |> Disk.unwrap
  in
  let data = Json.field result "data" in
  List.iter
    (Json.list (Json.field data "items"))
    ~f:(fun item ->
      let source = Json.field item "source" in
      printf
        "%s %s r%s\n"
        (Json.text (Json.field source "kind"))
        (Json.text (Json.field source "id"))
        (Json.text (Json.field source "revision")));
  printf
    "text without filesystem provider disclosed: %s\n"
    (Json.text (Json.field (Json.field data "coverage") "unindexed_text_resources"));
  let state =
    apply state "comment.tombstone" {|{"comment_id":"c","expected_revision":"1"}|}
  in
  let result =
    State.query
      state
      ~method_:"search.query"
      ~params:
        (Json.obj
           [ "text", Json.string "needle"; "kinds", `Array [ Json.string "comment" ] ])
    |> Disk.unwrap
  in
  printf
    "tombstone matches: %d\n"
    (Json.list (Json.field (Json.field result "data") "items") |> List.length);
  [%expect
    {|
    project p r1
    milestone m r1
    ticket a r1
    comment c r1
    handoff a r1
    resource r r2
    text without filesystem provider disclosed: 1
    tombstone matches: 0 |}]
;;

let%expect_test "search rejects stale extracted resource versions and malformed filters" =
  let state =
    apply
      (empty ())
      "resource.put_text"
      {|{"resource_id":"r","expected_revision":"0","title":"R","text":"old needle"}|}
  in
  let id = Id.Resource.of_string "r" |> Disk.unwrap in
  let version = State.resource_version state id ~revision:None |> Disk.unwrap in
  let texts =
    [ { Search.Text.id
      ; version = version.revision
      ; digest = version.digest
      ; outcome = Content { text = "old needle"; total_bytes = 10 }
      }
    ]
  in
  let state =
    apply
      state
      "resource.put_text"
      {|{"resource_id":"r","expected_revision":"1","title":"R","text":"new needle"}|}
  in
  outcome
    (State.query_with_texts
       state
       ~resource_texts:texts
       ~method_:"search.query"
       ~params:(Json.obj [ "text", Json.string "needle" ]));
  outcome
    (State.search_resources
       state
       ~params:
         (Json.obj
            [ "text", Json.string "needle"; "kinds", `Array [ Json.string "unknown" ] ]));
  outcome (State.search_resources state ~params:(Json.obj [ "text", Json.string "" ]));
  [%expect
    {|
    Conflict
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test
    "ready ordering follows committed creation sequence despite clock reversal"
  =
  let state =
    apply (empty ()) "ticket.create" {|{"ticket_id":"z","title":"Created first"}|}
  in
  let command =
    Domain_command.decode
      ~method_:"ticket.create"
      ~params:(Json.parse {|{"ticket_id":"a","title":"Created second"}|} |> Disk.unwrap)
    |> Disk.unwrap
  in
  let state =
    State.prepare state command ~actor ~timestamp:"2000-01-01T00:00:00Z"
    |> Disk.unwrap
    |> State.candidate
  in
  let ready =
    State.query state ~method_:"ticket.ready" ~params:(Json.obj []) |> Disk.unwrap
  in
  Json.list (Json.field (Json.field ready "data") "items")
  |> List.iter ~f:(fun ticket -> print_endline (Json.text (Json.field ticket "id")));
  [%expect
    {|
    z
    a |}]
;;

let%expect_test "byte budget bounds account for JSON escaping and omission metadata" =
  Quickcheck.test (Int.gen_incl 4096 100_000) ~trials:100 ~f:(fun max_bytes ->
    let body = String.concat (List.init 10000 ~f:(fun _ -> "\"\\\n界")) in
    let items =
      List.init 12 ~f:(fun i ->
        Json.obj [ "id", Json.string (Int.to_string i); "body", Json.string body ])
    in
    let value =
      Json.obj
        [ "workspace_revision", Json.int 9
        ; ( "data"
          , Json.obj
              [ "items", `Array items
              ; "offset", Json.int 7
              ; "next_offset", `Null
              ; "remaining", Json.int 0
              ] )
        ]
    in
    let result = Query_budget.fit ~max_bytes value in
    let size = String.length (Json.canonical result) in
    assert (size <= max_bytes);
    assert (Json.integer (Json.field (Json.field result "budget") "returned_bytes") = size);
    let data = Json.field result "data" in
    let count = List.length (Json.list (Json.field data "items")) in
    assert (count + Json.integer (Json.field data "remaining") = 12);
    if count < 12 then assert (Json.integer (Json.field data "next_offset") = 7 + count));
  print_endline "100 escaped JSON budgets and cursors verified";
  [%expect {| 100 escaped JSON budgets and cursors verified |}]
;;

let%expect_test "related links are symmetric revisioned and nonblocking" =
  let state =
    empty ()
    |> fun t ->
    apply t "ticket.create" {|{"ticket_id":"a","title":"A"}|}
    |> fun t -> apply t "ticket.create" {|{"ticket_id":"b","title":"B"}|}
  in
  let link =
    {|{"ticket_id":"a","related_id":"b","expected_revision":"1","related_expected_revision":"1"}|}
  in
  let prepared = prepare state "related.add" link |> Disk.unwrap in
  let linked = State.candidate prepared in
  let replayed = State.replay state (State.events prepared) |> Disk.unwrap in
  let asymmetric =
    match State.events prepared with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           if String.equal key "changes"
           then key, `Array (List.take (Json.list value) 1)
           else key, value))
    | _ -> assert false
  in
  outcome (State.replay state asymmetric);
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json linked))
         (Json.canonical (State.to_json replayed))
       : bool)];
  let tickets = Json.list (Json.field (State.to_json linked) "tickets") in
  List.iter tickets ~f:(fun ticket ->
    printf
      "%s: %s\n"
      (Json.text (Json.field ticket "id"))
      (Json.canonical (Json.field ticket "related")));
  let ready =
    State.query linked ~method_:"ticket.ready" ~params:(Json.obj []) |> Disk.unwrap
  in
  printf
    "ready: %d\n"
    (Json.list (Json.field (Json.field ready "data") "items") |> List.length);
  outcome
    (prepare
       linked
       "related.remove"
       {|{"ticket_id":"a","related_id":"b","expected_revision":"2","related_expected_revision":"1"}|});
  outcome
    (prepare
       linked
       "related.add"
       {|{"ticket_id":"a","related_id":"a","expected_revision":"2","related_expected_revision":"2"}|});
  let cleared =
    apply
      linked
      "related.remove"
      {|{"ticket_id":"a","related_id":"b","expected_revision":"2","related_expected_revision":"2"}|}
  in
  List.iter
    (Json.list (Json.field (State.to_json cleared) "tickets"))
    ~f:(fun ticket ->
      printf
        "%s: %s\n"
        (Json.text (Json.field ticket "id"))
        (Json.canonical (Json.field ticket "related")));
  [%expect
    {|
    Corrupt_store
    true
    a: ["b"]
    b: ["a"]
    ready: 2
    Conflict
    Conflict
    a: []
    b: [] |}]
;;

let%expect_test "ticket display keys are sequential immutable and resolve after replay" =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|{"operations":[{"method":"ticket.create","params":{"ticket_id":"z","title":"First"}},{"method":"ticket.create","params":{"ticket_id":"a","title":"Second"}}]}|}
  in
  let resolve state key =
    State.query
      state
      ~method_:"ticket.resolve"
      ~params:(Json.obj [ "display_key", Json.string key ])
    |> Disk.unwrap
    |> fun json -> Json.field json "data" |> Json.canonical |> print_endline
  in
  resolve state "WG-1";
  resolve state "WG-2";
  let state =
    apply
      state
      "ticket.archive"
      {|{"ticket_id":"z","expected_revision":"1","archived":true}|}
  in
  let state = apply state "ticket.create" {|{"ticket_id":"third","title":"Third"}|} in
  resolve state "WG-1";
  resolve state "WG-3";
  let prepared =
    prepare
      state
      "ticket.update"
      {|{"ticket_id":"a","expected_revision":"1","title":"Renamed"}|}
    |> Disk.unwrap
  in
  let replayed = State.replay state (State.events prepared) |> Disk.unwrap in
  resolve replayed "WG-2";
  [%expect
    {|
    {"display_key":"WG-1","ticket_id":"z"}
    {"display_key":"WG-2","ticket_id":"a"}
    {"display_key":"WG-1","ticket_id":"z"}
    {"display_key":"WG-3","ticket_id":"third"}
    {"display_key":"WG-2","ticket_id":"a"} |}]
;;

let%expect_test
    "omitted creation IDs resolve before batch aliases but explicit IDs remain"
  =
  let count = ref 0 in
  let fresh _ =
    incr count;
    "generated_" ^ Int.to_string !count
  in
  let params =
    Json.parse
      {|{"operations":[{"method":"ticket.create","as":"task","params":{"title":"Ticket","project_id":"$plan"}},{"method":"project.create","as":"plan","params":{"project_id":"explicit","title":"Project"}},{"method":"comment.add","params":{"ticket_id":"$task","body":"Progress"}}]}|}
    |> Disk.unwrap
  in
  let resolved =
    Id_resolution.resolve ~method_:"transaction.apply" ~params ~fresh |> Disk.unwrap
  in
  let command =
    Domain_command.decode ~method_:"transaction.apply" ~params:resolved |> Disk.unwrap
  in
  let prepared =
    State.prepare (empty ()) command ~actor ~timestamp:"2026-10-07" |> Disk.unwrap
  in
  printf
    "generated IDs: %d; revision: %d\n"
    !count
    (State.revision (State.candidate prepared));
  print_endline (Json.canonical resolved);
  [%expect
    {|
    generated IDs: 2; revision: 1
    {"operations":[{"as":"task","method":"ticket.create","params":{"project_id":"$plan","ticket_id":"generated_1","title":"Ticket"}},{"as":"plan","method":"project.create","params":{"project_id":"explicit","title":"Project"}},{"method":"comment.add","params":{"body":"Progress","comment_id":"generated_2","ticket_id":"$task"}}]} |}]
;;

let%expect_test "claim run identity fences the same actor across invocations" =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  let run1 = Id.Run.of_string "run1" |> Disk.unwrap
  and run2 = Id.Run.of_string "run2" |> Disk.unwrap in
  let command method_ params =
    Domain_command.decode ~method_ ~params:(Json.parse params |> Disk.unwrap)
    |> Disk.unwrap
  in
  let claim =
    State.prepare
      state
      ~run:run1
      (command "ticket.claim" {|{"ticket_id":"a","expected_revision":"1"}|})
      ~actor
      ~timestamp:"2026-10-07"
    |> Disk.unwrap
  in
  let state = State.candidate claim in
  let complete =
    command "ticket.complete" {|{"ticket_id":"a","token":"1","evidence":"Passed"}|}
  in
  outcome (State.prepare state ~run:run2 complete ~actor ~timestamp:"2026-10-07");
  outcome (State.prepare state complete ~actor ~timestamp:"2026-10-07");
  let replayed =
    State.replay
      (apply (empty ()) "ticket.create" {|{"ticket_id":"a","title":"A"}|})
      (State.events claim)
    |> Disk.unwrap
  in
  outcome (State.prepare replayed ~run:run1 complete ~actor ~timestamp:"2026-10-07");
  print_endline (Json.text (Json.field (State.events claim) "run_id"));
  let reassigned =
    State.prepare
      state
      ~run:run1
      (command
         "ticket.reassign"
         {|{"ticket_id":"a","expected_revision":"2","claimant_id":"agent","claimant_run_id":"run2","reason":"Session handoff"}|})
      ~actor
      ~timestamp:"2026-10-07"
    |> Disk.unwrap
    |> State.candidate
  in
  let complete =
    command "ticket.complete" {|{"ticket_id":"a","token":"2","evidence":"Passed"}|}
  in
  outcome (State.prepare reassigned ~run:run1 complete ~actor ~timestamp:"2026-10-07");
  outcome (State.prepare reassigned ~run:run2 complete ~actor ~timestamp:"2026-10-07");
  [%expect
    {|
    Stale_claim
    Stale_claim
    ok
    run1
    Stale_claim
    ok |}]
;;
