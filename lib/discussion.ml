open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Revision = struct
  type t = int [@@deriving sexp]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Kind = struct
  type t =
    | Comment
    | Progress
    | Decision
    | Blocker
    | Evidence
  [@@deriving sexp, equal]

  let jsonaf_of_t t =
    Json.string
      (match t with
       | Comment -> "comment"
       | Progress -> "progress"
       | Decision -> "decision"
       | Blocker -> "blocker"
       | Evidence -> "evidence")
  ;;

  let t_of_jsonaf value =
    match Json.text value with
    | "comment" -> Comment
    | "progress" -> Progress
    | "decision" -> Decision
    | "blocker" -> Blocker
    | "evidence" -> Evidence
    | _ -> Json.fail Invalid_argument "unknown discussion kind"
  ;;
end

module Origin = struct
  type t =
    | Authored
    | Completion
  [@@deriving sexp, equal]

  let jsonaf_of_t = function
    | Authored -> Json.string "authored"
    | Completion -> Json.string "completion"
  ;;

  let t_of_jsonaf value =
    match Json.text value with
    | "authored" -> Authored
    | "completion" -> Completion
    | _ -> Json.fail Invalid_argument "unknown comment origin"
  ;;
end

module Version = struct
  type t =
    { revision : Revision.t
    ; serial : Revision.t
    ; sequence : Revision.t
    ; actor : Id.Actor.t
    ; timestamp : string
    ; body : string
    ; tombstone : bool
    }
  [@@deriving sexp, jsonaf]
end

module Change = struct
  type t =
    | Create of
        { id : Id.Comment.t
        ; target : Entity_ref.t
        ; reply_to : Id.Comment.t option
        ; kind : Kind.t
        ; origin : Origin.t
        ; version : Version.t
        }
    | Revise of
        { id : Id.Comment.t
        ; version : Version.t
        }
  [@@deriving sexp, jsonaf]
end

module Entry = struct
  type t =
    { id : Id.Comment.t
    ; target : Entity_ref.t
    ; reply_to : Id.Comment.t option
    ; kind : Kind.t
    ; origin : Origin.t
    ; author : Id.Actor.t
    ; created_at : string
    ; current : Version.t
    ; previous : Version.t list
    }
end

type t =
  { entries : Entry.t Id.Comment.Map.t
  ; serial : int
  ; by_target : (Entity_ref.t, Id.Comment.Set.t, Entity_ref.comparator_witness) Map.t
  }

let empty =
  { entries = Id.Comment.Map.empty
  ; serial = 0
  ; by_target = Map.empty (module Entity_ref)
  }
;;

let next_serial t = t.serial + 1

let generated_id t ~sequence =
  match Id.Comment.of_string (sprintf "comment_%d_%d" sequence (next_serial t)) with
  | Ok id -> id
  | Error error -> raise (Json.Decode_error error)
;;

let find t id =
  match Map.find t.entries id with
  | Some entry -> entry
  | None -> Json.fail Not_found "comment not found"
;;

let revision t id = (find t id).current.revision
let target t id = (find t id).target
let require condition kind message = if not condition then Json.fail kind message

