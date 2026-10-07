open Core
open Workgraph

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
