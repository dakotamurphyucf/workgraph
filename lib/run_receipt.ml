open Core

type t =
  { run : Id.Run.t
  ; revision : int
  ; status : Agent_run_event.Status.t
  ; actor : Id.Actor.t
  ; last_observed_unix_ms : int64 option
  ; sessions : Session_id.t list
  }

let run t = t.run
let revision t = t.revision
let status t = t.status
let actor t = t.actor
let last_observed_unix_ms t = t.last_observed_unix_ms
let sessions t = t.sessions

let codec =
  let open Api_codec in
  let open Fields in
  let session = Coordination_wire.id Session_id.of_string Session_id.to_string in
  both
    (both
       (both
          (required "run_id" Coordination_wire.run)
          (required "revision" Coordination_wire.positive))
       (both
          (required "status" Agent_run_wire.status)
          (required "actor_id" Coordination_wire.actor)))
    (both
       (required "last_observed_unix_ms" (nullable (decimal64 ~max:Int64.max_value)))
       (required "session_ids" (list session ~max_items:100)))
  |> map
       ~decode:
         (fun
           (((run, revision), (status, actor)), (last_observed_unix_ms, sessions)) ->
         { run; revision; status; actor; last_observed_unix_ms; sessions })
       ~encode:(fun { run; revision; status; actor; last_observed_unix_ms; sessions } ->
         ((run, revision), (status, actor)), (last_observed_unix_ms, sessions))
  |> object_
  |> fun codec ->
  Coordination_wire.checked codec (fun t ->
    if List.contains_dup t.sessions ~compare:Session_id.compare
    then Json.fail Invalid_argument "run receipt has duplicate session links")
;;

let of_record (record : Agent_run_event.Record.t) =
  Json.decode (fun () ->
    Agent_run_event.Record.validate record;
    let t =
      { run = record.id
      ; revision = record.revision
      ; status = record.status
      ; actor = record.actor
      ; last_observed_unix_ms = record.last_observed_unix_ms
      ; sessions = record.sessions
      }
    in
    Api_codec.encode codec t
    |> Result.iter_error ~f:(fun problem -> raise (Json.Decode_error problem));
    t)
;;

let to_json t = Coordination_wire.encode_exn codec t
