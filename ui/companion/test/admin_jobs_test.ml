open Core
open Workgraph
open Workgraph_ui
open State_tests

let id text = Operation.Id.of_string text |> Disk.unwrap
let observer = Daemon_launcher.Context.create ~workspace:None ~project:None ~writer:None

let status job =
  Json.field (Admin_jobs.Job.to_json job) "state"
  |> fun value -> Json.field value "status" |> Json.text
;;

let revision job = Json.field (Admin_jobs.Job.to_json job) "revision" |> Json.integer
let field_job job name = Json.field (Admin_jobs.Job.to_json job) name

let source env root =
  let path = State_root.path root ^ "/source" in
  let fs = Eio.Stdenv.fs env in
  List.iter
    [ path; path ^ "/transactions"; path ^ "/blobs" ]
    ~f:(fun name -> Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / name));
  Disk.write_new
    Eio.Path.(fs / path / "workspace.json")
    {|{"version":"5","workspace_id":"old","name":"Old workspace"}|};
  Disk.write_new
    Eio.Path.(fs / path / "HEAD.json")
    {|{"version":"1","sequence":"0","digest":null}|};
  path
;;

let plan
      root
      source
      ?(intention = "migration")
      ?(context = observer)
      ?(destination = "converted")
      ()
  =
  Admin_jobs.Plan.create
    ~intention_id:(id intention)
    ~context
    ~action:
      (Admin_jobs.Plan.Migrate_0_6_2
         { source; destination = State_root.path root ^ "/" ^ destination })
  |> Disk.unwrap
;;

let inspect jobs name = Admin_jobs.inspect jobs ~intention_id:(id name) |> Disk.unwrap

let finished env jobs name =
  Eio.Time.Timeout.run_exn
    (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 10.)
    (fun () ->
       let rec loop () =
         let job = inspect jobs name in
         if String.equal (status job) "running"
         then (
           Eio.Time.sleep (Eio.Stdenv.clock env) 0.001;
           loop ())
         else
           (* Wait for the serialized publication, resyncing a failed save before
              this simulated restart; this never invokes the helper again. *)
           Admin_jobs.prepare
             jobs
             (Admin_jobs.Plan.of_json (field_job job "plan") |> Disk.unwrap)
           |> Disk.unwrap
       in
       loop ())
;;

(* Real metadata provider with a one-shot fault at the admin metadata file sync. *)
let failing_fs
      ?(before_sync = fun () -> ())
      (Eio.Resource.T (directory, ops), path)
      armed
      syncs
  =
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let module Wrapped = struct
    include Directory

    let open_out directory ~sw ~append ~create name =
      let (Eio.Resource.T (file, ops)) =
        Directory.open_out directory ~sw ~append ~create name
      in
      let module File = (val Eio.Resource.get ops Eio.File.Pi.Write) in
      let module Wrapped_file = struct
        include File

        let sync file =
          if String.is_substring name ~substring:"admin-migration.json.tmp"
          then (
            incr syncs;
            before_sync ();
            if !armed
            then (
              armed := false;
              Json.fail Local_io "injected admin metadata sync failure"));
          File.sync file
        ;;
      end
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.File.Pi.Write, (module Wrapped_file))
             :: Eio.Resource.bindings ops) )
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

