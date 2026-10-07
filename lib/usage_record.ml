open Core

module Key = struct
  module T = struct
    type t = string [@@deriving sexp_of, compare, equal]

    let of_string s = Result.map (Id.Run.of_string s) ~f:Id.Run.to_string

    let t_of_sexp sexp =
      match of_string (String.t_of_sexp sexp) with
      | Ok s -> s
      | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
    ;;
  end

  include T
  include Comparable.Make (T)

  let to_string t = t
  let jsonaf_of_t = Json.string

  let t_of_jsonaf j =
    match of_string (Json.text j) with
    | Ok t -> t
    | Error e -> raise (Json.Decode_error e)
  ;;
end

module Scope = struct
  type t =
    | Run of Id.Run.t
    | Attempt of Attempt.Id.t
  [@@deriving sexp, equal]
end

type t =
  { id : Key.t
  ; scope : Scope.t
  ; actor : Id.Actor.t
  ; tokens : int64
  ; elapsed_ms : int64
  ; provenance : string
  ; timestamp : string
  }
[@@deriving sexp, equal]

let validate t =
  Json.decode (fun () ->
    if Int64.(t.tokens < zero || t.elapsed_ms < zero)
    then Json.fail Invalid_argument "Reported usage is negative";
    if
      String.is_empty (String.strip t.provenance)
      || String.length t.provenance > 4096
      || String.is_empty t.timestamp
      || String.length t.timestamp > 128
    then Json.fail Invalid_argument "Invalid usage provenance or timestamp")
;;

let to_json t =
  Json.obj
    [ "id", Key.jsonaf_of_t t.id
    ; ( "scope"
      , match t.scope with
        | Scope.Run id -> Json.obj [ "run", Id.Run.jsonaf_of_t id ]
        | Attempt id -> Json.obj [ "attempt", Attempt.Id.jsonaf_of_t id ] )
    ; "actor", Id.Actor.jsonaf_of_t t.actor
    ; "tokens", Json.int64 t.tokens
    ; "elapsed_ms", Json.int64 t.elapsed_ms
    ; "provenance", Json.string t.provenance
    ; "timestamp", Json.string t.timestamp
    ]
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields
      json
      ~allowed:
        [ "id"; "scope"; "actor"; "tokens"; "elapsed_ms"; "provenance"; "timestamp" ];
    let get = Json.field json in
    let scope =
      let j = get "scope" in
      match Json.optional j "run", Json.optional j "attempt" with
      | Some id, None ->
        Json.fields j ~allowed:[ "run" ];
        Scope.Run (Id.Run.t_of_jsonaf id)
      | None, Some id ->
        Json.fields j ~allowed:[ "attempt" ];
        Attempt (Attempt.Id.t_of_jsonaf id)
      | Some _, Some _ | None, None -> Json.fail Invalid_argument "Usage needs one scope"
    in
    let t =
      { id = Key.t_of_jsonaf (get "id")
      ; scope
      ; actor = Id.Actor.t_of_jsonaf (get "actor")
      ; tokens = Json.integer64 (get "tokens")
      ; elapsed_ms = Json.integer64 (get "elapsed_ms")
      ; provenance = Json.text (get "provenance")
      ; timestamp = Json.text (get "timestamp")
      }
    in
    (match validate t with
     | Ok () -> ()
     | Error e -> raise (Json.Decode_error e));
    t)
;;

module Id = Key
