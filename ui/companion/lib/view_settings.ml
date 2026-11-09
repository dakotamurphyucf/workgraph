open Core
open Workgraph

let source_limit = 64 * 1024
let metadata_limit = 2 * 1024 * 1024
let document_limit = 25
let metadata_name = "view-settings.json"

module Target = struct
  type t =
    { connection : Connection_profile.t
    ; workspace : Id.Workspace.t
    }

  let create ~connection ~workspace = { connection; workspace }

  let to_json t =
    Json.obj
      [ "connection", Connection_profile.to_json t.connection
      ; "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
      ]
  ;;

  let of_json value =
    Json.fields value ~allowed:[ "connection"; "workspace_id" ];
    { connection =
        Connection_profile.of_json (Json.field value "connection") |> Disk.unwrap
    ; workspace = Id.Workspace.t_of_jsonaf (Json.field value "workspace_id")
    }
  ;;

  let same_slot a b =
    Id.Workspace.equal a.workspace b.workspace
    && Connection_profile.Id.equal
         (Connection_profile.id a.connection)
         (Connection_profile.id b.connection)
    && Connection_profile.Generation.equal
         (Connection_profile.generation a.connection)
         (Connection_profile.generation b.connection)
  ;;

  let same_endpoint a b =
    same_slot a b
    && String.equal
         (Connection_profile.socket a.connection)
         (Connection_profile.socket b.connection)
  ;;
end

module Document = struct
  type t =
    { id : Id.Resource.t
    ; source : string
    }

  let create ~id ~source =
    Json.decode (fun () ->
      if String.length source > source_limit
      then Json.fail Invalid_argument "personal configuration source exceeds 64KiB";
      (* Canonical string encoding validates UTF-8, without parsing/coercing an
         unknown configuration version or changing the retained source. *)
      ignore (Json.canonical (Json.string source) : string);
      { id; source })
  ;;

  let to_json t =
    Json.obj [ "id", Id.Resource.jsonaf_of_t t.id; "source", Json.string t.source ]
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields value ~allowed:[ "id"; "source" ];
      create
        ~id:(Id.Resource.t_of_jsonaf (Json.field value "id"))
        ~source:(Json.text (Json.field value "source"))
      |> Disk.unwrap)
  ;;
end

type bucket =
  { target : Target.t
  ; documents : Document.t list
  ; selected_id : Id.Resource.t option
  }

module Snapshot = struct
  type t =
    { revision : int
    ; bucket : bucket
    }

  let revision t = t.revision
  let documents t = t.bucket.documents
  let selected_id t = t.bucket.selected_id

  let to_json t =
    Json.obj
      [ "revision", Json.int t.revision
      ; "target", Target.to_json t.bucket.target
      ; "documents", `Array (List.map t.bucket.documents ~f:Document.to_json)
      ; ( "selected_id"
        , Option.value_map t.bucket.selected_id ~default:`Null ~f:Id.Resource.jsonaf_of_t
        )
      ]
  ;;
end

type state =
  { revision : int
  ; buckets : bucket list
  }

type t =
  { root : State_root.t
  ; mutex : Eio.Mutex.t
  ; mutable state : state
  ; mutable publication_fenced : bool
  }

let validate_documents documents selected_id =
  if List.length documents > document_limit
  then Json.fail Invalid_argument "personal settings permit at most 25 documents";
  let ids = List.map documents ~f:(fun document -> document.Document.id) in
  if List.contains_dup ids ~compare:Id.Resource.compare
  then Json.fail Invalid_argument "personal configuration IDs must be unique";
  Option.iter selected_id ~f:(fun id ->
    if not (List.mem ids id ~equal:Id.Resource.equal)
    then Json.fail Invalid_argument "selected personal configuration must exist")
;;

let bucket_json bucket =
  Json.obj
    [ "target", Target.to_json bucket.target
    ; "documents", `Array (List.map bucket.documents ~f:Document.to_json)
    ; ( "selected_id"
      , Option.value_map bucket.selected_id ~default:`Null ~f:Id.Resource.jsonaf_of_t )
    ]
;;

