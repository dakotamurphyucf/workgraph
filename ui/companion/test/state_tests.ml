open Core
open Workgraph
open Workgraph_ui

let json bytes = Json.parse bytes |> Disk.unwrap

let problem = function
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let rec remove path =
  match Eio.Path.kind ~follow:false path with
  | `Not_found -> ()
  | `Directory ->
    List.iter (Eio.Path.read_dir path) ~f:(fun name -> remove Eio.Path.(path / name));
    Eio.Path.rmdir path
  | _ -> Eio.Path.unlink path
;;

let with_root f =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let random = Eio.Stdenv.secure_random env in
    let bytes = Cstruct.create 32 in
    Eio.Flow.read_exact random bytes;
    let path = "/tmp/workgraph-ui-state-" ^ Json.hash (Cstruct.to_string bytes) in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / path);
    Exn.protect
      ~finally:(fun () -> remove Eio.Path.(fs / path))
      ~f:(fun () ->
        Eio.Switch.run (fun sw ->
          let root = State_root.acquire ~sw ~fs ~random ~path |> Disk.unwrap in
          f env root)))
;;

let profile
      ?(generation = Connection_profile.Generation.initial)
      ?(socket = "/tmp/ui-test.sock")
      ()
  =
  Connection_profile.create
    ~id:(Connection_profile.Id.of_string "local" |> Disk.unwrap)
    ~generation
    ~label:"Local"
    ~socket
  |> Disk.unwrap
;;

let context ?(workspace = "demo") ?(project = None) ?(actor = "author") ?(run = None) () =
  Operation.Context.create
    ~workspace:(Some (Id.Workspace.of_string workspace |> Disk.unwrap))
    ~project:
      (Option.map project ~f:(fun project -> Id.Project.of_string project |> Disk.unwrap))
    ~writer:
      (Writer.create
         ~actor:(Id.Actor.of_string actor |> Disk.unwrap)
         ~run:(Option.map run ~f:(fun run -> Id.Run.of_string run |> Disk.unwrap)))
;;

let preparation ?(connection = profile ()) () =
  Operation.Preparation.create
    ~intention_id:"intent"
    ~connection
    ~context:(context ())
    ~method_:"ticket.create"
    ~params:
      (json
         {|{"workspace_id":"demo","actor_id":"author","ticket_id":"task","title":"Task"}|})
  |> Disk.unwrap
;;

