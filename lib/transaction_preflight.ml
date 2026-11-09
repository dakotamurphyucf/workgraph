open Core

let run state request ~fresh ~now_unix_ms ~timestamp =
  let open Result.Let_syntax in
  let%bind _ = Api_codec.encode Preflight_api.Request.codec request in
  let revision = State.revision state in
  let%bind () =
    if Option.exists request.at_revision ~f:(fun expected -> expected <> revision)
    then Error (Problem.create Conflict "preflight planning capture changed")
    else Ok ()
  in
  let%bind params = Api_codec.encode Transaction_api.request request.operations in
  let generated = ref [] in
  let%bind params =
    Id_resolution.resolve ~method_:"transaction.apply" ~params ~fresh:(fun kind ->
      let id = fresh kind in
      generated := { Preflight_api.Generated_id.kind; id } :: !generated;
      id)
  in
  let%bind command = Domain_command.decode ~method_:"transaction.apply" ~params in
  let%bind prepared =
    State.prepare
      state
      command
      ~actor:request.actor
      ?run:request.run
      ~now_unix_ms
      ~timestamp
  in
  let blobs = State.blobs prepared in
  let staged_blob_bytes =
    List.sum
      (module Int64)
      blobs
      ~f:(fun (_, bytes) -> Int64.of_int (String.length bytes))
  in
  let response =
    { Preflight_api.Response.workspace_revision = revision
    ; proposed_revision = State.revision (State.candidate prepared)
    ; operation_count = State.expanded_operation_count prepared
    ; generated_ids = List.rev !generated
    ; staged_blob_count = List.length blobs
    ; staged_blob_bytes
    }
  in
  let%map _ = Api_codec.encode Preflight_api.Response.codec response in
  response
;;
