open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

let jsonaf_of_int = Json.int
let int_of_jsonaf = Json.integer
let jsonaf_of_int64 = Json.int64
let int64_of_jsonaf = Json.integer64

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

module State = struct
  type t =
    | Running
    | Waiting
    | Completed
    | Failed
    | Cancelled
  [@@deriving sexp, equal, jsonaf]

  let terminal = function
    | Running | Waiting -> false
    | Completed | Failed | Cancelled -> true
  ;;
end

module Checkpoint = struct
  type t =
    | Resource of
        { id : Id.Resource.t
        ; revision : int
        }
    | Handoff of
        { ticket : Id.Ticket.t
        ; revision : int
        }
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { id : Key.t
  ; revision : int
  ; run : Id.Run.t
  ; ticket : Id.Ticket.t
  ; token : int
  ; state : State.t
  ; sessions : Session_id.t list
  ; checkpoints : Checkpoint.t list
  ; evidence : string
  }
[@@deriving sexp, equal, jsonaf]

let validate t =
  if t.revision < 1 || t.token < 1
  then Json.fail Invalid_argument "Attempt counters must be positive";
  if List.length t.sessions > 100 || List.length t.checkpoints > 100
  then Json.fail Invalid_argument "Attempt links exceed 100";
  if List.contains_dup t.sessions ~compare:Session_id.compare
  then Json.fail Invalid_argument "Duplicate attempt session";
  if String.length t.evidence > 65536
  then Json.fail Invalid_argument "Attempt evidence exceeds 64KiB";
  if State.terminal t.state && String.is_empty (String.strip t.evidence)
  then Json.fail Invalid_argument "Terminal attempts require evidence";
  List.iter t.checkpoints ~f:(function
      | Checkpoint.Resource { revision; _ } | Handoff { revision; _ } ->
      if revision < 1
      then Json.fail Invalid_argument "Checkpoint revisions must be positive")
;;

let validate_transition ~previous t =
  validate t;
  match previous with
  | None ->
    if
      t.revision <> 1
      || (not (State.equal t.state Running))
      || (not (List.is_empty t.checkpoints))
      || not (String.is_empty t.evidence)
    then Json.fail Conflict "Attempt must begin running at revision one"
  | Some p ->
    if t.revision <> p.revision + 1
    then Json.fail Conflict "Nonconsecutive attempt revision";
    if State.terminal p.state then Json.fail Conflict "Terminal attempt is immutable";
    if
      not
        (Key.equal p.id t.id
         && Id.Run.equal p.run t.run
         && Id.Ticket.equal p.ticket t.ticket
         && Int.equal p.token t.token
         && List.equal Session_id.equal p.sessions t.sessions)
    then Json.fail Conflict "Attempt provenance is immutable";
    if not (List.is_prefix t.checkpoints ~prefix:p.checkpoints ~equal:Checkpoint.equal)
    then Json.fail Conflict "Checkpoints cannot be removed or rewritten";
    if State.equal p.state t.state
    then (
      if
        not
          (String.equal p.evidence t.evidence
           && List.length t.checkpoints = List.length p.checkpoints + 1)
      then Json.fail Conflict "Checkpoint update must append exactly one reference")
    else if
      not
        (State.terminal t.state && List.equal Checkpoint.equal p.checkpoints t.checkpoints)
    then Json.fail Conflict "Attempt finish cannot alter checkpoints"
;;

let state_of_jsonaf json =
  match Json.list json with
  | [ `String "Running" ] -> State.Running
  | [ `String "Waiting" ] -> Waiting
  | [ `String "Completed" ] -> Completed
  | [ `String "Failed" ] -> Failed
  | [ `String "Cancelled" ] -> Cancelled
  | [] | _ :: _ -> Json.fail Invalid_argument "Invalid attempt state"
;;

let checkpoint_of_jsonaf json =
  match Json.list json with
  | [ `String "Resource"; fields ] ->
    Json.fields fields ~allowed:[ "id"; "revision" ];
    Checkpoint.Resource
      { id = Id.Resource.t_of_jsonaf (Json.field fields "id")
      ; revision = Json.integer (Json.field fields "revision")
      }
  | [ `String "Handoff"; fields ] ->
    Json.fields fields ~allowed:[ "ticket"; "revision" ];
    Handoff
      { ticket = Id.Ticket.t_of_jsonaf (Json.field fields "ticket")
      ; revision = Json.integer (Json.field fields "revision")
      }
  | [] | _ :: _ -> Json.fail Invalid_argument "Invalid attempt checkpoint"
;;

let t_of_jsonaf json =
  Json.fields
    json
    ~allowed:
      [ "id"
      ; "revision"
      ; "run"
      ; "ticket"
      ; "token"
      ; "state"
      ; "sessions"
      ; "checkpoints"
      ; "evidence"
      ];
  let get = Json.field json in
  let t =
    { id = Key.t_of_jsonaf (get "id")
    ; revision = Json.integer (get "revision")
    ; run = Id.Run.t_of_jsonaf (get "run")
    ; ticket = Id.Ticket.t_of_jsonaf (get "ticket")
    ; token = Json.integer (get "token")
    ; state = state_of_jsonaf (get "state")
    ; sessions = List.map (Json.list (get "sessions")) ~f:Session_id.t_of_jsonaf
    ; checkpoints = List.map (Json.list (get "checkpoints")) ~f:checkpoint_of_jsonaf
    ; evidence = Json.bounded_text (get "evidence") ~max_bytes:65536
    }
  in
  validate t;
  t
;;

module Id = Key