let materialize preparation =
  let initial =
    Protocol.Request.create
      ~id:"exact-request"
      ~method_:(Operation.Preparation.method_ preparation)
      ~params:(Operation.Preparation.params preparation)
    |> Disk.unwrap
  in
  if not (Cli_mutation_identity.required initial)
  then Ok initial
  else (
    let params =
      match Operation.Preparation.params preparation with
      | `Object fields -> Json.obj (("mutation_id", Json.string "saved") :: fields)
      | _ -> assert false
    in
    Protocol.Request.create
      ~id:"exact-request"
      ~method_:(Operation.Preparation.method_ preparation)
      ~params)
;;

let prepared store input =
  Operation_store.prepare store input ~materialize:(fun () -> materialize input)
  |> Disk.unwrap
  |> Operation_store.operation
;;

let state operation =
  Json.field (Operation.to_json operation) "state"
  |> fun value -> Json.field value "kind" |> Json.text
;;

(* Wrap real resource providers: no production fault hooks or mock persistence. *)
let fault_fs (Eio.Resource.T (directory, ops), path) ~armed ~parent_sync ~stage_syncs =
  let fail_parent = ref false in
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let is_stage name =
    String.is_substring name ~substring:"operation-"
    && String.is_substring name ~substring:".tmp-"
  in
  let module Wrapped = struct
    include Directory

    let open_out directory ~sw ~append ~create name =
      let (Eio.Resource.T (file, file_ops)) =
        Directory.open_out directory ~sw ~append ~create name
      in
      let module File = (val Eio.Resource.get file_ops Eio.File.Pi.Write) in
      let module Wrapped_file = struct
        include File

        let sync file =
          if is_stage name then incr stage_syncs;
          if !armed && (not parent_sync) && is_stage name
          then (
            armed := false;
            Json.fail Local_io "injected stage file sync failure");
          File.sync file
        ;;
      end
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.File.Pi.Write, (module Wrapped_file))
             :: Eio.Resource.bindings file_ops) )
    ;;

    let rename directory source destination target =
      Directory.rename directory source destination target;
      if !armed && parent_sync && is_stage source then fail_parent := true
    ;;

    let open_in directory ~sw name =
      if !fail_parent
      then (
        fail_parent := false;
        armed := false;
        Json.fail Local_io "injected parent-directory sync acquisition failure");
      Directory.open_in directory ~sw name
    ;;
  end
  in
  ( Eio.Resource.T
      ( directory
      , Eio.Resource.handler
          (Eio.Resource.H (Eio.Fs.Pi.Dir, (module Wrapped)) :: Eio.Resource.bindings ops)
      )
  , path )
;;

let%expect_test "generation and writer decoders reject invalid alternatives" =
  List.iter [ "0"; "01"; "-1"; "1"; "2"; "x" ] ~f:(fun value ->
    problem (Connection_profile.Generation.of_string value));
  let writer =
    Writer.of_json (json {|{"actor_id":"author","run_id":null}|}) |> Disk.unwrap
  in
  print_endline (Json.canonical (Writer.to_json writer));
  problem (Writer.of_json (json {|{"actor_id":"author","run_id":null,"ignored":true}|}));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    ok
    Invalid_argument
    {"actor_id":"author","run_id":null}
    Invalid_argument
    |}]
;;

let%expect_test "public generation sexp decoder enforces positive canonical decimals" =
  List.iter [ "0"; "01"; "x"; "1" ] ~f:(fun value ->
    match Connection_profile.Generation.t_of_sexp (Sexp.Atom value) with
    | generation -> print_endline (Connection_profile.Generation.to_string generation)
    | exception Sexplib.Conv.Of_sexp_error _ -> print_endline "invalid");
  [%expect
    {|
    invalid
    invalid
    invalid
    1
    |}]
;;

let%expect_test "public profile constructor rejects invalid UTF8 before admitting state" =
  let id = Connection_profile.Id.of_string "local" |> Disk.unwrap in
  let generation = Connection_profile.Generation.initial in
  problem
    (Connection_profile.create ~id ~generation ~label:"\255" ~socket:"/tmp/valid.sock");
  problem
    (Connection_profile.create ~id ~generation ~label:"Valid" ~socket:"/tmp/\255.sock");
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "complete intention match before materialize; restart and exact retry" =
  with_root (fun env root ->
    let random = Eio.Stdenv.secure_random env in
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let input = preparation () in
    let calls = ref 0 in
    let materialize () =
      incr calls;
      materialize input
    in
    let first =
      Operation_store.prepare store input ~materialize
      |> Disk.unwrap
      |> Operation_store.operation
    in
    let repeated =
      Operation_store.prepare store input ~materialize
      |> Disk.unwrap
      |> Operation_store.operation
    in
    printf
      "same=%b calls=%d state=%s\n"
      (Operation.Id.equal (Operation.id first) (Operation.id repeated))
      !calls
      (state repeated);
    problem
      (Operation_store.prepare
         store
         (preparation ~connection:(profile ~socket:"/tmp/other.sock" ()) ())
         ~materialize);
    printf "calls=%d\n" !calls;
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let operation =
      Operation_store.prepare store input ~materialize
      |> Disk.unwrap
      |> Operation_store.operation
    in
    printf
      "same-reload=%b calls=%d\n"
      (Operation.Id.equal (Operation.id first) (Operation.id operation))
      !calls;
    let sending =
      Operation_store.admit store ~id:(Operation.id operation) ~retry:false |> Disk.unwrap
    in
    printf "admitted=%s\n" (state sending);
    problem (Operation_store.admit store ~id:(Operation.id operation) ~retry:false);
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let recovered =
      Operation_store.inspect store ~id:(Operation.id operation) |> Disk.unwrap
    in
    printf "after-crash=%s\n" (state recovered);
    let retried =
      Operation_store.admit store ~id:(Operation.id operation) ~retry:true |> Disk.unwrap
    in
    printf
      "retry-exact=%b\n"
      (String.equal
         (Json.canonical (Protocol.Request.to_json (Operation.request first)))
         (Json.canonical (Protocol.Request.to_json (Operation.request retried)))));
  [%expect
    {|
    same=true calls=1 state=prepared_unsent
    Idempotency_conflict
    calls=1
    same-reload=true calls=1
    admitted=sending
    Conflict
    after-crash=outcome_unknown
    retry-exact=true
    |}]
;;

let%expect_test "immutable endpoint generations survive reload and stale guards" =
  with_root (fun _ root ->
    let store = Connection_profile.Store.create root |> Disk.unwrap in
    let first = profile () in
    Connection_profile.Store.put store first ~expected_generation:None |> Disk.unwrap;
    let next =
      Connection_profile.Generation.next (Connection_profile.generation first)
      |> Disk.unwrap
    in
    let second = profile ~generation:next ~socket:"/tmp/second.sock" () in
    Connection_profile.Store.put
      store
      second
      ~expected_generation:(Some (Connection_profile.generation first))
    |> Disk.unwrap;
    problem
      (Connection_profile.Store.put
         store
         second
         ~expected_generation:(Some (Connection_profile.generation first)));
    let store = Connection_profile.Store.create root |> Disk.unwrap in
    let original =
      Connection_profile.Store.find
        store
        ~id:(Connection_profile.id first)
        ~generation:(Connection_profile.generation first)
      |> Option.value_exn
    in
    printf
      "original=%s latest=%s\n"
      (Connection_profile.socket original)
      (Connection_profile.socket (List.hd_exn (Connection_profile.Store.list store))));
  [%expect
    {|
    Conflict
    original=/tmp/ui-test.sock latest=/tmp/second.sock
    |}]
;;

let%expect_test "observed result survives final-status persistence failure" =
  with_root (fun env root ->
    let store =
      Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env) |> Disk.unwrap
    in
    let operation = prepared store (preparation ()) in
    let sending =
      Operation_store.admit store ~id:(Operation.id operation) ~retry:false |> Disk.unwrap
    in
    let response =
      Api_response.of_json
        (json
           {|{"data":{"ticket_id":"task","display_key":"WG-1","revision":"1"},"meta":{"durable":true,"workspace_revision":"1"}}|})
      |> Disk.unwrap
    in
    Eio.Path.unlink Eio.Path.(State_root.directory root / ".owner.lock");
    let committed =
      Operation_store.record store (Operation.with_state sending (Committed response))
    in
    assert (Operation.revision committed = Operation.revision sending + 2);
    printf
      "state=%s diagnostic=%b\n"
      (state committed)
      (not
         (String.equal
            (Json.canonical (Json.field (Operation.to_json committed) "diagnostic"))
            "null")));
  [%expect {|state=committed diagnostic=true|}]
;;

let%expect_test "missing exact journal and corrupt state never reset silently" =
  with_root (fun env root ->
    let random = Eio.Stdenv.secure_random env in
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let operation = prepared store (preparation ()) in
    Eio.Path.unlink
      Eio.Path.(
        Eio.Stdenv.fs env / (Operation.journal_path operation |> Option.value_exn));
    problem (Operation_store.create ~root ~random);
    Eio.Path.unlink
      Eio.Path.(
        State_root.directory root
        / ("operation-" ^ Operation.Id.to_string (Operation.id operation) ^ ".json"));
    State_root.save
      root
      ~name:"operation-broken.json"
      ~value:(json {|{"format":"wrong"}|})
    |> Disk.unwrap;
    problem (Operation_store.create ~root ~random));
  [%expect
    {|
    Invalid_argument
    Unsupported_version
    |}]
;;

let%expect_test "failed barrier never authorizes exchange or keeps volatile unsent" =
  with_root (fun env root ->
    let store =
      Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env) |> Disk.unwrap
    in
    let operation = prepared store (preparation ()) in
    Eio.Path.unlink Eio.Path.(State_root.directory root / ".owner.lock");
    problem (Operation_store.admit store ~id:(Operation.id operation) ~retry:false);
    let observed =
      Operation_store.inspect store ~id:(Operation.id operation) |> Disk.unwrap
    in
    printf "retained=%s\n" (state observed));
  [%expect
    {|
    Storage_unavailable
    retained=outcome_unknown
    |}]
;;

let%expect_test "file-sync and post-install parent-sync faults fence exchange" =
  List.iter [ false; true ] ~f:(fun parent_sync ->
    with_root (fun env original ->
      let armed = ref false in
      let fs = fault_fs (Eio.Stdenv.fs env) ~armed ~parent_sync ~stage_syncs:(ref 0) in
      let path = Filename.concat (State_root.path original) "fault-root" in
      Eio.Switch.run (fun sw ->
        let random = Eio.Stdenv.secure_random env in
        let root = State_root.acquire ~sw ~fs ~random ~path |> Disk.unwrap in
        let store = Operation_store.create ~root ~random |> Disk.unwrap in
        let operation = prepared store (preparation ()) in
        armed := true;
        problem (Operation_store.admit store ~id:(Operation.id operation) ~retry:false);
        let observed =
          Operation_store.inspect store ~id:(Operation.id operation) |> Disk.unwrap
        in
        let loaded = Operation_store.create ~root ~random |> Disk.unwrap in
        let durable =
          Operation_store.inspect loaded ~id:(Operation.id operation) |> Disk.unwrap
        in
        printf
          "parent=%b volatile=%s durable=%s\n"
          parent_sync
          (state observed)
          (state durable))));
  [%expect
    {|
    Local_io
    parent=false volatile=outcome_unknown durable=prepared_unsent
    Local_io
    parent=true volatile=outcome_unknown durable=outcome_unknown
    |}]
;;

let%expect_test
    "actor workspace run generation and omitted versus null are immutable inputs"
  =
  with_root (fun env root ->
    let store =
      Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env) |> Disk.unwrap
    in
    let params =
      json
        {|{"workspace_id":"demo","actor_id":"author","ticket_id":"task","expected_revision":"1"}|}
    in
    let input connection params =
      let actor = Json.field params "actor_id" |> Json.text in
      let run = Json.optional params "run_id" |> Option.map ~f:Json.text in
      Operation.Preparation.create
        ~intention_id:"metadata"
        ~connection
        ~context:(context ~actor ~run ())
        ~method_:"ticket.metadata"
        ~params
      |> Disk.unwrap
    in
    let original = input (profile ()) params in
    ignore (prepared store original : Operation.t);
    let calls = ref 0 in
    let materialize () =
      incr calls;
      failwith "conflicting intention must not materialize"
    in
    let replace key value =
      match params with
      | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key value)
      | _ -> assert false
    in
    List.iter
      [ "actor_id", Json.string "different"
      ; "workspace_id", Json.string "different"
      ; "run_id", Json.string "new-run"
      ; "assignee_id", `Null
      ; "expected_revision", Json.string "2"
      ]
      ~f:(fun (key, value) ->
        problem
          (Operation_store.prepare
             store
             (input (profile ()) (replace key value))
             ~materialize));
    let generation =
      Connection_profile.Generation.next Connection_profile.Generation.initial
      |> Disk.unwrap
    in
    problem
      (Operation_store.prepare store (input (profile ~generation ()) params) ~materialize);
    printf "materializer-calls=%d\n" !calls);
  [%expect
    {|
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    materializer-calls=0
    |}]
