open Core

(* Visit schemas, never arbitrary JSON values carried by schema annotations. *)
let children schema ~f =
  match schema with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (key, value) ->
         let value =
           match key, value with
           | ("properties" | "patternProperties" | "dependentSchemas"), `Object fields ->
             Json.obj (List.map fields ~f:(fun (name, child) -> name, f name child))
           | ( ( "items"
               | "additionalProperties"
               | "unevaluatedProperties"
               | "unevaluatedItems"
               | "contains"
               | "propertyNames"
               | "not"
               | "if"
               | "then"
               | "else" )
             , (`Object _ | `True | `False) ) -> f key value
           | ("allOf" | "anyOf" | "oneOf" | "prefixItems"), `Array values ->
             `Array (List.map values ~f:(f key))
           | _ -> value
         in
         key, value))
  | _ -> schema
;;

let compact schema =
  let exception Existing_scope_or_depth_limit in
  let rec check depth value =
    if depth > 128 then raise Existing_scope_or_depth_limit;
    (match value with
     | `Object fields ->
       if
         List.exists fields ~f:(fun (key, _) ->
           List.mem
             [ "$schema"
             ; "$id"
             ; "$ref"
             ; "$anchor"
             ; "$dynamicRef"
             ; "$dynamicAnchor"
             ; "$recursiveRef"
             ; "$recursiveAnchor"
             ; "$defs"
             ; "definitions"
             ]
             key
             ~equal:String.equal)
       then raise Existing_scope_or_depth_limit
     | _ -> ());
    children value ~f:(fun _ child -> check (depth + 1) child)
  in
  let supported =
    match check 0 schema with
    | _ -> true
    | exception Existing_scope_or_depth_limit -> false
  in
  if not supported
  then schema
  else (
    let counts = String.Table.create () in
    let originals = String.Table.create () in
    let labels = String.Table.create () in
    let rec collect label value =
      (match value with
       | `Object _fields ->
         let key = Json.canonical value in
         Hashtbl.update counts key ~f:(fun count -> Option.value count ~default:0 + 1);
         Hashtbl.set originals ~key ~data:value;
         let label = if String.equal label "meta" then "metadata" else label in
         Hashtbl.update labels key ~f:(function
           | None -> label
           | Some previous ->
             if String.compare label previous < 0 then label else previous)
       | _ -> ());
      children value ~f:(fun name child ->
        (* Combinators and array items inherit their semantic field name. *)
        let name =
          if List.mem [ "allOf"; "anyOf"; "oneOf"; "items" ] name ~equal:String.equal
          then label
          else name
        in
        collect name child)
    in
    ignore (collect "contract" schema : Jsonaf.t);
    let names = String.Table.create () in
    Hashtbl.iteri counts ~f:(fun ~key ~data:count ->
      let label = Hashtbl.find_exn labels key in
      if String.length key >= 384 && (count > 1 || String.equal label "metadata")
      then (
        let digest = Digestif.SHA256.(digest_string key |> to_hex) in
        let label =
          String.map label ~f:(fun char ->
            if Char.is_alphanum char || Char.equal char '_' then char else '_')
        in
        Hashtbl.set names ~key ~data:(label ^ "_" ^ digest)));
    let rec replace _label value =
      match Hashtbl.find names (Json.canonical value) with
      | Some name -> Json.obj [ "$ref", Json.string ("#/$defs/" ^ name) ]
      | None -> children value ~f:replace
    in
    let result = children schema ~f:replace in
    let definitions =
      Hashtbl.to_alist names
      |> List.map ~f:(fun (key, name) ->
        name, children (Hashtbl.find_exn originals key) ~f:replace)
      |> List.sort ~compare:(fun (a, _) (b, _) -> String.compare a b)
    in
    match result, definitions with
    | `Object fields, _ :: _ ->
      let result = Json.obj (("$defs", Json.obj definitions) :: fields) in
      if String.length (Json.canonical result) < String.length (Json.canonical schema)
      then result
      else schema
    | _ -> schema)
;;
