open Core

let descriptions ~method_name =
  match method_name with
  | None -> Ok Api_catalog.methods
  | Some name ->
    (match Api_catalog.find name with
     | Some method_ -> Ok [ method_ ]
     | None -> Error (Problem.create Not_found ("no executable method schema: " ^ name)))
;;

let schema ~method_name =
  Result.map (descriptions ~method_name) ~f:(fun methods ->
    Json.obj
      [ "schema_dialect", Json.string "https://json-schema.org/draft/2020-12/schema"
      ; ( "methods"
        , `Array
            (List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
               Api_method.describe method_)) )
      ])
;;

let help ~method_name =
  Result.map (descriptions ~method_name) ~f:(fun methods ->
    List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
      let description = Api_method.describe method_ in
      let summary = Json.text (Json.field description "summary") in
      let mode = Json.text (Json.field description "mode") in
      let heading = Api_method.name method_ ^ " [" ^ mode ^ "] — " ^ summary in
      match method_name with
      | None -> heading
      | Some _ ->
        String.concat
          ~sep:"\n"
          [ heading
          ; "Parameters (JSON Schema):"
          ; Jsonaf.to_string_hum (Json.field description "params")
          ; "Result envelope (JSON Schema):"
          ; Jsonaf.to_string_hum (Json.field description "result")
          ])
    |> String.concat ~sep:"\n")
;;
