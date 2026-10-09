open Core

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let bool value = if value then `True else `False

let lineage ~activity ~through ~checkpoint =
  let capture, observed =
    unwrap (Planning_lineage.with_checkpoint activity ~through ~checkpoint)
  in
  Planning_lineage.digest capture, observed
;;

let change_kinds event =
  Json.list (Json.field event "changes")
  |> List.filter_map ~f:(function
    | `Array (`String kind :: _) -> Some (String.lowercase kind)
    | _ -> None)
  |> List.dedup_and_sort ~compare:String.compare
;;

let read ~workspace ~revision ~activity ~params =
  Json.decode (fun () ->
    let request =
      Coordination_wire.decode_exn
        (Option.value_exn (Change_feed_api.Request.codec ~method_:"changes.read"))
        params
    in
    if not (Id.Workspace.equal (Change_feed_api.Request.workspace request) workspace)
    then Json.fail Invalid_argument "feed workspace differs from loaded workspace";
    let source_kind = Change_feed_api.Request.source request in
    let source =
      match source_kind with
      | Planning -> "planning"
      | History -> "history"
    in
    let target = Change_feed_api.Request.target request in
    let project = Change_feed_api.Request.project request in
    let actor = Change_feed_api.Request.actor request in
    let kinds = Change_feed_api.Request.kinds request in
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
      match Change_feed_api.Request.cursor request with
      | None ->
        let after = Option.value (Change_feed_api.Request.after request) ~default:0 in
        after, revision, None
      | Some encoded ->
        if Option.is_some (Change_feed_api.Request.after request)
        then Json.fail Invalid_argument "provide cursor or after, not both";
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
    let limit = Change_feed_api.Request.limit request in
    let max_bytes = Change_feed_api.Request.max_bytes request in
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
      let value : Change_feed_api.Item.t =
        { revision = Json.integer (Json.field event "revision")
        ; actor_id = Id.Actor.t_of_jsonaf (Json.field event "actor")
        ; timestamp = Json.text (Json.field event "timestamp")
        ; targets =
            List.map (Json.list (Json.field event "targets")) ~f:Entity_ref.t_of_jsonaf
        ; kinds = change_kinds event
        ; run_id =
            (match Json.optional event "run_id" with
             | None | Some `Null -> None
             | Some value -> Some (Id.Run.t_of_jsonaf value))
        }
      in
      Coordination_wire.encode_exn Change_feed_api.Item.codec value
    in
    let initial_count = Int.min limit total in
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
        |> Query_budget.annotate_whole_items_exn
             ~measure:(Api_response.encoded_size Feed)
             ~max_bytes
             ~omitted_items:(initial_count - count)
      in
      if Api_response.encoded_size Feed result <= max_bytes
      then result
      else if count > 0
      then fit (count - 1)
      else Json.fail Invalid_argument "feed metadata envelope exceeds byte budget"
    in
    fit initial_count)
;;

let has_items response =
  match Json.optional response "items" with
  | Some (`Array (_ :: _)) -> true
  | Some (`Array []) | Some _ | None -> false
;;
