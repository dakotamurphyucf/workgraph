open Core

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let bool value = if value then `True else `False

let lineage ~activity ~through ~checkpoint =
  let initial = Json.hash "workgraph-feed-lineage-v1" in
  let rec fold entries ~next_revision ~digest ~checkpoint_digest =
    if next_revision > through
    then digest, checkpoint_digest
    else (
      match entries with
      | [] -> Json.fail Corrupt_store "feed audit prefix is incomplete"
      | event :: rest ->
        if Json.integer (Json.field event "revision") <> next_revision
        then Json.fail Corrupt_store "feed audit revisions are not contiguous";
        let digest = Json.hash (digest ^ Json.canonical event) in
        let checkpoint_digest =
          if Option.exists checkpoint ~f:(Int.equal next_revision)
          then Some digest
          else checkpoint_digest
        in
        fold rest ~next_revision:(next_revision + 1) ~digest ~checkpoint_digest)
  in
  fold
    (List.rev activity)
    ~next_revision:1
    ~digest:initial
    ~checkpoint_digest:
      (if Option.exists checkpoint ~f:(Int.equal 0) then Some initial else None)
;;

let change_kinds event =
  Json.list (Json.field event "changes")
  |> List.filter_map ~f:(function
    | `Array (`String kind :: _) -> Some kind
    | _ -> None)
  |> List.dedup_and_sort ~compare:String.compare
;;

