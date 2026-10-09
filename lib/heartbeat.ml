open Core

type observation =
  { actor : Id.Actor.t
  ; observed : int64
  }

type t =
  { fs : Eio.Fs.dir_ty Eio.Path.t
  ; root : string
  ; mutable current : observation Id.Run.Map.t
  ; mutable persisted : observation Id.Run.Map.t
  ; mutable last_flush : int64 option
  }

let path t = Eio.Path.(t.fs / t.root / ".local/heartbeats.json")

let same (a : observation) b =
  Id.Actor.equal a.actor b.actor && Int64.equal a.observed b.observed
;;

let observation_json (o : observation) =
  Json.obj
    [ "actor_id", Id.Actor.jsonaf_of_t o.actor
    ; "observed_unix_ms", Json.string (Int64.to_string o.observed)
    ]
;;

let timestamp json =
  let text = Json.text json in
  match Int64.of_string_opt text with
  | Some value when Int64.(value >= 0L) && String.equal text (Int64.to_string value) ->
    value
  | Some _ | None ->
    Json.fail Invalid_argument "heartbeat time requires nonnegative decimal milliseconds"
;;

let open_existing ~fs ~root =
  Disk.protect (fun () ->
    let file = Eio.Path.(fs / root / ".local/heartbeats.json") in
    let current =
      match Eio.Path.kind ~follow:false file with
      | `Not_found -> Id.Run.Map.empty
      | `Regular_file ->
        let json = Disk.read file |> Json.parse |> Disk.unwrap in
        Current_format.validate Heartbeat_cache json |> Disk.unwrap;
        Json.fields json ~allowed:[ "version"; "observations" ];
        let entries = Json.list (Json.field json "observations") in
        if List.length entries > 1000
        then Json.fail Corrupt_store "heartbeat cache exceeds 1000 runs";
        List.fold entries ~init:Id.Run.Map.empty ~f:(fun map item ->
          Json.fields item ~allowed:[ "run_id"; "observation" ];
          let run = Id.Run.t_of_jsonaf (Json.field item "run_id") in
          let o = Json.field item "observation" in
          Json.fields o ~allowed:[ "actor_id"; "observed_unix_ms" ];
          let data =
            { actor = Id.Actor.t_of_jsonaf (Json.field o "actor_id")
            ; observed = timestamp (Json.field o "observed_unix_ms")
            }
          in
          if Map.mem map run then Json.fail Corrupt_store "duplicate heartbeat run";
          Map.set map ~key:run ~data)
      | _ -> Json.fail Corrupt_store "heartbeat cache must be a regular file"
    in
    let last_flush =
      Map.fold current ~init:None ~f:(fun ~key:_ ~data:o latest ->
        Some (Option.value_map latest ~default:o.observed ~f:(Int64.max o.observed)))
    in
    { fs; root; current; persisted = current; last_flush })
;;

let flush t =
  Disk.protect (fun () ->
    if not (Map.equal same t.current t.persisted)
    then (
      let json =
        Json.obj
          [ "version", Json.int 1
          ; ( "observations"
            , `Array
                (List.map (Map.to_alist t.current) ~f:(fun (run, o) ->
                   Json.obj
                     [ "run_id", Id.Run.jsonaf_of_t run
                     ; "observation", observation_json o
                     ])) )
          ]
      in
      Disk.replace (path t) (Json.canonical json);
      t.persisted <- t.current;
      t.last_flush
      <- Map.fold t.persisted ~init:None ~f:(fun ~key:_ ~data:o latest ->
           Some (Option.value_map latest ~default:o.observed ~f:(Int64.max o.observed)))))
;;

let get t ~run =
  Json.decode (fun () ->
    let current =
      match Map.find t.current run with
      | Some o -> o
      | None -> Json.fail Not_found "run has no heartbeat observation"
    in
    let durable = Map.find t.persisted run in
    Json.obj
      [ "target_run_id", Id.Run.jsonaf_of_t run
      ; "observation", observation_json current
      ; "persisted", Option.value_map durable ~default:`Null ~f:observation_json
      ; ("durable", if Option.exists durable ~f:(same current) then `True else `False)
      ; "advisory", `True
      ])
;;

let observe t ~run ~actor ~now_unix_ms =
  Disk.protect (fun () ->
    if Int64.(now_unix_ms < 0L) then Json.fail Invalid_argument "negative heartbeat time";
    (match Map.find t.current run with
     | Some previous ->
       if not (Id.Actor.equal previous.actor actor)
       then Json.fail Conflict "heartbeat actor differs from registered owner";
       if Int64.(now_unix_ms < previous.observed)
       then Json.fail Conflict "heartbeat clock moved backwards"
     | None ->
       if Map.length t.current >= 1000
       then Json.fail Blocked "heartbeat cache capacity reached");
    t.current <- Map.set t.current ~key:run ~data:{ actor; observed = now_unix_ms };
    if
      Allocation_lease.heartbeat_due
        ~last_unix_ms:t.last_flush
        ~now_unix_ms
        ~interval_ms:10000L
    then flush t |> Disk.unwrap;
    get t ~run |> Disk.unwrap)
;;

let observations t =
  Map.to_alist t.current |> List.map ~f:(fun (run, value) -> run, value.observed)
;;
