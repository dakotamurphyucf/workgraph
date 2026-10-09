open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json = Jsonaf.of_string

let report = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let digest = String.make 64 'a'
let id name = ok (Id.Workspace.of_string name)

let capture name =
  { Export_job.Capture.workspace = id name
  ; revision = 0
  ; head = None
  ; history_head = None
  }
;;

let job ?(captures = [ capture "work" ]) ?(kind = Export_job.Single) name =
  { Export_job.id = name
  ; kind
  ; destination = "/exports/" ^ name
  ; captures
  ; omitted = []
  ; status = Completed
  ; attempt = 1
  ; cancel_requested = false
  ; error = None
  }
;;

let registry jobs =
  { Registry.empty with
    exports = String.Map.of_alist_exn (List.map jobs ~f:(fun j -> j.Export_job.id, j))
  }
;;

let result registry ?(offset = 0) ?at_snapshot ?(max_bytes = 4096) () =
  Administration_wire.Export_page.response
    registry
    ~offset
    ~limit:100
    ~max_bytes
    ~at_snapshot
;;

let%expect_test
    "all nineteen administrative descriptors validate actual request identities"
  =
  let samples =
    [ "daemon.health", "{}"
    ; "workspace.list", "{}"
    ; ( "workspace.create"
      , {|{"actor_id":"operator","mutation_id":"create","name":"Work","root":"/work/workspace"}|}
      )
    ; ( "workspace.register"
      , {|{"actor_id":"operator","mutation_id":"register","root":"/work/existing"}|} )
    ; ( "workspace.open"
      , {|{"actor_id":"operator","mutation_id":"open","workspace_id":"work"}|} )
    ; ( "workspace.close"
      , {|{"actor_id":"operator","mutation_id":"close","workspace_id":"work"}|} )
    ; ( "workspace.unregister"
      , {|{"actor_id":"operator","mutation_id":"unregister","workspace_id":"work"}|} )
    ; ( "workspace.receipt"
      , {|{"workspace_id":"work","actor_id":"operator","mutation_id":"write","run_id":"runner"}|}
      )
    ; "registry.receipt", {|{"actor_id":"operator","mutation_id":"write"}|}
    ; ( "workspace.export"
      , {|{"actor_id":"operator","mutation_id":"export","workspace_id":"work","destination":"/work/export"}|}
      )
    ; ( "daemon.export_all"
      , {|{"actor_id":"operator","mutation_id":"export-all","destination":"/work/all"}|} )
    ; "export.get", {|{"job_id":"export"}|}
    ; "export.list", "{}"
    ; ( "export.cancel"
      , {|{"actor_id":"operator","mutation_id":"cancel","job_id":"export"}|} )
    ; "export.retry", {|{"actor_id":"operator","mutation_id":"retry","job_id":"export"}|}
    ; "export.verify", {|{"directory":"/work/export"}|}
    ; ( "workspace.restore"
      , {|{"actor_id":"operator","mutation_id":"restore","directory":"/work/export","root":"/work/restored"}|}
      )
    ; ( "daemon.restore_all"
      , {|{"actor_id":"operator","mutation_id":"restore-all","directory":"/work/all","roots":{"work":"/work/restored"}}|}
      )
    ; ( "restore.cancel"
      , {|{"actor_id":"operator","mutation_id":"cancel-restore","target_actor_id":"operator","target_mutation_id":"restore"}|}
      )
    ]
  in
  List.iter samples ~f:(fun (method_, params) ->
    ignore
      (ok (Administration_api.Request.decode ~method_ ~params:(json params))
       : Administration_api.Request.t);
    ignore
      (ok
         (Api_codec.decode
            (Option.value_exn (Administration_api.request_codec ~method_))
            (json params))
       : Jsonaf.t));
  print_s
    [%sexp (List.length samples : int), (List.length Administration_api.methods : int)];
  report
    (Administration_api.Request.decode
       ~method_:"workspace.create"
       ~params:
         (json
            {|{"actor_id":"operator","mutation_id":"create","name":"Work","root":"relative"}|}));
  report
    (Administration_api.Request.decode
       ~method_:"workspace.create"
       ~params:
         (json
            {|{"actor_id":"operator","mutation_id":"create","name":"Work","root":"/work","run_id":"runner"}|}));
  report
    (Administration_api.Request.decode
       ~method_:"export.list"
       ~params:(json {|{"offset":"1"}|}));
  report
    (Administration_api.Request.decode
       ~method_:"daemon.restore_all"
       ~params:
         (json
            {|{"actor_id":"operator","mutation_id":"restore","directory":"/work/export","roots":{"bad id":"/work/destination"}}|}));
  [%expect
    {|
    (19 19)
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "health counts and capture head invariants reject independent malformed fixtures"
  =
  report
    (Api_codec.decode
       Administration_wire.Health.codec
       (json
          {|{"registry_requires_restart":false,"pending_creates":"-1","pending_restores":"0","active_exports":"0","workspaces":[]}|}));
  report
    (Api_codec.decode
       Administration_wire.capture
       (json {|{"workspace_id":"work","revision":"1","head":null,"history_head":null}|}));
  let malformed =
    Json.obj
      [ "workspace_id", Json.string "work"
      ; "revision", Json.int 0
      ; "head", Json.string digest
      ; "history_head", `Null
      ]
  in
  report (Api_codec.decode Administration_wire.capture malformed);
  let current =
    Administration_wire.Health.capture
      Registry.empty
      ~registry_requires_restart:false
      ~active_exports:0
      ~workspace_status:(fun _ -> failwith "empty capture unexpectedly invoked")
  in
  report (Api_codec.encode Administration_wire.Health.codec current);
  let duplicate =
    Json.obj
      [ "registry_requires_restart", `False
      ; "pending_creates", Json.int 0
      ; "pending_restores", Json.int 0
      ; "active_exports", Json.int 0
      ; ( "workspaces"
        , `Array
            [ json
                {|{"workspace_id":"work","root":"/work/workspace","archived":null,"open":false,"open_intent":false,"error":null,"capacity":null}|}
            ; json
                {|{"workspace_id":"work","root":"/work/other","archived":null,"open":false,"open_intent":false,"error":null,"capacity":null}|}
            ] )
      ]
  in
  report (Api_codec.decode Administration_wire.Health.codec duplicate);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    |}]
;;

let%expect_test
    "receipt status derives pending intent and retains exact durable saved response"
  =
  let intent =
    { Registry.Create_intent.request_hash = digest
    ; root = "/work/workspace"
    ; workspace = id "work"
    ; name = "Work"
    ; token = digest
    }
  in
  let pending =
    { Registry.empty with creates = String.Map.singleton "operator:create" intent }
  in
  let pending = Registry.decode (ok (Registry.encode pending)) |> ok in
  let encoded =
    Api_codec.encode
      Administration_wire.Receipt.codec
      (Administration_wire.Receipt.registry pending ~key:"operator:create")
    |> ok
  in
  print_endline (Json.canonical encoded);
  let original =
    Json.obj
      [ "workspace_id", Json.string "work"
      ; "opaque", Json.string (String.make 10_000 'x')
      ]
  in
  let registry =
    { Registry.empty with
      receipts =
        String.Map.singleton
          "operator:create"
          { Registry.Receipt.request_hash = digest; response = original }
    }
  in
  let value = Administration_wire.Receipt.registry registry ~key:"operator:create" in
  let encoded = Api_codec.encode Administration_wire.Receipt.codec value |> ok in
  (match Api_codec.decode Administration_wire.Receipt.codec encoded |> ok with
   | Committed { response; _ } ->
     print_s
       [%sexp
         (String.equal
            (Json.canonical (Api_response.data response))
            (Json.canonical original)
          : bool)]
   | Absent | Pending -> failwith "saved receipt missing");
  report
    (Api_codec.decode
       Administration_wire.Receipt.planning_codec
       (json {|{"status":"pending"}|}));
  let invalid =
    Json.obj
      [ "status", Json.string "committed"
      ; "request_hash", Json.string "bad"
      ; "response", Json.field encoded "response"
      ]
  in
  report (Api_codec.decode Administration_wire.Receipt.codec invalid);
  let not_durable =
    Json.obj
      [ "status", Json.string "committed"
      ; "request_hash", Json.string digest
      ; "response", json {|{"data":{},"meta":{"durable":false}}|}
      ]
  in
  report (Api_codec.decode Administration_wire.Receipt.codec not_durable);
  [%expect
    {|
    {"status":"pending"}
    true
    Invalid_argument
    Invalid_argument
    Outcome_unknown
    |}]
;;

let%expect_test "whole export pages preserve capture proofs and measured metadata" =
  let small = job "a" in
  let captures =
    List.init 100 ~f:(fun i -> capture (Printf.sprintf "workspace-%03d" i))
  in
  let large = job ~kind:All ~captures "z" in
  let registry = registry [ small; large ] in
  let first = result registry () |> ok in
  let public = Api_response.project Snapshot_read first in
  let page =
    Api_codec.decode Administration_wire.Export_page.codec (Api_response.data public)
    |> ok
  in
  print_s
    [%sexp
      (List.map page.items ~f:(fun j -> j.Export_job.id) : string list)
    , (page.next_offset : int option)
    , (page.remaining : int)];
  print_s [%sexp (Api_response.encoded_size Snapshot_read first <= 4096 : bool)];
  let returned =
    Json.field (Api_response.meta public) "budget"
    |> fun b -> Json.integer (Json.field b "returned_bytes")
  in
  print_s [%sexp (returned = Api_response.encoded_size Snapshot_read first : bool)];
  let snapshot = Json.text (Json.field (Api_response.meta public) "snapshot") in
  report (result registry ~offset:1 ~at_snapshot:snapshot ());
  let second =
    result registry ~offset:1 ~at_snapshot:snapshot ~max_bytes:32768 ()
    |> ok
    |> Api_response.project Snapshot_read
  in
  let second =
    Api_codec.decode Administration_wire.Export_page.codec (Api_response.data second)
    |> ok
  in
  print_s
    [%sexp
      (List.length (List.hd_exn second.items).captures : int), (second.remaining : int)];
  report (result registry ~offset:1 ~at_snapshot:(String.make 64 'b') ());
  report
    (Api_codec.encode
       Administration_wire.Export_page.codec
       { page with items = [ small; small ]; next_offset = Some 2 });
  [%expect
    {|
    ((a) (1) 1)
    true
    true
    Invalid_argument
    (100 0)
    Conflict
    Invalid_argument
    |}]
;;

let%expect_test "restore results have named alternatives and enforce unique identities" =
  report
    (Api_codec.decode Administration_wire.Restore.codec (json {|{"kind":"canceled"}|}));
  report
    (Api_codec.decode
       Administration_wire.Restore.codec
       (json {|{"restored":false,"canceled":true}|}));
  let target =
    { Administration_wire.Restore.Target.root = "/work/restored"
    ; capture = capture "work"
    }
  in
  report (Api_codec.encode Administration_wire.Restore.codec (Installed [ target ]));
  report
    (Api_codec.encode Administration_wire.Restore.codec (Installed [ target; target ]));
  [%expect
    {|
    ok
    Invalid_argument
    ok
    Invalid_argument
    |}]
;;

let%expect_test "export page decoder checks counter overflow and nonadvancing pages" =
  let malformed ~offset ~remaining ~items ~next_offset =
    Json.obj
      [ "items", `Array (List.map items ~f:Export_job.to_json)
      ; "offset", Json.int offset
      ; "remaining", Json.int remaining
      ; "next_offset", Option.value_map next_offset ~default:`Null ~f:Json.int
      ]
    |> Api_codec.decode Administration_wire.Export_page.codec
    |> report
  in
  malformed ~offset:Int.max_value ~remaining:0 ~items:[ job "job" ] ~next_offset:None;
  malformed
    ~offset:(Int.max_value - 1)
    ~remaining:1
    ~items:[ job "job" ]
    ~next_offset:(Some Int.max_value);
  malformed ~offset:0 ~remaining:1 ~items:[] ~next_offset:(Some 0);
  malformed ~offset:Int.max_value ~remaining:0 ~items:[] ~next_offset:None;
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    |}]
;;