let%expect_test
    "plan capture preserves canonical provenance and rejects changed identity input"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let src = source env root in
      let alias = State_root.path root ^ "/source-alias" in
      Eio.Path.symlink ~link_to:src Eio.Path.(Eio.Stdenv.fs env / alias);
      let jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      let input = plan root alias () in
      let prepared = Admin_jobs.prepare jobs input |> Disk.unwrap in
      let execution = field_job prepared "execution_action" in
      printf
        "normalized=%b original=%b state=%s\n"
        (String.equal (Json.field execution "source" |> Json.text) src)
        (String.equal
           (Json.field (Json.field (field_job prepared "plan") "action") "source"
            |> Json.text)
           alias)
        (status prepared);
      List.iter
        [ plan root alias ~destination:"another" ()
        ; plan
            root
            alias
            ~context:
              (Daemon_launcher.Context.create
                 ~workspace:(Some (Id.Workspace.of_string "different" |> Disk.unwrap))
                 ~project:None
                 ~writer:None)
            ()
        ]
        ~f:(fun changed -> problem (Admin_jobs.prepare jobs changed));
      Eio.Path.unlink Eio.Path.(Eio.Stdenv.fs env / alias);
      printf
        "dedup-without-alias=%s\n"
        (status (Admin_jobs.prepare jobs input |> Disk.unwrap));
      problem
        (Admin_jobs.Plan.of_json
           (json
              {|{"intention_id":"x","context":{"workspace_id":null,"project_id":null,"writer":null},"action":{"kind":"shell","command":"ignored"}}|}))));
  [%expect
    {|normalized=true original=true state=prepared_unsent
Idempotency_conflict
Idempotency_conflict
dedup-without-alias=prepared_unsent
Invalid_argument|}]
;;

let%expect_test
    "failed prepare is unpublished and failed cancellation is resynced before repeated \
     acknowledgment"
  =
  with_root (fun env parent ->
    Eio.Switch.run (fun sw ->
      let armed = ref false
      and syncs = ref 0 in
      let fs = failing_fs (Eio.Stdenv.fs env) armed syncs in
      let root =
        State_root.acquire
          ~sw
          ~fs
          ~random:(Eio.Stdenv.secure_random env)
          ~path:(State_root.path parent ^ "/fault")
        |> Disk.unwrap
      in
      let src = source env root in
      let jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      let input = plan root src () in
      armed := true;
      problem (Admin_jobs.prepare jobs input);
      problem (Admin_jobs.inspect jobs ~intention_id:(id "migration"));
      printf
        "visible=%d\n"
        (Admin_jobs.list jobs ~offset:0 ~limit:100
         |> Disk.unwrap
         |> fun value -> Json.field value "items" |> Json.list |> List.length);
      ignore (Admin_jobs.prepare jobs input |> Disk.unwrap : Admin_jobs.Job.t);
      armed := true;
      problem (Admin_jobs.cancel jobs ~intention_id:(id "migration"));
      let before = !syncs in
      let canceled =
        Admin_jobs.cancel jobs ~intention_id:(id "migration") |> Disk.unwrap
      in
      let loaded = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      printf
        "resynced=%b volatile=%s durable=%s revision=%b\n"
        (!syncs > before)
        (status canceled)
        (status (inspect loaded "migration"))
        (Int.equal (revision canceled) (revision (inspect loaded "migration")));
      problem (Admin_jobs.start jobs ~intention_id:(id "migration"))));
  [%expect
    {|Local_io
Conflict
visible=0
Local_io
resynced=true volatile=canceled_unsent durable=canceled_unsent revision=true
Conflict|}]
;;

let%expect_test "failed running barrier never invokes native conversion" =
  with_root (fun env parent ->
    Eio.Switch.run (fun sw ->
      let armed = ref false in
      let fs = failing_fs (Eio.Stdenv.fs env) armed (ref 0) in
      let root =
        State_root.acquire
          ~sw
          ~fs
          ~random:(Eio.Stdenv.secure_random env)
          ~path:(State_root.path parent ^ "/fault")
        |> Disk.unwrap
      in
      let src = source env root in
      let jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      ignore
        (Admin_jobs.prepare jobs (plan root src ()) |> Disk.unwrap : Admin_jobs.Job.t);
      armed := true;
      problem (Admin_jobs.start jobs ~intention_id:(id "migration"));
      printf
        "state=%s no-target=%b no-source-lock=%b\n"
        (status (inspect jobs "migration"))
        (match
           Eio.Path.kind
             ~follow:false
             Eio.Path.(Eio.Stdenv.fs env / (State_root.path root ^ "/converted"))
         with
         | `Not_found -> true
         | _ -> false)
        (match
           Eio.Path.kind ~follow:false Eio.Path.(Eio.Stdenv.fs env / src / ".local")
         with
         | `Not_found -> true
         | _ -> false)));
  [%expect
    {|Local_io
state=outcome_unknown no-target=true no-source-lock=true|}]
;;

