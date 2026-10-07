open Core

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let version json =
  if Json.integer (Json.field json "version") <> 1
  then Json.fail Unsupported_version "unsupported portable storage schema"
;;

let digest json =
  let value = Json.text json in
  if
    String.length value <> 64
    || not
         (String.for_all value ~f:(fun c ->
            Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
  then Json.fail Corrupt_store "digest requires 64 lowercase hexadecimal digits";
  value
;;

let optional_digest = function
  | `Null -> None
  | json -> Some (digest json)
;;

let decode_sequence json =
  let value = Json.integer json in
  if value > 100_000 then Json.fail Corrupt_store "storage sequence exceeds 100000";
  value
;;

let predecessor sequence previous =
  if not (Bool.equal (sequence = 0) (Option.is_none previous))
  then Json.fail Corrupt_store "sequence and predecessor disagree"
;;

module Descriptor = struct
  type t =
    { workspace : Id.Workspace.t
    ; name : string
    }

  let workspace t = t.workspace
  let name t = t.name

  let create ~workspace ~name =
    Json.decode (fun () ->
      if String.is_empty (String.strip name) || String.length name > 512
      then Json.fail Invalid_argument "workspace name requires 1..512 bytes";
      { workspace; name })
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "version"; "workspace_id"; "name" ];
      version json;
      create
        ~workspace:(Id.Workspace.t_of_jsonaf (Json.field json "workspace_id"))
        ~name:(Json.text (Json.field json "name"))
      |> unwrap)
  ;;

  let to_json t =
    Json.obj
      [ "version", Json.int 1
      ; "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
      ; "name", Json.string t.name
      ]
  ;;
end

module Head = struct
  type t =
    { sequence : int
    ; digest : string option
    }

  let sequence t = t.sequence
  let digest t = t.digest

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "version"; "sequence"; "digest" ];
      version json;
      let sequence = decode_sequence (Json.field json "sequence") in
      let digest = optional_digest (Json.field json "digest") in
      predecessor sequence digest;
      { sequence; digest })
  ;;

  let to_json t =
    Json.obj
      [ "version", Json.int 1
      ; "sequence", Json.int t.sequence
      ; "digest", Option.value_map t.digest ~default:`Null ~f:Json.string
      ]
  ;;

  let create ~sequence ~digest = of_json (to_json { sequence; digest })
end

module Transaction = struct
  type t =
    { json : Jsonaf.t
    ; workspace : Id.Workspace.t
    ; sequence : int
    ; previous : string option
    ; key : string
    ; request_hash : string
    ; events : Jsonaf.t
    ; response : Jsonaf.t
    }

  let to_json t = t.json
  let workspace t = t.workspace
  let sequence t = t.sequence
  let previous t = t.previous
  let key t = t.key
  let request_hash t = t.request_hash
  let events t = t.events
  let response t = t.response

  let of_json json =
    Json.decode (fun () ->
      Json.fields
        json
        ~allowed:
          [ "version"
          ; "workspace_id"
          ; "sequence"
          ; "previous"
          ; "key"
          ; "request_hash"
          ; "events"
          ; "response"
          ];
      version json;
      let workspace = Id.Workspace.t_of_jsonaf (Json.field json "workspace_id") in
      let sequence = decode_sequence (Json.field json "sequence") in
      if sequence = 0 then Json.fail Corrupt_store "transaction sequence must be positive";
      let previous = optional_digest (Json.field json "previous") in
      predecessor (sequence - 1) previous;
      let key = Json.text (Json.field json "key") in
      let actor =
        match String.split key ~on:':' with
        | [ actor; mutation ] ->
          ignore (Id.Actor.of_string mutation |> unwrap : Id.Actor.t);
          Id.Actor.of_string actor |> unwrap |> Id.Actor.to_string
        | _ -> Json.fail Corrupt_store "receipt key requires actor:mutation"
      in
      let request_hash = digest (Json.field json "request_hash") in
      let events = Storage_event.of_json (Json.field json "events") |> unwrap in
      if
        sequence <> Storage_event.revision events
        || not (String.equal actor (Storage_event.actor events))
      then Json.fail Corrupt_store "receipt identity differs from events";
      let response = Json.field json "response" in
      Json.fields response ~allowed:[ "workspace_revision"; "durable"; "result" ];
      if Json.integer (Json.field response "workspace_revision") <> sequence
      then Json.fail Corrupt_store "receipt revision differs from transaction";
      (match Json.field response "durable" with
       | `True -> ()
       | _ -> Json.fail Corrupt_store "stored receipt must be durable");
      ignore (Json.field response "result" : Jsonaf.t);
      { json
      ; workspace
      ; sequence
      ; previous
      ; key
      ; request_hash
      ; events = Storage_event.to_json events
      ; response
      })
  ;;
end
