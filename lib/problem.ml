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
  module Claim = struct
    module Field = struct
      type t =
        | Actor
        | Run
        | Token
      [@@deriving sexp, equal]
    end

    type ownership =
      | Unclaimed
      | Mismatch of
          { field : Field.t
          ; actor_id : string
          ; run_id : string option
          }
    [@@deriving sexp, equal]

    type t =
      { ticket_id : string
      ; ownership : ownership
      }
    [@@deriving sexp, equal]
  end

  module Communication_entity = struct
    type t =
      | Board
      | Thread
      | Team
      | Request
      | Message
      | Subscription
    [@@deriving sexp, equal]

    let to_string = function
      | Board -> "board"
      | Thread -> "thread"
      | Team -> "team"
      | Request -> "request"
      | Message -> "message"
      | Subscription -> "subscription"
    ;;
  end

  module Size_unit = struct
    type t =
      | Utf8_bytes
      | Canonical_json_bytes
    [@@deriving sexp, equal]
  end

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
    | Claim of Claim.t
    | Entity_revision of
        { entity : Communication_entity.t
        ; entity_id : string
        ; expected : int
        ; actual : int
        }
    | Identity_collision of
        { entity : Communication_entity.t
        ; entity_id : string
        }
    | Size of
        { path : string list
        ; actual : int
        ; maximum : int
        ; unit : Size_unit.t
        }
    | Socket_owner of { socket_path : string }
    | Allocation of
        { ticket_id : string
        ; reasons : Allocation_admission_reason.t list
        ; omitted_reasons : int
        }
    | Reservation_conflict of Reservation_conflict.t
    | Readiness of
        { ticket_id : string
        ; blockers : string list
        ; omitted_blockers : int
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
    | Claim { ticket_id; ownership } ->
      tagged
        "claim"
        (("ticket_id", text ticket_id)
         ::
         (match ownership with
          | Unclaimed -> [ "status", text "unclaimed" ]
          | Mismatch { field; actor_id; run_id } ->
            [ "status", text "mismatch"
            ; ( "field"
              , text
                  (match field with
                   | Actor -> "actor"
                   | Run -> "run"
                   | Token -> "token") )
            ; "actor_id", text actor_id
            ; "run_id", optional run_id
            ]))
    | Entity_revision { entity; entity_id; expected; actual } ->
      tagged
        "entity_revision"
        [ "entity", text (Communication_entity.to_string entity)
        ; "entity_id", text entity_id
        ; "expected", text (Int.to_string expected)
        ; "actual", text (Int.to_string actual)
        ]
    | Identity_collision { entity; entity_id } ->
      tagged
        "identity_collision"
        [ "entity", text (Communication_entity.to_string entity)
        ; "entity_id", text entity_id
        ]
    | Size { path; actual; maximum; unit } ->
      tagged
        "size"
        [ "path", strings path
        ; "actual", text (Int.to_string actual)
        ; "maximum", text (Int.to_string maximum)
        ; ( "unit"
          , text
              (match unit with
               | Utf8_bytes -> "utf8_bytes"
               | Canonical_json_bytes -> "canonical_json_bytes") )
        ]
    | Socket_owner { socket_path } ->
      tagged "socket_owner" [ "socket_path", text socket_path ]
    | Allocation { ticket_id; reasons; omitted_reasons } ->
      tagged
        "allocation"
        [ "ticket_id", text ticket_id
        ; "reasons", `Array (List.map reasons ~f:Allocation_admission_reason.to_json)
        ; "omitted_reasons", text (Int.to_string omitted_reasons)
        ]
    | Reservation_conflict conflict -> Reservation_conflict.to_json conflict
    | Readiness { ticket_id; blockers; omitted_blockers } ->
      tagged
        "readiness"
        [ "ticket_id", text ticket_id
        ; "blockers", strings blockers
        ; "omitted_blockers", text (Int.to_string omitted_blockers)
        ]
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

let pointer path =
  "/"
  ^ String.concat
      ~sep:"/"
      (List.map path ~f:(fun s ->
         s
         |> String.substr_replace_all ~pattern:"~" ~with_:"~0"
         |> String.substr_replace_all ~pattern:"/" ~with_:"~1"))
;;

let at_field t segment =
  match t.details with
  | Some (Details.Size size) ->
    let path = segment :: size.path in
    let message =
      if List.is_empty size.path
      then t.message
      else String.chop_prefix_if_exists t.message ~prefix:(pointer size.path ^ ": ")
    in
    { t with
      message = pointer path ^ ": " ^ message
    ; details = Some (Details.Size { size with path })
    }
  | _ ->
    let path, expected, suggestion =
      match t.details with
      | Some (Details.Field { path; expected; suggestion }) ->
        segment :: path, expected, suggestion
      | _ -> [ segment ], t.message, None
    in
    { kind = t.kind
    ; message = pointer path ^ ": " ^ expected
    ; details = Some (Details.Field { path; expected; suggestion })
    }
;;

let identity_collision entity ~id =
  with_details
    (create
       Conflict
       (Details.Communication_entity.to_string entity ^ " ID already exists: " ^ id))
    (Identity_collision { entity; entity_id = id })
;;

let entity_revision entity ~id ~expected ~actual =
  with_details
    (create
       Conflict
       (sprintf
          "%s %s revision conflict: expected %d, actual %d"
          (Details.Communication_entity.to_string entity)
          id
          expected
          actual))
    (Entity_revision { entity; entity_id = id; expected; actual })
;;

let readiness_details ~ticket_id ~blockers =
  let listed = List.take blockers 100 in
  Details.Readiness
    { ticket_id
    ; blockers = listed
    ; omitted_blockers = List.length blockers - List.length listed
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
