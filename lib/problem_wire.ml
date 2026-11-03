open Core

let allocation_reason =
  let open Allocation_admission_reason in
  let module F = Api_codec.Fields in
  let ( ++ ) = F.both in
  let identity =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:(fun text -> Result.map (Id.Actor.of_string text) ~f:Id.Actor.to_string)
      ~encode:Fn.id
      ~description:"Stable actor or run identifier."
  in
  let name = Api_codec.text ~max_bytes:96 in
  let counter = Api_codec.decimal ~max:Int.max_value in
  let counts =
    F.required "used" counter
    ++ F.required "limit" counter
    ++ F.required "attempted" counter
  in
  let branch tag fields ~decode ~encode =
    Api_codec.map
      (Api_codec.object_ (F.required "kind" (Api_codec.literal tag) ++ fields))
      ~decode:(fun ((), fields) -> decode fields)
      ~encode:(fun value -> (), encode value)
      ~description:("Allocation " ^ tag ^ " reason.")
  in
  let counts_valid used limit attempted =
    limit > 0
    && used >= limit
    && attempted = if used = Int.max_value then used else used + 1
  in
  let run_required =
    branch
      "run_required"
      F.empty
      ~decode:(fun () -> Ok Run_required)
      ~encode:(function
        | Run_required -> ()
        | _ -> invalid_arg "run required expected")
  in
  let unregistered =
    branch
      "unregistered_run"
      (F.required "run_id" identity)
      ~decode:(fun run_id -> Ok (Unregistered_run { run_id }))
      ~encode:(function
        | Unregistered_run { run_id } -> run_id
        | _ -> invalid_arg "unregistered run expected")
  in
  let mismatch =
    branch
      "run_actor_mismatch"
      (F.required "run_id" identity
       ++ F.required "expected_actor" identity
       ++ F.required "actual_actor" identity)
      ~decode:(fun ((run_id, expected_actor), actual_actor) ->
        if String.equal expected_actor actual_actor
        then
          Error
            (Problem.create Invalid_argument "actor mismatch requires distinct actors")
        else Ok (Run_actor_mismatch { run_id; expected_actor; actual_actor }))
      ~encode:(function
        | Run_actor_mismatch { run_id; expected_actor; actual_actor } ->
          (run_id, expected_actor), actual_actor
        | _ -> invalid_arg "actor mismatch expected")
  in
  let terminal =
    branch
      "terminal_run"
      (F.required "run_id" identity)
      ~decode:(fun run_id -> Ok (Terminal_run { run_id }))
      ~encode:(function
        | Terminal_run { run_id } -> run_id
        | _ -> invalid_arg "terminal run expected")
  in
  let missing =
    branch
      "missing_capability"
      (F.required "run_id" identity ++ F.required "capability" name)
      ~decode:(fun (run_id, capability) ->
        if String.is_empty (String.strip capability)
        then Error (Problem.create Invalid_argument "empty capability")
        else Ok (Missing_capability { run_id; capability }))
      ~encode:(function
        | Missing_capability { run_id; capability } -> run_id, capability
        | _ -> invalid_arg "missing capability expected")
  in
  let pool =
    branch
      "pool_full"
      (F.required "pool" name
       ++ F.required "unit" (Api_codec.literal "allocated_tickets")
       ++ counts)
      ~decode:(fun ((pool, ()), ((used, limit), attempted)) ->
        if String.is_empty (String.strip pool) || not (counts_valid used limit attempted)
        then Error (Problem.create Invalid_argument "invalid pool exhaustion counts")
        else Ok (Pool_full { pool; used; limit; attempted }))
      ~encode:(function
        | Pool_full { pool; used; limit; attempted } ->
          (pool, ()), ((used, limit), attempted)
        | _ -> invalid_arg "pool full expected")
  in
  let budget =
    branch
      "budget_exhausted"
      (F.required
         "unit"
         (Api_codec.enum
            [ "total_attempts", Total_attempts; "active_attempts", Active_attempts ]
            ~equal:equal_budget)
       ++ counts)
      ~decode:(fun (budget, ((used, limit), attempted)) ->
        if not (counts_valid used limit attempted)
        then
          Error
            (Problem.create Invalid_argument "invalid attempt budget exhaustion counts")
        else Ok (Budget_exhausted { budget; used; limit; attempted }))
      ~encode:(function
        | Budget_exhausted { budget; used; limit; attempted } ->
          budget, ((used, limit), attempted)
        | _ -> invalid_arg "budget exhaustion expected")
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ "run_required", run_required
      ; "unregistered_run", unregistered
      ; "run_actor_mismatch", mismatch
      ; "terminal_run", terminal
      ; "missing_capability", missing
      ; "pool_full", pool
      ; "budget_exhausted", budget
      ]
    ~select:(function
      | Run_required -> "run_required"
      | Unregistered_run _ -> "unregistered_run"
      | Run_actor_mismatch _ -> "run_actor_mismatch"
      | Terminal_run _ -> "terminal_run"
      | Missing_capability _ -> "missing_capability"
      | Pool_full _ -> "pool_full"
      | Budget_exhausted _ -> "budget_exhausted")
