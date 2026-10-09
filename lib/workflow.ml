open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Revision = struct
  type t = int [@@deriving sexp]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Category = struct
  type t =
    | Backlog
    | Todo
    | In_progress
    | Done
    | Canceled
  [@@deriving sexp, equal, jsonaf]

  let of_name = function
    | "backlog" -> Backlog
    | "todo" -> Todo
    | "in_progress" -> In_progress
    | "done" -> Done
    | "canceled" -> Canceled
    | _ -> Json.fail Invalid_argument "unknown status category"
  ;;

  let jsonaf_of_t t =
    Json.string
      (match t with
       | Backlog -> "backlog"
       | Todo -> "todo"
       | In_progress -> "in_progress"
       | Done -> "done"
       | Canceled -> "canceled")
  ;;

  let t_of_jsonaf json = of_name (Json.text json)
end

module Actor = struct
  type kind =
    | Person
    | Agent
  [@@deriving sexp, equal]

  let jsonaf_of_kind = function
    | Person -> Json.string "person"
    | Agent -> Json.string "agent"
  ;;

  let kind_of_jsonaf value =
    match Json.text value with
    | "person" -> Person
    | "agent" -> Agent
    | _ -> Json.fail Invalid_argument "unknown actor kind"
  ;;

  type t =
    { id : Id.Actor.t
    ; name : string
    ; kind : kind
    ; revision : Revision.t
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Label = struct
  type t =
    { id : Id.Label.t
    ; name : string
    ; description : string
    ; revision : Revision.t
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Status = struct
  type t =
    { id : Id.Status.t
    ; name : string
    ; category : Category.t
    ; revision : Revision.t
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Change = struct
  type t =
    | Actor of Actor.t
    | Label of Label.t
    | Status of Status.t
  [@@deriving sexp, jsonaf]
end

type t =
  { actors : Actor.t Id.Actor.Map.t
  ; labels : Label.t Id.Label.Map.t
  ; statuses : Status.t Id.Status.Map.t
  }

let empty =
  { actors = Id.Actor.Map.empty
  ; labels = Id.Label.Map.empty
  ; statuses = Id.Status.Map.empty
  }
;;

let actor t id =
  match Map.find t.actors id with
  | Some value -> value
  | None -> Json.fail Not_found "actor not found"
;;

let label t id =
  match Map.find t.labels id with
  | Some value -> value
  | None -> Json.fail Not_found "label not found"
;;

let status t id =
  match Map.find t.statuses id with
  | Some value -> value
  | None -> Json.fail Not_found "status not found"
;;

let check_revision actual expected =
  if not (Int.equal actual expected) then Json.fail Conflict "catalog revision conflict"
;;

let valid_name name =
  if String.is_empty (String.strip name) || String.length name > 512
  then Json.fail Invalid_argument "name requires 1..512 bytes"
;;

let validate_change = function
  | Change.Actor a -> valid_name a.name
  | Label l ->
    valid_name l.name;
    if String.length l.description > 65_536
    then Json.fail Invalid_argument "label description exceeds byte limit"
  | Status s -> valid_name s.name
;;

let prepare t change =
  validate_change change;
  match change with
  | Change.Actor a ->
    check_revision
      (Option.value_map (Map.find t.actors a.id) ~default:0 ~f:(fun a -> a.Actor.revision))
      a.revision;
    Change.Actor { a with revision = a.revision + 1 }
  | Label l ->
    check_revision
      (Option.value_map (Map.find t.labels l.id) ~default:0 ~f:(fun l -> l.Label.revision))
      l.revision;
    Label { l with revision = l.revision + 1 }
  | Status s ->
    let previous = Map.find t.statuses s.id in
    check_revision
      (Option.value_map previous ~default:0 ~f:(fun s -> s.Status.revision))
      s.revision;
    Option.iter previous ~f:(fun old ->
      if not (Category.equal old.category s.category)
      then Json.fail Conflict "status category is immutable; create a new status");
    Status { s with revision = s.revision + 1 }
;;

let apply t change =
  validate_change change;
  let previous =
    match change with
    | Change.Actor a -> Change.Actor { a with revision = a.revision - 1 }
    | Label l -> Label { l with revision = l.revision - 1 }
    | Status s -> Status { s with revision = s.revision - 1 }
  in
  ignore (prepare t previous : Change.t);
  let next =
    match change with
    | Change.Actor a -> { t with actors = Map.set t.actors ~key:a.id ~data:a }
    | Label l -> { t with labels = Map.set t.labels ~key:l.id ~data:l }
    | Status s -> { t with statuses = Map.set t.statuses ~key:s.id ~data:s }
  in
  if
    Map.length next.actors > 1_000
    || Map.length next.labels > 1_000
    || Map.length next.statuses > 100
  then Json.fail Invalid_argument "workflow catalog limit exceeded";
  next
;;

let decode ~method_ ~params =
  let get name = Json.field params name in
  let name () = Json.bounded_text (get "name") ~max_bytes:512 in
  let revision () = Json.integer (get "expected_revision") in
  let archived () =
    match Json.optional params "archived" with
    | None | Some `False -> false
    | Some `True -> true
    | Some _ -> Json.fail Invalid_argument "archived must be boolean"
  in
  match method_ with
  | "actor.put" ->
    Json.fields
      params
      ~allowed:[ "target_actor_id"; "name"; "kind"; "expected_revision"; "archived" ];
    let kind =
      match Json.text (get "kind") with
      | "person" -> Actor.Person
      | "agent" -> Agent
      | _ -> Json.fail Invalid_argument "kind must be person or agent"
    in
    Change.Actor
      { id = Id.Actor.t_of_jsonaf (get "target_actor_id")
      ; name = name ()
      ; kind
      ; revision = revision ()
      ; archived = archived ()
      }
  | "label.put" ->
    Json.fields
      params
      ~allowed:[ "label_id"; "name"; "description"; "expected_revision"; "archived" ];
    Change.Label
      { id = Id.Label.t_of_jsonaf (get "label_id")
      ; name = name ()
      ; description =
          Option.value_map (Json.optional params "description") ~default:"" ~f:Json.text
      ; revision = revision ()
      ; archived = archived ()
      }
  | "status.put" ->
    Json.fields
      params
      ~allowed:[ "status_id"; "name"; "category"; "expected_revision"; "archived" ];
    Change.Status
      { id = Id.Status.t_of_jsonaf (get "status_id")
      ; name = name ()
      ; category = Category.of_name (Json.text (get "category"))
      ; revision = revision ()
      ; archived = archived ()
      }
  | _ -> Json.fail Invalid_argument "unknown workflow method"
;;

let items t ~kind ~include_archived =
  match kind with
  | `Actors ->
    Map.data t.actors
    |> List.filter ~f:(fun a -> include_archived || not a.Actor.archived)
    |> List.map ~f:Actor.jsonaf_of_t
  | `Labels ->
    Map.data t.labels
    |> List.filter ~f:(fun l -> include_archived || not l.Label.archived)
    |> List.map ~f:Label.jsonaf_of_t
  | `Statuses ->
    Map.data t.statuses
    |> List.filter ~f:(fun s -> include_archived || not s.Status.archived)
    |> List.map ~f:Status.jsonaf_of_t
;;

let to_json t =
  Json.obj
    [ "actors", `Array (items t ~kind:`Actors ~include_archived:true)
    ; "labels", `Array (items t ~kind:`Labels ~include_archived:true)
    ; "statuses", `Array (items t ~kind:`Statuses ~include_archived:true)
    ]
;;

let actors t ~include_archived =
  Map.data t.actors
  |> List.filter ~f:(fun (value : Actor.t) -> include_archived || not value.archived)
;;

let labels t ~include_archived =
  Map.data t.labels
  |> List.filter ~f:(fun (value : Label.t) -> include_archived || not value.archived)
;;

let statuses t ~include_archived =
  Map.data t.statuses
  |> List.filter ~f:(fun (value : Status.t) -> include_archived || not value.archived)
;;
