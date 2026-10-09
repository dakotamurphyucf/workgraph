open Core

let of_params params =
  let value =
    Option.value_map (Json.optional params "max_bytes") ~default:65_536 ~f:Json.integer
  in
  if value < 4096 || value > 1024 * 1024
  then Json.fail Invalid_argument "max_bytes must be 4096..1048576";
  value
;;

let prefix text ~max_bytes =
  if max_bytes < 0 then Json.fail Invalid_argument "prefix byte count is negative";
  let rec boundary n =
    if n > 0 && n < String.length text && Char.to_int text.[n] land 0xc0 = 0x80
    then boundary (n - 1)
    else n
  in
  String.prefix text (boundary (Int.min (String.length text) max_bytes))
;;

let text_field = function
  | "title"
  | "name"
  | "description"
  | "body"
  | "summary"
  | "instructions"
  | "objective"
  | "completed"
  | "decisions"
  | "blockers"
  | "next_steps"
  | "evidence"
  | "acceptance_criteria"
  | "reason"
  | "snippet" -> true
  | _ -> false
;;

let pointer key =
  String.substr_replace_all
    (String.substr_replace_all key ~pattern:"~" ~with_:"~0")
    ~pattern:"/"
    ~with_:"~1"
;;

let fit ?(measure = fun json -> String.length (Json.canonical json)) ~max_bytes value =
  if max_bytes < 4096 || max_bytes > 1024 * 1024
  then Json.fail Invalid_argument "invalid query budget";
  let attempt ~text_cap ~array_cap ~detail_cap =
    let omitted_fields = ref 0
    and omitted_items = ref 0
    and details = ref []
    and locations = ref 0 in
    let note path kind count =
      incr locations;
      if List.length !details < detail_cap
      then
        details
        := Json.obj
             [ "path", Json.string path
             ; "kind", Json.string kind
             ; "omitted", Json.int count
             ]
           :: !details
    in
    let rec trim path field = function
      | `String text when text_field field && String.length text > text_cap ->
        let selected = prefix text ~max_bytes:text_cap in
        incr omitted_fields;
        note path "text_bytes" (String.length text - String.length selected);
        Json.string selected
      | `Array [ `String tag; ((`Object _ | `Array _) as payload) ]
        when String.length tag > 0 && Char.is_uppercase tag.[0] ->
        `Array [ Json.string tag; trim (path ^ "/1") "" payload ]
      | `Array [ `String tag ] when String.length tag > 0 && Char.is_uppercase tag.[0] ->
        `Array [ Json.string tag ]
      | `Array items ->
        let selected = List.take items array_cap in
        let removed = List.length items - List.length selected in
        if removed > 0
        then (
          omitted_items := !omitted_items + removed;
          note path "items" removed);
        `Array
          (List.mapi selected ~f:(fun index item ->
             trim (path ^ "/" ^ Int.to_string index) "" item))
      | `Object fields ->
        let is_page =
          List.Assoc.mem fields "items" ~equal:String.equal
          && List.Assoc.mem fields "next_offset" ~equal:String.equal
          && List.Assoc.mem fields "offset" ~equal:String.equal
        in
        let result =
          List.map fields ~f:(fun (key, value) ->
            key, trim (path ^ "/" ^ pointer key) key value)
        in
        let is_serial_page =
          List.Assoc.mem fields "items" ~equal:String.equal
          && List.Assoc.mem fields "next_after" ~equal:String.equal
          && List.Assoc.mem fields "after" ~equal:String.equal
        in
        if is_serial_page
        then (
          let original = Json.obj fields in
          let retained = Json.list (Json.field (Json.obj result) "items") in
          let remaining =
            Json.integer (Json.field original "remaining")
            + List.length (Json.list (Json.field original "items"))
            - List.length retained
          in
          let cursor =
            Option.value_map
              (List.last retained)
              ~default:(Json.field original "after")
              ~f:(fun item -> Json.field item "notification_id")
          in
          Json.obj
            (List.map result ~f:(fun (key, value) ->
               ( key
               , match key with
                 | "remaining" -> Json.int remaining
                 | "next_after" -> cursor
                 | _ -> value ))))
        else if not is_page
        then Json.obj result
        else (
          let old = Json.obj fields in
          let result_json = Json.obj result in
          let before = List.length (Json.list (Json.field old "items")) in
          let after = List.length (Json.list (Json.field result_json "items")) in
          let remaining = Json.integer (Json.field old "remaining") + before - after in
          let offset = Json.integer (Json.field old "offset") in
          Json.obj
            (List.map result ~f:(fun (key, value) ->
               ( key
               , match key with
                 | "remaining" -> Json.int remaining
                 | "next_offset" ->
                   if remaining > 0 then Json.int (offset + after) else `Null
                 | _ -> value ))))
      | (`Null | `True | `False | `String _ | `Number _) as value -> value
    in
    let data = trim "" "" value in
    let truncated = !omitted_fields > 0 || !omitted_items > 0 in
    let metadata bytes =
      Json.obj
        [ "max_bytes", Json.int max_bytes
        ; "returned_bytes", Json.int bytes
        ; ("truncated", if truncated then `True else `False)
        ; "omitted_fields", Json.int !omitted_fields
        ; "omitted_items", Json.int !omitted_items
        ; "details", `Array (List.rev !details)
        ; ( "details_complete"
          , if (not truncated) || detail_cap >= !locations then `True else `False )
        ]
    in
    let wrap bytes =
      match data with
      | `Object fields -> Json.obj (fields @ [ "budget", metadata bytes ])
      | _ -> Json.obj [ "data", data; "budget", metadata bytes ]
    in
    let rec sized bytes =
      let result = wrap bytes in
      let size = measure result in
      if Int.equal size bytes then result, size else sized size
    in
    sized 0
  in
  let profiles =
    [ Int.max_value, Int.max_value
    ; 32768, 100
    ; 16384, 100
    ; 8192, 100
    ; 4096, 50
    ; 2048, 25
    ; 1024, 10
    ; 512, 5
    ; 128, 1
    ; 0, 0
    ]
  in
  let rec choose = function
    | [] ->
      Json.fail
        Invalid_argument
        "query metadata exceeds byte budget; use a narrower query"
    | (text_cap, array_cap) :: rest ->
      let result, size = attempt ~text_cap ~array_cap ~detail_cap:4 in
      if size <= max_bytes
      then result
      else (
        let result, size = attempt ~text_cap ~array_cap ~detail_cap:0 in
        if size <= max_bytes then result else choose rest)
  in
  choose profiles
;;

let annotate_whole_items_exn
      ?(measure = fun json -> String.length (Json.canonical json))
      ~max_bytes
      ~omitted_items
      value
  =
  if max_bytes < 4096 || max_bytes > 1048576 || omitted_items < 0
  then Json.fail Invalid_argument "invalid whole-item query budget";
  let fields =
    match value with
    | `Object fields ->
      if List.Assoc.mem fields "budget" ~equal:String.equal
      then Json.fail Invalid_argument "whole-item candidate already has budget metadata";
      fields
    | _ -> Json.fail Invalid_argument "whole-item query candidate must be an object"
  in
  let details =
    if omitted_items = 0
    then []
    else
      [ Json.obj
          [ "path", Json.string "/items"
          ; "kind", Json.string "items"
          ; "omitted", Json.int omitted_items
          ]
      ]
  in
  let rec sized bytes =
    let budget =
      Json.obj
        [ "max_bytes", Json.int max_bytes
        ; "returned_bytes", Json.int bytes
        ; ("truncated", if omitted_items > 0 then `True else `False)
        ; "omitted_fields", Json.int 0
        ; "omitted_items", Json.int omitted_items
        ; "details", `Array details
        ; "details_complete", `True
        ]
    in
    let result = Json.obj (fields @ [ "budget", budget ]) in
    let size = measure result in
    if size < 0 then Json.fail Invalid_argument "negative encoded query size";
    if Int.equal bytes size then result else sized size
  in
  sized 0
;;
