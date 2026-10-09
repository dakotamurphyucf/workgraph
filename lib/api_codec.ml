open Core

type 'a t =
  { decode_exn : Jsonaf.t -> 'a
  ; encode_exn : 'a -> Jsonaf.t
  ; schema : Jsonaf.t
  }

type 'a codec = 'a t

let decode t json = Json.decode (fun () -> t.decode_exn json)

let encode t value =
  Json.decode (fun () ->
    let json = t.encode_exn value in
    ignore (t.decode_exn json : _);
    json)
;;

let schema t = t.schema

let as_json t =
  { decode_exn =
      (fun json ->
        ignore (t.decode_exn json : _);
        json)
  ; encode_exn = Fn.id
  ; schema = t.schema
  }
;;

let rec object_field_names schema =
  let combine schemas =
    List.fold schemas ~init:(Some []) ~f:(fun names schema ->
      match names, object_field_names schema with
      | Some names, Some more -> Some (names @ more)
      | None, _ | _, None -> None)
    |> Option.map ~f:(List.dedup_and_sort ~compare:String.compare)
  in
  match Json.optional schema "properties" with
  | Some (`Object fields) -> Some (List.map fields ~f:fst)
  | _ ->
    (match Json.optional schema "allOf", Json.optional schema "oneOf" with
     | Some (`Array schemas), None | None, Some (`Array schemas) -> combine schemas
     | _ -> None)
;;

let field_names t = object_field_names t.schema

let merge_objects left right =
  let names codec =
    match field_names codec with
    | Some names -> names
    | None -> invalid_arg "merge_objects requires exact finite object codecs"
  in
  let left_names = names left in
  let right_names = names right in
  if List.exists left_names ~f:(fun name -> List.mem right_names name ~equal:String.equal)
  then invalid_arg "merge_objects fields overlap";
  let allowed = left_names @ right_names in
  (* Relax only the current object boundary. Nested properties/items retain
     their closed schemas. The outer unevaluatedProperties closes the union. *)
  let rec open_boundary = function
    | `Object fields ->
      Json.obj
        (List.filter_map fields ~f:(fun (name, value) ->
           match name, value with
           | ("additionalProperties" | "unevaluatedProperties"), _ -> None
           | ("allOf" | "oneOf"), `Array schemas ->
             Some (name, `Array (List.map schemas ~f:open_boundary))
           | _ -> Some (name, value)))
    | _ -> invalid_arg "codec schema must be an object"
  in
  let object_fields = function
    | `Object fields -> fields
    | _ -> Json.fail Invalid_argument "expected object"
  in
  { decode_exn =
      (fun json ->
        Json.fields json ~allowed;
        let left_fields, right_fields =
          object_fields json
          |> List.partition_tf ~f:(fun (name, _) ->
            List.mem left_names name ~equal:String.equal)
        in
        left.decode_exn (Json.obj left_fields), right.decode_exn (Json.obj right_fields))
  ; encode_exn =
      (fun (a, b) ->
        Json.obj (object_fields (left.encode_exn a) @ object_fields (right.encode_exn b)))
  ; schema =
      Json.obj
        [ "allOf", `Array [ open_boundary left.schema; open_boundary right.schema ]
        ; "unevaluatedProperties", `False
        ]
  }
;;

let require_bound name valid = if not valid then invalid_arg (name ^ " outside bounds")
let number value = `Number (Int.to_string value)