let apply t change ~sequence =
  let version =
    match change with
    | Change.Create { version; _ } | Revise { version; _ } -> version
  in
  require
    (Int.equal version.serial (next_serial t) && Int.equal version.sequence sequence)
    Corrupt_store
    "invalid comment activity cursor";
  require
    (String.length version.timestamp <= 128 && String.length version.body <= 65_536)
    Invalid_argument
    "comment exceeds byte limit";
  require
    ((not version.tombstone) || String.is_empty version.body)
    Corrupt_store
    "tombstone contains current text";
  let entry =
    match change with
    | Change.Create { id; target; reply_to; kind; origin; version } ->
      require (not (Map.mem t.entries id)) Conflict "comment already exists";
      require
        (Int.equal version.revision 1 && not version.tombstone)
        Corrupt_store
        "invalid initial comment version";
      (match origin with
       | Origin.Authored -> ()
       | Completion ->
         require
           (Kind.equal kind Evidence
            && Option.is_none reply_to
            &&
            match target with
            | Entity_ref.Ticket _ -> true
            | Workspace | Project _ | Milestone _ | Resource _ -> false)
           Corrupt_store
           "completion origin requires ticket evidence without a reply");
      Option.iter reply_to ~f:(fun reply ->
        let parent = find t reply in
        require (Entity_ref.equal parent.target target) Conflict "reply target differs";
        require (not parent.current.tombstone) Conflict "cannot reply to tombstone");
      { Entry.id
      ; target
      ; reply_to
      ; kind
      ; origin
      ; author = version.actor
      ; created_at = version.timestamp
      ; current = version
      ; previous = []
      }
    | Revise { id; version } ->
      let old = find t id in
      require
        (Origin.equal old.origin Authored)
        Conflict
        "completion evidence is immutable; append a correction reply";
      require
        (Id.Actor.equal old.author version.actor)
        Conflict
        "only the original author may revise or tombstone a comment";
      require
        (Int.equal version.revision (old.current.revision + 1))
        Conflict
        "comment revision conflict";
      { old with current = version; previous = old.current :: old.previous }
  in
  let by_target =
    match change with
    | Change.Create _ ->
      Map.update t.by_target entry.target ~f:(fun ids ->
        Set.add (Option.value ids ~default:Id.Comment.Set.empty) entry.id)
    | Revise _ -> t.by_target
  in
  { entries = Map.set t.entries ~key:entry.id ~data:entry
  ; serial = version.serial
  ; by_target
  }
;;

let version_json (entry : Entry.t) version =
  let fields =
    match Version.jsonaf_of_t version with
    | `Object fields -> fields
    | _ -> assert false
  in
  Json.obj
    ([ "comment_id", Id.Comment.jsonaf_of_t entry.id
     ; "target", Entity_ref.jsonaf_of_t entry.target
     ; "author", Id.Actor.jsonaf_of_t entry.author
     ; "created_at", Json.string entry.created_at
     ; ( "reply_to"
       , Option.value_map entry.reply_to ~default:`Null ~f:Id.Comment.jsonaf_of_t )
     ; "kind", Kind.jsonaf_of_t entry.kind
     ; "origin", Origin.jsonaf_of_t entry.origin
     ]
     @ fields)
;;

let get t id =
  let entry = find t id in
  version_json entry entry.current
;;

let history t id =
  let entry = find t id in
  List.rev (entry.current :: entry.previous) |> List.map ~f:(version_json entry)
;;

let entries_for_target t target =
  match Map.find t.by_target target with
  | None -> []
  | Some ids -> Set.to_list ids |> List.map ~f:(find t)
;;

let ids t = Map.to_sequence t.entries |> Sequence.map ~f:fst

let list t ~target ~include_tombstones =
  (match target with
   | None -> Map.data t.entries
   | Some target -> entries_for_target t target)
  |> List.filter ~f:(fun entry -> include_tombstones || not entry.Entry.current.tombstone)
  |> List.map ~f:(fun entry -> version_json entry entry.current)
;;

let since t ~target ~after =
  entries_for_target t target
  |> List.concat_map ~f:(fun entry ->
    entry.current :: entry.previous
    |> List.filter ~f:(fun version -> version.Version.sequence > after)
    |> List.map ~f:(fun version -> version.Version.serial, version_json entry version))
  |> List.sort ~compare:(fun (a, _) (b, _) -> Int.compare a b)
  |> List.map ~f:snd
;;

let targets t = Map.keys t.by_target

let to_json t =
  `Array
    (Map.data t.entries
     |> List.map ~f:(fun entry ->
       Json.obj
         [ "comment", version_json entry entry.current
         ; "history", `Array (history t entry.id)
         ]))
;;

let search_documents t =
  Map.data t.entries
  |> List.filter_map ~f:(fun entry ->
    if entry.Entry.current.tombstone
    then None
    else
      Some
        { Search.Document.source = Comment entry.id
        ; target = entry.target
        ; revision = entry.current.revision
        ; fields = [ "body", entry.current.body ]
        })
;;
