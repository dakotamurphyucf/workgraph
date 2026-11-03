open Core

type t =
  { after : int
  ; through : int
  ; offset : int
  ; clock : int64
  ; anchor : string
  }

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let filter_hash filter = Json.hash (Json.canonical filter)

let encode t ~workspace ~filter =
  let payload =
    Json.obj
      [ "version", Json.int 1
      ; "workspace", Id.Workspace.jsonaf_of_t workspace
      ; "filter", Json.string (filter_hash filter)
      ; "after", Json.int t.after
      ; "through", Json.int t.through
      ; "offset", Json.int t.offset
      ; "clock", Json.int64 t.clock
      ; "anchor", Json.string t.anchor
      ]
  in
  Json.obj
    [ "payload", payload; "checksum", Json.string (Json.hash (Json.canonical payload)) ]
  |> Json.canonical
  |> Base64.encode_string
;;

let capture ~workspace ~revision ~activity ~filter ~after ~cursor ~now_unix_ms =
  Json.decode (fun () ->
    let fresh after =
      if after > revision
      then Json.fail Conflict "attention position exceeds available history";
      { after
      ; through = revision
      ; offset = 0
      ; clock = now_unix_ms
      ; anchor =
          Planning_lineage.of_activity activity ~through:revision
          |> unwrap
          |> Planning_lineage.digest
      }
    in
    match cursor with
    | None -> fresh (Option.value after ~default:0)
    | Some encoded ->
      if Option.is_some after
      then Json.fail Invalid_argument "provide cursor or after, not both";
      let bytes =
        match Base64.decode encoded with
        | Ok bytes when String.equal encoded (Base64.encode_string bytes) -> bytes
        | Ok _ | Error _ -> Json.fail Invalid_argument "invalid attention cursor"
      in
      let envelope = Json.parse bytes |> unwrap in
      Json.fields envelope ~allowed:[ "payload"; "checksum" ];
      let payload = Json.field envelope "payload" in
      Json.fields
        payload
        ~allowed:
          [ "version"
          ; "workspace"
          ; "filter"
          ; "after"
          ; "through"
          ; "offset"
          ; "clock"
          ; "anchor"
          ];
      if
        not
          (String.equal
             (Json.field envelope "checksum" |> Json.text)
             (Json.hash (Json.canonical payload)))
      then Json.fail Invalid_argument "attention cursor integrity check failed";
      if Json.field payload "version" |> Json.integer <> 1
      then Json.fail Unsupported_version "unsupported attention cursor";
      if
        (not
           (Id.Workspace.equal
              workspace
              (Json.field payload "workspace" |> Id.Workspace.t_of_jsonaf)))
        || not
             (String.equal
                (filter_hash filter)
                (Json.field payload "filter" |> Json.text))
      then Json.fail Conflict "attention cursor workspace or filters changed";
      let t =
        { after = Json.field payload "after" |> Json.integer
        ; through = Json.field payload "through" |> Json.integer
        ; offset = Json.field payload "offset" |> Json.integer
        ; clock = Json.field payload "clock" |> Json.integer64
        ; anchor = Json.field payload "anchor" |> Json.text
        }
      in
      if
        (t.after = t.through && t.offset <> 0)
        || t.after > t.through
        || t.through > revision
        || Int64.(t.clock > now_unix_ms)
      then Json.fail Conflict "attention cursor capture unavailable";
      let lineage = Planning_lineage.of_activity activity ~through:t.through |> unwrap in
      if not (String.equal t.anchor (Planning_lineage.digest lineage))
      then Json.fail Conflict "attention history lineage changed";
      if t.after = t.through then fresh t.through else t)
;;

let advance t ~count ~complete =
  if complete
  then { t with after = t.through; offset = 0 }
  else { t with offset = t.offset + count }
;;

let current_page
      ~workspace
      ~revision
      ~activity
      ~filter
      ~cursor
      ~now_unix_ms
      ~rows
      ~limit
      ~max_bytes
  =
  Json.decode (fun () ->
    let captured =
      capture ~workspace ~revision ~activity ~filter ~after:None ~cursor ~now_unix_ms
      |> unwrap
    in
    if captured.through <> revision
    then Json.fail Conflict "current attention capture changed; rescan required";
    if captured.offset > List.length rows
    then Json.fail Conflict "current attention row position unavailable";
    let remaining = List.drop rows captured.offset in
    let envelope selected ~needs_larger_budget ~required_bytes =
      let count = List.length selected in
      let complete = count = List.length remaining in
      let data =
        Json.obj
          [ "workspace_revision", Json.int revision
          ; "observed_unix_ms", Json.int64 captured.clock
          ; "items", `Array selected
          ; ( "cursor"
            , if complete
              then `Null
              else
                Json.string
                  (encode
                     { captured with offset = captured.offset + count }
                     ~workspace
                     ~filter) )
          ; ("has_more", if complete then `False else `True)
          ; ("needs_larger_budget", if needs_larger_budget then `True else `False)
          ; "required_bytes", Option.value_map required_bytes ~default:`Null ~f:Json.int
          ]
      in
      Json.obj [ "workspace_revision", Json.int revision; "data", data ]
      |> Query_budget.annotate_whole_items_exn
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items:(Int.min limit (List.length remaining) - count)
    in
    let required =
      Option.map (List.hd remaining) ~f:(fun row ->
        Api_response.encoded_size
          Planning_read
          (envelope [ row ] ~needs_larger_budget:false ~required_bytes:None))
    in
    let rec fit count =
      let selected = List.take remaining count in
      let result =
        envelope
          selected
          ~needs_larger_budget:(count = 0 && not (List.is_empty remaining))
          ~required_bytes:(if count = 0 then required else None)
      in
      if Api_response.encoded_size Planning_read result <= max_bytes
      then result
      else if count > 0
      then fit (count - 1)
      else Json.fail Invalid_argument "attention page metadata exceeds byte budget"
    in
    fit (Int.min limit (List.length remaining)))
;;
