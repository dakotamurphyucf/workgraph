open Core

module Detail = struct
  type t =
    | Brief
    | Full
  [@@deriving sexp, equal]
end

let canonical_method_name = function
  | "ticket.get" -> "ticket.context"
  | name -> name
;;

let local_methods = [ "resource.upload"; "resource.download" ]

let helper_help = function
  | "init" | "bootstrap" -> Some Cli_bootstrap.help
  | "evidence-run" ->
    Some
      "evidence-run [local helper]\n\
       Usage: workgraph evidence-run --stage ABS_NEW_DIR --cwd ABS_DIR\n\
       [--source-root ABS_GIT_ROOT] [--output-limit BYTES] -- COMMAND ARG...\n\
       Create only the stage parent; the stage itself must be fresh. Everything after\n\
       -- is literal child argv, including --help and --context. No daemon is used.\n\
       Each stream retains its first BYTES (default 65536, range 1..1048576), drains\n\
       and hashes observed bytes, and stores binary output as base64 in capture.json.\n\
       JSON stdout: stage, capture_file, outcome, stdout/stderr counts and truncation,\n\
       source_drift, publication:not_attempted. Exit 0: observed command success;\n\
       2: captured nonzero/signal/launch failure; 1: infrastructure/argument error.\n\
       Partial provenance is not whole-tree proof. A capture is not approval.\n\
       Example: workgraph evidence-run --stage /absolute/stages/check-1 --cwd \
       /absolute/checkout -- python3 -m unittest\n\
       Read docs/agent/execution.md for output, provenance and publication contracts."
  | "evidence-publish" ->
    Some
      "evidence-publish [local helper]\n\
       Usage: workgraph --context ABS_FILE evidence-publish --stage ABS_STAGE\n\
       --resource-id ID --expected-revision REV --title TEXT\n\
       Or supply ABS_SOCKET, --workspace-id ID and --actor-id ID explicitly.\n\
       Optional --run-id attributes publication. The context supplies admitted defaults.\n\
       Save the exact publication.json before sending; a missing mutation_id is generated.\n\
       Retry: workgraph --socket ABS_SOCKET evidence-publish --stage ABS_STAGE\n\
       Saved-stage retry accepts transport/output/journal options only; it never reruns\n\
       execution or changes attribution. Missing, unfinished or malformed stages reject.\n\
       JSON stdout is the normal JSON-RPC receipt: .result.data.resource_id, .revision\n\
       and .version.{revision,digest}. Journal paths are diagnostics on stderr.\n\
       --output json|text and --timeout SECONDS are local options. Publication does not\n\
       automatically link or approve a ticket. Read docs/agent/execution.md."
  | "resource.upload" ->
    Some
      "resource.upload [local helper]\n\
       Usage: workgraph --context ABS_FILE resource upload --resource-id ID\n\
       --expected-revision REV --title TEXT --file ABS_REGULAR_FILE\n\
       Optional --filename BASENAME, --mime-type TYPE/SUBTYPE and --run-id ID.\n\
       File bytes are bounded to 64MiB. Save the exact upload plan with --save-request\n\
       ABS_NEW_FILE, a configured request directory, or supply a stable --mutation-id.\n\
       Retry only the saved plan with workgraph retry; changed source bytes reject.\n\
       Result paths: .result.data.resource_id; .revision is the entity guard,\n\
       .version.{revision,digest} is the immutable evidence identity.\n\
       This helper is not a daemon method. Read docs/agent/resources.md."
  | "resource.download" ->
    Some
      "resource.download [local helper]\n\
       Usage: workgraph --context ABS_FILE resource download --resource-id ID\n\
       --destination ABS_NEW_FILE [--version CONTENT_VERSION]\n\
       No actor/run/mutation fields. The destination parent must exist; never replaces\n\
       a destination. Pins the first immutable version and verifies all chunks and\n\
       the complete digest before publishing the private downloaded file.\n\
       Result paths: .result.data.resource_id, .version, .digest, .size_bytes, \
       .destination.\n\
       A post-publication directory-sync error is Outcome_unknown; inspect the retained\n\
       destination rather than deleting it blindly. Read docs/agent/resources.md."
  | "retry" ->
    Some
      "retry [local helper]\n\
       Usage: workgraph retry [ABS_SOCKET] ABS_SAVED_REQUEST\n\
       [--timeout SECONDS] [--output json|text]\n\
       --context/--socket may select transport. Retry preserves saved method, params,\n\
       mutation identity and attribution; parameter overrides and --self reject.\n\
       Understands saved resource upload plans. Never reruns an evidence command."
  | "serve" ->
    Some
      "serve [local helper]\n\
       Usage: workgraph serve ABS_REGISTRY_DIRECTORY ABS_SOCKET\n\
       Run in a separate process. Preserve managed data and ownership guards; never\n\
       remove an occupied socket based only on connection refusal. SIGTERM, Ctrl-C\n\
       or daemon.shutdown drains admitted work. Read docs/agent/administration.md."
  | "call" ->
    Some
      "call [local helper]\n\
       Usage: workgraph call [ABS_SOCKET] METHOD PARAMS_JSON\n\
       PARAMS_JSON is one object. Use --context/--socket for transport defaults.\n\
       Named parameter flags cannot be merged into the raw object. Read help METHOD\n\
       for the exact schema and docs/agent/cli-contract.md for retry rules."
  | _ -> None