let%expect_test
    "native migration report survives replay and corruption never negates known \
     conversion success"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let src = source env root in
      let jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      ignore
        (Admin_jobs.prepare jobs (plan root src ()) |> Disk.unwrap : Admin_jobs.Job.t);
      ignore
        (Admin_jobs.start jobs ~intention_id:(id "migration") |> Disk.unwrap
         : Admin_jobs.Job.t);
      let done_ = finished env jobs "migration" in
      let state = field_job done_ "state" in
      printf "converted=%s\n" (status done_);
      let report = Json.field state "report" in
      let path = Json.field report "path" |> Json.text in
      let bytes = Disk.read Eio.Path.(Eio.Stdenv.fs env / path) in
      printf
        "full-report=%b bytes=%b mappings=%d\n"
        (String.equal (Json.hash bytes) (Json.field report "sha256" |> Json.text))
        (String.length bytes = (Json.field report "byte_count" |> Json.integer))
        (Json.field (Json.field state "summary") "history_head_count" |> Json.integer);
      let loaded = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      printf "replayed=%s\n" (status (inspect loaded "migration"));
      Eio.Path.save
        ~create:(`Or_truncate 0o600)
        Eio.Path.(Eio.Stdenv.fs env / path)
        "corrupted";
      let changed = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      let observed = inspect changed "migration" in
      printf
        "changed-report=%s diagnostic=%s expected-hash-retained=%b\n"
        (status observed)
        (Json.field (field_job observed "diagnostic") "kind" |> Json.text)
        (String.equal
           (Json.field (Json.field (field_job observed "state") "report") "sha256"
            |> Json.text)
           (Json.field report "sha256" |> Json.text))));
  [%expect
    {|converted=succeeded
full-report=true bytes=true mappings=0
replayed=succeeded
changed-report=succeeded diagnostic=Corrupt_store expected-hash-retained=true|}]
;;

let%expect_test "report publication failure retains known migration success" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let src = source env root in
      let jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      Eio.Path.mkdir
        ~perm:0o700
        Eio.Path.(
          Eio.Stdenv.fs env / (State_root.path root ^ "/admin-report-migration.data"));
      ignore
        (Admin_jobs.prepare jobs (plan root src ()) |> Disk.unwrap : Admin_jobs.Job.t);
      ignore
        (Admin_jobs.start jobs ~intention_id:(id "migration") |> Disk.unwrap
         : Admin_jobs.Job.t);
      let done_ = finished env jobs "migration" in
      printf
        "outcome=%s missing-report=%b diagnostic=%b\n"
        (status done_)
        (match Json.field (field_job done_ "state") "report" with
         | `Null -> true
         | _ -> false)
        (match field_job done_ "diagnostic" with
         | `Null -> false
         | _ -> true);
      let replayed = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      printf "replayed=%s\n" (status (inspect replayed "migration"))));
  [%expect
    {|outcome=succeeded missing-report=true diagnostic=true
replayed=succeeded|}]
;;

let replace value name field =
  match value with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal name field)
  | _ -> assert false
;;

let%expect_test
    "independent running fixture restarts unknown exactly once and corrupt result \
     provenance rejects"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let src = source env root in
      let jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      let prepared = Admin_jobs.prepare jobs (plan root src ()) |> Disk.unwrap in
      let raw =
        Admin_jobs.Job.to_json prepared
        |> fun value ->
        replace
          (replace value "revision" (Json.int 7))
          "state"
          (json {|{"status":"running"}|})
      in
      State_root.save
        root
        ~name:"admin-migration.json"
        ~value:(Json.obj [ "format", Json.string "ui-admin-job-1"; "job", raw ])
      |> Disk.unwrap;
      let one = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      let two = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      printf
        "recovered=%s revision=%d stable=%b\n"
        (status (inspect one "migration"))
        (revision (inspect one "migration"))
        (revision (inspect one "migration") = revision (inspect two "migration"));
      let summary =
        json
          {|{"workspace_id":"old","source":"/other/source","destination":"/other/destination","planning_revision":"0","planning_head":null,"source_history_head":null,"history_head":null,"history_head_count":"0","from_release":"0.6.2","source_format":"5","source_history_format":"1","register_in_fresh_registry":true,"old_api_requests_supported":false}|}
      in
      let bad =
        replace
          raw
          "state"
          (Json.obj
             [ "status", Json.string "succeeded"; "summary", summary; "report", `Null ])
      in
      State_root.save
        root
        ~name:"admin-migration.json"
        ~value:(Json.obj [ "format", Json.string "ui-admin-job-1"; "job", bad ])
      |> Disk.unwrap;
      problem (Admin_jobs.create ~sw ~env ~root)));
  [%expect
    {|recovered=outcome_unknown revision=8 stable=true
Corrupt_store|}]
;;

