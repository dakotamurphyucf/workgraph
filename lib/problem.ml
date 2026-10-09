open Core

type kind =
  | Invalid_argument
  | Not_found
  | Conflict
  | Blocked
  | Dependency_cycle
  | Already_claimed
  | Stale_claim
  | Idempotency_conflict
  | Corrupt_store
  | Storage_unavailable
  | Local_io
  | Outcome_unknown
  | Workspace_closed
  | Unsupported_version
[@@deriving sexp, equal]

module Details = struct
  type t =
    | Field of
        { path : string list
        ; expected : string
        ; suggestion : string option
        }
    | Revision of
        { expected : int
        ; actual : int
        }
    | Ownership of
        { actor_id : string
        ; run_id : string option
        }
    | Readiness of
        { ticket_id : string
        ; blockers : string list
        }
    | Version of
        { representation : string
        ; observed : string option
        ; supported : string
        }
    | Capacity of
        { meter : string
        ; used : int
        ; limit : int
        ; attempted : int
        ; unit : string
        ; operator_action : string
        }
  [@@deriving sexp, equal]

  let to_json t =
    let text s = `String s in
    let optional = Option.value_map ~default:`Null ~f:text in
    let strings xs = `Array (List.map xs ~f:text) in
    let tagged tag fields = `Object (("type", text tag) :: fields) in
    match t with
    | Field { path; expected; suggestion } ->
      tagged
        "field"
        [ "path", strings path
        ; "expected", text expected
        ; "suggestion", optional suggestion
        ]
    | Revision { expected; actual } ->
      tagged
        "revision"
        [ "expected", text (Int.to_string expected)
        ; "actual", text (Int.to_string actual)
        ]
    | Ownership { actor_id; run_id } ->
      tagged "ownership" [ "actor_id", text actor_id; "run_id", optional run_id ]
    | Readiness { ticket_id; blockers } ->
      tagged "readiness" [ "ticket_id", text ticket_id; "blockers", strings blockers ]
    | Version { representation; observed; supported } ->
      tagged
        "version"
        [ "representation", text representation
        ; "observed", optional observed
        ; "supported", text supported
        ]
    | Capacity { meter; used; limit; attempted; unit; operator_action } ->
      tagged
        "capacity"
        [ "meter", text meter
        ; "used", text (Int.to_string used)
        ; "limit", text (Int.to_string limit)
        ; "attempted", text (Int.to_string attempted)
        ; "unit", text unit
        ; "operator_action", text operator_action
        ]
  ;;
end

type t =
  { kind : kind
  ; message : string
  ; details : Details.t option [@sexp.option]
  }
[@@deriving sexp]

let create kind message = { kind; message; details = None }
let with_details t details = { t with details = Some details }

let at_field t segment =
  let path, expected, suggestion =
    match t.details with
    | Some (Details.Field { path; expected; suggestion }) ->
      segment :: path, expected, suggestion
    | _ -> [ segment ], t.message, None
  in
  let pointer =
    "/"
    ^ String.concat
        ~sep:"/"
        (List.map path ~f:(fun s ->
           s
           |> String.substr_replace_all ~pattern:"~" ~with_:"~0"
           |> String.substr_replace_all ~pattern:"/" ~with_:"~1"))
  in
  { kind = t.kind
  ; message = pointer ^ ": " ^ expected
  ; details = Some (Details.Field { path; expected; suggestion })
  }
;;

(* Current public wire names are intentionally independent of derived OCaml sexps. *)
let wire_name = function
  | Invalid_argument -> "Invalid_argument"
  | Not_found -> "Not_found"
  | Conflict -> "Conflict"
  | Blocked -> "Blocked"
  | Dependency_cycle -> "Dependency_cycle"
  | Already_claimed -> "Already_claimed"
  | Stale_claim -> "Stale_claim"
  | Idempotency_conflict -> "Idempotency_conflict"
  | Corrupt_store -> "Corrupt_store"
  | Storage_unavailable -> "Storage_unavailable"
  | Local_io -> "Local_io"
  | Outcome_unknown -> "Outcome_unknown"
  | Workspace_closed -> "Workspace_closed"
  | Unsupported_version -> "Unsupported_version"
;;

let to_json t =
  `Object
    ([ "kind", `String (wire_name t.kind); "message", `String t.message ]
     @ Option.to_list
         (Option.map t.details ~f:(fun details -> "details", Details.to_json details)))
;;
