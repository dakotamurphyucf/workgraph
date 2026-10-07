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
        match method_ with
        | "daemon.shutdown" ->
          Json.fields params ~allowed:[];
          Atomic.set stopping true;
          Json.obj [ "stopping", `True ]
        | "initialize" ->
          Json.fields params ~allowed:[];
          Json.obj
            [ "protocol_version", Json.int 1
            ; "max_frame_bytes", Json.int Framing.max_bytes
            ; "name", Json.string "workgraph"
            ; "version", Json.string Version.value
            ; "administrative_receipts", `True
            ; "workspace_receipts", `True
            ; "registry_format_version", Json.int 1
            ; "background_exports", `True
            ]
        | "daemon.health" | "workspace.list" ->
          Json.fields params ~allowed:[];
          Json.obj
            [ ("registry_requires_restart", if !registry_failed then `True else `False)
            ; "pending_creates", Json.int (Map.length !registry_state.creates)
            ; "pending_restores", Json.int (Map.length !registry_state.restores)
            ; "active_exports", Json.int (Map.length !active_exports)
            ; ( "workspaces"
              , `Array
                  (Map.to_alist !registry_state.registrations
                   |> List.map ~f:(fun (id, r) ->
                     Json.obj
                       [ "workspace_id", Json.string id
                       ; "root", Json.string r.root
                       ; ( "archived"
                         , Option.value_map
                             (Map.find !loaded id)
                             ~default:`Null
                             ~f:(fun v ->
                               if State.archived v.state then `True else `False) )
                       ; ("open", if Map.mem !loaded id then `True else `False)
                       ; ("open_intent", if r.is_open then `True else `False)
                       ; ( "error"
                         , Option.value_map
                             (Map.find !failures id)
                             ~default:`Null
                             ~f:Problem.to_json )
                       ])) )
            ]
        | "workspace.receipt" ->
          Json.fields
            params
            ~allowed:[ "workspace_id"; "actor_id"; "mutation_id"; "run_id" ];
          let value = get_loaded (Json.text (get "workspace_id")) in
          let key, _ = Registry.request ~method_:"lookup" ~params |> Disk.unwrap in
          (match
             worker (fun () -> Store.lookup_receipt value.store ~key) |> Disk.unwrap
           with
           | None -> Json.obj [ "status", Json.string "absent" ]
           | Some r ->
             Json.obj
               [ "status", Json.string "committed"
               ; "request_hash", Json.string r.request_hash
               ; "response", r.response
               ])
        | "registry.receipt" ->
          Json.fields params ~allowed:[ "actor_id"; "mutation_id" ];
          let key, _ = Registry.request ~method_:"lookup" ~params |> Disk.unwrap in
          (match Map.find !registry_state.receipts key with
           | Some receipt ->
             Json.obj
               [ "status", Json.string "committed"
               ; "request_hash", Json.string receipt.request_hash
               ; "response", receipt.response
               ]
           | None ->
             Json.obj
               [ ( "status"
                 , Json.string
                     (if
                        Map.mem !registry_state.creates key
                        || Map.mem !registry_state.restores key
                      then "pending"
                      else "absent") )
               ])
        | "restore.cancel" ->
          Json.fields
            params
            ~allowed:
              [ "actor_id"; "mutation_id"; "target_actor_id"; "target_mutation_id" ];
          let key, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
          let target_actor = Id.Actor.t_of_jsonaf (get "target_actor_id") in
          let target_mutation = Id.Actor.t_of_jsonaf (get "target_mutation_id") in
          let target_key =
            Id.Actor.to_string target_actor ^ ":" ^ Id.Actor.to_string target_mutation
          in
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
             let canceled = Json.obj [ "restored", `False; "canceled", `True ] in
             let response = Json.obj [ "canceled", `True ] in
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
          let extra =
            if String.equal method_ "workspace.restore" then [ "root" ] else [ "roots" ]
          in
          Json.fields params ~allowed:([ "actor_id"; "mutation_id"; "directory" ] @ extra);
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
             let plan =
               match Map.find !registry_state.restores key with
               | Some plan ->
                 check_hash plan.request_hash;
                 plan
               | None ->
                 let source = Json.text (get "directory") in
                 let targets =
                   if String.equal method_ "workspace.restore"
                   then (
                     let root = canonical_root (Json.text (get "root")) in
                     [ worker (fun () -> Restore.inspect ~fs ~source ~root) |> Disk.unwrap
                     ])
                   else (
                     let roots =
                       match get "roots" with
                       | `Object pairs ->
                         String.Map.of_alist_exn
                           (List.map pairs ~f:(fun (id, value) ->
                              ignore
                                (Id.Workspace.of_string id |> Disk.unwrap
                                 : Id.Workspace.t);
                              id, canonical_root (Json.text value)))
                       | _ ->
                         Json.fail
                           Invalid_argument
                           "roots must map workspace IDs to fresh absolute paths"
                     in
                     worker (fun () -> Restore.inspect_all ~fs ~source ~roots)
                     |> Disk.unwrap)
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
                 save_registry
                   { !registry_state with
                     restores = Map.set !registry_state.restores ~key ~data:plan
                   };
                 plan
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
             let response =
               Json.obj
                 [ "restored", `True
                 ; "open", `False
                 ; ( "workspaces"
                   , `Array
                       (List.map plan.targets ~f:(fun target ->
                          Json.obj
                            [ "root", Json.string target.root
                            ; "capture", Export_job.Capture.to_json target.capture
                            ])) )
                 ]
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
          let extra =
            match method_ with
            | "workspace.create" -> [ "workspace_id"; "root"; "name" ]
            | "workspace.register" -> [ "root" ]
            | _ -> [ "workspace_id" ]
          in
          Json.fields params ~allowed:([ "actor_id"; "mutation_id" ] @ extra);
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
                let root = canonical_root (Json.text (get "root")) in
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
                    match Json.optional params "workspace_id" with
                    | Some value -> Id.Workspace.t_of_jsonaf value
                    | None ->
                      (match Map.find !registry_state.creates key with
                       | Some intent -> intent.workspace
                       | None -> Id.Workspace.of_string (fresh_id "ws_") |> Disk.unwrap)
                  in
                  let id = Id.Workspace.to_string workspace in
                  let name = Json.text (get "name") in
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
                  Id.Workspace.t_of_jsonaf (get "workspace_id") |> Id.Workspace.to_string
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
                  Id.Workspace.t_of_jsonaf (get "workspace_id") |> Id.Workspace.to_string
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
          Json.fields params ~allowed:[ "directory" ];
          let directory = Json.text (get "directory") in
          let verified =
            worker (fun () -> Snapshot.verify ~fs ~directory) |> Disk.unwrap
          in
          Json.obj
            [ ( "workspace_id"
              , Id.Workspace.jsonaf_of_t (Snapshot.Verified.workspace verified) )
            ; "revision", Json.int (Snapshot.Verified.revision verified)
            ; ( "head"
              , Option.value_map
                  (Snapshot.Verified.head verified)
                  ~default:`Null
                  ~f:Json.string )
            ; "verified", `True
            ; "canonical_state_validated", `False
            ]
        | "export.get" ->
          Json.fields params ~allowed:[ "job_id" ];
          find_export (Json.text (get "job_id")) |> Export_job.to_json
        | "export.list" ->
          Json.fields params ~allowed:[ "offset"; "limit"; "max_bytes"; "at_snapshot" ];
          let snapshot =
            Json.hash
              (Json.canonical
                 (Json.obj
                    (Map.to_alist !registry_state.exports
                     |> List.map ~f:(fun (id, job) -> id, Export_job.to_json job))))
          in
          let offset =
            Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
          in
          let limit =
            Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
          in
          if limit = 0 || limit > 100
          then Json.fail Invalid_argument "export limit must be 1..100";
          (match Json.optional params "at_snapshot" with
           | None when offset > 0 ->
             Json.fail Invalid_argument "export pagination requires at_snapshot"
           | Some value when not (String.equal (Json.text value) snapshot) ->
             Json.fail Conflict "export listing changed; restart pagination"
           | None | Some _ -> ());
          let jobs = List.drop (Map.data !registry_state.exports) offset in
          Query_budget.fit
            ~max_bytes:(Query_budget.of_params params)
            (Json.obj
               [ "snapshot", Json.string snapshot
               ; ( "data"
                 , Json.obj
                     [ ( "items"
                       , `Array (List.take jobs limit |> List.map ~f:Export_job.to_json) )
                     ; "offset", Json.int offset
                     ; "remaining", Json.int (Int.max 0 (List.length jobs - limit))
                     ; ( "next_offset"
                       , if List.length jobs > limit
                         then Json.int (offset + limit)
                         else `Null )
                     ] )
               ])
        | "workspace.export" | "daemon.export_all" | "export.cancel" | "export.retry" ->
          let allowed =
            match method_ with
            | "workspace.export" -> [ "workspace_id"; "destination" ]
            | "daemon.export_all" -> [ "destination"; "allow_partial" ]
            | _ -> [ "job_id" ]
          in
          Json.fields params ~allowed:([ "actor_id"; "mutation_id" ] @ allowed);
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
               let response = Export_job.to_json job in
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
               let job = find_export (Json.text (get "job_id")) in
               let control =
                 match Map.find !active_exports job.id with
                 | None -> Json.fail Conflict "export is not running"
                 | Some control -> control
               in
               if not (Export_run.Control.cancel control)
               then
                 Json.fail Conflict "export has begun publication and cannot be canceled";
               commit_job { job with cancel_requested = true })
             else (
               if Map.length !active_exports >= 8
               then Json.fail Conflict "export admission limit is 8 active jobs";
               let job, snapshots =
                 if String.equal method_ "export.retry"
                 then (
                   let previous = find_export (Json.text (get "job_id")) in
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
                   let destination = canonical_root (Json.text (get "destination")) in
                   let sources, omitted =
                     match kind with
                     | Single -> [ get_loaded (Json.text (get "workspace_id")) ], []
                     | All ->
                       let omitted =
                         Map.keys !registry_state.registrations
                         |> List.filter ~f:(fun id -> not (Map.mem !loaded id))
                       in
                       let allow_partial =
                         match Json.optional params "allow_partial" with
                         | None | Some `False -> false
                         | Some `True -> true
                         | Some _ ->
                           Json.fail Invalid_argument "allow_partial requires boolean"
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
        | "upload.begin" | "upload.chunk" | "upload.status" | "upload.abort" ->
          let extra =
            match method_ with
            | "upload.begin" -> [ "size_bytes"; "digest" ]
            | "upload.chunk" -> [ "offset"; "data_base64" ]
            | _ -> []
          in
          Json.fields params ~allowed:([ "workspace_id"; "actor_id"; "upload_id" ] @ extra);
          let value = get_loaded (Json.text (get "workspace_id")) in
          let actor = Id.Actor.t_of_jsonaf (get "actor_id") in
          let id = Id.Upload.t_of_jsonaf (get "upload_id") in
          (match method_ with
           | "upload.begin" ->
             let size_bytes = Json.integer (get "size_bytes") in
             let digest = Json.text (get "digest") in
             worker (fun () ->
               Store.begin_upload value.store ~id ~actor ~size_bytes ~digest)
             |> Disk.unwrap
           | "upload.chunk" ->
             let offset = Json.integer (get "offset") in
             let encoded =
               Json.bounded_text
                 (get "data_base64")
                 ~max_bytes:((Upload.max_chunk_bytes + 2) / 3 * 4)
             in
             let bytes =
               match Base64.decode encoded with
               | Ok bytes when String.equal encoded (Base64.encode_string bytes) -> bytes
               | Ok _ | Error _ -> Json.fail Invalid_argument "invalid canonical base64"
             in
             worker (fun () -> Store.upload_chunk value.store ~id ~actor ~offset ~bytes)
             |> Disk.unwrap
           | "upload.status" ->
             worker (fun () -> Store.upload_status value.store ~id ~actor) |> Disk.unwrap
           | _ ->
             worker (fun () -> Store.abort_upload value.store ~id ~actor) |> Disk.unwrap;
             Json.obj [ "aborted", `True ])
        | "resource.read_chunk" ->
          Json.fields
            params
            ~allowed:[ "workspace_id"; "resource_id"; "version"; "offset"; "length" ];
          let value = get_loaded (Json.text (get "workspace_id")) in
          let id = Id.Resource.t_of_jsonaf (get "resource_id") in
          let revision = Option.map (Json.optional params "version") ~f:Json.integer in
          let version = State.resource_version value.state id ~revision |> Disk.unwrap in
          let offset =
            Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
          in
          let length =
            Option.value_map
              (Json.optional params "length")
              ~default:65_536
              ~f:Json.integer
          in
          if length = 0 then Json.fail Invalid_argument "read length must be positive";
          let bytes, total =
            worker (fun () ->
              Store.read_blob_range value.store ~digest:version.digest ~offset ~length)
            |> Disk.unwrap
          in
          Option.iter version.size_bytes ~f:(fun expected ->
            if not (Int.equal total expected)
            then Json.fail Corrupt_store "blob size differs from metadata");
          let next = offset + String.length bytes in
          Json.obj
            [ "resource_id", Id.Resource.jsonaf_of_t id
            ; "version", Json.int version.revision
            ; "digest", Json.string version.digest
            ; "size_bytes", Json.int total
            ; "offset", Json.int offset
            ; "data_base64", Json.string (Base64.encode_string bytes)
            ; "chunk_digest", Json.string (Json.hash bytes)
            ; ("next_offset", if next = total then `Null else Json.int next)
            ; ("eof", if next = total then `True else `False)
            ]
        | "resource.read" ->
          Json.fields params ~allowed:[ "workspace_id"; "digest" ];
          let value = get_loaded (Json.text (get "workspace_id")) in
          let digest = Json.text (get "digest") in
          if not (List.mem (State.blob_digests value.state) digest ~equal:String.equal)
          then Json.fail Not_found "unreferenced blob";
          let text =
            worker (fun () -> Store.read_blob value.store ~digest) |> Disk.unwrap
          in
          Json.obj [ "text", Json.string text ]
        | "search.query" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let resources = State.search_resources value.state ~params |> Disk.unwrap in
          let resource_texts =
            worker (fun () -> Store.extract_search_texts value.store ~resources)
            |> Disk.unwrap
          in
          State.query_with_texts value.state ~resource_texts ~method_ ~params
          |> Disk.unwrap
        | "run.heartbeat" ->
          Json.fields
            params
            ~allowed:[ "workspace_id"; "run_id"; "actor_id"; "mutation_id" ];
          let value = get_loaded (Json.text (get "workspace_id")) in
          let run = Id.Run.t_of_jsonaf (get "run_id") in
          let actor = Id.Actor.t_of_jsonaf (get "actor_id") in
          State.validate_run_actor value.state ~run ~actor |> Disk.unwrap;
          let now_unix_ms =
            Int64.of_float (Eio.Time.now (Eio.Stdenv.clock env) *. 1000.)
          in
          worker (fun () -> Store.heartbeat value.store ~run ~actor ~now_unix_ms)
          |> Disk.unwrap
        | "run.heartbeat_get" ->
          Json.fields params ~allowed:[ "workspace_id"; "run_id" ];
          let value = get_loaded (Json.text (get "workspace_id")) in
          worker (fun () ->
            Store.heartbeat_get value.store ~run:(Id.Run.t_of_jsonaf (get "run_id")))
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
          State.query value.state ~method_ ~params:query_params |> Disk.unwrap
        | "coordinator.overview" ->
          let value = get_loaded (Json.text (get "workspace_id")) in
          let heartbeats =
            worker (fun () -> Store.heartbeat_observations value.store) |> Disk.unwrap
          in
          Coordinator.read
            ~workspace:(State.workspace value.state)
            ~revision:(State.revision value.state)
            ~head:(Store.head value.store)
            ~tickets:(State.coordination_tickets value.state)
            ~runs:(State.agent_runs value.state)
            ~evidence:(State.evidence value.state)
            ~communication:(State.communication value.state)
            ~policies:(State.policies value.state)
            ~heartbeats
            ~now_unix_ms:(Int64.of_float (Eio.Time.now (Eio.Stdenv.clock env) *. 1000.))
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
          else State.query value.state ~method_ ~params |> Disk.unwrap
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
          State.query value.state ~method_ ~params |> Disk.unwrap
        | _ ->
          let id =
            Id.Workspace.t_of_jsonaf (get "workspace_id") |> Id.Workspace.to_string
          in
          let value = get_loaded id in
          let actor = Id.Actor.t_of_jsonaf (get "actor_id") in
          let run = Option.map (Json.optional params "run_id") ~f:Id.Run.t_of_jsonaf in
          let mutation = Id.Actor.t_of_jsonaf (get "mutation_id") |> Id.Actor.to_string in
          let key = Id.Actor.to_string actor ^ ":" ^ mutation in
          let command_params =
            match params with
            | `Object fields ->
              Json.obj
                (List.filter fields ~f:(fun (key, _) ->
                   not
                     (List.mem
                        [ "workspace_id"; "actor_id"; "mutation_id"; "run_id" ]
                        key
                        ~equal:String.equal)))
            | _ -> Json.fail Invalid_argument "params must be object"
          in
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
                 Json.fields
                   command_params
                   ~allowed:
                     [ "upload_id"
                     ; "resource_id"
                     ; "expected_revision"
                     ; "title"
                     ; "filename"
                     ; "mime_type"
                     ];
                 let get key = Json.field command_params key in
                 let upload = Id.Upload.t_of_jsonaf (get "upload_id") in
                 let id = Id.Resource.t_of_jsonaf (get "resource_id") in
                 let expected_revision = Json.integer (get "expected_revision") in
                 let title = Json.text (get "title") in
                 let filename = Json.text (get "filename") in
                 let mime_type = Json.text (get "mime_type") in
                 Resource.validate_metadata
                   { title
                   ; filename
                   ; mime_type
                   ; description = ""
                   ; targets = []
                   ; archived = false
                   };
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
          let current = ref fields in
          let latest = ref None in
          let poll () =
            let query =
              Json.obj
                [ "jsonrpc", Json.string "2.0"
                ; "id", Json.field request "id"
                ; "method", Json.string "changes.read"
                ; "params", Json.obj !current
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
              := ("cursor", Json.field result "cursor")
                 :: List.filter !current ~f:(fun (key, _) ->
                   not (String.equal key "after" || String.equal key "cursor"));
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
          let result =
            if String.equal (Json.text (Json.field request "method")) "changes.wait"
            then
              Eio.Fiber.first
                (fun () -> wait_feed request)
                (fun () ->
                   ignore (Eio.Flow.single_read flow (Cstruct.create 1) : int);
                   Error (Problem.create Invalid_argument "one request per connection"))
            else submit request
          in
          let response =
            match result with
            | Ok result ->
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
          write_response response
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
