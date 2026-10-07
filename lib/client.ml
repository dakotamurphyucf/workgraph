open Core

type t = { execute : Protocol.Request.t -> (Protocol.response, Problem.t) Result.t }

let create ~net ~clock ~socket ~timeout_seconds =
  Json.decode (fun () ->
    Disk.absolute socket;
    if
      (not (Float.is_finite timeout_seconds))
      || Float.(timeout_seconds <= 0. || timeout_seconds > 3600.)
    then Json.fail Invalid_argument "timeout requires 0..3600 seconds (exclusive zero)";
    let execute request =
      let attempted = ref false in
      let failure message =
        let uncertain =
          !attempted && Protocol.Request.equal_mode (Protocol.Request.mode request) Write
        in
        Error
          (Problem.create
             (if uncertain then Outcome_unknown else Storage_unavailable)
             (if uncertain
              then message ^ "; retry the identical saved request or inspect its receipt"
              else message))
      in
      try
        match
          Disk.protect (fun () ->
            Eio.Time.Timeout.run_exn
              (Eio.Time.Timeout.seconds clock timeout_seconds)
              (fun () ->
                 Eio.Switch.run (fun sw ->
                   let flow = Eio.Net.connect ~sw net (`Unix socket) in
                   attempted := true;
                   Framing.write flow (Protocol.Request.to_json request);
                   let response = Framing.read flow in
                   Protocol.decode_response request response |> Disk.unwrap)))
        with
        | Ok response -> Ok response
        | Error error -> failure error.message
      with
      | Eio.Time.Timeout -> failure "request timed out"
      | End_of_file -> failure "connection ended before response"
    in
    { execute })
;;

let execute t request = t.execute request
let invoke t request = Result.bind (execute t request) ~f:Protocol.result

module Commit = struct
  type t =
    { workspace_revision : int
    ; result : Jsonaf.t
    }
end

let mutate t ?run ~workspace ~actor ~mutation_id command =
  Json.decode (fun () ->
    let method_, params = Wire_command.encode command |> Disk.unwrap in
    let fields =
      match params with
      | `Object fields -> fields
      | _ -> assert false
    in
    let params =
      Json.obj
        ([ "workspace_id", Id.Workspace.jsonaf_of_t workspace
         ; "actor_id", Id.Actor.jsonaf_of_t actor
         ; "mutation_id", Id.Actor.jsonaf_of_t mutation_id
         ]
         @ Option.to_list
             (Option.map run ~f:(fun run -> "run_id", Id.Run.jsonaf_of_t run))
         @ fields)
    in
    let request =
      Protocol.Request.create ~id:"client-mutation" ~method_ ~params |> Disk.unwrap
    in
    let response = invoke t request |> Disk.unwrap in
    match
      Json.decode (fun () ->
        Json.fields response ~allowed:[ "workspace_revision"; "durable"; "result" ];
        (match Json.field response "durable" with
         | `True -> ()
         | _ -> Json.fail Outcome_unknown "mutation response is not durable");
        { Commit.workspace_revision =
            Json.integer (Json.field response "workspace_revision")
        ; result = Json.field response "result"
        })
    with
    | Ok value -> value
    | Error error ->
      Json.fail Outcome_unknown ("invalid mutation acknowledgement: " ^ error.message))
;;

module Administration = struct
  type t =
    | Create of
        { workspace : Id.Workspace.t
        ; name : string
        ; root : string
        }
    | Register of { root : string }
    | Open of Id.Workspace.t
    | Close of Id.Workspace.t
    | Unregister of Id.Workspace.t
    | Export of
        { workspace : Id.Workspace.t
        ; destination : string
        }
    | Export_all of
        { destination : string
        ; allow_partial : bool
        }
    | Cancel_export of { job_id : string }
    | Retry_export of { job_id : string }
    | Restore of
        { directory : string
        ; root : string
        }
    | Restore_all of
        { directory : string
        ; roots : (Id.Workspace.t * string) list
        }
    | Cancel_restore of
        { target_actor : Id.Actor.t
        ; target_mutation : Id.Actor.t
        }
end

let administrate t ~actor ~mutation_id command =
  Json.decode (fun () ->
    let method_, fields =
      match command with
      | Administration.Create { workspace; name; root } ->
        ( "workspace.create"
        , [ "workspace_id", Id.Workspace.jsonaf_of_t workspace
          ; "name", Json.string name
          ; "root", Json.string root
          ] )
      | Register { root } -> "workspace.register", [ "root", Json.string root ]
      | Open id -> "workspace.open", [ "workspace_id", Id.Workspace.jsonaf_of_t id ]
      | Close id -> "workspace.close", [ "workspace_id", Id.Workspace.jsonaf_of_t id ]
      | Unregister id ->
        "workspace.unregister", [ "workspace_id", Id.Workspace.jsonaf_of_t id ]
      | Export { workspace; destination } ->
        ( "workspace.export"
        , [ "workspace_id", Id.Workspace.jsonaf_of_t workspace
          ; "destination", Json.string destination
          ] )
      | Export_all { destination; allow_partial } ->
        ( "daemon.export_all"
        , [ "destination", Json.string destination
          ; ("allow_partial", if allow_partial then `True else `False)
          ] )
      | Cancel_export { job_id } -> "export.cancel", [ "job_id", Json.string job_id ]
      | Retry_export { job_id } -> "export.retry", [ "job_id", Json.string job_id ]
      | Restore { directory; root } ->
        ( "workspace.restore"
        , [ "directory", Json.string directory; "root", Json.string root ] )
      | Restore_all { directory; roots } ->
        ( "daemon.restore_all"
        , [ "directory", Json.string directory
          ; ( "roots"
            , Json.obj
                (List.map roots ~f:(fun (id, root) ->
                   Id.Workspace.to_string id, Json.string root)) )
          ] )
      | Cancel_restore { target_actor; target_mutation } ->
        ( "restore.cancel"
        , [ "target_actor_id", Id.Actor.jsonaf_of_t target_actor
          ; "target_mutation_id", Id.Actor.jsonaf_of_t target_mutation
          ] )
    in
    let params =
      Json.obj
        ([ "actor_id", Id.Actor.jsonaf_of_t actor
         ; "mutation_id", Id.Actor.jsonaf_of_t mutation_id
         ]
         @ fields)
    in
    Protocol.Request.create ~id:"client-admin" ~method_ ~params
    |> Disk.unwrap
    |> invoke t
    |> Disk.unwrap)
;;

module Query_result = struct
  type t =
    { workspace_revision : int
    ; data : Jsonaf.t
    ; budget : Jsonaf.t
    }
end

let query t ~workspace ~parameters selector =
  Json.decode (fun () ->
    let request = Query_request.encode selector ~workspace ~parameters |> Disk.unwrap in
    let response = invoke t request |> Disk.unwrap in
    Json.fields response ~allowed:[ "workspace_revision"; "data"; "budget" ];
    { Query_result.workspace_revision =
        Json.integer (Json.field response "workspace_revision")
    ; data = Json.field response "data"
    ; budget = Json.field response "budget"
    })
;;