;;

let reservation_conflict =
  let module F = Api_codec.Fields in
  let ( ++ ) = F.both in
  let identity =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:(fun text -> Result.map (Id.Run.of_string text) ~f:Id.Run.to_string)
      ~encode:Fn.id
      ~description:"Stable owner identity."
  in
  let target =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "named"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "named")
                  ++ F.required "reservation_id" identity)
                 ~decode:(fun ((), name) -> Reservation_conflict.Target.Named name)
                 ~encode:(function
                   | Named name -> (), name
                   | Path _ -> Json.fail Invalid_argument "Expected named conflict")) )
        ; ( "path"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "path")
                  ++ F.required "target" Path_scope.codec)
                 ~decode:(fun ((), path) ->
                   Reservation_conflict.Target.Path
                     { worktree_id =
                         Path_scope.Worktree_id.to_string (Path_scope.worktree_id path)
                     ; kind =
                         (match Path_scope.kind path with
                          | File -> Reservation_conflict.Path_kind.File
                          | Subtree -> Subtree)
                     ; path = Path_scope.path path
                     })
                 ~encode:(function
                   | Path { worktree_id; kind; path } ->
                     let worktree_id =
                       match Path_scope.Worktree_id.of_string worktree_id with
                       | Ok x -> x
                       | Error e -> raise (Json.Decode_error e)
                     in
                     let kind =
                       match kind with
                       | Reservation_conflict.Path_kind.File -> Path_scope.Kind.File
                       | Subtree -> Subtree
                     in
                     ( ()
                     , (match Path_scope.create ~worktree_id ~kind ~path with
                        | Ok x -> x
                        | Error e -> raise (Json.Decode_error e)) )
                   | Named _ -> Json.fail Invalid_argument "Expected path conflict")) )
        ]
      ~select:(function
        | Named _ -> "named"
        | Path _ -> "path")
  in
  let mode =
    Api_codec.enum
      [ "exclusive", Reservation_conflict.Mode.Exclusive; "shared", Shared ]
      ~equal:Reservation_conflict.Mode.equal
  in
  let owner =
    Api_codec.object_
      (F.map
         (F.required "target" target
          ++ F.required "actor_id" identity
          ++ F.required "run_id" identity
          ++ F.required "mode" mode)
         ~decode:(fun (((target, actor_id), run_id), mode) ->
           { Reservation_conflict.Owner.target; actor_id; run_id; mode })
         ~encode:(fun (o : Reservation_conflict.Owner.t) ->
           ((o.target, o.actor_id), o.run_id), o.mode))
  in
  Api_codec.map
    (Api_codec.object_
       (F.map
          (F.required "type" (Api_codec.literal "reservation_conflict")
           ++ F.required "requested" target
           ++ F.required "owners" (Api_codec.list owner ~max_items:16)
           ++ F.required "omitted_owners" (Api_codec.decimal ~max:Int.max_value))
          ~decode:(fun ((((), requested), owners), omitted_owners) ->
            { Reservation_conflict.requested; owners; omitted_owners })
          ~encode:(fun c ->
            (((), c.Reservation_conflict.requested), c.owners), c.omitted_owners)))
    ~decode:(fun c ->
      if List.is_empty c.owners || c.omitted_owners > Int.max_value - List.length c.owners
      then Error (Problem.create Invalid_argument "Invalid reservation conflict counts")
      else Ok (Problem.Details.Reservation_conflict c))
    ~encode:(function
      | Reservation_conflict c -> c
      | _ -> Json.fail Invalid_argument "Expected reservation conflict")
    ~description:
      "Bounded conflicting owner metadata with exact omissions; fencing tokens excluded."