let json ~max_bytes ~max_depth =
  require_bound "JSON byte limit" (max_bytes > 0 && max_bytes <= 4 * 1024 * 1024);
  require_bound "JSON depth limit" (max_depth > 0 && max_depth <= 64);
  let rec check_depth level = function
    | `Object fields ->
      if level >= max_depth then Json.fail Invalid_argument "JSON exceeds nesting limit";
      List.iter fields ~f:(fun (_, value) -> check_depth (level + 1) value)
    | `Array values ->
      if level >= max_depth then Json.fail Invalid_argument "JSON exceeds nesting limit";
      List.iter values ~f:(check_depth (level + 1))
    | `Null | `False | `True | `String _ | `Number _ -> ()
  in
  { decode_exn =
      (fun value ->
        check_depth 0 value;
        if String.length (Json.canonical value) > max_bytes
        then Json.fail Invalid_argument "JSON exceeds canonical byte limit";
        value)
  ; encode_exn = Fn.id
  ; schema =
      Json.obj [ "x-maxCanonicalBytes", number max_bytes; "x-maxDepth", number max_depth ]
  }
;;

let text ~max_bytes =
  require_bound "text byte limit" (max_bytes >= 0);
  { decode_exn =
      (fun value ->
        let value = Json.bounded_text value ~max_bytes in
        let valid =
          Uutf.String.fold_utf_8
            (fun valid _ -> function
               | `Uchar _ -> valid
               | `Malformed _ -> false)
            true
            value
        in
        if not valid then Json.fail Invalid_argument "text requires valid UTF-8";
        value)
  ; encode_exn = Json.string
  ; schema = Json.obj [ "type", Json.string "string"; "x-maxUtf8Bytes", number max_bytes ]
  }
;;

let literal expected =
  let string = text ~max_bytes:(String.length expected) in
  (match decode string (Json.string expected) with
   | Ok _ -> ()
   | Error _ -> invalid_arg "literal requires valid UTF-8");
  { decode_exn =
      (fun json ->
        let actual = string.decode_exn json in
        if not (String.equal expected actual)
        then Json.fail Invalid_argument "unexpected literal string")
  ; encode_exn = (fun () -> Json.string expected)
  ; schema = Json.obj [ "type", Json.string "string"; "const", Json.string expected ]
  }
;;

let boolean =
  { decode_exn =
      (function
        | `True -> true
        | `False -> false
        | _ -> Json.fail Invalid_argument "expected boolean")
  ; encode_exn = (fun value -> if value then `True else `False)
  ; schema = Json.obj [ "type", Json.string "boolean" ]
  }
;;

let decimal_schema max =
  Json.obj
    [ "type", Json.string "string"
    ; "pattern", Json.string "^(0|[1-9][0-9]*)(?![\\s\\S])"
    ; "x-maximumDecimal", Json.string max
    ]
;;

let decimal ~max =
  require_bound "decimal maximum" (max >= 0);
  { decode_exn =
      (fun value ->
        let value = Json.integer value in
        if value > max then Json.fail Invalid_argument "decimal exceeds maximum";
        value)
  ; encode_exn = Json.int
  ; schema = decimal_schema (Int.to_string max)
  }
;;

let decimal64 ~max =
  require_bound "decimal maximum" (Int64.compare max 0L >= 0);
  { decode_exn =
      (fun value ->
        let value = Json.integer64 value in
        if Int64.compare value max > 0
        then Json.fail Invalid_argument "decimal exceeds maximum";
        value)
  ; encode_exn = Json.int64
  ; schema = decimal_schema (Int64.to_string max)
  }
;;

let nullable t =
  { decode_exn =
      (function
        | `Null -> None
        | json -> Some (t.decode_exn json))
  ; encode_exn = Option.value_map ~default:`Null ~f:t.encode_exn
  ; schema =
      Json.obj [ "anyOf", `Array [ t.schema; Json.obj [ "type", Json.string "null" ] ] ]
  }
;;

let list t ~max_items =
  require_bound "list item limit" (max_items >= 0);
  { decode_exn =
      (fun value ->
        let values = Json.list value in
        if List.length values > max_items
        then Json.fail Invalid_argument "list exceeds item limit";
        List.map values ~f:t.decode_exn)
  ; encode_exn = (fun values -> `Array (List.map values ~f:t.encode_exn))
  ; schema =
      Json.obj
        [ "type", Json.string "array"; "items", t.schema; "maxItems", number max_items ]
  }
;;

let map t ~decode ~encode ~description =
  { decode_exn =
      (fun json ->
        match decode (t.decode_exn json) with
        | Ok value -> value
        | Error problem -> raise (Json.Decode_error problem))
  ; encode_exn = (fun value -> t.encode_exn (encode value))
  ; schema =
      Json.obj [ "allOf", `Array [ t.schema ]; "description", Json.string description ]
  }
;;

