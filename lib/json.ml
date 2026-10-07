open Core

exception Decode_error of Problem.t

let fail kind message = raise (Decode_error (Problem.create kind message))

let decode f =
  try Ok (f ()) with
  | Decode_error error -> Error error
;;

let obj fields = `Object fields
let string s = `String s
let int n = `String (Int.to_string n)
let int64 n = `String (Int64.to_string n)

let text = function
  | `String s -> s
  | _ -> fail Invalid_argument "expected string"
;;

let bounded_text value ~max_bytes =
  let s = text value in
  if String.length s > max_bytes then fail Invalid_argument "text exceeds byte limit";
  s
;;

let integer64 value =
  let s = text value in
  match Int64.of_string_opt s with
  | Some n when Int64.(n >= zero) && String.equal (Int64.to_string n) s -> n
  | Some _ | None -> fail Invalid_argument "expected canonical nonnegative decimal string"
;;

let integer value =
  match Int64.to_int (integer64 value) with
  | Some n -> n
  | None -> fail Invalid_argument "integer exceeds supported native range"
;;

let list = function
  | `Array xs -> xs
  | _ -> fail Invalid_argument "expected array"
;;

let optional value key =
  match value with
  | `Object fields -> List.Assoc.find fields key ~equal:String.equal
  | _ -> fail Invalid_argument "expected object"
;;

let field value key =
  match optional value key with
  | Some value -> value
  | None -> fail Invalid_argument ("missing field: " ^ key)
;;

let fields value ~allowed =
  match value with
  | `Object fields ->
    let seen = ref String.Set.empty in
    List.iter fields ~f:(fun (key, _) ->
      if Set.mem !seen key then fail Invalid_argument ("duplicate JSON key: " ^ key);
      seen := Set.add !seen key;
      if not (List.mem allowed key ~equal:String.equal)
      then fail Invalid_argument ("unknown field: " ^ key))
  | _ -> fail Invalid_argument "expected object"
;;

let utf8 text =
  if
    not
      (Uutf.String.fold_utf_8
         (fun valid _ -> function
            | `Uchar _ -> valid
            | `Malformed _ -> false)
         true
         text)
  then fail Invalid_argument "JSON requires valid UTF-8"
;;

let rec normalize = function
  | `Object fields ->
    List.iter fields ~f:(fun (key, _) -> utf8 key);
    let fields = List.sort fields ~compare:(fun (a, _) (b, _) -> String.compare a b) in
    let rec check = function
      | (a, _) :: ((b, _) :: _ as rest) ->
        if String.equal a b then fail Invalid_argument ("duplicate JSON key: " ^ a);
        check rest
      | [] | [ _ ] -> ()
    in
    check fields;
    `Object (List.map fields ~f:(fun (key, value) -> key, normalize value))
  | `Array xs -> `Array (List.map xs ~f:normalize)
  | `String text as value ->
    utf8 text;
    value
  | `Number number as value ->
    (match Jsonaf.parse number with
     | Ok (`Number parsed) when String.equal parsed number -> ()
     | Ok _ | Error _ -> fail Invalid_argument "invalid JSON number");
    (match Float.of_string_opt number with
     | Some number when Float.is_finite number -> ()
     | Some _ | None -> fail Invalid_argument "JSON numbers must be finite");
    value
  | (`Null | `False | `True) as value -> value
;;

let canonical value = Jsonaf.to_string (normalize value)
let pretty value = Jsonaf.to_string_hum (normalize value)

let parse_with_limit ~max_bytes raw =
  decode (fun () ->
    if max_bytes <= 0 || max_bytes > 64 * 1024 * 1024
    then fail Invalid_argument "invalid JSON size bound";
    if String.length raw > max_bytes then fail Invalid_argument "JSON exceeds byte limit";
    utf8 raw;
    let depth = ref 0
    and quoted = ref false
    and escaped = ref false in
    String.iter raw ~f:(fun c ->
      if !quoted
      then (
        if !escaped
        then escaped := false
        else if Char.equal c '\\'
        then escaped := true
        else if Char.equal c '"'
        then quoted := false)
      else if Char.equal c '"'
      then quoted := true
      else if Char.equal c '{' || Char.equal c '['
      then (
        incr depth;
        if !depth > 64 then fail Invalid_argument "JSON nesting exceeds 64")
      else if Char.equal c '}' || Char.equal c ']'
      then decr depth);
    match Jsonaf.parse raw with
    | Ok value -> normalize value
    | Error error -> fail Invalid_argument (Error.to_string_hum error))
;;

let parse raw = parse_with_limit ~max_bytes:(4 * 1024 * 1024) raw
let hash bytes = Digestif.SHA256.(digest_string bytes |> to_hex)
