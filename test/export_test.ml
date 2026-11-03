open Core
open Workgraph

let%expect_test "readable text fences cannot be closed by recorded Markdown" =
  print_string (Readable_markdown.literal "line\n```\n# still literal\n````");
  print_string (Readable_markdown.section ~heading:"Blockers" "");
  [%expect
    {|
    `````text
    line
    ```
    # still literal
    ````
    `````

    ### Blockers

    _None recorded._
    |}]
;;

let%expect_test "readable handoffs and discussion preserve fields and exact versions" =
  let actor = Id.Actor.of_string "author" |> Disk.unwrap in
  let empty =
    State.empty ~workspace:(Id.Workspace.of_string "demo" |> Disk.unwrap) ~name:"Demo"
    |> Disk.unwrap
  in
  let apply state method_ params =
    let command =
      Domain_command.decode ~method_ ~params:(Json.parse params |> Disk.unwrap)
      |> Disk.unwrap
    in
    State.prepare state command ~actor ~timestamp:"2026-11-03T00:00:00Z"
    |> Disk.unwrap
    |> State.candidate
  in
  let state = apply empty "project.create" {|{"project_id":"p","title":"Project"}|} in
  let state =
    apply state "ticket.create" {|{"ticket_id":"t","project_id":"p","title":"Task"}|}
  in
  let state =
    apply
      state
      "comment.add"
      {|{"comment_id":"decision","target":{"kind":"project","id":"p"},"kind":"decision","body":"Keep exact integers."}|}
  in
  let state =
    apply
      state
      "comment.add"
      {|{"comment_id":"note","target":{"kind":"ticket","id":"t"},"body":"first version"}|}
  in
  let state =
    apply
      state
      "comment.edit"
      {|{"comment_id":"note","expected_revision":"1","body":"second version"}|}
  in
  let state =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"t","expected_revision":"0","summary":"summary sentinel","objective":"objective sentinel","completed":"completed sentinel","decisions":"decisions sentinel","blockers":"blockers sentinel","next_steps":"next sentinel","evidence":"checks sentinel"}|}
  in
  let files = State.readable_files state |> Sequence.to_list in
  let ticket = List.Assoc.find_exn files "tickets/t.md" ~equal:String.equal in
  let project = List.Assoc.find_exn files "projects/p.md" ~equal:String.equal in
  List.iter
    [ "summary sentinel"
    ; "objective sentinel"
    ; "completed sentinel"
    ; "decisions sentinel"
    ; "blockers sentinel"
    ; "next sentinel"
    ; "checks sentinel"
    ; "first version"
    ; "second version"
    ; "note (revision 1)"
    ; "note (revision 2)"
    ; "Actor: author"
    ]
    ~f:(fun substring ->
      printf "%s: %b\n" substring (String.is_substring ticket ~substring));
  printf
    "project decision: %b\n"
    (String.is_substring project ~substring:"Keep exact integers.");
  [%expect
    {|
    summary sentinel: true
    objective sentinel: true
    completed sentinel: true
    decisions sentinel: true
    blockers sentinel: true
    next sentinel: true
    checks sentinel: true
    first version: true
    second version: true
    note (revision 1): true
    note (revision 2): true
    Actor: author: true
    project decision: true
    |}]
;;

let%expect_test "export captures and current registry validate invariants" =
  let workspace = Id.Workspace.of_string "demo" |> Disk.unwrap in
  let job =
    { Export_job.id = "job"
    ; kind = Single
    ; destination = "/tmp/output"
    ; captures =
        [ { Export_job.Capture.workspace; revision = 0; head = None; history_head = None }
        ]
    ; omitted = []
    ; status = Running
    ; attempt = 1
    ; cancel_requested = false
    ; error = None
    }
  in
  let report job =
    match Json.decode (fun () -> Export_job.validate job) with
    | Ok () -> print_endline "valid"
    | Error error -> print_s [%sexp (error.kind : Problem.kind)]
  in
  report job;
  report { job with captures = [] };
  report { job with captures = job.captures @ job.captures; kind = All };
  report
    { job with
      captures = [ { workspace; revision = 1; head = None; history_head = None } ]
    };
  report { job with attempt = 0 };
  report { job with status = Completed; cancel_requested = true };
  report { job with status = Failed };
  let registry = Registry.empty in
  let registry = { registry with exports = String.Map.singleton "job" job } in
  let decoded =
    Registry.encode registry |> Disk.unwrap |> Registry.decode |> Disk.unwrap
  in
  printf "roundtrip export jobs: %d\n" (Map.length decoded.exports);
  [%expect
    {|
    valid
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    roundtrip export jobs: 1 |}]
;;

let%expect_test "export cancellation is idempotent before publication" =
  let control = Export_run.Control.create () in
  print_s [%sexp (Export_run.Control.canceled control : bool)];
  print_s [%sexp (Export_run.Control.cancel control : bool)];
  print_s [%sexp (Export_run.Control.cancel control : bool)];
  print_s [%sexp (Export_run.Control.canceled control : bool)];
  [%expect
    {|
    false
    true
    true
    true |}]
;;

let%expect_test "registry writers and readers agree on captured revision bounds" =
  let workspace = Id.Workspace.of_string "demo" |> Disk.unwrap in
  List.iter [ 0; 1; 100_000; 100_001; -1 ] ~f:(fun revision ->
    let capture =
      { Export_job.Capture.workspace
      ; revision
      ; head = (if revision = 0 then None else Some (String.make 64 'a'))
      ; history_head = None
      }
    in
    let job =
      { Export_job.id = "job"
      ; kind = Single
      ; destination = "/tmp/output"
      ; captures = [ capture ]
      ; omitted = []
      ; status = Running
      ; attempt = 1
      ; cancel_requested = false
      ; error = None
      }
    in
    let plan =
      { Restore_plan.request_hash = String.make 64 'b'
      ; token = String.make 64 'c'
      ; targets =
          [ { Restore_plan.Target.source = "/tmp/output"
            ; root = "/tmp/restored"
            ; capture
            ; manifest_hash = String.make 64 'd'
            }
          ]
      }
    in
    let report label registry =
      match Registry.encode registry with
      | Error error ->
        printf
          "%s %d: %s\n"
          label
          revision
          (Sexp.to_string (Problem.sexp_of_kind error.kind))
      | Ok bytes ->
        ignore (Registry.decode bytes |> Disk.unwrap : Registry.t);
        printf "%s %d: round trip\n" label revision
    in
    report "export" { Registry.empty with exports = String.Map.singleton "job" job };
    report
      "restore"
      { Registry.empty with restores = String.Map.singleton "agent:m" plan });
  [%expect
    {|
    export 0: round trip
    restore 0: round trip
    export 1: round trip
    restore 1: round trip
    export 100000: round trip
    restore 100000: round trip
    export 100001: Corrupt_store
    restore 100001: Corrupt_store
    export -1: Corrupt_store
    restore -1: Corrupt_store
    |}]
;;
