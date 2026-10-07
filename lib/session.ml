open Core

module Event_ref = struct
  type t =
    { session : Session_id.t
    ; sequence : int
    }
  [@@deriving sexp, equal, compare]

  let create ~session ~sequence =
    if sequence <= 0 || sequence > 1_000_000
    then Error (Problem.create Invalid_argument "event sequence requires 1..1000000")
    else Ok { session; sequence }
  ;;

  let to_json { session; sequence } =
    Json.obj
      [ "session_id", Session_id.jsonaf_of_t session; "sequence", Json.int sequence ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "session_id"; "sequence" ];
      Disk.unwrap
        (create
           ~session:(Session_id.t_of_jsonaf (Json.field json "session_id"))
           ~sequence:(Json.integer (Json.field json "sequence"))))
  ;;
end

type t =
  { workspace : Id.Workspace.t
  ; id : Session_id.t
  ; title : string
  ; actor : Id.Actor.t
  ; run : Id.Run.t option
  ; parent : Event_ref.t option
  ; scopes : Entity_ref.t list
  ; archived : bool
  }

let create ~workspace ~id ~title ~actor ?run ?parent ~scopes () =
  Json.decode (fun () ->
    ignore (Json.canonical (Json.string title) : string);
    if String.is_empty title || String.length title > 512
    then Json.fail Invalid_argument "session title requires 1..512 bytes";
    if List.length scopes > 100
    then Json.fail Invalid_argument "session permits at most 100 scopes";
    if
      List.length (List.dedup_and_sort scopes ~compare:Entity_ref.compare)
      <> List.length scopes
    then Json.fail Invalid_argument "duplicate session scope";
    { workspace; id; title; actor; run; parent; scopes; archived = false })
;;

let id t = t.id
let workspace t = t.workspace
let title t = t.title
let actor t = t.actor
let run t = t.run
let parent t = t.parent
let scopes t = t.scopes
let archived t = t.archived
let archive t = { t with archived = true }

let to_json t =
  Json.obj
    [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
    ; "id", Session_id.jsonaf_of_t t.id
    ; "title", Json.string t.title
    ; "actor", Id.Actor.jsonaf_of_t t.actor
    ; "run", Option.value_map t.run ~default:`Null ~f:Id.Run.jsonaf_of_t
    ; "parent", Option.value_map t.parent ~default:`Null ~f:Event_ref.to_json
    ; "scopes", `Array (List.map t.scopes ~f:Entity_ref.jsonaf_of_t)
    ; ("archived", if t.archived then `True else `False)
    ]
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields
      json
      ~allowed:
        [ "workspace_id"; "id"; "title"; "actor"; "run"; "parent"; "scopes"; "archived" ];
    let optional key f =
      match Json.field json key with
      | `Null -> None
      | value -> Some (f value)
    in
    let t =
      Disk.unwrap
        (create
           ~workspace:(Id.Workspace.t_of_jsonaf (Json.field json "workspace_id"))
           ~id:(Session_id.t_of_jsonaf (Json.field json "id"))
           ~title:(Json.text (Json.field json "title"))
           ~actor:(Id.Actor.t_of_jsonaf (Json.field json "actor"))
           ?run:(optional "run" Id.Run.t_of_jsonaf)
           ?parent:(optional "parent" (fun json -> Disk.unwrap (Event_ref.of_json json)))
           ~scopes:
             (List.map (Json.list (Json.field json "scopes")) ~f:Entity_ref.t_of_jsonaf)
           ())
    in
    match Json.field json "archived" with
    | `True -> archive t
    | `False -> t
    | _ -> Json.fail Invalid_argument "archived requires boolean")
;;
