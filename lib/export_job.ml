open Core

module Capture = struct
  type t =
    { workspace : Id.Workspace.t
    ; revision : int
    ; head : string option
    ; history_head : string option
    }

  let to_json t =
    Json.obj
      [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
      ; "revision", Json.int t.revision
      ; "head", Option.value_map t.head ~default:`Null ~f:Json.string
      ; "history_head", Option.value_map t.history_head ~default:`Null ~f:Json.string
      ]
  ;;

  let validate t =
    if
      t.revision < 0
      || t.revision > 100_000
      || not (Bool.equal (t.revision = 0) (Option.is_none t.head))
    then Json.fail Corrupt_store "captured revision and head disagree";
    List.iter
      (Option.to_list t.head @ Option.to_list t.history_head)
      ~f:(fun hash ->
        if
          String.length hash <> 64
          || not
               (String.for_all hash ~f:(fun c ->
                  Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
        then Json.fail Corrupt_store "invalid captured head digest")
  ;;

  let of_json json =
    Json.fields json ~allowed:[ "workspace_id"; "revision"; "head"; "history_head" ];
    let digest field =
      match Json.field json field with
      | `Null -> None
      | value -> Some (Json.text value)
    in
    let revision = Json.integer (Json.field json "revision") in
    let head = digest "head" in
    let t =
      { workspace = Id.Workspace.t_of_jsonaf (Json.field json "workspace_id")
      ; revision
      ; head
      ; history_head = digest "history_head"
      }
    in
    validate t;
    t
  ;;
end

type kind =
  | Single
  | All
[@@deriving equal, sexp]

type status =
  | Running
  | Completed
  | Failed
  | Canceled
  | Interrupted
[@@deriving equal, sexp]

type t =
  { id : string
  ; kind : kind
  ; destination : string
  ; captures : Capture.t list
  ; omitted : Id.Workspace.t list
  ; status : status
  ; attempt : int
  ; cancel_requested : bool
  ; error : string option
  }

let stage t = t.destination ^ ".exporting-" ^ t.id ^ "-" ^ Int.to_string t.attempt

let contains t ~workspace =
  List.exists t.captures ~f:(fun c ->
    String.equal workspace (Id.Workspace.to_string c.workspace))
;;

let validate t =
  (match Id.Actor.of_string t.id with
   | Ok _ -> ()
   | Error e -> raise (Json.Decode_error e));
  if (not (Filename.is_absolute t.destination)) || String.mem t.destination '\000'
  then Json.fail Corrupt_store "invalid export destination";
  if t.attempt < 1 || t.attempt > 1_000_000
  then Json.fail Corrupt_store "invalid export attempt";
  (match t.status with
   | Running ->
     if Option.is_some t.error
     then Json.fail Corrupt_store "running export carries terminal error"
   | Completed ->
     if Option.is_some t.error || t.cancel_requested
     then Json.fail Corrupt_store "completed export has contradictory cancellation/error"
   | Failed | Canceled | Interrupted ->
     if Option.is_none t.error
     then Json.fail Corrupt_store "unsuccessful export requires an error");
  if
    equal_kind t.kind Single
    && (List.length t.captures <> 1 || not (List.is_empty t.omitted))
  then Json.fail Corrupt_store "single export requires one capture and no omissions";
  let ids = List.map t.captures ~f:(fun c -> c.Capture.workspace) @ t.omitted in
  if
    List.length ids > 1000 || List.length ids <> Set.length (Id.Workspace.Set.of_list ids)
  then Json.fail Corrupt_store "invalid export workspace vector";
  List.iter t.captures ~f:Capture.validate;
  Option.iter t.error ~f:(fun message ->
    if String.length message > 4096 then Json.fail Corrupt_store "export error too large")
;;

let to_json t =
  Json.obj
    [ "job_id", Json.string t.id
    ; ( "kind"
      , Json.string
          (match t.kind with
           | Single -> "workspace"
           | All -> "all") )
    ; "destination", Json.string t.destination
    ; "captures", `Array (List.map t.captures ~f:Capture.to_json)
    ; "omitted", `Array (List.map t.omitted ~f:Id.Workspace.jsonaf_of_t)
    ; ( "status"
      , Json.string
          (match t.status with
           | Running -> "running"
           | Completed -> "completed"
           | Failed -> "failed"
           | Canceled -> "canceled"
           | Interrupted -> "interrupted") )
    ; "attempt", Json.int t.attempt
    ; ("cancel_requested", if t.cancel_requested then `True else `False)
    ; "error", Option.value_map t.error ~default:`Null ~f:Json.string
    ]
;;

let of_json json =
  Json.fields
    json
    ~allowed:
      [ "job_id"
      ; "kind"
      ; "destination"
      ; "captures"
      ; "omitted"
      ; "status"
      ; "attempt"
      ; "cancel_requested"
      ; "error"
      ];
  let t =
    { id = Json.text (Json.field json "job_id")
    ; kind =
        (match Json.text (Json.field json "kind") with
         | "workspace" -> Single
         | "all" -> All
         | _ -> Json.fail Corrupt_store "unknown export kind")
    ; destination = Json.text (Json.field json "destination")
    ; captures = List.map (Json.list (Json.field json "captures")) ~f:Capture.of_json
    ; omitted =
        List.map (Json.list (Json.field json "omitted")) ~f:Id.Workspace.t_of_jsonaf
    ; status =
        (match Json.text (Json.field json "status") with
         | "running" -> Running
         | "completed" -> Completed
         | "failed" -> Failed
         | "canceled" -> Canceled
         | "interrupted" -> Interrupted
         | _ -> Json.fail Corrupt_store "unknown export status")
    ; attempt = Json.integer (Json.field json "attempt")
    ; cancel_requested =
        (match Json.field json "cancel_requested" with
         | `True -> true
         | `False -> false
         | _ -> Json.fail Corrupt_store "invalid export cancellation flag")
    ; error =
        (match Json.field json "error" with
         | `Null -> None
         | value -> Some (Json.text value))
    }
  in
  validate t;
  t
;;