;;

let%expect_test "two concurrent preparations materialize once despite yielding callback" =
  with_root (fun env root ->
    let store =
      Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env) |> Disk.unwrap
    in
    let input = preparation () in
    let calls = ref 0 in
    let prepare () =
      Operation_store.prepare store input ~materialize:(fun () ->
        incr calls;
        Eio.Fiber.yield ();
        materialize input)
      |> Disk.unwrap
      |> Operation_store.operation
    in
    let first, second = Eio.Fiber.pair prepare prepare in
    printf
      "same=%b calls=%d\n"
      (Operation.Id.equal (Operation.id first) (Operation.id second))
      !calls);
  [%expect {| same=true calls=1 |}]
;;

let%expect_test
    "interrupted preparation retains identity and observed commit cannot be downgraded"
  =
  with_root (fun env original ->
    let armed = ref false in
    let stage_syncs = ref 0 in
    let fs = fault_fs (Eio.Stdenv.fs env) ~armed ~parent_sync:true ~stage_syncs in
    Eio.Switch.run (fun sw ->
      let random = Eio.Stdenv.secure_random env in
      let path = Filename.concat (State_root.path original) "prepare-fault" in
      let root = State_root.acquire ~sw ~fs ~random ~path |> Disk.unwrap in
      let store = Operation_store.create ~root ~random |> Disk.unwrap in
      let input = preparation () in
      let calls = ref 0 in
      let materialize () =
        incr calls;
        materialize input
      in
      armed := true;
      problem (Operation_store.prepare store input ~materialize);
      let hidden = Operation_store.list store ~offset:0 ~limit:100 |> Disk.unwrap in
      printf
        "unpublished-visible=%d\n"
        (Json.field hidden "items" |> Json.list |> List.length);
      let filename =
        State_root.names root
        |> Disk.unwrap
        |> List.find_exn ~f:(fun name -> String.is_prefix name ~prefix:"operation-")
      in
      let raw = State_root.read root ~name:filename |> Disk.unwrap |> Option.value_exn in
      let installed = Operation.of_storage_json raw |> Disk.unwrap in
      problem (Operation_store.inspect store ~id:(Operation.id installed));
      let before = !stage_syncs in
      let loaded_before_ack = Operation_store.create ~root ~random |> Disk.unwrap in
      let recovered =
        Operation_store.prepare loaded_before_ack input ~materialize |> Disk.unwrap
      in
      printf "restart-resynced=%b\n" (!stage_syncs > before);
      ignore (recovered : Operation_store.prepared);
      let resumed =
        Operation_store.prepare store input ~materialize
        |> Disk.unwrap
        |> Operation_store.operation
      in
      let loaded = Operation_store.create ~root ~random |> Disk.unwrap in
      let repeated =
        Operation_store.prepare loaded input ~materialize
        |> Disk.unwrap
        |> Operation_store.operation
      in
      printf
        "same=%b calls=%d\n"
        (Operation.Id.equal (Operation.id resumed) (Operation.id repeated))
        !calls;
      let sending =
        Operation_store.admit loaded ~id:(Operation.id repeated) ~retry:false
        |> Disk.unwrap
      in
      let response =
        Api_response.of_json
          (json
             {|{"data":{"ticket_id":"task","display_key":"WG-1","revision":"1"},"meta":{"durable":true,"workspace_revision":"1"}}|})
        |> Disk.unwrap
      in
      ignore
        (Operation_store.record loaded (Operation.with_state sending (Committed response))
         : Operation.t);
      let stale =
        Operation.with_state
          sending
          (Outcome_unknown (Problem.create Outcome_unknown "late observer"))
      in
      printf "late-result=%s\n" (state (Operation_store.record loaded stale))));
  [%expect
    {|
    Local_io
    unpublished-visible=0
    Conflict
    restart-resynced=true
    same=true calls=1
    late-result=committed
    |}]
