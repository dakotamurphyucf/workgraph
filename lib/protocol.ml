open Core

let validate_server_request json =
  Json.decode (fun () ->
    Json.fields json ~allowed:[ "jsonrpc"; "id"; "method"; "params" ];
    if not (String.equal (Json.text (Json.field json "jsonrpc")) "2.0")
    then Json.fail Unsupported_version "JSON-RPC 2.0 required";
    (match Json.field json "id" with
     | `String id when String.length id > 0 && String.length id <= 256 -> ()
     | `Number _ | `Null -> ()
     | _ -> Json.fail Invalid_argument "invalid request ID");
    let method_ = Json.text (Json.field json "method") in
    if String.is_empty method_ || String.length method_ > 128
    then Json.fail Invalid_argument "method requires 1..128 bytes";
    match Json.optional json "params" with
    | None | Some (`Object _) -> ()
    | Some _ -> Json.fail Invalid_argument "params must be an object")
;;

module Request = struct
  type mode =
    | Read
    | Write
  [@@deriving equal, sexp]

  type t =
    { id : string
    ; method_ : string
    ; params : Jsonaf.t
    }

  let to_json t =
    Json.obj
      [ "jsonrpc", Json.string "2.0"
      ; "id", Json.string t.id
      ; "method", Json.string t.method_
      ; "params", t.params
      ]
  ;;

  let create ~id ~method_ ~params =
    Json.decode (fun () ->
      if String.is_empty id || String.length id > 256
      then Json.fail Invalid_argument "request ID requires 1..256 bytes";
      if String.is_empty method_ || String.length method_ > 128
      then Json.fail Invalid_argument "method requires 1..128 bytes";
      (match params with
       | `Object _ -> ()
       | _ -> Json.fail Invalid_argument "params must be an object");
      let t = { id; method_; params } in
      if String.length (Json.canonical (to_json t)) > 4 * 1024 * 1024
      then Json.fail Invalid_argument "request exceeds frame limit";
      t)
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "jsonrpc"; "id"; "method"; "params" ];
      if not (String.equal (Json.text (Json.field json "jsonrpc")) "2.0")
      then Json.fail Unsupported_version "JSON-RPC 2.0 required";
      match
        create
          ~id:(Json.text (Json.field json "id"))
          ~method_:(Json.text (Json.field json "method"))
          ~params:(Json.field json "params")
      with
      | Ok t -> t
      | Error e -> raise (Json.Decode_error e))
  ;;

  let method_ t = t.method_
  let params t = t.params
  let with_params t params = create ~id:t.id ~method_:t.method_ ~params

  let mode t =
    match t.method_ with
    | "initialize"
    | "export.verify"
    | "export.get"
    | "export.list"
    | "daemon.health"
    | "workspace.list"
    | "workspace.get"
    | "workspace.overview"
    | "coordinator.overview"
    | "registry.receipt"
    | "workspace.receipt"
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
    | "changes.read"
    | "changes.wait"
    | "search.query"
    | "resource.list"
    | "resource.get"
    | "resource.history"
    | "resource.read"
    | "resource.read_chunk"
    | "upload.status"
    | "run.heartbeat_get" -> Read
    | method_
      when List.mem
             (Communication.query_methods
              @ Agent_run.query_methods
              @ Evidence.query_methods
              @ History_command.query_methods
              @ Agent_run_policy.query_methods)
             method_
             ~equal:String.equal -> Read
    | _ -> Write
  ;;
end

type response =
  | Success of Jsonaf.t
  | Failure of Problem.t

let decode_response request json =
  Json.decode (fun () ->
    Json.fields json ~allowed:[ "jsonrpc"; "id"; "result"; "error" ];
    if not (String.equal (Json.text (Json.field json "jsonrpc")) "2.0")
    then Json.fail Unsupported_version "response protocol version differs";
    if not (String.equal (Json.text (Json.field json "id")) request.Request.id)
    then Json.fail Invalid_argument "response request ID differs";
    match Json.optional json "result", Json.optional json "error" with
    | Some result, None -> Success result
    | None, Some error ->
      Json.fields error ~allowed:[ "code"; "message"; "data" ];
      let invalid_envelope =
        match Json.field error "code" with
        | `Number "-32000" -> false
        | `Number "-32600" -> true
        | _ -> Json.fail Unsupported_version "unsupported v1 error code"
      in
      let data = Json.field error "data" in
      Json.fields data ~allowed:[ "kind"; "message" ];
      let kind =
        match Json.text (Json.field data "kind") with
        | "Invalid_argument" -> Problem.Invalid_argument
        | "Not_found" -> Not_found
        | "Conflict" -> Conflict
        | "Blocked" -> Blocked
        | "Dependency_cycle" -> Dependency_cycle
        | "Already_claimed" -> Already_claimed
        | "Stale_claim" -> Stale_claim
        | "Idempotency_conflict" -> Idempotency_conflict
        | "Corrupt_store" -> Corrupt_store
        | "Storage_unavailable" -> Storage_unavailable
        | "Outcome_unknown" -> Outcome_unknown
        | "Workspace_closed" -> Workspace_closed
        | "Unsupported_version" -> Unsupported_version
        | _ -> Json.fail Unsupported_version "unknown application error discriminator"
      in
      if
        invalid_envelope
        && not
             (List.mem
                [ Problem.Invalid_argument; Unsupported_version ]
                kind
                ~equal:Problem.equal_kind)
      then Json.fail Invalid_argument "error code and kind disagree";
      let message = Json.text (Json.field data "message") in
      if not (String.equal message (Json.text (Json.field error "message")))
      then Json.fail Invalid_argument "error messages differ";
      Failure (Problem.create kind message)
    | Some _, Some _ | None, None ->
      Json.fail Invalid_argument "response requires exactly one result or error")
;;

let response_json request response =
  Json.obj
    ([ "jsonrpc", Json.string "2.0"; "id", Json.string request.Request.id ]
     @ [ (match response with
          | Success value -> "result", value
          | Failure error ->
            ( "error"
            , Json.obj
                [ "code", `Number "-32000"
                ; "message", Json.string error.message
                ; "data", Problem.to_json error
                ] ))
       ])
;;

let result = function
  | Success value -> Ok value
  | Failure error -> Error error
;;
