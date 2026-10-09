open Core

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
  let readiness =
    branch
      "readiness"
      (F.required "ticket_id" identity
       ++ F.required "blockers" (Api_codec.list text ~max_items:100))
      ~decode:(fun (ticket_id, blockers) ->
        Problem.Details.Readiness { ticket_id; blockers })
      ~encode:(function
        | Problem.Details.Readiness { ticket_id; blockers } -> ticket_id, blockers
        | _ -> invalid_arg "readiness diagnostic expected")
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
      ; "readiness", readiness
      ; "version", version
      ; "capacity", capacity
      ]
    ~select:(function
      | Problem.Details.Field _ -> "field"
      | Revision _ -> "revision"
      | Ownership _ -> "ownership"
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