let storage state =
  Json.obj
    [ "format", Json.string "workgraph-ui-view-settings-1"
    ; "revision", Json.int state.revision
    ; "buckets", `Array (List.map state.buckets ~f:bucket_json)
    ]
;;

let validate_state state =
  if
    List.sum (module Int) state.buckets ~f:(fun bucket -> List.length bucket.documents)
    > document_limit
  then
    Json.fail Invalid_argument "private view settings capacity is 25 documents globally";
  if String.length (Json.canonical (storage state)) > metadata_limit
  then
    Json.fail
      Invalid_argument
      "private view settings envelope exceeds 2MiB including UTF-8 and escaping overhead"
;;

let load root =
  let document = State_root.read root ~name:metadata_name |> Disk.unwrap in
  match document with
  | None -> { revision = 0; buckets = [] }
  | Some value ->
    Json.fields value ~allowed:[ "format"; "revision"; "buckets" ];
    if
      not
        (String.equal
           (Json.text (Json.field value "format"))
           "workgraph-ui-view-settings-1")
    then Json.fail Unsupported_version "unsupported private view settings storage";
    let revision = Json.integer (Json.field value "revision") in
    if revision = 0
    then Json.fail Corrupt_store "stored private view settings revision must be positive";
    let buckets = Json.list (Json.field value "buckets") in
    if List.length buckets > document_limit
    then Json.fail Corrupt_store "too many private view settings target buckets";
    let buckets =
      List.map buckets ~f:(fun value ->
        Json.fields value ~allowed:[ "target"; "documents"; "selected_id" ];
        let target = Target.of_json (Json.field value "target") in
        let documents =
          Json.list (Json.field value "documents")
          |> List.map ~f:(fun document -> Document.of_json document |> Disk.unwrap)
        in
        let selected_id =
          match Json.field value "selected_id" with
          | `Null -> None
          | value -> Some (Id.Resource.t_of_jsonaf value)
        in
        if List.is_empty documents
        then Json.fail Corrupt_store "empty private view settings bucket is not stored";
        validate_documents documents selected_id;
        { target; documents; selected_id })
    in
    List.iteri buckets ~f:(fun index bucket ->
      if
        List.exists
          (List.drop buckets (index + 1))
          ~f:(fun other -> Target.same_slot bucket.target other.target)
      then Json.fail Corrupt_store "duplicate private view settings target");
    let state = { revision; buckets } in
    validate_state state;
    state
;;

let create root =
  Json.decode (fun () ->
    { root; mutex = Eio.Mutex.create (); state = load root; publication_fenced = false })
;;

let locked t f =
  Eio.Mutex.lock t.mutex;
  Exn.protect ~finally:(fun () -> Eio.Mutex.unlock t.mutex) ~f
;;

let snapshot state target =
  let bucket =
    match
      List.find state.buckets ~f:(fun bucket -> Target.same_slot bucket.target target)
    with
    | Some bucket ->
      if not (Target.same_endpoint bucket.target target)
      then
        Json.fail
          Conflict
          "personal settings endpoint differs from its retained generation";
      bucket
    | None -> { target; documents = []; selected_id = None }
  in
  { Snapshot.revision = state.revision; bucket }
;;

let reload t =
  (* A failed reconciliation must not leave cached guards writable. Set before
     I/O so cancellation and unexpected errors fence equally. *)
  t.publication_fenced <- true;
  let state = load t.root in
  if state.revision < t.state.revision
  then Json.fail Corrupt_store "private settings revision regressed";
  state
;;

let read t target =
  locked t (fun () ->
    Json.decode (fun () ->
      let state = reload t in
      let result = snapshot state target in
      t.state <- state;
      t.publication_fenced <- false;
      result))
;;

let list t =
  locked t (fun () ->
    Json.decode (fun () ->
      let state = reload t in
      let result =
        Json.obj
          [ "revision", Json.int state.revision
          ; ( "items"
            , `Array
                (List.map state.buckets ~f:(fun bucket ->
                   Json.obj
                     [ "target", Target.to_json bucket.target
                     ; ( "document_ids"
                       , `Array
                           (List.map bucket.documents ~f:(fun document ->
                              Id.Resource.jsonaf_of_t document.Document.id)) )
                     ; ( "selected_id"
                       , Option.value_map
                           bucket.selected_id
                           ~default:`Null
                           ~f:Id.Resource.jsonaf_of_t )
                     ])) )
          ]
      in
      t.state <- state;
      t.publication_fenced <- false;
      result))
;;

let replace t target ~expected_revision ~documents ~selected_id =
  locked t (fun () ->
    Json.decode (fun () ->
      if t.publication_fenced
      then
        Json.fail
          Outcome_unknown
          "private settings publication is uncertain; explicitly inspect durable settings";
      if expected_revision < 0 || expected_revision <> t.state.revision
      then
        Json.fail Conflict "private settings revision changed; original draft is retained";
      if t.state.revision = Int.max_value
      then Json.fail Conflict "private settings revision is exhausted";
      ignore (snapshot t.state target : Snapshot.t);
      validate_documents documents selected_id;
      let buckets =
        List.filter t.state.buckets ~f:(fun bucket ->
          not (Target.same_slot bucket.target target))
      in
      let buckets =
        if List.is_empty documents
        then buckets
        else buckets @ [ { target; documents; selected_id } ]
      in
      let state = { revision = t.state.revision + 1; buckets } in
      validate_state state;
      (* Set before suspension; a canceled/failed sync may have installed bytes.
         No later replace can reuse a stale guard until explicit readback. *)
      t.publication_fenced <- true;
      (match State_root.save t.root ~name:metadata_name ~value:(storage state) with
       | Ok () -> ()
       | Error problem ->
         Json.fail
           Outcome_unknown
           ("Private settings publication needs explicit reconciliation ("
            ^ Sexp.to_string (Problem.sexp_of_kind problem.kind)
            ^ "): "
            ^ problem.message));
      t.state <- state;
      t.publication_fenced <- false;
      snapshot state target))
;;
