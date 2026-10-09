open Core

module Mode = struct
  type t =
    | Read
    | Write
    | Mutation
  [@@deriving sexp, equal]
end

module Tier = struct
  type t =
    | Core
    | Advanced
  [@@deriving sexp, equal]
end

type ('request, 'response) t =
  { name : string
  ; summary : string
  ; mode : Mode.t
  ; request : 'request Api_codec.t
  ; response : 'response Api_codec.t
  ; tier : Tier.t
  }

type ('request, 'response) method_ = ('request, 'response) t

exception Invalid_response of string * Problem.t

let create ~name ~summary ~mode ~request ~response =
  if String.is_empty name || String.length name > 128
  then invalid_arg "invalid method name";
  { name; summary; mode; request; response; tier = Advanced }
;;

let name t = t.name
let mode t = t.mode
let tier t = t.tier
let summary t = t.summary
let with_discovery t ~tier ~summary = { t with tier; summary }
let request_codec t = t.request
let response_codec t = t.response
let with_request t ~request = { t with request }

let describe t =
  Json.obj
    [ "name", Json.string t.name
    ; "summary", Json.string t.summary
    ; ( "tier"
      , Json.string
          (match t.tier with
           | Core -> "core"
           | Advanced -> "advanced") )
    ; ( "mode"
      , Json.string
          (match t.mode with
           | Read -> "read"
           | Write -> "write"
           | Mutation -> "mutation") )
    ; "params", Api_schema.compact (Api_codec.schema t.request)
    ; "result", Api_schema.compact (Api_codec.schema (Api_response.codec t.response))
    ]
;;

let encode_response t response =
  match Api_codec.encode t.response response with
  | Ok json -> json
  | Error problem -> raise (Invalid_response (t.name, problem))
;;

let invoke t ~params ~f =
  let open Result.Let_syntax in
  let%bind request = Api_codec.decode t.request params in
  let%map response = f request in
  encode_response t response
;;

module Packed = struct
  type t = Pack : ('request, 'response) method_ -> t
end