let enum entries ~equal =
  let names = List.map entries ~f:fst in
  if List.is_empty entries || List.contains_dup names ~compare:String.compare
  then invalid_arg "enum requires distinct nonempty names";
  List.iter names ~f:(fun name ->
    if
      String.is_empty name
      || not
           (String.for_all name ~f:(fun c ->
              Char.is_lowercase c || Char.is_digit c || Char.equal c '_'))
    then invalid_arg "enum names must be lowercase");
  List.iteri entries ~f:(fun index (_, value) ->
    if
      List.exists (List.take entries index) ~f:(fun (_, previous) -> equal value previous)
    then invalid_arg "enum values must be distinct");
  { decode_exn =
      (fun json ->
        match List.Assoc.find entries (Json.text json) ~equal:String.equal with
        | Some value -> value
        | None -> Json.fail Invalid_argument "unknown enum value")
  ; encode_exn =
      (fun value ->
        match List.find entries ~f:(fun (_, candidate) -> equal value candidate) with
        | Some (name, _) -> Json.string name
        | None -> Json.fail Invalid_argument "unknown enum value")
  ; schema =
      Json.obj
        [ "type", Json.string "string"; "enum", `Array (List.map names ~f:Json.string) ]
  }
;;

type 'a reference =
  | Literal of 'a
  | Alias of string

let reference literal =
  let alias key =
    if
      String.is_empty key
      || String.length key > 96
      || not
           (String.for_all key ~f:(fun c ->
              Char.is_alphanum c || Char.equal c '_' || Char.equal c '-'))
    then
      Json.fail
        Invalid_argument
        "alias requires 1..96 ASCII letters, digits, underscores or hyphens";
    Alias key
  in
  { decode_exn =
      (fun json ->
        match json with
        | `String value when String.is_prefix value ~prefix:"$" ->
          alias (String.drop_prefix value 1)
        | `String value ->
          ignore (alias value : _ reference);
          Literal (literal.decode_exn json)
        | _ -> Json.fail Invalid_argument "reference requires an ID or $alias string")
  ; encode_exn =
      (function
        | Literal value -> literal.encode_exn value
        | Alias key ->
          ignore (alias key : _ reference);
          Json.string ("$" ^ key))
  ; schema =
      Json.obj
        [ ( "anyOf"
          , `Array
              [ Json.obj
                  [ ( "allOf"
                    , `Array
                        [ literal.schema
                        ; Json.obj
                            [ "type", Json.string "string"
                            ; "pattern", Json.string "^[A-Za-z0-9_-]{1,96}(?![\\s\\S])"
                            ]
                        ] )
                  ]
              ; Json.obj
                  [ "type", Json.string "string"
                  ; "pattern", Json.string "^\\$[A-Za-z0-9_-]{1,96}(?![\\s\\S])"
                  ; "maxLength", number 97
                  ]
              ] )
        ; ( "description"
          , Json.string "Literal entity ID or $alias resolved within transaction.apply." )
        ]
  }
;;

module Fields = struct
  type 'a t =
    { properties : (string * Jsonaf.t) list
    ; required : string list
    ; decode_exn : Jsonaf.t -> 'a
    ; encode_exn : 'a -> (string * Jsonaf.t) list
    }

  let empty =
    { properties = []
    ; required = []
    ; decode_exn = (fun _ -> ())
    ; encode_exn = (fun () -> [])
    }
  ;;

  let names t = List.map t.properties ~f:fst
  let check_name name = if String.is_empty name then invalid_arg "empty field name"

  let required name (codec : _ codec) =
    check_name name;
    { properties = [ name, codec.schema ]
    ; required = [ name ]
    ; decode_exn = (fun json -> codec.decode_exn (Json.field json name))
    ; encode_exn = (fun value -> [ name, codec.encode_exn value ])
    }
  ;;

  let optional name (codec : _ codec) =
    check_name name;
    { properties = [ name, codec.schema ]
    ; required = []
    ; decode_exn = (fun json -> Option.map (Json.optional json name) ~f:codec.decode_exn)
    ; encode_exn =
        (fun value ->
          Option.to_list (Option.map value ~f:(fun value -> name, codec.encode_exn value)))
    }
  ;;

  let both a b =
    let properties = a.properties @ b.properties in
    if List.contains_dup (List.map properties ~f:fst) ~compare:String.compare
    then invalid_arg "duplicate object field";
    { properties
    ; required = a.required @ b.required
    ; decode_exn = (fun json -> a.decode_exn json, b.decode_exn json)
    ; encode_exn = (fun (left, right) -> a.encode_exn left @ b.encode_exn right)
    }
  ;;

  let map t ~decode ~encode =
    { t with
      decode_exn = (fun json -> decode (t.decode_exn json))
    ; encode_exn = (fun value -> t.encode_exn (encode value))
    }
  ;;
end

let object_ (fields : _ Fields.t) =
  let allowed = List.map fields.properties ~f:fst in
  { decode_exn =
      (fun json ->
        Json.fields json ~allowed;
        fields.decode_exn json)
  ; encode_exn = (fun value -> Json.obj (fields.encode_exn value))
  ; schema =
      Json.obj
        [ "type", Json.string "object"
        ; "properties", Json.obj fields.properties
        ; "required", `Array (List.map fields.required ~f:Json.string)
        ; "additionalProperties", `False
        ]
  }
;;

let tagged ~discriminator ~cases ~select =
  if
    List.is_empty cases
    || List.contains_dup (List.map cases ~f:fst) ~compare:String.compare
  then invalid_arg "tagged codec requires distinct cases";
  let branch tag =
    match List.Assoc.find cases tag ~equal:String.equal with
    | Some codec -> codec
    | None -> Json.fail Invalid_argument "unknown tagged object kind"
  in
  { decode_exn =
      (fun json ->
        let codec = branch (Json.text (Json.field json discriminator)) in
        codec.decode_exn json)
  ; encode_exn = (fun value -> (branch (select value)).encode_exn value)
  ; schema =
      Json.obj [ "oneOf", `Array (List.map cases ~f:(fun (_, codec) -> codec.schema)) ]
  }
;;

let dictionary value ~max_items ~max_key_bytes =
  require_bound "dictionary item limit" (max_items >= 0);
  let key = text ~max_bytes:max_key_bytes in
  let decode_exn = function
    | `Object fields ->
      Json.fields (`Object fields) ~allowed:(List.map fields ~f:fst);
      if List.length fields > max_items
      then Json.fail Invalid_argument "dictionary exceeds item limit";
      List.map fields ~f:(fun (name, json) ->
        key.decode_exn (Json.string name), value.decode_exn json)
    | _ -> Json.fail Invalid_argument "expected dictionary object"
  in
  { decode_exn
  ; encode_exn =
      (fun fields ->
        Json.obj (List.map fields ~f:(fun (name, item) -> name, value.encode_exn item)))
  ; schema =
      Json.obj
        [ "type", Json.string "object"
        ; "additionalProperties", value.schema
        ; "maxProperties", number max_items
        ; "propertyNames", key.schema
        ]
  }
;;