;;

let%expect_test
    "ephemeral context binds actor run workspace project without native fields"
  =
  with_root (fun env root ->
    let store =
      Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env) |> Disk.unwrap
    in
    let input context =
      Operation.Preparation.create
        ~intention_id:"shutdown"
        ~connection:(profile ())
        ~context
        ~method_:"daemon.shutdown"
        ~params:(Json.obj [])
      |> Disk.unwrap
    in
    let original = input (context ()) in
    ignore (prepared store original : Operation.t);
    let calls = ref 0 in
    let materialize () =
      incr calls;
      failwith "changed context must not materialize"
    in
    List.iter
      [ context ~actor:"different" ()
      ; context ~run:(Some "run") ()
      ; context ~workspace:"different" ()
      ; context ~project:(Some "different") ()
      ]
      ~f:(fun context ->
        problem (Operation_store.prepare store (input context) ~materialize));
    printf "materializer-calls=%d\n" !calls);
  [%expect
    {|
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    Idempotency_conflict
    materializer-calls=0
    |}]
;;

let%expect_test "captured writer equals actual admitted actor and optional run" =
  List.iter
    [ context ~actor:"wrong" (); context ~run:(Some "not-in-params") () ]
    ~f:(fun context ->
      problem
        (Operation.Preparation.create
           ~intention_id:"writer"
           ~connection:(profile ())
           ~context
           ~method_:"ticket.create"
           ~params:(Operation.Preparation.params (preparation ()))));
  let different_scope =
    Operation.Preparation.create
      ~intention_id:"target-is-separate"
      ~connection:(profile ())
      ~context:(context ~workspace:"selection" ~project:(Some "selection-project") ())
      ~method_:"ticket.create"
      ~params:(Operation.Preparation.params (preparation ()))
  in
  problem different_scope;
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    ok
    |}]
