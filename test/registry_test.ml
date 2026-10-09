open Core
open Workgraph

let outcome result =
  match result with
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let%expect_test "current registry roundtrip and strict invariants" =
  let decoded =
    Registry.decode
      {|{"version":"2","workspaces":{"demo":{"root":"/tmp/demo","open":false,"known_head":null,"known_history_head":null}},"receipts":{},"creates":{},"exports":{},"restores":{}}|}
    |> Disk.unwrap
  in
  let encoded = Registry.encode decoded |> Disk.unwrap in
  print_endline encoded;
  outcome
    (Registry.decode
       {|{"version":"3","workspaces":{},"receipts":{},"creates":{},"exports":{},"restores":{}}|});
  let report value =
    match Registry.encode value with
    | Ok _ -> print_endline "accepted"
    | Error error -> print_s [%sexp (error.kind : Problem.kind)]
  in
  let duplicate =
    Map.set
      decoded.registrations
      ~key:"second"
      ~data:
        { Registry.Registration.root = "/tmp/demo"
        ; is_open = false
        ; known_head = None
        ; known_history_head = None
        }
  in
  report { decoded with registrations = duplicate };
  report
    { decoded with
      receipts =
        String.Map.singleton
          "bad-key"
          { Registry.Receipt.request_hash = String.make 64 'a'; response = `Null }
    };
  report
    { decoded with
      receipts =
        String.Map.singleton
          "agent:mutation"
          { Registry.Receipt.request_hash = "not-a-hash"; response = `Null }
    };
  [%expect
    {|
    {"creates":{},"exports":{},"receipts":{},"restores":{},"version":"2","workspaces":{"demo":{"known_head":null,"known_history_head":null,"open":false,"root":"/tmp/demo"}}}
    Unsupported_version
    Corrupt_store
    Corrupt_store
    Corrupt_store |}]
;;

let%expect_test
    "registry identity hashes ignore JSON object order but retain method and scope"
  =
  let request method_ bytes =
    Registry.request ~method_ ~params:(Json.parse bytes |> Disk.unwrap) |> Disk.unwrap
  in
  let key, hash =
    request
      "workspace.close"
      {|{"actor_id":"agent","mutation_id":"m","workspace_id":"a"}|}
  in
  let key2, hash2 =
    request
      "workspace.close"
      {|{"workspace_id":"a","mutation_id":"m","actor_id":"agent"}|}
  in
  let _, changed =
    request "workspace.open" {|{"workspace_id":"a","mutation_id":"m","actor_id":"agent"}|}
  in
  print_s
    [%sexp
      ((String.equal key key2, String.equal hash hash2, String.equal hash changed)
       : bool * bool * bool)];
  [%expect {| (true true false) |}]
;;

let%expect_test "restore intents reserve roots and identities independently of receipts" =
  let target =
    { Restore_plan.Target.source = "/tmp/export"
    ; root = "/tmp/restored"
    ; capture =
        { Export_job.Capture.workspace = Id.Workspace.of_string "demo" |> Disk.unwrap
        ; revision = 0
        ; head = None
        ; history_head = None
        }
    ; manifest_hash = String.make 64 'a'
    }
  in
  let plan =
    { Restore_plan.request_hash = String.make 64 'b'
    ; token = String.make 64 'c'
    ; targets = [ target ]
    }
  in
  let registry =
    { Registry.empty with restores = String.Map.singleton "agent:restore" plan }
  in
  let decoded =
    Registry.encode registry |> Disk.unwrap |> Registry.decode |> Disk.unwrap
  in
  printf "pending: %d\n" (Map.length decoded.restores);
  let report registry =
    match Registry.encode registry with
    | Ok _ -> print_endline "accepted"
    | Error error -> print_s [%sexp (error.kind : Problem.kind)]
  in
  report
    { registry with
      registrations =
        String.Map.singleton
          "demo"
          { Registry.Registration.root = "/tmp/other"
          ; is_open = false
          ; known_head = None
          ; known_history_head = None
          }
    };
  report
    { registry with
      registrations =
        String.Map.singleton
          "other"
          { Registry.Registration.root = "/tmp/restored"
          ; is_open = false
          ; known_head = None
          ; known_history_head = None
          }
    };
  report
    { registry with
      receipts =
        String.Map.singleton
          "agent:restore"
          { Registry.Receipt.request_hash = plan.request_hash; response = `Null }
    };
  report
    { registry with
      restores =
        String.Map.singleton "agent:restore" { plan with targets = [ target; target ] }
    };
  report
    { registry with
      restores =
        String.Map.singleton
          "agent:restore"
          { plan with
            targets = [ { target with capture = { target.capture with revision = 1 } } ]
          }
    };
  [%expect
    {|
    pending: 1
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store |}]
;;