;;

let method_names =
  "ticket.get"
  :: (local_methods
      @ List.map Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
        Api_method.name method_))
;;

let edit_distance left right =
  let previous = ref (Array.init (String.length right + 1) ~f:Fn.id) in
  String.iteri left ~f:(fun i a ->
    let next = Array.create ~len:(String.length right + 1) (i + 1) in
    String.iteri right ~f:(fun j b ->
      next.(j + 1)
      <- Int.min
           (Int.min (next.(j) + 1) (!previous.(j + 1) + 1))
           (!previous.(j) + if Char.equal a b then 0 else 1));
    previous := next);
  !previous.(String.length right)
;;

let unknown_method ~kind name =
  let suggestions =
    if String.length name > 128
    then []
    else
      method_names
      |> List.map ~f:(fun candidate -> edit_distance name candidate, candidate)
      |> List.filter ~f:(fun (distance, _) -> distance <= 3)
      |> List.sort ~compare:(fun (a, left) (b, right) ->
        match Int.compare a b with
        | 0 -> String.compare left right
        | order -> order)
      |> Fn.flip List.take 3
      |> List.map ~f:snd
  in
  Problem.create
    kind
    ("unknown method: "
     ^ Query_budget.prefix name ~max_bytes:128
     ^ (if String.length name > 128 then "..." else "")
     ^
     if List.is_empty suggestions
     then "; use workgraph methods or help FAMILY"
     else "; did you mean " ^ String.concat ~sep:", " suggestions ^ "?")
;;

let resolve_method arguments =
  let finish name = function
    | Some value -> Ok value
    | None -> Error (unknown_method ~kind:Invalid_argument name)
  in
  let rec loop parts best = function
    | word :: rest
      when not (String.is_prefix word ~prefix:"--" || Filename.is_absolute word) ->
      let parts = parts @ [ word ] in
      let name = String.concat ~sep:"." parts in
      let best =
        if List.mem method_names name ~equal:String.equal
        then Some (canonical_method_name name, rest)
        else best
      in
      if
        List.exists method_names ~f:(fun candidate ->
          String.is_prefix candidate ~prefix:(name ^ "."))
      then loop parts best rest
      else finish name best
    | _ -> finish (String.concat ~sep:"." parts) best
  in
  loop [] None arguments
;;

