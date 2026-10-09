open Core
module W = Coordination_wire

let prose_fields = Resume_api.prose_fields

let create ~kind ~summary ~sources ~record ~max_field_bytes =
  if max_field_bytes < 1
  then Json.fail Invalid_argument "prose excerpt budget must be positive";
  let clips = ref [] in
  let record =
    match record with
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (field, value) ->
           if List.mem (prose_fields kind) field ~equal:String.equal
           then (
             match value with
             | `String original when String.length original > max_field_bytes ->
               let excerpt = Query_budget.prefix original ~max_bytes:max_field_bytes in
               clips
               := Json.obj
                    [ "field", Json.string field
                    ; "original_bytes", Json.int (String.length original)
                    ; ( "omitted_bytes"
                      , Json.int (String.length original - String.length excerpt) )
                    ]
                  :: !clips;
               field, Json.string excerpt
             | _ -> field, value)
           else field, value))
    | _ -> record
  in
  W.decode_exn
    Resume_api.item_codec
    (Json.obj
       [ "kind", Json.string kind
       ; "summary", Json.string (Query_budget.prefix summary ~max_bytes:1024)
       ; ( "sources"
         , `Array
             (List.map
                (List.fold sources ~init:[] ~f:(fun acc source ->
                   if List.mem acc source ~equal:Resume_source.equal
                   then acc
                   else acc @ [ source ]))
                ~f:(W.encode_exn Resume_source.codec)) )
       ; "record", record
       ; "clipped_fields", `Array (List.rev !clips)
       ])
;;

let escape text =
  String.concat_map text ~f:(fun c ->
    if List.mem [ '\\'; '`'; '*'; '_'; '['; ']'; '<'; '>' ] c ~equal:Char.equal
    then "\\" ^ String.of_char c
    else String.of_char c)
;;

let block text =
  let rec fence n =
    let f = String.make n '`' in
    if String.is_substring text ~substring:f then fence (n + 1) else f
  in
  let fence = fence 3 in
  fence ^ "\n" ^ text ^ "\n" ^ fence
;;

let markdown items =
  List.map items ~f:(fun item ->
    let kind = Json.field item "kind" |> Json.text in
    let record = Json.field item "record" in
    let lines =
      List.filter_map (prose_fields kind) ~f:(fun field ->
        Option.bind (Json.optional record field) ~f:(function
          | `String text when not (String.is_empty text) ->
            Some (escape field ^ ":\n" ^ block text)
          | _ -> None))
    in
    let lines =
      if String.equal kind "fact"
      then (
        match Json.optional record "value" with
        | Some value -> lines @ [ block (Json.canonical value) ]
        | None -> lines)
      else lines
    in
    let metadata =
      match record with
      | `Object fields ->
        Json.obj
          (List.filter fields ~f:(fun (name, _) ->
             (not (List.mem (prose_fields kind) name ~equal:String.equal))
             && not (String.equal kind "fact" && String.equal name "value")))
      | value -> value
    in
    let lines =
      lines @ [ "Recorded controls and metadata:\n" ^ block (Json.canonical metadata) ]
    in
    let clips = Json.list (Json.field item "clipped_fields") in
    let lines =
      if List.is_empty clips
      then lines
      else
        lines
        @ [ "Prose excerpts (byte counts):\n" ^ block (Json.canonical (`Array clips)) ]
    in
    let sources =
      Json.list (Json.field item "sources")
      |> List.map ~f:(fun s ->
        W.decode_exn Resume_source.codec s |> Resume_source.label |> escape)
    in
    String.concat
      ~sep:"\n\n"
      ([ "### " ^ escape (Json.field item "summary" |> Json.text) ]
       @ lines
       @ [ "Sources: " ^ String.concat ~sep:"; " sources ]))
  |> String.concat ~sep:"\n\n"
;;

let count ~section ~total ~returned =
  if total < returned || returned < 0
  then Json.fail Invalid_argument "invalid section counts";
  Json.obj
    [ "section", Json.string section
    ; "total", Json.int total
    ; "returned", Json.int returned
    ; "omitted", Json.int (total - returned)
    ]
;;

let envelope ~revision data =
  Json.obj [ "workspace_revision", Json.int revision; "data", data ]
;;

let markdown_context ~capture ~warnings ~counts ~cursor ~has_more =
  "Capture and continuation:\n"
  ^ block
      (Json.canonical
         (Json.obj
            [ "capture", capture
            ; "cursor", Json.string cursor
            ; ("has_more", if has_more then `True else `False)
            ]))
  ^ "\n\nWarnings:\n"
  ^ block (Json.canonical (`Array warnings))
  ^ "\n\nSection counts:\n"
  ^ block (Json.canonical (`Array counts))
;;
