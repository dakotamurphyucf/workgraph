open Core

module Detail = struct
  type t =
    | Brief
    | Full
  [@@deriving sexp, equal]
end

let descriptions ~core ~method_name =
  match method_name with
  | None ->
    Ok
      (List.filter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
         (not core) || Api_method.Tier.equal (Api_method.tier method_) Core))
  | Some name ->
    (match Api_catalog.find name with
     | Some method_ -> Ok [ method_ ]
     | None -> Error (Problem.create Not_found ("no executable method schema: " ^ name)))
;;

let schema ?(core = false) ~method_name () =
  Result.map (descriptions ~core ~method_name) ~f:(fun methods ->
    Json.obj
      [ "schema_dialect", Json.string "https://json-schema.org/draft/2020-12/schema"
      ; ( "methods"
        , `Array
            (List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
               Api_method.describe method_)) )
      ])
;;

let values schema key =
  match Json.optional schema key with
  | Some (`Array values) -> values
  | _ -> []
;;

let properties schema =
  match Json.optional schema "properties" with
  | Some (`Object fields) -> fields
  | _ -> []
;;

let strings schema key = List.map (values schema key) ~f:Json.text

(* Scope composition and mapped codecs both use allOf. Tagged alternatives have
   conditional fields: display every field once and retain its conditionality. *)
let rec fields schema =
  let required = strings schema "required" in
  let own =
    List.map (properties schema) ~f:(fun (name, schema) ->
      name, schema, List.mem required name ~equal:String.equal, false)
  in
  let composed = List.concat_map (values schema "allOf") ~f:fields in
  let alternatives = values schema "oneOf" in
  let conditional =
    let branches = List.map alternatives ~f:fields in
    let names =
      List.concat branches
      |> List.map ~f:(fun (name, _, _, _) -> name)
      |> List.dedup_and_sort ~compare:String.compare
    in
    List.map names ~f:(fun name ->
      let declarations =
        List.filter_map branches ~f:(fun branch ->
          List.find branch ~f:(fun (field, _, _, _) -> String.equal field name))
      in
      let schemas =
        List.map declarations ~f:(fun (_, schema, _, _) -> schema)
        |> List.dedup_and_sort ~compare:(fun a b ->
          String.compare (Json.canonical a) (Json.canonical b))
      in
      let schema =
        match schemas with
        | [ schema ] -> schema
        | _ -> Json.obj [ "anyOf", `Array schemas ]
      in
      let required =
        List.length declarations = List.length branches
        && List.for_all declarations ~f:(fun (_, _, required, conditional) ->
          required && not conditional)
      in
      let conditional =
        List.length declarations < List.length branches
        || ((not required)
            && List.exists declarations ~f:(fun (_, _, required, _) -> required))
      in
      name, schema, required, conditional)
  in
  own @ composed @ conditional
;;

let rec shape schema ~depth =
  let mapped = values schema "allOf" in
  let alternatives = values schema "anyOf" @ values schema "oneOf" in
  let base =
    match Json.optional schema "type" with
    | Some (`String "object") ->
      let names = strings schema "required" in
      if depth > 0 && not (List.is_empty names)
      then "object (requires " ^ String.concat ~sep:", " names ^ ")"
      else "object"
    | Some (`String "array") ->
      if depth > 0
      then "array of " ^ shape (Json.field schema "items") ~depth:(depth - 1)
      else "array"
    | Some (`String type_) -> type_
    | _ ->
      (match mapped, alternatives with
       | first :: _, _ -> shape first ~depth
       | [], [ left; right ] ->
         shape left ~depth:(Int.max 0 (depth - 1))
         ^ " | "
         ^ shape right ~depth:(Int.max 0 (depth - 1))
       | [], _ :: _ -> "tagged alternatives (see --full)"
       | [], [] -> "JSON")
  in
  let annotations =
    List.filter_map
      [ "enum"
      ; "const"
      ; "pattern"
      ; "maxItems"
      ; "x-maxUtf8Bytes"
      ; "x-maximumDecimal"
      ; "x-maxCanonicalBytes"
      ; "x-maxDepth"
      ]
      ~f:(fun key ->
        Option.map (Json.optional schema key) ~f:(fun value ->
          let label =
            match key with
            | "x-maximumDecimal" -> "decimal 0.."
            | "x-maxUtf8Bytes" -> "max UTF-8 bytes="
            | "maxItems" -> "max items="
            | _ -> key ^ "="
          in
          label ^ Json.canonical value))
  in
  String.concat ~sep:"; " (base :: annotations)
;;

let rec descriptions_in schema =
  let own =
    Option.to_list (Option.map (Json.optional schema "description") ~f:Json.text)
  in
  own @ List.concat_map (values schema "allOf") ~f:descriptions_in
;;

let rec example ?(field = "") ?(nonempty = false) ?(path_target = false) schema =
  let child field schema = example ~field ~nonempty ~path_target schema in
  match Json.optional schema "const", values schema "enum" with
  | Some value, _ | None, value :: _ -> value
  | None, [] ->
    (match Json.optional schema "type" with
     | Some (`String "object") ->
       let required = strings schema "required" in
       let declared =
         properties schema
         |> List.filter_map ~f:(fun (name, schema) ->
           if List.mem required name ~equal:String.equal
           then Some (name, child name schema)
           else None)
       in
       (match declared, Json.optional schema "additionalProperties" with
        | [], Some (`Object _ as value) when nonempty ->
          Json.obj [ "example", child field value ]
        | _ -> Json.obj declared)
     | Some (`String "array") ->
       `Array (if nonempty then [ child field (Json.field schema "items") ] else [])
     | Some (`String "boolean") -> `False
     | Some (`String "null") -> `Null
     | Some (`String "string") ->
       Json.string
         (if Option.is_some (Json.optional schema "x-maximumDecimal")
          then if String.equal field "offset" then "0" else "1"
          else if String.is_suffix field ~suffix:"digest"
          then String.make 64 '0'
          else if
            List.mem
              [ "root"; "roots"; "destination"; "directory" ]
              field
              ~equal:String.equal
          then "/tmp/workgraph-example"
          else if String.equal field "target_date"
          then "2030-01-01"
          else if String.is_suffix field ~suffix:"_base64"
          then "YQ=="
          else if String.equal field "mime_type"
          then "text/plain"
          else "example")
     | _ ->
       (match values schema "allOf", values schema "oneOf" @ values schema "anyOf" with
        | first :: rest, _ ->
          List.fold rest ~init:(child field first) ~f:(fun previous schema ->
            match previous, child field schema with
            | `Object previous, `Object more -> Json.obj (previous @ more)
            | value, _ -> value)
        | [], first :: rest ->
          child
            field
            (if path_target && String.equal field "target" && not (List.is_empty rest)
             then List.hd_exn rest
             else first)
        | [], [] -> `Null))
;;

let preconditions name mode request =
  let common =
    match mode with
    | Api_method.Mode.Read -> []
    | Write ->
      [ "This write has no durable mutation retry receipt; follow its method-specific \
         retry rules."
      ]
    | Mutation ->
      [ "Save an exact request before sending; retries retain actor_id, mutation_id and \
         params."
      ; "Actor/run attribution is cooperative metadata; ownership tokens fence stale \
         writers."
      ]
  in
  let guarded =
    let names = List.map (fields request) ~f:(fun (name, _, _, _) -> name) in
    (if List.mem names "token" ~equal:String.equal
     then [ "Use the current ownership token returned by claim/start; do not guess it." ]
     else [])
    @ (if List.mem names "expected_revision" ~equal:String.equal
       then [ "expected_revision guards the affected entity's current revision." ]
       else [])
    @
    if List.mem names "at_revision" ~equal:String.equal
    then
      [ "at_revision guards current captured consistency; it does not retrieve past \
         state."
      ]
    else []
  in
  let specific =
    match name with
    | "transaction.apply" ->
      [ "operations: 1..32 ordered {method, params, as?} objects; all commit or none do."
      ; "as is only for creation methods, unique ASCII IDs (1..96 bytes)."
      ; "$alias resolves earlier creations only in declared typed reference fields; \
         never text."
      ; "Discover each operation's inputs with help METHOD; schema transaction.apply is \
         complete."
      ]
    | "resource.put_text" ->
      [ "title is required on both create and update; omitted filename/MIME metadata is \
         retained."
      ]
    | "ticket.start" ->
      [ "The ticket must be ready and claimable; retain the returned token and \
         attempt_id."
      ]
    | "ticket.finish" ->
      [ "Supply nonblank completion evidence and satisfy configured current acceptance \
         gates."
      ]
    | "inbox.wait" ->
      [ "timeout_ms is capped at 25000; repeat bounded waits and retain the returned \
         cursor."
      ]
    | _ -> []
  in
  common @ guarded @ specific @ descriptions_in request
;;

let brief method_ =
  let name = Api_method.name method_ in
  let request = Api_codec.schema (Api_method.request_codec method_) in
  let result = Api_codec.schema (Api_method.response_codec method_) in
  let inputs =
    fields request
    |> List.dedup_and_sort ~compare:(fun (a, _, _, _) (b, _, _, _) -> String.compare a b)
    |> List.map ~f:(fun (field, schema, required, conditional) ->
      let presence =
        if conditional then "conditional" else if required then "required" else "optional"
      in
      let kind =
        if String.equal name "transaction.apply" && String.equal field "operations"
        then "array of {method: string, params: object, as?: string}; 1..32 items"
        else shape schema ~depth:2
      in
      "  "
      ^ field
      ^ " ["
      ^ presence
      ^ "]: "
      ^ kind
      ^
      match descriptions_in schema with
      | [] -> ""
      | descriptions -> " — " ^ String.concat ~sep:" " descriptions)
  in
  let sample ~nonempty =
    if String.equal name "transaction.apply"
    then
      Json.obj
        [ "workspace_id", Json.string "workspace"
        ; "actor_id", Json.string "actor"
        ; "mutation_id", Json.string "unique-mutation"
        ; ( "operations"
          , `Array
              [ Json.obj
                  [ "method", Json.string "ticket.create"
                  ; ( "params"
                    , Json.obj
                        [ "ticket_id", Json.string "task"; "title", Json.string "Task" ] )
                  ; "as", Json.string "task"
                  ]
              ] )
        ]
    else (
      let sample =
        example
          ~nonempty
          ~path_target:(String.equal name "reservation.path.recover")
          request
      in
      let set sample field value =
        match sample with
        | `Object fields ->
          Json.obj (List.Assoc.add fields ~equal:String.equal field value)
        | _ -> sample
      in
      let sample =
        if
          List.mem
            [ "resource.put_text"; "resource.finish_upload" ]
            name
            ~equal:String.equal
        then set sample "expected_revision" (Json.string "0")
        else sample
      in
      if List.mem [ "message.send"; "request.create" ] name ~equal:String.equal
      then (
        let _, recipients, _, _ =
          List.find_exn (fields request) ~f:(fun (field, _, _, _) ->
            String.equal field "recipients")
        in
        set sample "recipients" (example ~nonempty:true recipients))
      else sample)
  in
  (* Examples are suggestions, never a second validator. Try two bounded schema
     candidates and admit only one accepted by the actual mapped request codec. *)
  let initial = sample ~nonempty:false in
  let sample, sample_label =
    match Api_codec.decode (Api_method.request_codec method_) initial with
    | Ok _ -> initial, "Example params: "
    | Error _ ->
      let alternative = sample ~nonempty:true in
      (match Api_codec.decode (Api_method.request_codec method_) alternative with
       | Ok _ -> alternative, "Example params: "
       | Error problem ->
         ( alternative
         , "Example skeleton (replace placeholders; codec rejects: "
           ^ problem.message
           ^ "): " ))
  in
  let results =
    let fields = fields result in
    if List.is_empty fields
    then shape result ~depth:0
    else
      List.map fields ~f:(fun (name, schema, required, _) ->
        name ^ (if required then "" else "?") ^ ": " ^ shape schema ~depth:0)
      |> String.concat ~sep:"; "
  in
  String.concat
    ~sep:"\n"
    ([ "Inputs:" ]
     @ inputs
     @ [ "Preconditions:" ]
     @ List.map
         (preconditions name (Api_method.mode method_) request)
         ~f:(fun text -> "  " ^ text)
     @ [ sample_label ^ Json.canonical sample
       ; "Result data: " ^ results
       ; "Result envelope: {data, meta}; meta carries captured revisions, durability and \
          bounded-output diagnostics when applicable."
       ; "Complete contracts: workgraph help "
         ^ name
         ^ " --full (or workgraph schema "
         ^ name
         ^ ")."
       ])
;;

let help ?(detail = Detail.Brief) ?(core = false) ~method_name () =
  Result.map (descriptions ~core ~method_name) ~f:(fun methods ->
    let rendered =
      List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
        let mode =
          match Api_method.mode method_ with
          | Read -> "read"
          | Write -> "write"
          | Mutation -> "mutation"
        in
        let heading =
          Api_method.name method_ ^ " [" ^ mode ^ "] — " ^ Api_method.summary method_
        in
        match method_name, detail with
        | None, _ -> heading
        | Some _, Brief -> heading ^ "\n" ^ brief method_
        | Some _, Full ->
          let description = Api_method.describe method_ in
          String.concat
            ~sep:"\n"
            [ heading
            ; "Parameters (JSON Schema):"
            ; Jsonaf.to_string_hum (Json.field description "params")
            ; "Result envelope (JSON Schema):"
            ; Jsonaf.to_string_hum (Json.field description "result")
            ])
      |> String.concat ~sep:"\n"
    in
    match method_name with
    | Some _ -> rendered
    | None ->
      "Daemon methods"
      ^ (if core then " (core everyday tier)" else " (complete index)")
      ^ ":\n"
      ^ rendered
      ^ "\n\
         CLI helpers (local workflows): init, bootstrap, upload, download, evidence-run, \
         evidence-publish, retry.\n\
         Use methods --core for everyday methods; help METHOD for concise inputs; help \
         METHOD --full for complete contracts.")
;;
