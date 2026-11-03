open Core

type t =
  { pointer : string
  ; segments : string list
  ; equals : Jsonaf.t
  ; canonical : string
  }

let decode_segment segment =
  let buffer = Buffer.create (String.length segment) in
  let rec loop offset =
    if offset < String.length segment
    then (
      match segment.[offset] with
      | '~' ->
        if offset + 1 >= String.length segment
        then Json.fail Invalid_argument "incomplete JSON pointer escape";
        let decoded =
          match segment.[offset + 1] with
          | '0' -> '~'
          | '1' -> '/'
          | _ -> Json.fail Invalid_argument "JSON pointer escape must be ~0 or ~1"
        in
        Buffer.add_char buffer decoded;
        loop (offset + 2)
      | char ->
        Buffer.add_char buffer char;
        loop (offset + 1))
  in
  loop 0;
  Buffer.contents buffer
;;

let create ~pointer ~equals =
  Json.decode (fun () ->
    if String.length pointer > 512
    then Json.fail Invalid_argument "fact pointer exceeds 512 bytes";
    ignore (Json.canonical (`String pointer) : string);
    let segments =
      if String.is_empty pointer
      then []
      else if String.is_prefix pointer ~prefix:"/"
      then String.split (String.drop_prefix pointer 1) ~on:'/'
      else Json.fail Invalid_argument "fact pointer must be empty or start with /"
    in
    if List.length segments > 16
    then Json.fail Invalid_argument "fact pointer exceeds 16 segments";
    (match equals with
     | `Object _ | `Array _ ->
       Json.fail Invalid_argument "fact equality requires a scalar"
     | `Null | `True | `False | `String _ | `Number _ -> ());
    let canonical = Json.canonical equals in
    if String.length canonical > 4096
    then Json.fail Invalid_argument "fact equality scalar exceeds 4096 bytes";
    { pointer; segments = List.map segments ~f:decode_segment; equals; canonical })
;;

let codec =
  let open Api_codec in
  map
    (object_
       (Fields.both
          (Fields.required "pointer" (text ~max_bytes:512))
          (Fields.required "equals" (json ~max_bytes:4096 ~max_depth:1))))
    ~decode:(fun (pointer, equals) -> create ~pointer ~equals)
    ~encode:(fun t -> t.pointer, t.equals)
    ~description:
      "Scalar equality at a JSON pointer (at most 16 segments). Missing differs from \
       null; numbers compare exact canonical JSON spellings, not floating point."
;;

let conjunction_codec = Api_codec.list codec ~max_items:8

let matches t ~value =
  let rec select value = function
    | [] ->
      (match value with
       | `Object _ | `Array _ -> false
       | `Null | `True | `False | `String _ | `Number _ ->
         String.equal t.canonical (Jsonaf.to_string value))
    | segment :: rest ->
      let child =
        match value with
        | `Object fields -> List.Assoc.find fields segment ~equal:String.equal
        | `Array values ->
          (match Int.of_string_opt segment with
           | Some index when index >= 0 && String.equal (Int.to_string index) segment ->
             List.nth values index
           | Some _ | None -> None)
        | `Null | `True | `False | `String _ | `Number _ -> None
      in
      Option.value_map child ~default:false ~f:(fun value -> select value rest)
  in
  select value t.segments
;;