let descriptions ~core ~method_name =
  match method_name with
  | None ->
    Ok
      (List.filter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
         (not core) || Api_method.Tier.equal (Api_method.tier method_) Core))
  | Some name ->
    (match Api_catalog.find (canonical_method_name name) with
     | Some method_ -> Ok [ method_ ]
     | None ->
       (match helper_help name with
        | Some _ ->
          Error
            (Problem.create
               Not_found
               (name ^ " is a local CLI helper, not a daemon schema; use help " ^ name))
        | None -> Error (unknown_method ~kind:Not_found name)))
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
      if depth > 0
      then (
        let children =
          fields schema
          |> List.map ~f:(fun (name, schema, required, conditional) ->
            name
            ^ (if conditional then "[conditional]" else if required then "" else "?")
            ^ ": "
            ^ shape schema ~depth:0)
        in
        if List.is_empty children
        then "object"
        else "object {" ^ String.concat ~sep:"; " children ^ "}")
      else "object"
    | Some (`String "array") ->
      if depth > 0
      then (
        let item = Json.field schema "items" in
        (* Show the item object's fields once, but bound nested arrays too. *)
        let item_depth = if List.is_empty (fields item) then 0 else depth in
        "array of " ^ shape item ~depth:item_depth)
      else "array"
    | Some (`String type_) -> type_
    | _ ->
      (match mapped, alternatives with
       | first :: _, _ -> shape first ~depth
       | [], _ :: _ ->
         List.map alternatives ~f:(fun schema -> shape schema ~depth)
         |> List.dedup_and_sort ~compare:String.compare
         |> String.concat ~sep:" | "
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
          else (
            match field with
            | "workspace_id" -> "demo"
            | "actor_id" | "resolver_id" -> "worker"
            | "run_id" | "target_run_id" -> "worker-run"
            | "ticket_id" | "prerequisite_id" -> "task"
            | "attempt_id" -> "task-attempt"
            | "mutation_id" -> "saved-operation"
            | "project_id" -> "project"
            | "resource_id" -> "notes"
            | "request_id" -> "question"
            | "consumer_id" -> "worker-inbox"
            | "key" -> "result"
            | "title" -> "Investigate the failure"
            | "objective" -> "Implement and check the assigned task"
            | "body" -> "Checked the implementation; details are recorded on the ticket."
            | "evidence" -> "Tests passed; exact output is linked to this ticket."
            | _ -> "example"))
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
      ; "Actor/run attribution is cooperative metadata; ownership tokens are visible, \
         sequential stale-writer fences, not credentials."
      ]
  in
  let guarded =
    let names = List.map (fields request) ~f:(fun (name, _, _, _) -> name) in
    (if List.mem names "token" ~equal:String.equal
     then
       [ "Use your current ownership token returned by claim/start; never use another \
          owner's token or guess it."
       ]
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
      ; "workspace_id, actor_id, run_id and mutation_id belong to the outer call, not \
         operation params. Separate commands are independent commits."
      ]
    | "resource.put_text" ->
      [ "title is required on both create and update; omitted filename/MIME metadata is \
         retained."
      ]
    | "board.put" | "thread.put" ->
      [ "Use expected_revision 0 to create; updating requires the entity's current \
         revision."
      ]
    | "ticket.start" ->
      [ "The ticket must be ready and claimable; retain the returned token. Supply \
         run_id and attempt_id to start an attempt atomically."
      ]
    | "ticket.claim" ->
      [ "Claims ownership only; no attempt is started. Use ticket.start with attempt_id \
         or ticket.claim_next to start an attempt atomically."
      ]
    | "fact.put" ->
      [ "expected_revision 0 creates a new key; otherwise use the observed fact \
         revision. Values are at most 4096 canonical JSON bytes. Scope is explicit."
      ]
    | "ticket.claim_next" ->
      [ "target_run_id must identify a registered live run owned by actor_id; run_id \
         attribution must identify that same run."
      ; "Supply a fresh attempt_id; context does not default target_run_id or attempt_id."
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

let result_paths = function
  | "ticket.context" ->
    ".result.data.ticket.{ticket_id,description,status,claim}; .result.data.handoff"
  | "ticket.list" | "ticket.ready" ->
    ".result.data.items[].ticket_id; .result.data.next_offset; \
     .result.meta.workspace_revision"
  | "ticket.claim_next" ->
    ".result.data.kind; when claimed: .result.data.claim.{ticket_id,token}; \
     .result.data.attempt"
  | "resource.get" ->
    ".result.data.metadata.title; .result.data.revision (entity guard); \
     .result.data.current_version.{revision,digest} (content pin)"
  | "resource.read" ->
    ".result.data.text; .result.data.version (content version); .result.data.digest"
  | "resource.list" | "fact.list" ->
    ".result.data.items; .result.data.next_offset; .result.meta.workspace_revision"
  | "fact.keys" -> ".result.data.items; .result.data.remaining; .result.data.total"
  | "transaction.apply" ->
    ".result.data.results[] has method and data, in operation order"
  | "request.get" ->
    ".result.data.{revision,thread_revision}; with include_messages: \
     .result.data.related.{source_message,messages.items}"
  | _ -> ".result.data contains the fields above; .result.meta carries response metadata"
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
        else shape schema ~depth:1
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
            [ "resource.put_text"
            ; "resource.finish_upload"
            ; "board.put"
            ; "thread.put"
            ; "fact.put"
            ]
            name
            ~equal:String.equal
        then set sample "expected_revision" (Json.string "0")
        else sample
      in
      let sample =
        if String.equal name "ticket.claim_next"
        then set sample "run_id" (Json.string "worker-run")
        else sample
      in
      let sample =
        if String.equal name "fact.put"
        then
          set
            (set
               sample
               "scope"
               (Json.obj [ "kind", Json.string "ticket"; "id", Json.string "task" ]))
            "value"
            (Json.obj [ "tests_passed", `Number "12"; "notes", Json.string "notes" ])
        else sample
      in
      let sample =
        if List.mem [ "inbox.read"; "inbox.wait"; "inbox.ack" ] name ~equal:String.equal
        then
          set
            sample
            "recipient"
            (Json.obj [ "kind", Json.string "actor"; "id", Json.string "worker" ])
        else sample
      in
      if
        List.mem
          [ "message.send"; "request.create"; "request.ask" ]
          name
          ~equal:String.equal
      then (
        let sample =
          if List.mem [ "request.create"; "request.ask" ] name ~equal:String.equal
          then set sample "resolver_id" (Json.string "lead")
          else sample
        in
        set
          sample
          "recipients"
          (`Array [ Json.obj [ "kind", Json.string "actor"; "id", Json.string "lead" ] ]))
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
     @ [ "Input defaults:"
       ; "  Raw API envelopes require every required input. --context supplies missing \
          workspace_id and write actor_id/run_id only when admitted by the method."
       ; "  A context without run_id supplies no run identity. Read filters and target \
          identities remain explicit; supported --self selectors require their context \
          identity."
       ; "  Missing mutation_id is generated only when --save-request or a request \
          directory saves the exact request before sending."
       ; "Preconditions:"
       ]
     @ List.map
         (preconditions name (Api_method.mode method_) request)
         ~f:(fun text -> "  " ^ text)
     @ [ sample_label ^ Json.canonical sample
       ; "  References and guards are illustrative; use observed IDs/revisions for live \
          work."
       ; "Result data: " ^ results
       ; "Result paths: " ^ result_paths name
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
  match Option.bind method_name ~f:helper_help with
  | Some usage -> Ok usage
  | None ->
    let family_methods =
      Option.value_map method_name ~default:[] ~f:(fun name ->
        if Option.is_some (Api_catalog.find (canonical_method_name name))
        then []
        else
          List.filter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
            String.is_prefix (Api_method.name method_) ~prefix:(name ^ ".")))
    in
    if not (List.is_empty family_methods)
    then
      Ok
        ("Daemon method family "
         ^ Option.value_exn method_name
         ^ ":\n"
         ^ String.concat
             ~sep:"\n"
             (List.map family_methods ~f:(fun (Api_method.Packed.Pack method_) ->
                Api_method.name method_ ^ " — " ^ Api_method.summary method_))
         ^ "\nUse workgraph help METHOD for exact inputs, examples and result paths."
         ^
         if Option.equal String.equal method_name (Some "resource")
         then "\nLocal helpers: resource.upload, resource.download (help each helper)."
         else "")
    else
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
             CLI helpers (local workflows): init, bootstrap, upload, download, \
             evidence-run, evidence-publish, retry.\n\
             CLI spelling: ticket.get (canonical ticket.context); request get/list/... \
             select request-domain methods with --context/--socket.\n\
             Generic transport: request ABS_SOCKET METHOD; dotted METHOD is also accepted.\n\
             Use methods --core for everyday methods; help METHOD for concise inputs; \
             help METHOD --full for complete contracts.")
;;