let environment env domain_mgr : Eio_unix.Stdenv.base =
  object
    method stdin = env#stdin
    method stdout = env#stdout
    method stderr = env#stderr
    method net = env#net
    method process_mgr = env#process_mgr
    method clock = env#clock
    method mono_clock = env#mono_clock
    method fs = env#fs
    method cwd = env#cwd
    method secure_random = env#secure_random
    method debug = env#debug
    method backend_id = env#backend_id
    method domain_mgr = domain_mgr
  end
;;

let%expect_test
    "one admitted helper bounds capacity; cancellation is uncertain and cannot silently \
     retry"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let src = source env root in
      let entered, entered_u = Eio.Promise.create () in
      let gate, _gate_u = Eio.Promise.create () in
      let (Eio.Resource.T (inner, ops)) = env#domain_mgr in
      let module Manager = (val Eio.Resource.get ops Eio.Domain_manager.Pi.Mgr) in
      let module Gated = struct
        include Manager

        let run inner f =
          if not (Eio.Promise.is_resolved entered) then Eio.Promise.resolve entered_u ();
          Eio.Promise.await gate;
          Manager.run inner f
        ;;
      end
      in
      let domain_mgr =
        Eio.Domain_manager.Pi.mgr (module Gated)
        |> fun handler -> Eio.Resource.T (inner, handler)
      in
      let isolated = environment env domain_mgr in
      let jobs = Admin_jobs.create ~sw ~env:isolated ~root |> Disk.unwrap in
      ignore
        (Admin_jobs.prepare jobs (plan root src ()) |> Disk.unwrap : Admin_jobs.Job.t);
      ignore
        (Admin_jobs.prepare
           jobs
           (plan root src ~intention:"second" ~destination:"second-root" ())
         |> Disk.unwrap
         : Admin_jobs.Job.t);
      ignore
        (Admin_jobs.start jobs ~intention_id:(id "migration") |> Disk.unwrap
         : Admin_jobs.Job.t);
      Eio.Promise.await entered;
      problem (Admin_jobs.start jobs ~intention_id:(id "second"));
      printf "second=%s\n" (status (inspect jobs "second"));
      ignore
        (Admin_jobs.cancel jobs ~intention_id:(id "migration") |> Disk.unwrap
         : Admin_jobs.Job.t);
      let done_ = finished env jobs "migration" in
      printf
        "cancel=%s requested=%s\n"
        (status done_)
        (Json.canonical (field_job done_ "cancel_requested"));
      problem (Admin_jobs.start jobs ~intention_id:(id "migration"))));
  [%expect
    {|Blocked
second=prepared_unsent
cancel=outcome_unknown requested=true
Conflict|}]
;;

