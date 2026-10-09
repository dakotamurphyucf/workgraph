open Core

type job =
  | Job : (unit -> 'a) * 'a Eio.Promise.u -> job
  | Stop

type loaded =
  { store : Store.t
  ; state : State.t
  }

type message =
  | Request of Jsonaf.t * (Jsonaf.t, Problem.t) Result.t Eio.Promise.u
  | Export_finished of string * (unit, Problem.t) Result.t
  | History_finished of
      string
      * (Jsonaf.t, Problem.t) Result.t
      * (Jsonaf.t, Problem.t) Result.t Eio.Promise.u

type history_work =
  | History_query of
      { workspace : string
      ; root : string
      ; generation : int
      ; capture : Session_store.Capture.t
      ; method_ : string
      ; params : Jsonaf.t
      ; resolver : (Jsonaf.t, Problem.t) Result.t Eio.Promise.u
      }
  | Stop_history

type export_work =
  | Export of Export_job.t * Snapshot.t list * Export_run.Control.t
  | Stop_exports

let serve_with ~env ~registry ~listen ~handle_signals =
  let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
  let diagnostic text = Platform.write_string (Eio.Stdenv.stderr env) text in
  Disk.absolute registry;
  Eio.Switch.run (fun sw ->
    let jobs = Eio.Stream.create 16 in
    let worker_switch, worker_switch_resolver = Eio.Promise.create () in
    Eio.Fiber.fork ~sw (fun () ->
      Eio.Domain_manager.run (Eio.Stdenv.domain_mgr env) (fun () ->
        Eio.Switch.run (fun worker_sw ->
          Eio.Promise.resolve worker_switch_resolver worker_sw;
          let rec loop () =
            match Eio.Stream.take jobs with
            | Stop -> ()
            | Job (f, resolver) ->
              let result = f () in
              Eio.Promise.resolve resolver result;
              loop ()
          in
          loop ())));
    let worker_sw = Eio.Promise.await worker_switch in
    let worker f =
      let promise, resolver = Eio.Promise.create () in
      Eio.Stream.add jobs (Job (f, resolver));
      Eio.Promise.await promise
    in
    let registry_path = Eio.Path.(fs / registry) in
    let registry_lock =
      worker (fun () ->
        Disk.ensure_directory registry_path;
        let lock =
          Eio.Path.open_out
            ~sw:worker_sw
            ~create:(`If_missing 0o600)
            Eio.Path.(registry_path / "daemon.lock")
        in
        if not (Platform.lock_exclusive lock)
        then Json.fail Conflict "registry already served";
        lock)
    in
    let registry_file = Eio.Path.(registry_path / "registry.json") in
    let registry_state = ref Registry.empty in
    let loaded = ref String.Map.empty in
    let failures = ref String.Map.empty in
    let registry_failed = ref false in
    let registry_bytes = ref None in
    let save_registry candidate =
      if !registry_failed
      then Json.fail Outcome_unknown "registry requires daemon restart";
      let bytes = Registry.encode candidate |> Disk.unwrap in
      let expected_bytes = !registry_bytes in
      match
        worker (fun () ->
          Disk.protect (fun () ->
            let actual =
              match Eio.Path.kind ~follow:false registry_file with
              | `Not_found -> None
              | _ -> Some (Disk.read registry_file)
            in
            if not (Option.equal String.equal actual expected_bytes)
            then Json.fail Conflict "registry changed externally";
            Disk.replace registry_file bytes))
      with
      | Ok () ->
        registry_state := candidate;
        registry_bytes := Some bytes
      | Error error ->
        registry_failed := true;
        Json.fail
          Outcome_unknown
          ("registry write outcome requires restart: " ^ error.message)
    in
    let open_root root =
      worker (fun () -> Store.open_existing ~sw:worker_sw ~fs ~root) |> Disk.unwrap
    in
    let check_known store (registration : Registry.Registration.t) =
      Option.iter registration.known_head ~f:(fun digest ->
        if not (worker (fun () -> Store.has_ancestor store ~digest))
        then Json.fail Conflict "workspace head diverged from last closed head");
      Option.iter registration.known_history_head ~f:(fun digest ->
        ignore
          (worker (fun () ->
             Store.with_history store ~f:(fun journal ->
               Session_store.capture_at journal ~head:(Some digest)))
           |> Disk.unwrap
           : Session_store.Capture.t))
    in
    let saved_bytes =
      worker (fun () ->
        Disk.protect (fun () ->
          match Eio.Path.kind ~follow:false registry_file with
          | `Not_found -> None
          | _ -> Some (Disk.read registry_file)))
      |> Disk.unwrap
    in
    registry_bytes := saved_bytes;
    registry_state
    := Option.value_map saved_bytes ~default:Registry.empty ~f:(fun bytes ->
         Registry.decode bytes |> Disk.unwrap);
    Map.iteri !registry_state.registrations ~f:(fun ~key:id ~data:r ->
      if r.is_open
      then (
        let result =
          Json.decode (fun () ->
            let store, state = open_root r.root in
            match
              Json.decode (fun () ->
                if not (String.equal id (Id.Workspace.to_string (State.workspace state)))
                then Json.fail Conflict "registered identity changed";
                check_known store r)
            with
            | Ok () -> { store; state }
            | Error error ->
              worker (fun () -> Store.close store);
              raise (Json.Decode_error error))
        in
        match result with
        | Ok value -> loaded := Map.set !loaded ~key:id ~data:value
        | Error error -> failures := Map.set !failures ~key:id ~data:error));
    let requests = Eio.Stream.create 128 in
    let changes_changed = Eio.Condition.create () in
    let history_jobs = Eio.Stream.create 8 in
    let history_pins = ref String.Map.empty in
    let history_changed = Eio.Condition.create () in
    Eio.Fiber.fork ~sw (fun () ->
      Eio.Domain_manager.run (Eio.Stdenv.domain_mgr env) (fun () ->
        let indexes = ref String.Map.empty in
        let rec loop () =
          match Eio.Stream.take history_jobs with
          | Stop_history -> ()
          | History_query
              { workspace; root; generation; capture; method_; params; resolver } ->
            let result =
              Disk.protect (fun () ->
                let index =
                  match Map.find !indexes root with
                  | Some (previous, index) when previous = generation -> index
                  | Some _ | None ->
                    let index = History_index.create ~fs ~root in
                    indexes := Map.set !indexes ~key:root ~data:(generation, index);
                    index
                in
                if String.equal method_ "history.search"
                then History_index.rebuild index capture |> Disk.unwrap;
                History_command.query capture ~fs ~root ~index ~method_ ~params
                |> Disk.unwrap)
            in
            Eio.Stream.add requests (History_finished (workspace, result, resolver));
            loop ()
        in
        loop ()));
    let exports = Eio.Stream.create 8 in
    let active_exports = ref String.Map.empty in
    let exports_changed = Eio.Condition.create () in
    let recovered_exports =
      Map.map !registry_state.exports ~f:(fun job ->
        match job.Export_job.status with
        | Running | Interrupted -> worker (fun () -> Export_run.recover job ~fs)
        | Completed | Failed | Canceled -> job)
    in
    if
      not
        (String.equal
           (Json.canonical
              (Json.obj
                 (Map.to_alist !registry_state.exports
                  |> List.map ~f:(fun (id, job) -> id, Export_job.to_json job))))
           (Json.canonical
              (Json.obj
                 (Map.to_alist recovered_exports
                  |> List.map ~f:(fun (id, job) -> id, Export_job.to_json job)))))
    then save_registry { !registry_state with exports = recovered_exports };
    Eio.Fiber.fork ~sw (fun () ->
      Eio.Domain_manager.run (Eio.Stdenv.domain_mgr env) (fun () ->
        let rec loop () =
          match Eio.Stream.take exports with
          | Stop_exports -> ()
          | Export (job, snapshots, control) ->
            let result = Export_run.run job ~fs ~snapshots ~control in
            Eio.Stream.add requests (Export_finished (job.id, result));
            loop ()
        in
        loop ()));
    let find_export id =
      match Map.find !registry_state.exports id with
      | Some job -> job
      | None -> Json.fail Not_found "export job not found"
    in
    let ensure_unpinned id =
      if Map.mem !history_pins id
      then Json.fail Conflict "workspace pinned by active history query";
      if
        Map.existsi !active_exports ~f:(fun ~key:job_id ~data:_ ->
          Export_job.contains (find_export job_id) ~workspace:id)
      then Json.fail Conflict "workspace pinned by active export; wait or cancel the job"
    in
    let canonical_root root =
      worker (fun () ->
        Disk.protect (fun () ->
          Disk.absolute root;
          let path = Eio.Path.(fs / root) in
          (match Eio.Path.kind ~follow:false path with
           | `Directory | `Not_found -> ()
           | _ -> Json.fail Invalid_argument "expected a real directory or fresh path");
          let rec resolve path =
            match Eio.Path.kind ~follow:true path with
            | `Directory -> Platform.realpath (Eio.Path.native_exn path)
            | `Not_found ->
              (match Eio.Path.split path with
               | Some (parent, name) ->
                 let parent = resolve parent in
                 if String.equal name "."
                 then parent
                 else if String.equal name ".."
                 then Filename.dirname parent
                 else Filename.concat parent name
               | None -> Json.fail Invalid_argument "directory path has no parent")
            | _ -> Json.fail Invalid_argument "path ancestor must be a directory"
          in
          resolve path))
      |> Disk.unwrap
    in
    let overlaps left right =
      let contains parent child =
        String.equal parent child
        || String.is_prefix
             child
             ~prefix:(if String.equal parent "/" then "/" else parent ^ "/")
      in
      contains left right || contains right left
    in
    (* Resolve existing parents so aliases cannot bypass admission. This is a
       trusted-local ownership guard, not a sandbox against concurrent renames. *)
    let ensure_disjoint ~key root =
      let check other =
        if overlaps root (canonical_root other)
        then Json.fail Conflict "directory overlaps registered or reserved storage"
      in
      check registry;
      Map.iter !registry_state.registrations ~f:(fun r -> check r.root);
      Map.iteri !registry_state.creates ~f:(fun ~key:other ~data:r ->
        if not (String.equal key other) then check r.root);
      Map.iteri !registry_state.restores ~f:(fun ~key:other ~data:plan ->
        if not (String.equal key other)
        then List.iter plan.targets ~f:(fun target -> check target.root));
      Map.iteri !active_exports ~f:(fun ~key:id ~data:_ ->
        check (find_export id).destination)
    in
    let stopping = Atomic.make false in
    let get_loaded id =
      match Map.find !loaded id with
      | Some value -> value
      | None -> Json.fail Workspace_closed "workspace is closed or unavailable"
    in
    let fresh_id prefix =
      let bytes = Cstruct.create 32 in
      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
      prefix ^ Json.hash (Cstruct.to_string bytes)
    in
    let dispatch request =
      Json.decode (fun () ->
        Json.fields request ~allowed:[ "jsonrpc"; "id"; "method"; "params" ];
        if not (String.equal (Json.text (Json.field request "jsonrpc")) "2.0")
        then Json.fail Unsupported_version "JSON-RPC 2.0 required";
        ignore (Json.field request "id" : Jsonaf.t);
        let method_ = Json.text (Json.field request "method") in
        let params =
          Option.value (Json.optional request "params") ~default:(Json.obj [])
        in
        let get key = Json.field params key in
        let observed_unix_ms =
          Int64.of_float (Eio.Time.now (Eio.Stdenv.clock env) *. 1000.)
        in
        (match Json.field request "id" with
         | `String _ | `Number _ | `Null -> ()
         | _ -> Json.fail Invalid_argument "invalid request ID");
        if
          !registry_failed
          && not
               (List.mem
                  [ "initialize"; "workspace.list"; "daemon.health"; "daemon.shutdown" ]
                  method_
                  ~equal:String.equal)
        then Json.fail Outcome_unknown "registry requires daemon restart";
        Option.iter (Api_catalog.validate_request ~method_ ~params) ~f:(fun result ->
          ignore (Disk.unwrap result : unit));
        let administrative_request () =
          Administration_api.Request.decode ~method_ ~params |> Disk.unwrap
        in
        let administrative_result value =
          Administration_api.validate_result ~method_ value;
          value
        in
        match method_ with
        | method_ when String.equal method_ (Api_method.name Daemon_methods.shutdown) ->
          Api_method.invoke Daemon_methods.shutdown ~params ~f:(fun () -> Ok true)
          |> Disk.unwrap
        | method_ when String.equal method_ (Api_method.name Daemon_methods.initialize) ->
          Api_method.invoke Daemon_methods.initialize ~params ~f:(fun () ->
            Ok (Daemon_methods.Initialization.current ()))
          |> Disk.unwrap
        | "daemon.health" | "workspace.list" ->
          ignore (administrative_request () : Administration_api.Request.t);
          Administration_wire.Health.capture
            !registry_state
            ~registry_requires_restart:!registry_failed
            ~active_exports:(Map.length !active_exports)
            ~workspace_status:(fun workspace ->
              let id = Id.Workspace.to_string workspace in
              ( Option.map (Map.find !loaded id) ~f:(fun v -> State.archived v.state)
              , Map.mem !loaded id
              , Map.find !failures id ))
          |> Api_codec.encode Administration_wire.Health.codec
          |> Disk.unwrap
        | "workspace.receipt" ->
          let identity =
            match administrative_request () with
            | Workspace_receipt identity -> identity
            | _ -> failwith "workspace receipt request differs"
          in
          let value = get_loaded (Id.Workspace.to_string identity.workspace) in
          let key = Mutation_request.key identity in
          (match
             worker (fun () -> Store.lookup_receipt value.store ~key) |> Disk.unwrap
           with
           | None -> Administration_wire.Receipt.Absent
           | Some r ->
             Administration_wire.Receipt.planning
               ~request_hash:r.request_hash
               ~response:r.response)
          |> Api_codec.encode Administration_wire.Receipt.planning_codec
          |> Disk.unwrap
        | "registry.receipt" ->
          let identity =
            match administrative_request () with
            | Registry_receipt identity -> identity
            | _ -> failwith "registry receipt request differs"
          in
          Administration_wire.Receipt.registry
            !registry_state
            ~key:(Administration_api.Identity.key identity)
          |> Api_codec.encode Administration_wire.Receipt.codec
          |> Disk.unwrap
        | "restore.cancel" ->
          let target =
            match administrative_request () with
            | Restore_cancel { target; _ } -> target
            | _ -> failwith "restore cancellation request differs"
          in
          let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
          let target_key = Administration_api.Identity.key target in
          (match Map.find !registry_state.receipts key with
           | Some receipt ->
             if not (String.equal receipt.request_hash request_hash)
             then
               Json.fail
                 Idempotency_conflict
                 "administrative mutation ID reused with different content";
             receipt.response
           | None ->
             if
               Map.mem !registry_state.creates key || Map.mem !registry_state.restores key
             then Json.fail Idempotency_conflict "cancel requires a fresh mutation ID";
             let plan =
               match Map.find !registry_state.restores target_key with
               | Some plan -> plan
               | None -> Json.fail Not_found "pending restore not found"
             in
             worker (fun () ->
               Disk.protect (fun () ->
                 List.iter plan.targets ~f:(fun target ->
                   match Eio.Path.kind ~follow:false Eio.Path.(fs / target.root) with
                   | `Not_found -> ()
                   | _ ->
                     Json.fail
                       Conflict
                       "restore has an installed or occupied target; complete the \
                        original retry")))
             |> Disk.unwrap;
             let canceled =
               Api_codec.encode Administration_wire.Restore.codec Canceled |> Disk.unwrap
             in
             Administration_api.validate_result ~method_:"workspace.restore" canceled;
             let response = administrative_result canceled in
             let receipts =
               Map.set
                 !registry_state.receipts
                 ~key:target_key
                 ~data:
                   { Registry.Receipt.request_hash = plan.request_hash
                   ; response = canceled
                   }
               |> Map.set ~key ~data:{ Registry.Receipt.request_hash; response }
             in
             save_registry
               { !registry_state with
                 restores = Map.remove !registry_state.restores target_key
               ; receipts
               };
             response)
        | "workspace.restore" | "daemon.restore_all" ->
          let restore_request = administrative_request () in
          let source =
            match restore_request with
            | Workspace_restore { directory; _ } | Restore_all { directory; _ } ->
              directory
            | _ -> failwith "restore request differs"
          in
          let restore_response plan =
            Administration_wire.Restore.of_plan plan
            |> Api_codec.encode Administration_wire.Restore.codec
            |> Disk.unwrap
            |> administrative_result
          in
          let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
          let check_hash previous =
            if not (String.equal previous request_hash)
            then
              Json.fail
                Idempotency_conflict
                "administrative mutation ID reused with different content"
          in
          (match Map.find !registry_state.receipts key with
           | Some receipt ->
             check_hash receipt.request_hash;
             receipt.response
           | None ->
             if Map.mem !registry_state.creates key
             then Json.fail Idempotency_conflict "mutation ID reserved by creation";
             let secure_token () =
               let bytes = Cstruct.create 32 in
               Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
               Json.hash (Cstruct.to_string bytes)
             in
             let plan, response =
               match Map.find !registry_state.restores key with
               | Some plan ->
                 check_hash plan.request_hash;
                 plan, restore_response plan
               | None ->
                 let targets =
                   match restore_request with
                   | Workspace_restore { root; _ } ->
                     let root = canonical_root root in
                     [ worker (fun () -> Restore.inspect ~fs ~source ~root) |> Disk.unwrap
                     ]
                   | Restore_all { roots; _ } ->
                     let roots =
                       String.Map.of_alist_exn
                         (List.map roots ~f:(fun (id, root) ->
                            Id.Workspace.to_string id, canonical_root root))
                     in
                     worker (fun () -> Restore.inspect_all ~fs ~source ~roots)
                     |> Disk.unwrap
                   | _ -> failwith "restore request differs"
                 in
                 let plan =
                   { Restore_plan.request_hash; token = secure_token (); targets }
                 in
                 Restore_plan.validate plan;
                 List.iteri targets ~f:(fun index target ->
                   if
                     List.exists
                       (List.drop targets (index + 1))
                       ~f:(fun other ->
                         overlaps target.Restore_plan.Target.root other.root)
                   then Json.fail Conflict "restore roots overlap");
                 List.iter targets ~f:(fun target ->
                   ensure_disjoint ~key target.Restore_plan.Target.root;
                   let id =
                     Id.Workspace.to_string target.Restore_plan.Target.capture.workspace
                   in
                   if
                     Map.mem !registry_state.registrations id
                     || Map.exists !registry_state.registrations ~f:(fun r ->
                       String.equal r.root target.root)
                     || Map.exists !registry_state.creates ~f:(fun r ->
                       String.equal r.root target.root
                       || Id.Workspace.equal r.workspace target.capture.workspace)
                     || Map.exists !registry_state.restores ~f:(fun plan ->
                       List.exists plan.targets ~f:(fun other ->
                         String.equal other.root target.root
                         || Id.Workspace.equal
                              other.capture.workspace
                              target.capture.workspace))
                   then
                     Json.fail
                       Conflict
                       "restore identity or root already registered or reserved";
                   worker (fun () ->
                     Disk.protect (fun () ->
                       let root = Eio.Path.(fs / target.root) in
                       (match Eio.Path.kind ~follow:false root with
                        | `Not_found -> ()
                        | _ -> Json.fail Conflict "restore requires a fresh root");
                       match Eio.Path.split root with
                       | Some (parent, _) ->
                         (match Eio.Path.kind ~follow:false parent with
                          | `Directory -> ()
                          | _ ->
                            Json.fail
                              Invalid_argument
                              "restore parent must be an existing real directory")
                       | None -> Json.fail Invalid_argument "restore path has no parent"))
                   |> Disk.unwrap);
                 let response = restore_response plan in
                 save_registry
                   { !registry_state with
                     restores = Map.set !registry_state.restores ~key ~data:plan
                   };
                 plan, response
             in
             let attempt = secure_token () in
             worker (fun () -> Restore.install plan ~sw:worker_sw ~fs ~attempt)
             |> Disk.unwrap;
             let registrations =
               List.fold
                 plan.targets
                 ~init:!registry_state.registrations
                 ~f:(fun registrations target ->
                   Map.set
                     registrations
                     ~key:(Id.Workspace.to_string target.capture.workspace)
                     ~data:
                       { Registry.Registration.root = target.root
                       ; is_open = false
                       ; known_head = target.capture.head
                       ; known_history_head = target.capture.history_head
                       })
             in
             save_registry
               { !registry_state with
                 registrations
               ; restores = Map.remove !registry_state.restores key
               ; receipts =
                   Map.set
                     !registry_state.receipts
                     ~key
                     ~data:{ Registry.Receipt.request_hash; response }
               };
             response)
        | "workspace.create"
        | "workspace.register"
        | "workspace.open"
        | "workspace.close"
        | "workspace.unregister" ->
          let lifecycle_request = administrative_request () in
          let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
          let verify_hash previous =
            if not (String.equal previous request_hash)
            then
              Json.fail
                Idempotency_conflict
                "administrative mutation ID reused with different content"
          in
          (match Map.find !registry_state.receipts key with
           | Some receipt ->
             verify_hash receipt.request_hash;
             receipt.response
           | None ->
             if Map.mem !registry_state.restores key
             then Json.fail Idempotency_conflict "mutation ID reserved by restore";
             Option.iter (Map.find !registry_state.creates key) ~f:(fun intent ->
               verify_hash intent.request_hash);
             let complete registrations response =
               let response = administrative_result response in
               let candidate =
                 { Registry.registrations
                 ; exports = !registry_state.exports
                 ; restores = !registry_state.restores
                 ; creates = Map.remove !registry_state.creates key
                 ; receipts =
                     Map.set
                       !registry_state.receipts
                       ~key
                       ~data:{ Registry.Receipt.request_hash; response }
                 }
               in
               save_registry candidate;
               response
             in
             let registration id =
               match Map.find !registry_state.registrations id with
               | Some r -> r
               | None -> Json.fail Not_found "workspace not registered"
             in
             (match method_ with
              | "workspace.create" | "workspace.register" ->
                let root =
                  match lifecycle_request with
                  | Workspace_create { root; _ } | Workspace_register { root; _ } ->
                    canonical_root root
                  | _ -> failwith "workspace root request differs"
                in
                ensure_disjoint ~key root;
                if
                  Map.exists !registry_state.registrations ~f:(fun r ->
                    String.equal r.root root)
                then Json.fail Conflict "root already registered";
                if
                  Map.existsi !registry_state.creates ~f:(fun ~key:other ~data:r ->
                    (not (String.equal other key)) && String.equal r.root root)
                then Json.fail Conflict "root reserved by pending creation";
                if
                  Map.exists !registry_state.restores ~f:(fun plan ->
                    List.exists plan.targets ~f:(fun target ->
                      String.equal target.root root))
                then Json.fail Conflict "root reserved by pending restore";
                if String.equal method_ "workspace.create"
                then (
                  let workspace =
                    match lifecycle_request with
                    | Workspace_create { workspace = Some workspace; _ } -> workspace
                    | Workspace_create { workspace = None; _ } ->
                      (match Map.find !registry_state.creates key with
                       | Some intent -> intent.workspace
                       | None -> Id.Workspace.of_string (fresh_id "ws_") |> Disk.unwrap)
                    | _ -> failwith "workspace creation request differs"
                  in
                  let id = Id.Workspace.to_string workspace in
                  let name =
                    match lifecycle_request with
                    | Workspace_create { name; _ } -> name
                    | _ -> failwith "workspace creation name differs"
                  in
                  ignore
                    (administrative_result
                       (Json.obj [ "workspace_id", Id.Workspace.jsonaf_of_t workspace ])
                     : Jsonaf.t);
                  ignore (State.empty ~workspace ~name |> Disk.unwrap : State.t);
                  if
                    Map.mem !registry_state.registrations id
                    || Map.existsi !registry_state.creates ~f:(fun ~key:other ~data:r ->
                      (not (String.equal other key))
                      && Id.Workspace.equal r.workspace workspace)
                  then Json.fail Conflict "workspace ID already registered or reserved";
                  if
                    Map.exists !registry_state.restores ~f:(fun plan ->
                      List.exists plan.targets ~f:(fun target ->
                        Id.Workspace.equal target.capture.workspace workspace))
                  then Json.fail Conflict "workspace ID reserved by pending restore";
                  let intent =
                    match Map.find !registry_state.creates key with
                    | Some intent -> intent
                    | None ->
                      worker (fun () ->
                        Disk.protect (fun () ->
                          match Eio.Path.kind ~follow:false Eio.Path.(fs / root) with
                          | `Not_found -> ()
                          | _ -> Json.fail Conflict "workspace root already exists"))
                      |> Disk.unwrap;
                      let bytes = Cstruct.create 32 in
                      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
                      let token = Json.hash (Cstruct.to_string bytes) in
                      let intent =
                        { Registry.Create_intent.request_hash
                        ; root
                        ; workspace
                        ; name
                        ; token
                        }
                      in
                      save_registry
                        { !registry_state with
                          creates = Map.set !registry_state.creates ~key ~data:intent
                        };
                      intent
                  in
                  worker (fun () ->
                    Store.create ~fs ~root ~workspace ~name ~creation_token:intent.token)
                  |> Disk.unwrap);
                let store, state = open_root root in
                let id = Id.Workspace.to_string (State.workspace state) in
                let result =
                  Json.decode (fun () ->
                    if
                      Map.existsi !registry_state.creates ~f:(fun ~key:other ~data:r ->
                        (not (String.equal other key))
                        && Id.Workspace.equal r.workspace (State.workspace state))
                    then Json.fail Conflict "workspace ID reserved by pending creation";
                    if
                      Map.exists !registry_state.restores ~f:(fun plan ->
                        List.exists plan.targets ~f:(fun target ->
                          Id.Workspace.equal
                            target.capture.workspace
                            (State.workspace state)))
                    then Json.fail Conflict "workspace ID reserved by pending restore";
                    let known_head =
                      match Map.find !registry_state.registrations id with
                      | None -> None
                      | Some previous ->
                        if previous.is_open || Map.mem !loaded id
                        then
                          Json.fail
                            Conflict
                            "workspace ID already registered; close before moving";
                        worker (fun () ->
                          Disk.protect (fun () ->
                            match
                              Eio.Path.kind ~follow:false Eio.Path.(fs / previous.root)
                            with
                            | `Not_found -> ()
                            | _ ->
                              Json.fail
                                Conflict
                                "previous root still exists; unregister it before \
                                 selecting a copy"))
                        |> Disk.unwrap;
                        check_known store previous;
                        previous.known_head
                    in
                    let response = Json.obj [ "workspace_id", Json.string id ] in
                    complete
                      (Map.set
                         !registry_state.registrations
                         ~key:id
                         ~data:
                           { Registry.Registration.root
                           ; is_open = true
                           ; known_head
                           ; known_history_head =
                               worker (fun () -> Store.history_capture store)
                               |> Disk.unwrap
                               |> Session_store.Capture.head
                           })
                      response)
                in
                (match result with
                 | Error error ->
                   worker (fun () -> Store.close store);
                   raise (Json.Decode_error error)
                 | Ok response ->
                   loaded := Map.set !loaded ~key:id ~data:{ store; state };
                   failures := Map.remove !failures id;
                   response)
              | "workspace.open" ->
                let id =
                  match lifecycle_request with
                  | Workspace_open { workspace; _ } -> Id.Workspace.to_string workspace
                  | _ -> failwith "workspace open request differs"
                in
                if Map.mem !loaded id then Json.fail Conflict "workspace already open";
                let r = registration id in
                let store, state = open_root r.root in
                let result =
                  Json.decode (fun () ->
                    if
                      not
                        (String.equal id (Id.Workspace.to_string (State.workspace state)))
                    then Json.fail Conflict "workspace identity changed";
                    check_known store r;
                    complete
                      (Map.set
                         !registry_state.registrations
                         ~key:id
                         ~data:{ r with is_open = true })
                      (Json.obj [ "opened", `True ]))
                in
                (match result with
                 | Error error ->
                   worker (fun () -> Store.close store);
                   raise (Json.Decode_error error)
                 | Ok response ->
                   loaded := Map.set !loaded ~key:id ~data:{ store; state };
                   failures := Map.remove !failures id;
                   response)
              | "workspace.close" | "workspace.unregister" ->
                let id =
                  match lifecycle_request with
                  | Workspace_close { workspace; _ }
                  | Workspace_unregister { workspace; _ } ->
                    Id.Workspace.to_string workspace
                  | _ -> failwith "workspace close request differs"
                in
                ensure_unpinned id;
                let r = registration id in
                let value = Map.find !loaded id in
                let known_head =
                  match value with
                  | None -> r.known_head
                  | Some v -> worker (fun () -> Store.head v.store)
                in
                let known_history_head =
                  match value with
                  | None -> r.known_history_head
                  | Some v -> worker (fun () -> Store.known_history_head v.store)
                in
                Option.iter value ~f:(fun v ->
                  match worker (fun () -> Store.flush_heartbeats v.store) with
                  | Ok () -> ()
                  | Error error ->
                    diagnostic (Json.canonical (Problem.to_json error) ^ "\n"));
                let unregister = String.equal method_ "workspace.unregister" in
                let registrations =
                  if unregister
                  then Map.remove !registry_state.registrations id
                  else
                    Map.set
                      !registry_state.registrations
                      ~key:id
                      ~data:{ r with is_open = false; known_head; known_history_head }
                in
                let response =
                  complete
                    registrations
                    (Json.obj
                       [ (if unregister then "unregistered" else "closed"), `True ])
                in
                Option.iter value ~f:(fun v -> worker (fun () -> Store.close v.store));
                loaded := Map.remove !loaded id;
                failures := Map.remove !failures id;
                response
              | _ -> assert false))
        | "export.verify" ->
          let directory =
            match administrative_request () with
            | Export_verify directory -> directory
            | _ -> failwith "export verification request differs"
          in
          worker (fun () -> Snapshot.verify ~fs ~directory)
          |> Disk.unwrap
          |> Administration_wire.Verification.of_verified
          |> Api_codec.encode Administration_wire.Verification.codec
          |> Disk.unwrap
        | "export.get" ->
          let id =
            match administrative_request () with
            | Export_get id -> id
            | _ -> failwith "export get request differs"
          in
          find_export id |> Api_codec.encode Administration_wire.export_job |> Disk.unwrap
        | "export.list" ->
          (match administrative_request () with
           | Export_list { offset; limit; max_bytes; at_snapshot } ->
             Administration_wire.Export_page.response
               !registry_state
               ~offset
               ~limit
               ~max_bytes
               ~at_snapshot
             |> Disk.unwrap
           | _ -> failwith "export list request differs")
        | "workspace.export" | "daemon.export_all" | "export.cancel" | "export.retry" ->
          let export_request = administrative_request () in
          let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
          (match Map.find !registry_state.receipts key with
           | Some receipt ->
             if not (String.equal receipt.request_hash request_hash)
             then Json.fail Idempotency_conflict "administrative mutation ID reused";
             receipt.response
           | None ->
             if
               Map.mem !registry_state.creates key || Map.mem !registry_state.restores key
             then
               Json.fail Idempotency_conflict "mutation ID belongs to a pending creation";
             let commit_job job =
               let response =
                 Api_codec.encode Administration_wire.export_job job
                 |> Disk.unwrap
                 |> administrative_result
               in
               save_registry
                 { !registry_state with
                   exports = Map.set !registry_state.exports ~key:job.id ~data:job
                 ; receipts =
                     Map.set
                       !registry_state.receipts
                       ~key
                       ~data:{ Registry.Receipt.request_hash; response }
                 };
               response
             in
             if String.equal method_ "export.cancel"
             then (
               let id =
                 match export_request with
                 | Export_cancel { job; _ } -> job
                 | _ -> failwith "export cancellation request differs"
               in
               let job = find_export id in
               let control =
                 match Map.find !active_exports job.id with
                 | None -> Json.fail Conflict "export is not running"
                 | Some control -> control
               in
               if not (Export_job.equal_status job.status Running)
               then Json.fail Conflict "export is not running";
               let next = { job with cancel_requested = true } in
               ignore
                 (administrative_result
                    (Api_codec.encode Administration_wire.export_job next |> Disk.unwrap)
                  : Jsonaf.t);
               if not (Export_run.Control.cancel control)
               then
                 Json.fail Conflict "export has begun publication and cannot be canceled";
               commit_job next)
             else (
               if Map.length !active_exports >= 8
               then Json.fail Conflict "export admission limit is 8 active jobs";
               let job, snapshots =
                 if String.equal method_ "export.retry"
                 then (
                   let id =
                     match export_request with
                     | Export_retry { job; _ } -> job
                     | _ -> failwith "export retry request differs"
                   in
                   let previous = find_export id in
                   if
                     Map.mem !active_exports previous.id
                     || Export_job.equal_status previous.status Completed
                   then Json.fail Conflict "export is active or already completed";
                   let snapshots =
                     List.map previous.captures ~f:(fun captured ->
                       let value =
                         get_loaded (Id.Workspace.to_string captured.workspace)
                       in
                       let snapshot =
                         worker (fun () ->
                           Store.capture_at_history
                             value.store
                             ~revision:captured.revision
                             ~history_head:captured.history_head)
                         |> Disk.unwrap
                       in
                       if
                         not
                           (Option.equal
                              String.equal
                              captured.head
                              (Snapshot.head snapshot))
                       then
                         Json.fail Conflict "export retry head no longer matches source";
                       snapshot)
                   in
                   ( { previous with
                       attempt = previous.attempt + 1
                     ; status = Running
                     ; cancel_requested = false
                     ; error = None
                     }
                   , snapshots ))
                 else (
                   let kind =
                     if String.equal method_ "workspace.export"
                     then Export_job.Single
                     else All
                   in
                   let destination =
                     match export_request with
                     | Workspace_export { destination; _ } | Export_all { destination; _ }
                       -> canonical_root destination
                     | _ -> failwith "export destination request differs"
                   in
                   let sources, omitted =
                     match kind with
                     | Single ->
                       let workspace =
                         match export_request with
                         | Workspace_export { workspace; _ } -> workspace
                         | _ -> failwith "workspace export request differs"
                       in
                       [ get_loaded (Id.Workspace.to_string workspace) ], []
                     | All ->
                       let omitted =
                         Map.keys !registry_state.registrations
                         |> List.filter ~f:(fun id -> not (Map.mem !loaded id))
                       in
                       let allow_partial =
                         match export_request with
                         | Export_all { allow_partial; _ } -> allow_partial
                         | _ -> failwith "all workspace export request differs"
                       in
                       if (not allow_partial) && not (List.is_empty omitted)
                       then
                         Json.fail
                           Workspace_closed
                           "complete export-all requires every registered workspace open \
                            and available";
                       ( Map.data !loaded
                       , List.map omitted ~f:(fun id ->
                           Id.Workspace.of_string id |> Disk.unwrap) )
                   in
                   let snapshots =
                     List.map sources ~f:(fun value ->
                       worker (fun () -> Store.capture value.store ~state:value.state)
                       |> Disk.unwrap)
                   in
                   let captures =
                     List.map snapshots ~f:(fun snapshot ->
                       { Export_job.Capture.workspace = Snapshot.workspace snapshot
                       ; revision = Snapshot.revision snapshot
                       ; history_head = Snapshot.history_head snapshot
                       ; head = Snapshot.head snapshot
                       })
                   in
                   ( { Export_job.id = "export_" ^ Json.hash key
                     ; kind
                     ; destination
                     ; captures
                     ; omitted
                     ; status = Running
                     ; attempt = 1
                     ; cancel_requested = false
                     ; error = None
                     }
                   , snapshots ))
               in
               ensure_disjoint ~key (canonical_root job.destination);
               if
                 Map.existsi !active_exports ~f:(fun ~key:id ~data:_ ->
                   String.equal (find_export id).destination job.destination)
               then Json.fail Conflict "destination reserved by another active export";
               worker (fun () ->
                 Disk.protect (fun () ->
                   match Eio.Path.kind ~follow:false Eio.Path.(fs / job.destination) with
                   | `Not_found -> ()
                   | _ -> Json.fail Conflict "export destination already exists"))
               |> Disk.unwrap;
               let response = commit_job job in
               let control = Export_run.Control.create () in
               active_exports := Map.set !active_exports ~key:job.id ~data:control;
               Eio.Stream.add exports (Export (job, snapshots, control));
               response))
        | "upload.begin" ->
          Api_method.invoke Upload_api.begin_method ~params ~f:(fun request ->
            let identity = Upload_api.Begin_request.identity request in
            let value =
              get_loaded (Id.Workspace.to_string (Upload_api.Identity.workspace identity))
            in
            worker (fun () ->
              Store.begin_upload
                value.store
                ~id:(Upload_api.Identity.upload identity)
                ~actor:(Upload_api.Identity.actor identity)
                ~size_bytes:(Upload_api.Begin_request.size_bytes request)
                ~digest:(Upload_api.Begin_request.digest request))
            |> Result.map ~f:(Upload_api.Status.of_result identity ~method_))
          |> Disk.unwrap
        | "upload.chunk" ->
          Api_method.invoke Upload_api.chunk_method ~params ~f:(fun request ->
            let identity = Upload_api.Chunk_request.identity request in
            let value =
              get_loaded (Id.Workspace.to_string (Upload_api.Identity.workspace identity))
            in
            worker (fun () ->
              Store.upload_chunk
                value.store
                ~id:(Upload_api.Identity.upload identity)
                ~actor:(Upload_api.Identity.actor identity)
                ~offset:(Upload_api.Chunk_request.offset request)
                ~bytes:(Upload_api.Chunk_request.bytes request))
            |> Result.map ~f:(Upload_api.Status.of_result identity ~method_))
          |> Disk.unwrap
        | "upload.status" ->
          Api_method.invoke Upload_api.status_method ~params ~f:(fun identity ->
            let value =
              get_loaded (Id.Workspace.to_string (Upload_api.Identity.workspace identity))
            in
            worker (fun () ->
              Store.upload_status
                value.store
                ~id:(Upload_api.Identity.upload identity)
                ~actor:(Upload_api.Identity.actor identity))
            |> Result.map ~f:(Upload_api.Status.of_result identity ~method_))
          |> Disk.unwrap
        | "upload.abort" ->
          Api_method.invoke Upload_api.abort_method ~params ~f:(fun identity ->
            let value =
              get_loaded (Id.Workspace.to_string (Upload_api.Identity.workspace identity))
            in
            worker (fun () ->
              Store.abort_upload
                value.store
                ~id:(Upload_api.Identity.upload identity)
                ~actor:(Upload_api.Identity.actor identity))
            |> Result.map ~f:(fun () -> Upload_api.Aborted.confirmed))
          |> Disk.unwrap
        | "resource.read_chunk" ->
          Api_method.invoke Resource_read.chunk_method ~params ~f:(fun request ->
            let open Result.Let_syntax in
            let selector = Resource_read.Chunk_request.request request in
            let value =
              get_loaded
                (Id.Workspace.to_string (Resource_read.Request.workspace selector))
            in
            let%bind version =
              State.resource_version
                value.state
                (Resource_read.Request.resource selector)
                ~revision:(Resource_read.Request.version selector)
            in
            let%bind bytes, total_bytes =
              worker (fun () ->
                Store.read_blob_range
                  value.store
                  ~digest:version.digest
                  ~offset:(Resource_read.Chunk_request.byte_offset request)
                  ~length:(Resource_read.Chunk_request.max_bytes request))
            in
            Resource_read.Chunk.create request ~version ~bytes ~total_bytes)
          |> Disk.unwrap
        | "resource.read" ->
          Api_method.invoke Resource_read.text_method ~params ~f:(fun request ->
            let open Result.Let_syntax in
            let value =
              get_loaded
                (Id.Workspace.to_string (Resource_read.Request.workspace request))
            in
            let%bind version =
              State.resource_version
                value.state
                (Resource_read.Request.resource request)
                ~revision:(Resource_read.Request.version request)
            in
            let%bind text =
              worker (fun () -> Store.read_blob value.store ~digest:version.digest)
            in
            Resource_read.Text.create request ~version ~text)
          |> Disk.unwrap
        | "search.query" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let resources = State.search_resources value.state ~params |> Disk.unwrap in
          let resource_texts =
            worker (fun () -> Store.extract_search_texts value.store ~resources)
            |> Disk.unwrap
          in
          State.query_with_texts
            ~now_unix_ms:observed_unix_ms
            value.state
            ~resource_texts
            ~method_
            ~params
          |> Disk.unwrap
        | "run.heartbeat" ->
          Api_method.invoke Heartbeat_api.observe ~params ~f:(fun request ->
            let open Result.Let_syntax in
            let value = get_loaded (Id.Workspace.to_string request.workspace_id) in
            let run = request.target_run_id in
            let actor = request.actor_id in
            let%bind () = State.validate_run_actor value.state ~run ~actor in
            let now_unix_ms =
              Int64.of_float (Eio.Time.now (Eio.Stdenv.clock env) *. 1000.)
            in
            worker (fun () -> Store.heartbeat value.store ~run ~actor ~now_unix_ms))
          |> Disk.unwrap
        | "run.heartbeat_get" ->
          Api_method.invoke Heartbeat_api.read ~params ~f:(fun request ->
            let value = get_loaded (Id.Workspace.to_string request.workspace_id) in
            worker (fun () -> Store.heartbeat_get value.store ~run:request.target_run_id))
          |> Disk.unwrap
        | method_
          when List.mem History_command.mutation_methods method_ ~equal:String.equal ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let actor = Id.Actor.t_of_jsonaf (get "actor_id") in
          let run = Option.map (Json.optional params "run_id") ~f:Id.Run.t_of_jsonaf in
          let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
          let command_params =
            match params with
            | `Object fields ->
              Json.obj
                (List.filter fields ~f:(fun (key, _) ->
                   not
                     (List.mem
                        [ "workspace_id"; "actor_id"; "run_id"; "mutation_id" ]
                        key
                        ~equal:String.equal)))
            | _ -> Json.fail Invalid_argument "params must be an object"
          in
          let command =
            History_command.decode
              ~workspace:(State.workspace value.state)
              ~actor
              ?run
              ~method_
              ~params:command_params
              ()
            |> Disk.unwrap
          in
          State.validate_targets value.state (History_command.session_scopes command)
          |> Disk.unwrap;
          List.iter (History_command.resource_versions command) ~f:(fun reference ->
            ignore
              (State.resource_version
                 value.state
                 reference.id
                 ~revision:(Some reference.revision)
               |> Disk.unwrap
               : Resource.Version.t));
          worker (fun () ->
            Store.with_history value.store ~f:(fun journal ->
              History_command.execute journal command ~actor ?run ~key ~request_hash ()))
          |> Disk.unwrap
        | method_
          when List.mem
                 (Communication.query_methods
                  @ Agent_run.query_methods
                  @ Evidence.query_methods
                  @ Ticket_recovery.query_methods
                  @ Resume_api.query_methods
                  @ Agent_run_policy.query_methods)
                 method_
                 ~equal:String.equal ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let query_params =
            match params with
            | `Object fields ->
              Json.obj
                (List.filter fields ~f:(fun (key, _) ->
                   not (String.equal key "workspace_id")))
            | _ -> Json.fail Invalid_argument "params must be an object"
          in
          State.query
            ~now_unix_ms:observed_unix_ms
            value.state
            ~method_
            ~params:query_params
          |> Disk.unwrap
        | "workspace.metrics" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let fields =
            match params with
            | `Object fields ->
              List.filter fields ~f:(fun (key, _) ->
                not (String.equal key "workspace_id"))
            | _ -> Json.fail Invalid_argument "params must be an object"
          in
          let request =
            Api_codec.decode Workspace_metrics.Request.codec (Json.obj fields)
            |> Disk.unwrap
          in
          Option.iter request.at_revision ~f:(fun expected ->
            if not (Int.equal expected (State.revision value.state))
            then Json.fail Conflict "Planning capture changed");
          let planning = State.metrics value.state ~observed_unix_ms in
          let storage_admission, history_head =
            worker (fun () ->
              let admission = Store.admission value.store |> Disk.unwrap in
              admission, Store.known_history_head value.store)
          in
          let metrics =
            Workspace_metrics.create
              planning
              ~observed_unix_ms
              ~history_head
              ~storage_admission
            |> Disk.unwrap
          in
          Workspace_metrics.response metrics ~max_bytes:request.max_bytes |> Disk.unwrap
        | "coordinator.overview" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let params =
            match params with
            | `Object fields ->
              Json.obj
                (List.filter fields ~f:(fun (key, _) ->
                   not (String.equal key "workspace_id")))
            | _ -> Json.fail Invalid_argument "params must be an object"
          in
          let selected =
            Disk.unwrap (Api_codec.decode Coordinator_api.Request.codec params)
          in
          let heartbeats =
            worker (fun () -> Store.heartbeat_observations value.store) |> Disk.unwrap
          in
          Coordinator.read
            ~workspace:(State.workspace value.state)
            ~revision:(State.revision value.state)
            ~head:(Store.head value.store)
            ~tickets:
              (State.coordination_tickets
                 ?run:(Coordinator_api.Request.run selected)
                 ~now_unix_ms:observed_unix_ms
                 value.state)
            ~runs:(State.agent_runs value.state)
            ~evidence:(State.evidence value.state)
            ~communication:(State.communication value.state)
            ~policies:(State.policies value.state)
            ~heartbeats
            ~now_unix_ms:observed_unix_ms
            ~params
          |> Disk.unwrap
        | "changes.read" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let source =
            Option.value_map
              (Json.optional params "source")
              ~default:"planning"
              ~f:Json.text
          in
          if String.equal source "history"
          then (
            let capture =
              worker (fun () -> Store.history_capture value.store) |> Disk.unwrap
            in
            Change_feed.read
              ~workspace:(State.workspace value.state)
              ~revision:(Session_store.Capture.sequence capture)
              ~activity:(Session_store.Capture.activity capture)
              ~params
            |> Disk.unwrap)
          else
            State.query ~now_unix_ms:observed_unix_ms value.state ~method_ ~params
            |> Disk.unwrap
        | method_ when List.mem Facts.query_methods method_ ~equal:String.equal ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          State.query ~now_unix_ms:observed_unix_ms value.state ~method_ ~params
          |> Disk.unwrap
        | "workspace.get"
        | "workspace.overview"
        | "actor.list"
        | "label.list"
        | "status.list"
        | "project.list"
        | "project.get"
        | "project.brief"
        | "milestone.list"
        | "milestone.get"
        | "ticket.list"
        | "ticket.ready"
        | "ticket.resolve"
        | "ticket.context"
        | "ticket.blockers"
        | "ticket.readiness"
        | "comment.list"
        | "comment.get"
        | "comment.history"
        | "handoff.get"
        | "handoff.history"
        | "activity.since"
        | "resource.list"
        | "resource.history"
        | "resource.get" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          State.query ~now_unix_ms:observed_unix_ms value.state ~method_ ~params
          |> Disk.unwrap
        | _ ->
          let identity, command_params =
            Mutation_request.of_params params |> Disk.unwrap
          in
          let id = Id.Workspace.to_string identity.workspace in
          let value = get_loaded id in
          let actor = identity.actor in
          let run = identity.run in
          let key = Mutation_request.key identity in
          let request_hash =
            Json.hash
              (Json.canonical
                 (Json.obj
                    ([ "method", Json.string method_; "params", command_params ]
                     @ Option.to_list
                         (Option.map run ~f:(fun run -> "run_id", Id.Run.jsonaf_of_t run))
                    )))
          in
          let receipt = worker (fun () -> Store.receipt value.store ~key) in
          (match receipt with
           | Some receipt ->
             if not (String.equal receipt.request_hash request_hash)
             then
               Json.fail Idempotency_conflict "mutation ID reused with different content";
             receipt.response
           | None ->
             let command_params =
               Id_resolution.resolve ~method_ ~params:command_params ~fresh:(fun kind ->
                 fresh_id
                   (match kind with
                    | Id_resolution.Kind.Project -> "project_"
                    | Milestone -> "milestone_"
                    | Ticket -> "ticket_"
                    | Comment -> "comment_"
                    | Resource -> "resource_"))
               |> Disk.unwrap
             in
             let command, upload =
               if String.equal method_ "resource.finish_upload"
               then (
                 let request =
                   Api_codec.decode Resource_api.Finish_request.codec command_params
                   |> Disk.unwrap
                 in
                 let upload = Resource_api.Finish_request.upload request in
                 let id =
                   match Resource_api.Finish_request.resource request with
                   | Some id -> id
                   | None -> failwith "resource.finish_upload ID was not resolved"
                 in
                 let expected_revision =
                   Resource_api.Finish_request.expected_revision request
                 in
                 let title = Resource_api.Finish_request.title request in
                 let filename = Resource_api.Finish_request.filename request in
                 let mime_type = Resource_api.Finish_request.mime_type request in
                 let digest, size_bytes =
                   worker (fun () -> Store.finish_upload value.store ~id:upload ~actor)
                   |> Disk.unwrap
                 in
                 ( Domain_command.Resource_publish
                     { id
                     ; expected_revision
                     ; title
                     ; filename
                     ; mime_type
                     ; digest
                     ; size_bytes
                     }
                 , Some upload ))
               else
                 ( Domain_command.decode ~method_ ~params:command_params |> Disk.unwrap
                 , None )
             in
             let timestamp =
               Time_ns.of_span_since_epoch
                 (Time_ns.Span.of_sec (Eio.Time.now (Eio.Stdenv.clock env)))
               |> Time_ns.to_string_utc
             in
             let prepared =
               State.prepare
                 value.state
                 ?run
                 ~now_unix_ms:
                   (Int64.of_float (Eio.Time.now (Eio.Stdenv.clock env) *. 1000.))
                 command
                 ~actor
                 ~timestamp
               |> Disk.unwrap
             in
             let response =
               worker (fun () -> Store.commit value.store ~prepared ~key ~request_hash)
               |> Disk.unwrap
             in
             loaded
             := Map.set
                  !loaded
                  ~key:id
                  ~data:{ value with state = State.candidate prepared };
             Option.iter upload ~f:(fun id ->
               worker (fun () -> Store.forget_upload value.store ~id));
             response))
    in
    Eio.Fiber.fork_daemon ~sw (fun () ->
      let rec loop () =
        (match Eio.Stream.take requests with
         | Request (request, resolver)
           when List.mem
                  History_command.query_methods
                  (Json.text (Json.field request "method"))
                  ~equal:String.equal ->
           let queued =
             Json.decode (fun () ->
               if !registry_failed
               then Json.fail Outcome_unknown "registry requires daemon restart";
               if
                 Map.fold !history_pins ~init:0 ~f:(fun ~key:_ ~data:n sum -> sum + n)
                 >= 8
               then
                 Json.fail
                   Conflict
                   "history worker queue is full; retry after a query completes";
               let params = Json.field request "params" in
               let method_ = Json.text (Json.field request "method") in
               Option.iter
                 (Api_catalog.validate_request ~method_ ~params)
                 ~f:(fun result -> ignore (Disk.unwrap result : unit));
               let workspace = Json.text (Json.field params "workspace_id") in
               let value = get_loaded workspace in
               let capture =
                 worker (fun () ->
                   Store.with_history value.store ~f:(fun journal ->
                     match Json.optional params "head" with
                     | None -> Session_store.capture journal
                     | Some `Null -> Session_store.capture_at journal ~head:None
                     | Some head ->
                       Session_store.capture_at journal ~head:(Some (Json.text head))))
                 |> Disk.unwrap
               in
               let params =
                 match params with
                 | `Object fields ->
                   Json.obj
                     (List.filter fields ~f:(fun (key, _) ->
                        not (String.equal key "workspace_id")))
                 | _ -> Json.fail Invalid_argument "params must be an object"
               in
               history_pins
               := Map.update !history_pins workspace ~f:(function
                    | None -> 1
                    | Some n -> n + 1);
               Eio.Stream.add
                 history_jobs
                 (History_query
                    { workspace
                    ; root = Store.root value.store
                    ; generation = Store.cache_generation value.store
                    ; capture
                    ; method_ = Json.text (Json.field request "method")
                    ; params
                    ; resolver
                    }))
           in
           (match queued with
            | Ok () -> ()
            | Error e -> Eio.Promise.resolve resolver (Error e))
         | History_finished (workspace, result, resolver) ->
           (match Map.find !history_pins workspace with
            | Some n when n > 1 ->
              history_pins := Map.set !history_pins ~key:workspace ~data:(n - 1)
            | Some _ | None -> history_pins := Map.remove !history_pins workspace);
           Eio.Condition.broadcast history_changed;
           Eio.Promise.resolve resolver result
         | Request (request, resolver) ->
           Eio.Cancel.protect (fun () ->
             let result = dispatch request in
             let mode =
               Protocol.Request.create
                 ~id:"dispatch"
                 ~method_:(Json.text (Json.field request "method"))
                 ~params:
                   (Option.value (Json.optional request "params") ~default:(Json.obj []))
               |> Result.map ~f:Protocol.Request.mode
             in
             (match result, mode with
              | Ok _, Ok Write -> Eio.Condition.broadcast changes_changed
              | Error _, _ | _, Error _ | Ok _, Ok Read -> ());
             Eio.Promise.resolve resolver result)
         | Export_finished (id, result) ->
           Eio.Cancel.protect (fun () ->
             let job = find_export id in
             let canceled =
               Option.exists (Map.find !active_exports id) ~f:Export_run.Control.canceled
             in
             let status, error =
               match result with
               | Ok () -> Export_job.Completed, None
               | Error error ->
                 ( (if canceled
                    then Canceled
                    else if Problem.equal_kind error.kind Outcome_unknown
                    then Interrupted
                    else Failed)
                 , Some (Query_budget.prefix error.message ~max_bytes:4096) )
             in
             let job = { job with status; error } in
             (match
                Json.decode (fun () ->
                  save_registry
                    { !registry_state with
                      exports = Map.set !registry_state.exports ~key:id ~data:job
                    })
              with
              | Ok () -> ()
              | Error error -> diagnostic (Json.canonical (Problem.to_json error) ^ "\n"));
             active_exports := Map.remove !active_exports id;
             Eio.Condition.broadcast exports_changed));
        loop ()
      in
      loop ());
    let listener = listen sw in
    if handle_signals
    then (
      let old_int =
        Signal.Expert.signal Signal.int (`Handle (fun _ -> Atomic.set stopping true))
      in
      let old_term =
        Signal.Expert.signal Signal.term (`Handle (fun _ -> Atomic.set stopping true))
      in
      Eio.Switch.on_release sw (fun () ->
        ignore (Signal.Expert.signal Signal.int old_int : Signal.Expert.behavior);
        ignore (Signal.Expert.signal Signal.term old_term : Signal.Expert.behavior)));
    let on_error exn = diagnostic (Exn.to_string exn ^ "\n") in
    let respond flow =
      let submit request =
        let promise, resolver = Eio.Promise.create () in
        Eio.Stream.add requests (Request (request, resolver));
        Eio.Promise.await promise
      in
      let wait_feed request =
        Json.decode (fun () ->
          let params = Json.field request "params" in
          let decoded =
            Disk.unwrap
              (Api_codec.decode
                 (Option.value_exn
                    (Change_feed_api.Request.codec ~method_:"changes.wait"))
                 params)
          in
          let timeout_ms = Change_feed_api.Request.timeout_ms decoded in
          let current = ref decoded in
          let latest = ref None in
          let poll () =
            let query =
              Json.obj
                [ "jsonrpc", Json.string "2.0"
                ; "id", Json.field request "id"
                ; "method", Json.string "changes.read"
                ; "params", Disk.unwrap (Change_feed_api.Request.read_params !current)
                ]
            in
            let result = submit query |> Disk.unwrap in
            latest := Some result;
            let needs_larger_budget =
              match Json.field result "needs_larger_budget" with
              | `True -> true
              | _ -> false
            in
            if Change_feed.has_items result || needs_larger_budget
            then Some result
            else (
              current
              := Change_feed_api.Request.with_cursor
                   !current
                   ~cursor:(Json.text (Json.field result "cursor"));
              None)
          in
          try
            Eio.Time.with_timeout_exn
              (Eio.Stdenv.clock env)
              (Float.of_int timeout_ms /. 1000.)
              (fun () -> Eio.Condition.loop_no_mutex changes_changed poll)
          with
          | Eio.Time.Timeout ->
            (match !latest with
             | Some response -> response
             | None ->
               Json.fail Storage_unavailable "feed read did not complete before timeout"))
      in
      let wait_inbox request =
        Json.decode (fun () ->
          let params = Json.field request "params" in
          Option.iter
            (Api_catalog.validate_request ~method_:"inbox.wait" ~params)
            ~f:(fun result -> ignore (Disk.unwrap result : unit));
          let timeout_ms =
            Option.value_map
              (Json.optional params "timeout_ms")
              ~default:20_000
              ~f:Json.integer
          in
          if timeout_ms < 1 || timeout_ms > 25_000
          then Json.fail Invalid_argument "timeout_ms must be 1..25000";
          let fields =
            match params with
            | `Object fields ->
              List.filter fields ~f:(fun (key, _) -> not (String.equal key "timeout_ms"))
            | _ -> Json.fail Invalid_argument "params must be an object"
          in
          let query =
            Json.obj
              [ "jsonrpc", Json.string "2.0"
              ; "id", Json.field request "id"
              ; "method", Json.string "inbox.read"
              ; "params", Json.obj fields
              ]
          in
          let latest = ref None in
          let poll () =
            let result = submit query |> Disk.unwrap in
            latest := Some result;
            if
              (not (List.is_empty (Json.list (Json.field result "items"))))
              || Json.integer (Json.field result "remaining") > 0
            then Some result
            else None
          in
          (* A read never acknowledges delivery. Keep the caller's filters and
             lower bound unchanged across polls; a filtered empty page must not
             advance over unseen messages. An omitted upper bound is recaptured
             by each serialized read; an explicit bound remains fixed. *)
          try
            Eio.Time.with_timeout_exn
              (Eio.Stdenv.clock env)
              (Float.of_int timeout_ms /. 1000.)
              (fun () -> Eio.Condition.loop_no_mutex changes_changed poll)
          with
          | Eio.Time.Timeout ->
            (match !latest with
             | Some response -> response
             | None ->
               Json.fail Storage_unavailable "inbox read did not complete before timeout"))
      in
      let write_response response =
        try
          Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 30. (fun () ->
            Framing.write flow response)
        with
        | Eio.Time.Timeout -> ()
      in
      try
        let request =
          Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 30. (fun () ->
            Framing.read flow)
        in
        match Json.optional request "id" with
        | None -> ()
        | Some id ->
          Protocol.validate_server_request request |> Disk.unwrap;
          let method_ = Json.text (Json.field request "method") in
          let result =
            match Api_catalog.find method_ with
            | None ->
              Error (Problem.create Invalid_argument ("unknown method: " ^ method_))
            | Some _ ->
              (match method_ with
               | "changes.wait" | "inbox.wait" ->
                 Eio.Fiber.first
                   (fun () ->
                      if String.equal method_ "changes.wait"
                      then wait_feed request
                      else wait_inbox request)
                   (fun () ->
                      ignore (Eio.Flow.single_read flow (Cstruct.create 1) : int);
                      Error (Problem.create Invalid_argument "one request per connection"))
               | _ -> submit request)
          in
          (* Starting cancellation in the dispatcher can race this connection's
             reply. Stop after its bounded write attempt, even if the peer has
             disconnected; other admitted work still drains through the barrier. *)
          Exn.protect
            ~finally:(fun () ->
              if
                Result.is_ok result
                && String.equal
                     (Json.text (Json.field request "method"))
                     "daemon.shutdown"
              then Atomic.set stopping true)
            ~f:(fun () ->
              let response =
                match result with
                | Ok result ->
                  let method_ = Json.text (Json.field request "method") in
                  let result =
                    Api_response.project (Service_response.layout method_) result
                  in
                  ignore (Api_catalog.validate_response ~method_ result : unit option);
                  let result = Api_response.to_json result in
                  Json.obj [ "jsonrpc", Json.string "2.0"; "id", id; "result", result ]
                | Error error ->
                  Json.obj
                    [ "jsonrpc", Json.string "2.0"
                    ; "id", id
                    ; ( "error"
                      , Json.obj
                          [ "code", `Number "-32000"
                          ; "message", Json.string error.message
                          ; "data", Problem.to_json error
                          ] )
                    ]
              in
              write_response response)
      with
      | Json.Decode_error error ->
        write_response
          (Json.obj
             [ "jsonrpc", Json.string "2.0"
             ; "id", `Null
             ; ( "error"
               , Json.obj
                   [ "code", `Number "-32600"
                   ; "message", Json.string error.message
                   ; "data", Problem.to_json error
                   ] )
             ])
      | End_of_file -> ()
      | Eio.Time.Timeout -> ()
    in
    Eio.Fiber.first
      (fun () ->
         Eio.Net.run_server ~max_connections:64 ~on_error listener (fun flow _ ->
           respond flow))
      (fun () ->
         let rec poll () =
           if not (Atomic.get stopping)
           then (
             Eio.Time.sleep (Eio.Stdenv.clock env) 0.05;
             poll ())
         in
         poll ());
    (* Queue a barrier behind already admitted operations before closing files. *)
    let promise, resolver = Eio.Promise.create () in
    Eio.Stream.add
      requests
      (Request
         ( Json.obj
             [ "jsonrpc", Json.string "2.0"
             ; "id", Json.string "shutdown"
             ; "method", Json.string "daemon.health"
             ]
         , resolver ));
    ignore (Eio.Promise.await promise : (Jsonaf.t, Problem.t) Result.t);
    Map.iter !active_exports ~f:(fun control ->
      ignore (Export_run.Control.cancel control : bool));
    while not (Map.is_empty !active_exports) do
      Eio.Condition.await_no_mutex exports_changed
    done;
    Eio.Stream.add exports Stop_exports;
    while not (Map.is_empty !history_pins) do
      Eio.Condition.await_no_mutex history_changed
    done;
    Eio.Stream.add history_jobs Stop_history;
    let stores = List.map (Map.data !loaded) ~f:(fun value -> value.store) in
    worker (fun () ->
      List.iter stores ~f:(fun store ->
        (match Store.flush_heartbeats store with
         | Ok () -> ()
         | Error error -> diagnostic (Json.canonical (Problem.to_json error) ^ "\n"));
        Store.close store);
      Eio.Resource.close registry_lock);
    Eio.Stream.add jobs Stop)
;;

let serve ~env ~registry ~listener =
  serve_with ~env ~registry ~handle_signals:false ~listen:(fun _ -> listener)
;;

let run ~env ~registry ~socket =
  Disk.absolute socket;
  let fs = Eio.Stdenv.fs env in
  serve_with ~env ~registry ~handle_signals:true ~listen:(fun sw ->
    let socket_path = Eio.Path.(fs / socket) in
    (match Eio.Path.kind ~follow:false socket_path with
     | `Not_found -> ()
     | `Socket ->
       let active =
         Eio.Switch.run (fun check_sw ->
           try
             ignore (Eio.Net.connect ~sw:check_sw (Eio.Stdenv.net env) (`Unix socket));
             true
           with
           | Eio.Io (Eio.Net.E (Connection_failure (Refused _)), _) -> false)
       in
       if active
       then Json.fail Conflict "socket already served"
       else Eio.Path.unlink socket_path
     | _ -> Json.fail Conflict "socket path is occupied");
    let listener =
      Eio.Net.listen
        ~sw
        ~reuse_addr:false
        ~backlog:128
        (Eio.Stdenv.net env)
        (`Unix socket)
    in
    Platform.restrict_socket socket;
    (listener :> [ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t))
;;
