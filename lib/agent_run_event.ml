open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

let jsonaf_of_int = Json.int
let int_of_jsonaf = Json.integer
let jsonaf_of_int64 = Json.int64
let int64_of_jsonaf = Json.integer64

(** Current resolved records. Event values remain separate from commands;
    commands and live state implementation may evolve independently. *)
let tag json =
  match Json.list json with
  | [ `String value ] -> value
  | [] | _ :: _ -> Json.fail Invalid_argument "Invalid enum encoding"
;;

let optional json f =
  match json with
  | `Null -> None
  | value -> Some (f value)
;;

module Status = struct
  type t =
    | Running
    | Waiting
    | Completed
    | Failed
    | Cancelled
  [@@deriving sexp, equal, jsonaf]

  let t_of_jsonaf json =
    match tag json with
    | "Running" -> Running
    | "Waiting" -> Waiting
    | "Completed" -> Completed
    | "Failed" -> Failed
    | "Cancelled" -> Cancelled
    | _ -> Json.fail Invalid_argument "Invalid run status"
  ;;

  let terminal = function
    | Running | Waiting -> false
    | Completed | Failed | Cancelled -> true
  ;;
end

module Parent_stop_policy = struct
  type t =
    | Continue
    | Request_cancel
    | Request_wait
  [@@deriving sexp, equal, jsonaf]

  let t_of_jsonaf json =
    match tag json with
    | "Continue" -> Continue
    | "Request_cancel" -> Request_cancel
    | "Request_wait" -> Request_wait
    | _ -> Json.fail Invalid_argument "Invalid parent-stop policy"
  ;;
end

module Runner_action = struct
  type t =
    { parent : Id.Run.t
    ; child : Id.Run.t
    ; policy : Parent_stop_policy.t
    }
  [@@deriving sexp, equal, jsonaf]

  let t_of_jsonaf json =
    Json.fields json ~allowed:[ "parent"; "child"; "policy" ];
    { parent = Id.Run.t_of_jsonaf (Json.field json "parent")
    ; child = Id.Run.t_of_jsonaf (Json.field json "child")
    ; policy = Parent_stop_policy.t_of_jsonaf (Json.field json "policy")
    }
  ;;
end

module Record = struct
  type t =
    { id : Id.Run.t
    ; revision : int
    ; parent : Id.Run.t option
    ; parent_stop_policy : Parent_stop_policy.t
    ; objective : string
    ; actor : Id.Actor.t
    ; capabilities : string list
    ; sessions : Session_id.t list
    ; process_ref : string option
    ; worktree_ref : string option
    ; status : Status.t
    ; last_observed_unix_ms : int64 option
    ; evidence : string
    }
  [@@deriving sexp, equal, jsonaf]

  let validate record =
    let require condition message =
      if not condition then Json.fail Invalid_argument message
    in
    let nonempty text max_bytes =
      require (String.length text <= max_bytes) "Run metadata exceeds byte limit";
      require (not (String.is_empty (String.strip text))) "Run text is empty"
    in
    nonempty record.objective 16384;
    require (record.revision > 0) "Run revision must be positive";
    require
      (List.length record.capabilities <= 100 && List.length record.sessions <= 100)
      "Run links exceed limit";
    List.iter record.capabilities ~f:(fun c -> nonempty c 96);
    require
      (not (List.contains_dup record.capabilities ~compare:String.compare))
      "Duplicate capabilities";
    require
      (not (List.contains_dup record.sessions ~compare:Session_id.compare))
      "Duplicate sessions";
    Option.iter record.process_ref ~f:(fun v -> nonempty v 1024);
    Option.iter record.worktree_ref ~f:(fun v -> nonempty v 4096);
    Option.iter record.last_observed_unix_ms ~f:(fun n ->
      require Int64.(n >= zero) "Observation time is negative");
    require (String.length record.evidence <= 65536) "Run metadata exceeds byte limit";
    if Status.terminal record.status then nonempty record.evidence 65536
  ;;

  let t_of_jsonaf json =
    Json.fields
      json
      ~allowed:
        [ "id"
        ; "revision"
        ; "parent"
        ; "parent_stop_policy"
        ; "objective"
        ; "actor"
        ; "capabilities"
        ; "sessions"
        ; "process_ref"
        ; "worktree_ref"
        ; "status"
        ; "last_observed_unix_ms"
        ; "evidence"
        ];
    let get = Json.field json in
    let record =
      { id = Id.Run.t_of_jsonaf (get "id")
      ; revision = Json.integer (get "revision")
      ; parent = optional (get "parent") Id.Run.t_of_jsonaf
      ; parent_stop_policy = Parent_stop_policy.t_of_jsonaf (get "parent_stop_policy")
      ; objective = Json.bounded_text (get "objective") ~max_bytes:16384
      ; actor = Id.Actor.t_of_jsonaf (get "actor")
      ; capabilities = List.map (Json.list (get "capabilities")) ~f:Json.text
      ; sessions = List.map (Json.list (get "sessions")) ~f:Session_id.t_of_jsonaf
      ; process_ref = optional (get "process_ref") Json.text
      ; worktree_ref = optional (get "worktree_ref") Json.text
      ; status = Status.t_of_jsonaf (get "status")
      ; last_observed_unix_ms = optional (get "last_observed_unix_ms") Json.integer64
      ; evidence = Json.bounded_text (get "evidence") ~max_bytes:65536
      }
    in
    validate record;
    record
  ;;
end

module Update = struct
  type t =
    | Pool_put of Allocation.Definition.t
    | Ticket_policy_put of Allocation.Ticket_policy.t
    | Run_put of Record.t
    | Attempt_put of Attempt.t
    | Reservation_put of Reservation.t
    | Actions_set of
        { actions : Runner_action.t list
        ; evidence : string
        }
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { version : int
  ; revision : int
  ; actor : Id.Actor.t
  ; actor_run : Id.Run.t option
  ; timestamp : string
  ; sequence : int
  ; update : Update.t
  }
[@@deriving sexp, equal, jsonaf]

let validate t =
  if t.version <> 1 then Json.fail Unsupported_version "Unsupported run event version";
  if t.revision < 1 || t.sequence < 1
  then Json.fail Invalid_argument "Invalid run event counters";
  if String.is_empty t.timestamp || String.length t.timestamp > 128
  then Json.fail Invalid_argument "Invalid run timestamp"
;;

let t_of_jsonaf json =
  Json.fields
    json
    ~allowed:
      [ "version"; "revision"; "actor"; "actor_run"; "timestamp"; "sequence"; "update" ];
  let get = Json.field json in
  let update =
    match Json.list (get "update") with
    | [ `String "Pool_put"; value ] ->
      Json.fields value ~allowed:[ "name"; "revision"; "limit" ];
      Update.Pool_put
        { Allocation.Definition.name = Json.text (Json.field value "name")
        ; revision = Json.integer (Json.field value "revision")
        ; limit = Json.integer (Json.field value "limit")
        }
    | [ `String "Ticket_policy_put"; value ] ->
      Json.fields
        value
        ~allowed:[ "ticket"; "revision"; "required_capabilities"; "pools" ];
      Update.Ticket_policy_put
        { Allocation.Ticket_policy.ticket =
            Id.Ticket.t_of_jsonaf (Json.field value "ticket")
        ; revision = Json.integer (Json.field value "revision")
        ; required_capabilities =
            List.map (Json.list (Json.field value "required_capabilities")) ~f:Json.text
        ; pools = List.map (Json.list (Json.field value "pools")) ~f:Json.text
        }
    | [ `String "Run_put"; value ] -> Update.Run_put (Record.t_of_jsonaf value)
    | [ `String "Attempt_put"; value ] -> Attempt_put (Attempt.t_of_jsonaf value)
    | [ `String "Reservation_put"; value ] ->
      Reservation_put (Reservation.t_of_jsonaf value)
    | [ `String "Actions_set"; value ] ->
      Json.fields value ~allowed:[ "actions"; "evidence" ];
      Actions_set
        { actions =
            List.map (Json.list (Json.field value "actions")) ~f:Runner_action.t_of_jsonaf
        ; evidence = Json.bounded_text (Json.field value "evidence") ~max_bytes:65536
        }
    | [] | _ :: _ -> Json.fail Invalid_argument "Invalid run update"
  in
  let t =
    { version = Json.integer (get "version")
    ; revision = Json.integer (get "revision")
    ; actor = Id.Actor.t_of_jsonaf (get "actor")
    ; actor_run = optional (get "actor_run") Id.Run.t_of_jsonaf
    ; timestamp = Json.bounded_text (get "timestamp") ~max_bytes:128
    ; sequence = Json.integer (get "sequence")
    ; update
    }
  in
  validate t;
  t
;;