;;

let details =
  let module F = Api_codec.Fields in
  let ( ++ ) = F.both in
  let text = Api_codec.text ~max_bytes:65536 in
  let identity =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:(fun s -> Result.map (Id.Actor.of_string s) ~f:Id.Actor.to_string)
      ~encode:Fn.id
      ~description:"1..96 ASCII letters, digits, underscores or hyphens."
  in
  let counter = Api_codec.decimal ~max:Int.max_value in
  let branch tag fields ~decode ~encode =
    Api_codec.map
      (Api_codec.object_ (F.required "type" (Api_codec.literal tag) ++ fields))
      ~decode:(fun ((), fields) -> Ok (decode fields))
      ~encode:(fun value -> (), encode value)
      ~description:("Public " ^ tag ^ " diagnostic.")
  in
  let field =
    branch
      "field"
      (F.required
         "path"
         (Api_codec.list (Api_codec.text ~max_bytes:4194304) ~max_items:64)
       ++ F.required "expected" text
       ++ F.required "suggestion" (Api_codec.nullable (Api_codec.text ~max_bytes:256)))
      ~decode:(fun ((path, expected), suggestion) ->
        Problem.Details.Field { path; expected; suggestion })
      ~encode:(function
        | Problem.Details.Field { path; expected; suggestion } ->
          (path, expected), suggestion
        | _ -> invalid_arg "field diagnostic expected")
  in
  let revision =
    branch
      "revision"
      (F.required "expected" counter ++ F.required "actual" counter)
      ~decode:(fun (expected, actual) -> Problem.Details.Revision { expected; actual })
      ~encode:(function
        | Problem.Details.Revision { expected; actual } -> expected, actual
        | _ -> invalid_arg "revision diagnostic expected")
  in
  let ownership =
    branch
      "ownership"
      (F.required "actor_id" identity ++ F.required "run_id" (Api_codec.nullable identity))
      ~decode:(fun (actor_id, run_id) -> Problem.Details.Ownership { actor_id; run_id })
      ~encode:(function
        | Problem.Details.Ownership { actor_id; run_id } -> actor_id, run_id
        | _ -> invalid_arg "ownership diagnostic expected")
  in
  let claim =
    let open Problem.Details.Claim in
    let unclaimed =
      branch
        "claim"
        (F.required "ticket_id" identity
         ++ F.required "status" (Api_codec.literal "unclaimed"))
        ~decode:(fun (ticket_id, ()) ->
          Problem.Details.Claim { ticket_id; ownership = Unclaimed })
        ~encode:(function
          | Problem.Details.Claim { ticket_id; ownership = Unclaimed } -> ticket_id, ()
          | _ -> invalid_arg "unclaimed diagnostic expected")
    in
    let mismatch =
      branch
        "claim"
        (F.required "ticket_id" identity
         ++ F.required "status" (Api_codec.literal "mismatch")
         ++ F.required
              "field"
              (Api_codec.enum
                 [ "actor", Field.Actor; "run", Run; "token", Token ]
                 ~equal:Field.equal)
         ++ F.required "actor_id" identity
         ++ F.required "run_id" (Api_codec.nullable identity))
        ~decode:(fun ((((ticket_id, ()), field), actor_id), run_id) ->
          Problem.Details.Claim
            { ticket_id; ownership = Mismatch { field; actor_id; run_id } })
        ~encode:(function
          | Problem.Details.Claim
              { ticket_id; ownership = Mismatch { field; actor_id; run_id } } ->
            (((ticket_id, ()), field), actor_id), run_id
          | _ -> invalid_arg "claim mismatch diagnostic expected")
    in
    Api_codec.tagged
      ~discriminator:"status"
      ~cases:[ "unclaimed", unclaimed; "mismatch", mismatch ]
      ~select:(function
        | Problem.Details.Claim { ownership = Unclaimed; _ } -> "unclaimed"
        | Problem.Details.Claim { ownership = Mismatch _; _ } -> "mismatch"
        | _ -> invalid_arg "claim diagnostic expected")
  in
  let entity =
    let open Problem.Details.Communication_entity in
    Api_codec.enum
      (List.map [ Board; Thread; Team; Request; Message; Subscription ] ~f:(fun e ->
         to_string e, e))
      ~equal
  in
  let entity_revision =
    branch
      "entity_revision"
      (F.required "entity" entity
       ++ F.required "entity_id" identity
       ++ F.required "expected" counter
       ++ F.required "actual" counter)
      ~decode:(fun (((entity, entity_id), expected), actual) ->
        if Int.equal expected actual
        then
          Json.fail
            Invalid_argument
            "entity revision conflict requires different revisions";
        Problem.Details.Entity_revision { entity; entity_id; expected; actual })
      ~encode:(function
        | Problem.Details.Entity_revision { entity; entity_id; expected; actual } ->
          ((entity, entity_id), expected), actual
        | _ -> invalid_arg "entity revision diagnostic expected")
  in
  let identity_collision =
    branch
      "identity_collision"
      (F.required "entity" entity ++ F.required "entity_id" identity)
      ~decode:(fun (entity, entity_id) ->
        Problem.Details.Identity_collision { entity; entity_id })
      ~encode:(function
        | Problem.Details.Identity_collision { entity; entity_id } -> entity, entity_id
        | _ -> invalid_arg "identity collision diagnostic expected")
  in
  let size =
    let open Problem.Details.Size_unit in
    Api_codec.map
      (Api_codec.object_
         (F.required "type" (Api_codec.literal "size")
          ++ F.required
               "path"
               (Api_codec.list (Api_codec.text ~max_bytes:4194304) ~max_items:64)
          ++ F.required "actual" counter
          ++ F.required "maximum" counter
          ++ F.required
               "unit"
               (Api_codec.enum
                  [ "utf8_bytes", Utf8_bytes
                  ; "canonical_json_bytes", Canonical_json_bytes
                  ]
                  ~equal)))
      ~decode:(fun (((((), path), actual), maximum), unit) ->
        if actual <= maximum
        then
          Error
            (Problem.create
               Invalid_argument
               "size diagnostic requires actual above maximum")
        else Ok (Problem.Details.Size { path; actual; maximum; unit }))
      ~encode:(function
        | Problem.Details.Size { path; actual; maximum; unit } ->
          ((((), path), actual), maximum), unit
        | _ -> invalid_arg "size diagnostic expected")
      ~description:"Exact rejected byte size and maximum, preserving nested field paths."
  in
  let readiness =
    Api_codec.map
      (Api_codec.object_
         (F.required "type" (Api_codec.literal "readiness")
          ++ F.required "ticket_id" identity
          ++ F.required "blockers" (Api_codec.list text ~max_items:100)
          ++ F.required "omitted_blockers" counter))
      ~decode:(fun ((((), ticket_id), blockers), omitted_blockers) ->
        if
          List.is_empty blockers
          || omitted_blockers > Int.max_value - List.length blockers
        then Error (Problem.create Invalid_argument "invalid readiness diagnostic counts")
        else Ok (Problem.Details.Readiness { ticket_id; blockers; omitted_blockers }))
      ~encode:(function
        | Problem.Details.Readiness { ticket_id; blockers; omitted_blockers } ->
          (((), ticket_id), blockers), omitted_blockers
        | _ -> invalid_arg "readiness diagnostic expected")
      ~description:"Exact blocker total is listed count plus omitted_blockers."
  in
  let socket_owner =
    branch
      "socket_owner"
      (F.required "socket_path" text)
      ~decode:(fun socket_path -> Problem.Details.Socket_owner { socket_path })
      ~encode:(function
        | Problem.Details.Socket_owner { socket_path } -> socket_path
        | _ -> invalid_arg "socket owner diagnostic expected")
  in
  let allocation =
    Api_codec.map
      (Api_codec.object_
         (F.required "type" (Api_codec.literal "allocation")
          ++ F.required "ticket_id" identity
          ++ F.required "reasons" (Api_codec.list allocation_reason ~max_items:16)
          ++ F.required "omitted_reasons" counter))
      ~decode:(fun ((((), ticket_id), reasons), omitted_reasons) ->
        if List.is_empty reasons || omitted_reasons > Int.max_value - List.length reasons
        then
          Error (Problem.create Invalid_argument "invalid allocation diagnostic counts")
        else Ok (Problem.Details.Allocation { ticket_id; reasons; omitted_reasons }))
      ~encode:(function
        | Problem.Details.Allocation { ticket_id; reasons; omitted_reasons } ->
          (((), ticket_id), reasons), omitted_reasons
        | _ -> invalid_arg "allocation diagnostic expected")
      ~description:"Bounded exact admission reasons; total count is listed plus omitted."
  in
  let version =
    branch
      "version"
      (F.required "representation" text
       ++ F.required "observed" (Api_codec.nullable text)
       ++ F.required "supported" text)
      ~decode:(fun ((representation, observed), supported) ->
        Problem.Details.Version { representation; observed; supported })
      ~encode:(function
        | Problem.Details.Version { representation; observed; supported } ->
          (representation, observed), supported
        | _ -> invalid_arg "version diagnostic expected")
  in
  let capacity =
    branch
      "capacity"
      (F.required "meter" (Api_codec.text ~max_bytes:256)
       ++ F.required "used" counter
       ++ F.required "limit" counter
       ++ F.required "attempted" counter
       ++ F.required "unit" (Api_codec.text ~max_bytes:128)
       ++ F.required "operator_action" (Api_codec.text ~max_bytes:4096))
      ~decode:(fun (((((meter, used), limit), attempted), unit), operator_action) ->
        Problem.Details.Capacity { meter; used; limit; attempted; unit; operator_action })
      ~encode:(function
        | Problem.Details.Capacity
            { meter; used; limit; attempted; unit; operator_action } ->
          ((((meter, used), limit), attempted), unit), operator_action
        | _ -> invalid_arg "capacity diagnostic expected")
  in
  Api_codec.tagged
    ~discriminator:"type"
    ~cases:
      [ "field", field
      ; "revision", revision
      ; "ownership", ownership
      ; "claim", claim
      ; "entity_revision", entity_revision
      ; "identity_collision", identity_collision
      ; "size", size
      ; "socket_owner", socket_owner
      ; "allocation", allocation
      ; "reservation_conflict", reservation_conflict
      ; "readiness", readiness
      ; "version", version
      ; "capacity", capacity
      ]
    ~select:(function
      | Problem.Details.Field _ -> "field"
      | Revision _ -> "revision"
      | Ownership _ -> "ownership"
      | Claim _ -> "claim"
      | Entity_revision _ -> "entity_revision"
      | Identity_collision _ -> "identity_collision"
      | Size _ -> "size"
      | Socket_owner _ -> "socket_owner"
      | Allocation _ -> "allocation"
      | Reservation_conflict _ -> "reservation_conflict"
      | Readiness _ -> "readiness"
      | Version _ -> "version"
      | Capacity _ -> "capacity")
