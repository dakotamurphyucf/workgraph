open Core

let validate_server_request json =
  Json.decode (fun () ->
    (match Current_format.validate Application_api json with
     | Ok () -> ()
     | Error p -> raise (Json.Decode_error p));
    Json.fields json ~allowed:[ "jsonrpc"; "workgraph_api"; "id"; "method"; "params" ];
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
      ; "workgraph_api", Current_format.value Application_api
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
      (match Current_format.validate Application_api json with
       | Ok () -> ()
       | Error p -> raise (Json.Decode_error p));
      Json.fields json ~allowed:[ "jsonrpc"; "workgraph_api"; "id"; "method"; "params" ];
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
    match Api_catalog.find t.method_ with
    | Some (Api_method.Packed.Pack method_) ->
      (match Api_method.mode method_ with
       | Read -> Read
       | Write | Mutation -> Write)
    | None -> Write
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
    | Some result, None ->
      if String.equal request.Request.method_ "initialize"
      then (
        match Current_format.validate Application_api (Json.field result "data") with
        | Ok () -> ()
        | Error problem -> raise (Json.Decode_error problem));
      (match Api_response.of_json result with
       | Ok _ -> Success result
       | Error problem -> raise (Json.Decode_error problem))
    | None, Some error ->
      Json.fields error ~allowed:[ "code"; "message"; "data" ];
      let invalid_envelope =
        match Json.field error "code" with
        | `Number "-32000" -> false
        | `Number "-32600" -> true
        | _ -> Json.fail Unsupported_version "unsupported application error code"
      in
      let data = Json.field error "data" in
      let problem =
        match Problem_wire.of_json data with
        | Ok problem -> problem
        | Error error -> raise (Json.Decode_error error)
      in
      let kind = problem.Problem.kind in
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
      Failure problem
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