let%expect_test "pending or failed cancellation sync cannot authorize helper cancellation"
  =
  with_root (fun env parent ->
    Eio.Switch.run (fun sw ->
      let armed = ref false
      and syncs = ref 0 in
      let saving, saving_u = Eio.Promise.create () in
      let release, release_u = Eio.Promise.create () in
      let before_sync () =
        if !syncs = 3
        then (
          Eio.Promise.resolve saving_u ();
          Eio.Promise.await release)
      in
      let fs = failing_fs ~before_sync (Eio.Stdenv.fs env) armed syncs in
      let root =
        State_root.acquire
          ~sw
          ~fs
          ~random:(Eio.Stdenv.secure_random env)
          ~path:(State_root.path parent ^ "/fault")
        |> Disk.unwrap
      in
      let () =
        let entered, entered_u = Eio.Promise.create () in
        let canceled, canceled_u = Eio.Promise.create () in
        let gate, _gate_u = Eio.Promise.create () in
        let (Eio.Resource.T (inner, ops)) = env#domain_mgr in
        let module Manager = (val Eio.Resource.get ops Eio.Domain_manager.Pi.Mgr) in
        let module Gated = struct
          include Manager

          let run inner f =
            Eio.Promise.resolve entered_u ();
            try
              Eio.Promise.await gate;
              Manager.run inner f
            with
            | Eio.Cancel.Cancelled _ as error ->
              Eio.Promise.resolve canceled_u ();
              raise error
          ;;
        end
        in
        let domain_mgr =
          Eio.Resource.T (inner, Eio.Domain_manager.Pi.mgr (module Gated))
        in
        let isolated = environment env domain_mgr in
        let src = source env root in
        let jobs = Admin_jobs.create ~sw ~env:isolated ~root |> Disk.unwrap in
        ignore
          (Admin_jobs.prepare jobs (plan root src ()) |> Disk.unwrap : Admin_jobs.Job.t);
        ignore
          (Admin_jobs.start jobs ~intention_id:(id "migration") |> Disk.unwrap
           : Admin_jobs.Job.t);
        Eio.Promise.await entered;
        armed := true;
        let result, result_u = Eio.Promise.create () in
        Eio.Fiber.fork ~sw (fun () ->
          Eio.Promise.resolve
            result_u
            (Admin_jobs.cancel jobs ~intention_id:(id "migration")));
        Eio.Promise.await saving;
        printf
          "saving-requested=%s delivered=%b\n"
          (Json.canonical (field_job (inspect jobs "migration") "cancel_requested"))
          (Eio.Promise.is_resolved canceled);
        Eio.Promise.resolve release_u ();
        problem (Eio.Promise.await result);
        Eio.Fiber.yield ();
        printf
          "after-failure=%s delivered=%b\n"
          (status (inspect jobs "migration"))
          (Eio.Promise.is_resolved canceled);
        ignore
          (Admin_jobs.cancel jobs ~intention_id:(id "migration") |> Disk.unwrap
           : Admin_jobs.Job.t);
        Eio.Promise.await canceled;
        printf
          "after-exact-retry=%s destination-exists=%b\n"
          (status (finished env jobs "migration"))
          (Eio.Path.is_directory
             Eio.Path.(Eio.Stdenv.fs env / (State_root.path root ^ "/converted")))
      in
      ()));
  [%expect
    {|saving-requested=true delivered=false
Local_io
after-failure=running delivered=false
after-exact-retry=outcome_unknown destination-exists=false|}]
;;

let%expect_test
    "Eio owner installs cancellation context before a queued cancel save can run"
  =
  with_root (fun _env _root ->
    Eio.Switch.run (fun sw ->
      let mutex = Eio.Mutex.create () in
      let admission, admission_u = Eio.Promise.create () in
      let saving, saving_u = Eio.Promise.create () in
      let installed = ref false
      and installed_before_save = ref false in
      Eio.Mutex.use_rw ~protect:true mutex (fun () ->
        Eio.Fiber.fork ~sw (fun () ->
          Eio.Mutex.use_rw ~protect:true mutex (fun () ->
            installed_before_save := !installed;
            Eio.Promise.resolve saving_u ())));
      (* Exact non-suspending admission-to-context sequence used by start.
         Resolving admission and waking the mutex waiter enqueue other fibers;
         neither lets their cancellation-save callback run before sub installs. *)
      Eio.Promise.resolve admission_u ();
      Eio.Cancel.sub (fun _context ->
        installed := true;
        Eio.Promise.await saving);
      Eio.Promise.await admission;
      printf "context-before-cancel-save=%b\n" !installed_before_save));
  [%expect {|context-before-cancel-save=true|}]
;;