;;

let kinds =
  [ Problem.Invalid_argument
  ; Not_found
  ; Conflict
  ; Blocked
  ; Dependency_cycle
  ; Already_claimed
  ; Stale_claim
  ; Idempotency_conflict
  ; Corrupt_store
  ; Storage_unavailable
  ; Local_io
  ; Outcome_unknown
  ; Workspace_closed
  ; Unsupported_version
  ]
;;

let codec =
  let module F = Api_codec.Fields in
  let ( ++ ) = F.both in
  let cases =
    List.map kinds ~f:(fun kind ->
      let name = Problem.wire_name kind in
      ( name
      , Api_codec.map
          (Api_codec.object_
             (F.required "kind" (Api_codec.literal name)
              ++ F.required "message" (Api_codec.text ~max_bytes:4194304)
              ++ F.optional "details" details))
          ~decode:(fun (((), message), details) -> Ok { Problem.kind; message; details })
          ~encode:(fun { Problem.kind = actual; message; details } ->
            if not (Problem.equal_kind actual kind)
            then invalid_arg "problem kind differs";
            ((), message), details)
          ~description:"Public error with optional typed diagnostic details." ))
  in
  Api_codec.tagged ~discriminator:"kind" ~cases ~select:(fun p ->
    Problem.wire_name p.Problem.kind)
;;

let of_json json =
  Result.bind
    (Json.decode (fun () ->
       let name = Json.text (Json.field json "kind") in
       if
         not
           (List.exists kinds ~f:(fun kind -> String.equal name (Problem.wire_name kind)))
       then Json.fail Unsupported_version "unknown application error discriminator"))
    ~f:(fun () -> Api_codec.decode codec json)
;;