let read ~workspace ~revision ~activity ~params =
  Json.decode (fun () ->
    Json.fields
      params
      ~allowed:
        [ "workspace_id"
        ; "source"
        ; "after"
        ; "cursor"
        ; "target"
        ; "project_id"
        ; "actor_id"
        ; "kinds"
        ; "limit"
        ; "max_bytes"
        ];
    let supplied = Id.Workspace.t_of_jsonaf (Json.field params "workspace_id") in
    if not (Id.Workspace.equal supplied workspace)
    then Json.fail Invalid_argument "feed workspace differs from loaded workspace";
    let source =
      Option.value_map (Json.optional params "source") ~default:"planning" ~f:Json.text
    in
    if not (List.mem [ "planning"; "history" ] source ~equal:String.equal)
    then Json.fail Invalid_argument "feed source must be planning or history";
    let target = Option.map (Json.optional params "target") ~f:Entity_ref.t_of_jsonaf in
    let project =
      Option.map (Json.optional params "project_id") ~f:Id.Project.t_of_jsonaf
    in
    let actor = Option.map (Json.optional params "actor_id") ~f:Id.Actor.t_of_jsonaf in
    let kinds =
      Option.value_map (Json.optional params "kinds") ~default:[] ~f:(fun value ->
        let kinds = Json.list value in
        if List.length kinds > 32 then Json.fail Invalid_argument "at most 32 feed kinds";
        List.map kinds ~f:(fun kind -> Json.bounded_text kind ~max_bytes:128)
        |> List.dedup_and_sort ~compare:String.compare)
    in
    let optional encode = Option.value_map ~default:`Null ~f:encode in
    let filter_hash =
      Json.obj
        [ "source", Json.string source
        ; "target", optional Entity_ref.jsonaf_of_t target
        ; "project", optional Id.Project.jsonaf_of_t project
        ; "actor", optional Id.Actor.jsonaf_of_t actor
        ; "kinds", `Array (List.map kinds ~f:Json.string)
        ]
      |> Json.canonical
      |> Json.hash
    in
    let cursor after through anchor =
      Json.obj
        [ "version", Json.int 1
        ; "workspace", Id.Workspace.jsonaf_of_t workspace
        ; "filter", Json.string filter_hash
        ; "after", Json.int after
        ; "through", Json.int through
        ; "anchor", Json.string anchor
        ]
      |> Json.canonical
      |> Base64.encode_string
      |> Json.string
    in
    let after, through, checkpoint =
      match Json.optional params "cursor" with
      | None ->
        let after =
          Option.value_map (Json.optional params "after") ~default:0 ~f:Json.integer
        in
        after, revision, None
      | Some encoded ->
        if Option.is_some (Json.optional params "after")
        then Json.fail Invalid_argument "provide cursor or after, not both";
        let encoded = Json.bounded_text encoded ~max_bytes:2048 in
        let bytes =
          match Base64.decode encoded with
          | Ok bytes when String.equal encoded (Base64.encode_string bytes) -> bytes
          | Ok _ | Error _ -> Json.fail Invalid_argument "invalid feed cursor"
        in
        let value = Json.parse bytes |> unwrap in
        Json.fields
          value
          ~allowed:[ "version"; "workspace"; "filter"; "after"; "through"; "anchor" ];
        if Json.integer (Json.field value "version") <> 1
        then Json.fail Unsupported_version "unsupported feed cursor";
        if
          (not
             (Id.Workspace.equal
                workspace
                (Id.Workspace.t_of_jsonaf (Json.field value "workspace"))))
          || not (String.equal filter_hash (Json.text (Json.field value "filter")))
        then
          Json.fail Conflict "feed cursor workspace or filters changed; start a new scan";
        let after = Json.integer (Json.field value "after") in
        let upper = Json.integer (Json.field value "through") in
        let anchor = Json.text (Json.field value "anchor") in
        if
          String.length anchor <> 64
          || not
               (String.for_all anchor ~f:(fun c ->
                  Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
        then Json.fail Invalid_argument "invalid feed lineage anchor";
        if after > upper || upper > revision
        then Json.fail Conflict "feed cursor history is unavailable; start a new scan";
        after, (if after = upper then revision else upper), Some (upper, anchor)
    in
    if after > revision
    then Json.fail Conflict "feed position exceeds available history; start a new scan";
    let anchor, checkpoint_digest =
      lineage ~activity ~through ~checkpoint:(Option.map checkpoint ~f:fst)
    in
    Option.iter checkpoint ~f:(fun (_, expected) ->
      if not (Option.exists checkpoint_digest ~f:(String.equal expected))
      then Json.fail Conflict "feed cursor history changed; start a new scan");
    let limit =
      Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
    in
    if limit < 1 || limit > 100 then Json.fail Invalid_argument "limit must be 1..100";
    let max_bytes = Query_budget.of_params params in
    let matches event =
      let position = Json.integer (Json.field event "revision") in
      let targets =
        Json.list (Json.field event "targets") |> List.map ~f:Entity_ref.t_of_jsonaf
      in
      position > after
      && position <= through
      && Option.for_all target ~f:(fun target ->
        List.mem targets target ~equal:Entity_ref.equal)
      && Option.for_all project ~f:(fun project ->
        List.mem targets (Entity_ref.Project project) ~equal:Entity_ref.equal)
      && Option.for_all actor ~f:(fun actor ->
        Id.Actor.equal actor (Id.Actor.t_of_jsonaf (Json.field event "actor")))
      && (List.is_empty kinds
          || List.exists (change_kinds event) ~f:(fun kind ->
            List.mem kinds kind ~equal:String.equal))
    in
    let matching = List.rev_filter activity ~f:matches in
    let total = List.length matching in
    let metadata event =
      Json.obj
        ([ "revision", Json.field event "revision"
         ; "actor", Json.field event "actor"
         ; "timestamp", Json.field event "timestamp"
         ; "targets", Json.field event "targets"
         ; "kinds", `Array (List.map (change_kinds event) ~f:Json.string)
         ]
         @ Option.to_list
             (Option.map (Json.optional event "run_id") ~f:(fun value -> "run_id", value))
        )
    in
    let rec fit count =
      let selected = List.take matching count in
      let count = List.length selected in
      let last =
        Option.value_map (List.last selected) ~default:after ~f:(fun event ->
          Json.integer (Json.field event "revision"))
      in
      let next = if count = total then through else last in
      let result =
        Json.obj
          [ "source", Json.string source
          ; "workspace_revision", Json.int revision
          ; "through", Json.int through
          ; "items", `Array (List.map selected ~f:metadata)
          ; "cursor", cursor next through anchor
          ; "has_more", bool (count < total)
          ; "needs_larger_budget", bool (count = 0 && total > 0)
          ]
        |> Query_budget.fit ~max_bytes
      in
      let retained = List.length (Json.list (Json.field result "items")) in
      if retained < count then fit retained else result
    in
    fit (Int.min limit total))
;;

let has_items response =
  match Json.optional response "items" with
  | Some (`Array (_ :: _)) -> true
  | Some (`Array []) | Some _ | None -> false
;;