;;

let%expect_test
    "replayed Sending increments once and persists matching state and revision"
  =
  with_root (fun env root ->
    let random = Eio.Stdenv.secure_random env in
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let operation = prepared store (preparation ()) in
    let sending =
      Operation_store.admit store ~id:(Operation.id operation) ~retry:false |> Disk.unwrap
    in
    let reload () =
      let loaded = Operation_store.create ~root ~random |> Disk.unwrap in
      Operation_store.inspect loaded ~id:(Operation.id operation) |> Disk.unwrap
    in
    let first = reload () in
    let second = reload () in
    printf
      "sending=%d recovered=%d/%s second=%d/%s\n"
      (Operation.revision sending)
      (Operation.revision first)
      (state first)
      (Operation.revision second)
      (state second);
    let fields =
      match Operation.to_json sending with
      | `Object fields -> fields
      | _ -> assert false
    in
    let exhausted =
      Json.obj
        (List.Assoc.add fields ~equal:String.equal "revision" (Json.int Int.max_value))
    in
    problem (Operation.of_json exhausted));
  [%expect
    {|
    sending=2 recovered=3/outcome_unknown second=3/outcome_unknown
    Conflict
    |}]
;;

let rec nested depth = if depth = 0 then `Null else `Array [ nested (depth - 1) ]

let%expect_test "native frame64 and independent payload64 retain their storage budget" =
  let params = Json.obj [ "payload", nested 62 ] in
  let request =
    Protocol.Request.create ~id:"boundary" ~method_:"ticket.create" ~params |> Disk.unwrap
  in
  let frame =
    Protocol.Request.to_json request |> Json.canonical |> Json.parse |> Disk.unwrap
  in
  ignore (Protocol.validate_server_request frame |> Disk.unwrap : unit);
  printf "native-frame64=valid\n";
  let response =
    Api_response.of_json (Json.obj [ "data", nested 64; "meta", Json.obj [] ])
    |> Disk.unwrap
  in
  let operation =
    Operation.create
      ~id:(Operation.Id.of_string "boundary" |> Disk.unwrap)
      ~preparation:(preparation ())
      ~request
      ~journal_path:None
    |> fun operation -> Operation.with_state operation (Observed response)
  in
  (* This serializer fixture intentionally has no matching method-domain payload.
     It checks protocol/JSON bounds independently; the original method codec must
     still reject it on full operation admission. No production fixture bypass. *)
  let stored =
    Operation.to_storage_json operation |> Json.canonical |> Json.parse |> Disk.unwrap
  in
  let document = Json.field stored "operation" in
  let request_params =
    Json.field (Json.field document "request") "params"
    |> Json.text
    |> Json.parse
    |> Disk.unwrap
  in
  let data =
    Json.field (Json.field (Json.field document "state") "response") "data"
    |> Json.text
    |> Json.parse
    |> Disk.unwrap
  in
  printf
    "request-preserved=%b payload64-preserved=%b\n"
    (String.equal (Json.canonical request_params) (Json.canonical params))
    (String.equal (Json.canonical data) (Json.canonical (nested 64)));
  problem (Json.parse (Json.canonical (nested 65)));
  [%expect
    {|
    native-frame64=valid
    request-preserved=true payload64-preserved=true
    Invalid_argument
    |}]
;;

let%expect_test "actual history provenance32 survives durable preparation and restart" =
  with_root (fun env root ->
    let random = Eio.Stdenv.secure_random env in
    let event =
      Json.obj
        [ "client_id", Json.string "event"
        ; "kind", Json.string "example"
        ; "phase", Json.string "example"
        ; "role", Json.string "example"
        ; "payload", json {|{"kind":"inline","bytes_base64":"YQ=="}|}
        ; "provenance", nested 32
        ]
    in
    let params =
      Json.obj
        [ "workspace_id", Json.string "demo"
        ; "actor_id", Json.string "author"
        ; "session_id", Json.string "session"
        ; "events", `Array [ event ]
        ]
    in
    let input =
      Operation.Preparation.create
        ~intention_id:"max-provenance"
        ~connection:(profile ())
        ~context:(context ())
        ~method_:"session.append"
        ~params
      |> Disk.unwrap
    in
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let operation = prepared store input in
    let loaded = Operation_store.create ~root ~random |> Disk.unwrap in
    let restored =
      Operation_store.inspect loaded ~id:(Operation.id operation) |> Disk.unwrap
    in
    printf
      "exact=%b state=%s\n"
      (String.equal
         (Json.canonical (Protocol.Request.to_json (Operation.request operation)))
         (Json.canonical (Protocol.Request.to_json (Operation.request restored))))
      (state restored);
    let invalid_event =
      match event with
      | `Object fields ->
        Json.obj (List.Assoc.add fields ~equal:String.equal "provenance" (nested 33))
      | _ -> assert false
    in
    let invalid_params =
      match params with
      | `Object fields ->
        Json.obj
          (List.Assoc.add fields ~equal:String.equal "events" (`Array [ invalid_event ]))
      | _ -> assert false
    in
    problem
      (Operation.Preparation.create
         ~intention_id:"too-deep-provenance"
         ~connection:(profile ())
         ~context:(context ())
         ~method_:"session.append"
         ~params:invalid_params));
  [%expect
    {|
    exact=true state=prepared_unsent
    Invalid_argument
    |}]
;;
