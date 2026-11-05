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

let local_methods =
  [ "resource.upload"
  ; "request.wait"
  ; "journal.inspect"
  ; "journal.list"
  ; "resource.publish_text"
  ; "resource.upload-abort"
  ; "resource.download"
  ; "evidence.show"
  ; "evidence.clean"
  ]
;;

let helper_help = function
  | "request.wait" ->
    Some
      {|request wait [local read helper]
Usage: workgraph --context ABS_FILE request wait --request-id ID
  [--wait-ms 30000 --poll-interval-ms 1000 --timeout 30 --output json|text]
Dotted request.wait also works; explicit --workspace-id and socket override context.
Polls request.get immediately, then at bounded intervals. Total 1000..300000ms,
interval 250..25000ms; --timeout caps each transport by the remaining deadline.
No messages, acknowledgements, acceptances, writes or daemon-side worker are created.
Result data preserves request.get paths: .result.data.status.kind,
.revision (request revision), .thread_revision and .answer (exact pinned comment
with .body/.comment_id/.revision, or null when resolved without an answer).
Local .result.meta.wait has stop, resolved and poll_count. Exit 0 only for a
complete resolved observation; cancelled/deadline/incomplete observations exit 1
with the last result. Read errors stop unchanged; cancellation propagates.
Data is bounded to 1MiB; clipped replies stop as incomplete, never a full answer.
This is a local helper, not a daemon method or a saved mutation to retry.
Journal, --self and --paginate options reject. A context's journal default is unused.|}
  | "journal" | "journal.inspect" | "journal.list" ->
    Some
      {|journal inspect ABS_REQUEST / journal list ABS_DIRECTORY [offline helpers]
Inspect one current saved request, or list sorted nonrecursive .json entries.
List options: --after BASENAME --limit COUNT (1..1000; default100),
--max-bytes BYTES (4194304..67108864 aggregate input; default16777216).
Output caps at1MiB; inspect complete/next_after/stop before treating a scan as complete.
Groups cover returned entries only; they distinguish same scoped request hashes
from conflicting payloads. Registry, planning and history receipt namespaces differ.
envelope_hash covers the saved request; mutation.request_hash matches its actual
receipt namespace. Upload plans expose a distinct finish_upload identity/hash;
their optional ticket link is a separate workflow.
commit_status=unchecked and transmission_status=unknown: saved attempts prove no
send or commit. These commands never contact a daemon, retry, rewrite aliases or
read upload source bytes. No actor/run/context defaults are applied.
Automatic request-directory filenames hash the full frozen envelope. Identical
bytes may be re-synced/reused; different same-path bytes reject without overwrite.
Fresh generated mutation identities remain fresh operations; use retry for recovery.
See skills/workgraph/references/cli-contract.md. --output json|text is local.|}
  | "fields" ->
    Some
      {|fields [local helper]
Usage: workgraph fields METHOD
Offline JSON input descriptors plus the original validation_schema.
Use .fields for names, requirements, summaries, nested schemas and JSON argument form.
Full cross-field validation cannot be reconstructed from a flat field list.
No daemon, socket or context is needed.|}
  | "resource.publish_text" ->
    Some
      {|resource.publish_text [local atomic text helper]
Usage: workgraph --context ABS_FILE resource publish_text --ticket-id ID
  --expected-revision REV --text TEXT [--resource-id ID --title TEXT]
At most 65536 UTF-8 bytes; --field-file text ABS_FILE or --field-file text - work.
Title is required on creation (revision 0); omitted resource_id generates an ID.
Optional filename, mime-type and run-id follow resource.put_text semantics.
Publishes text and links the ticket atomically through one transaction.apply.
A missing ticket, stale guard or existing link fails without publishing content.
For already-linked text updates use resource.put_text; existing links are preserved.
Save with --save-request ABS_NEW_FILE or --request-directory ABS_PRIVATE_DIR;
otherwise provide a stable --mutation-id. Retry only that exact saved request.
Saved bytes are the expanded transaction, so retry never rereads the text source.
Success is the normal durable transaction receipt: .result.data.results[0].data
contains resource_id, revision and version.{revision,digest}; results[1].data
contains the final linked metadata revision. Publication is not ticket approval.
This helper is not a daemon method. Read skills/workgraph/references/resources.md.|}
  | "init" | "bootstrap" -> Some Cli_bootstrap.help
  | "reservation-wait" | "reservation.wait" | "reservation.paths.wait" ->
    Some
      {|reservation wait / reservation paths wait [local acquisition helper]
Usage: workgraph --context ABS_FILE reservation wait --target-run-id RUN
  --json-field requests '[{"reservation_id":"build","mode":"exclusive"}]'
  --request-directory ABS_EXISTING_PRIVATE_DIR
  [--wait-ms 30000 --max-attempts 32 --wait-slice-ms 1000 --timeout 30]
For paths use reservation paths wait and the reservation.paths.acquire request
fields. Dotted spellings reservation.wait / reservation.paths.wait also work.
Total deadline 1000..300000ms, attempts 1..100, feed slice 1..25000ms.
Captures the planning cursor before acquisition. Each attempt syncs an exclusive
exact request file before sending. Only typed contention for an original batch
target permits a fresh identity after a feed wake or timer; guards never refresh.
Other conflicts, uncertainty, malformed/nondurable replies or save failures stop.
--timeout caps each transport by the remaining monotonic deadline. An in-flight
durable success remains success; no later attempt starts after the deadline.
Atomic batches stay intact. No fairness queue, foreign cleanup, renewal, process
liveness or termination guarantee is implied. Expiry alone does not free a holder;
its exact release/recovery is separate. --save-request/--paginate reject.
Result paths: .result.data.daemon_response retains the actual {data,meta} grant;
.result.data.wait.{completed,stop,attempt_count,journals,last_conflict,problem,
feed_response,saved_request,retry_request} describes the bounded local workflow.
Incomplete exits nonzero. Check exit status and completed before using grants.
After uncertainty, retry the exact saved_request; retry never reruns this helper.|}
  | "receipts" | "scripting" ->
    Some
      {|receipts [local reference]
Mutation results use .result.data and .result.meta. IDs and state fields are
method-specific: run_id/status for run mutations, attempt_id/state for attempts,
ticket_id/token for acquisition, and answer/thread revisions for resolution.
request.ask returns request_revision, thread_revision and question; it does not
return status or a generic revision. request.get returns revision and status.kind.
request.get.answer contains the exact resolved comment body/version or null;
include_messages expands related messages, not a replacement location for answers.
ticket.progress returns comment_id, not a new ticket revision. Read ticket.get for
the ticket's current revision; meta.workspace_revision is the containing commit.
Lists generally return data.items; inspect the method's own continuation fields.
Run revision guards that run, coordination_revision guards its domain collection,
workspace_revision identifies the durable transaction, and a resource content
version/digest is an immutable evidence pin. Never interchange these counters.

Check the process exit status before extracting JSON; a nonzero result can carry
a JSON-RPC error on stdout or a local Problem on stderr. saved_request diagnostics
are on stderr. Example (fresh request/output paths and live connection required):
  if "$WG" --context "$CONTEXT" run register --target-run-id worker-1 \
       --objective 'Inspect the change' --save-request "$REQUEST" >"$RESULT"; then
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["result"]["data"]; print(d["run_id"],d["revision"],d["status"])' "$RESULT"
  else
    exit 1
  fi

After an uncertain write, explicitly retry the exact saved request:
  if "$WG" --context "$CONTEXT" retry "$REQUEST" >"$RESULT"; then
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["data"])' "$RESULT"
  else
    exit 1
  fi
Retry never refreshes state, changes attribution or generates another identity.
A later run transition does not alter the original receipt. Reported lifecycle
state and observation time do not establish that a harness process is alive.
Use help METHOD for actual response fields; no universal id/status is invented.|}
  | "pagination" ->
    Some
      ("pagination [local read helper]\n\
        Usage: workgraph --context ABS_FILE ticket list --project-id PROJECT --paginate\n\
        [--page-limit 100] [--total-bytes 16777216] [--limit 50] [--max-bytes 65536]\n\
        Ordinary supported single-page reads add validated client-only meta.pagination\n\
        with capture, next_request and retry_request. Raw call and saved retry stay exact.\n\
        Daemon max_bytes bounds its original page; local continuation metadata has its\n\
        own 65536-byte cap. metadata_limit is explicitly incomplete and preserves page.\n\
        Opt-in bounded traversal; requests 1..1000, total JSON 4096..67108864 bytes.\n\
        Keeps exact selectors and per-family captures: at_revision (planning),\n\
        expected_revision/revision plus query_scope (domain), at_snapshot (exports),\n\
        opaque cursor, inbox notification through, or immutable history head.\n\
        Current-revision guards detect changes; they do not retrieve old state.\n\
        Result paths: .result.data.pages[] retains each exact {data,meta};\n\
        .result.data.pagination.{complete,stop,capture,next_request,retry_request,problem}.\n\
        Incomplete exits1 for page/byte limits, no progress, unsafe server omissions,\n\
        oversized rows or unchanged fetch errors. Never silently refreshes a guard,\n\
        retries, acknowledges inbox rows or splits an atomic transaction. Waits and\n\
        nested multi-section views reject. Complete traversal retains each page's\n\
        source/index coverage; it is not a claim of complete indexing.\n\
        Resume with the exact next_request; retry_request repeats an unconsumed position.\n\
        Exact retry is null where a first captured position cannot be reconstructed.\n\
        Initial opaque reads require room for the first bounded page plus cursor metadata.\n\
        Continue another bounded collection using next_request.method and .params with\n\
        --paginate; retry of a saved raw request performs one read.\n\
        Supported methods: "
       ^ String.concat ~sep:", " (Query_pagination.supported_methods ()))
  | "evidence" ->
    Some
      "Evidence helpers: evidence-run, evidence-publish, evidence show, evidence clean.\n\
       Use each helper's --help for local capture, bounded inspection, exact publication\n\
       retry and explicit owned-stage cleanup contracts."
  | "evidence-show" | "evidence.show" ->
    Some
      "evidence-show [local helper]\n\
       Usage: workgraph evidence show --stage ABS_DIR [--stdout|--stderr]\n\
       [--offset BYTE --length BYTES | --tail BYTES] [--output json|text|bytes]\n\
       Lengths 1..65536. Offsets count retained prefix bytes. A retained tail is NOT the \
       final\n\
       process tail when truncation discarded bytes. Counts/EOF/truncation and provenance\n\
       coverage remain visible. Text labels malformed UTF8 replacement; bytes is exact \
       binary\n\
       stdout with JSON metadata on stderr. No execution, publication or daemon access."
  | "evidence-clean" | "evidence.clean" ->
    Some
      "evidence-clean [local helper]\n\
       Usage: workgraph evidence clean --stage ABS_DIR --owner-token TOKEN\n\
       Explicitly clean one finished, validated owned stage using evidence-run's \
       owner_token.\n\
       Refuses live locks, unfinished/foreign stages, publication intents and unknown \
       files.\n\
       No recursive pruning, overwrite or cleanup of published evidence. No daemon \
       access."
  | "evidence-run" ->
    Some
      "evidence-run [local helper]\n\
       Usage: workgraph evidence-run --stage ABS_NEW_DIR --cwd ABS_DIR\n\
       [--source-root ABS_GIT_ROOT] [--hash-path ROOT_RELATIVE_FILE]...\n\
       [--output-limit BYTES] -- COMMAND ARG...\n\
       Create only the stage parent; the stage itself must be fresh. Everything after\n\
       -- is literal child argv, including --help and --context. No daemon is used.\n\
       Each stream retains its first BYTES (default 65536, range 1..1048576), drains\n\
       and hashes observed bytes, and stores binary output as base64 in capture.json.\n\
       capture.json: .stdout.base64/.stderr.base64 hold the retained prefix. Printed\n\
       .stdout_preview.data_base64/.stderr_preview.data_base64 hold selected previews.\n\
       Use evidence show --stage ABS --stdout --output bytes for exact selected bytes.\n\
       JSON stdout: stage, capture_file, outcome, stdout/stderr counts and truncation,\n\
       source_drift, publication:not_attempted. Exit 0: observed command success;\n\
       2: captured nonzero/signal/launch failure; 1: infrastructure/argument error.\n\
       JSON includes decoded bounded retained-tail previews and prominent source coverage.\n\
       --hash-path selects at most 256 exact files (no recursive directory expansion).\n\
       Its identity covers only those files, including explicitly selected ignored files.\n\
       Partial provenance is not whole-tree proof. A capture is not approval.\n\
       Example: workgraph evidence-run --stage /absolute/stages/check-1 --cwd \
       /absolute/checkout -- python3 -m unittest\n\
       Read skills/workgraph/references/execution.md for output, provenance and \
       publication contracts."
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
       approve a ticket. Optional --ticket-id ID freezes a separate resource link.\n\
       Publication and link are not atomic; a failed link exits nonzero with\n\
       .result.data.publication (exact committed receipt), ticket_link_error,\n\
       retry_request and saved_request. Retry the saved plan without fresh guards.\n\
       Success adds .result.data.ticket_link (exact link receipt). Read \
       skills/workgraph/references/execution.md."
  | "resource.upload" ->
    Some
      "resource.upload [local helper]\n\
       Usage: workgraph --context ABS_FILE resource upload --resource-id ID\n\
       --expected-revision REV --title TEXT --file ABS_REGULAR_FILE\n\
       Optional --filename BASENAME, --mime-type TYPE/SUBTYPE, --run-id ID and \
       --ticket-id ID.\n\
       Ticket linking is separate from publication. A failed link exits nonzero with\n\
       the exact committed publication receipt and saved retry plan; never reruns input.\n\
       File bytes are bounded to 64MiB. Save the exact upload plan with --save-request\n\
       ABS_NEW_FILE, a configured request directory, or supply a stable --mutation-id.\n\
       Retry only the saved plan with workgraph retry; changed source bytes reject.\n\
       Result paths: .result.data.resource_id; .revision is the entity guard,\n\
       .version.{revision,digest} is the immutable evidence identity.\n\
       This helper is not a daemon method. Read skills/workgraph/references/resources.md."
  | "resource.upload-abort" ->
    Some
      {|resource.upload-abort [local helper]
Usage: workgraph resource upload-abort [ABS_SOCKET] ABS_SAVED_UPLOAD_PLAN
  [--timeout SECONDS] [--output json|text]
Context workspace/actor must match the saved plan when present. The stable
upload_id is validated before transmission; source bytes are never read.
Only owner staging is aborted. Published blobs and exact finish receipts remain.
Recover publication with workgraph retry [ABS_SOCKET] ABS_SAVED_UPLOAD_PLAN.
No automatic idle expiry; inspect upload.list and explicitly abort abandoned work.|}
  | "resource.download" ->
    Some
      "resource.download [local helper]\n\
       Usage: workgraph --context ABS_FILE resource download --resource-id ID\n\
       --destination ABS_NEW_FILE|- [--version CONTENT_VERSION]\n\
       No actor/run/mutation fields. The destination parent must exist; never replaces\n\
       a destination. Pins the first immutable version and verifies all chunks and\n\
       the complete digest before publishing the private downloaded file.\n\
       Destination - streams raw bytes to stdout; its JSON receipt goes to stderr.\n\
       A later integrity error may follow an emitted prefix. Add --spool ABS_NEW_FILE\n\
       to verify the complete download before emitting bytes; the 0600 spool is retained.\n\
       Result paths: .result.data.resource_id, .version, .digest, .size_bytes, \
       .destination.\n\
       A post-publication directory-sync error is Outcome_unknown; inspect the retained\n\
       destination rather than deleting it blindly. Read \
       skills/workgraph/references/resources.md."
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
       or daemon.shutdown drains admitted work. Read \
       skills/workgraph/references/administration.md."
  | "call" ->
    Some
      "call [local helper]\n\
       Usage: workgraph call [ABS_SOCKET] METHOD PARAMS_JSON\n\
       PARAMS_JSON is one object. Use --context/--socket for transport defaults.\n\
       Named parameter flags cannot be merged into the raw object. Read help METHOD\n\
       for the exact schema and skills/workgraph/references/cli-contract.md for retry \
       rules."
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

let field_descriptors ~method_name =
  let method_name = canonical_method_name method_name in
  match Api_catalog.find method_name with
  | None -> Error (unknown_method ~kind:Not_found method_name)
  | Some (Api_method.Packed.Pack method_) ->
    let validation_schema = Api_codec.schema (Api_method.request_codec method_) in
    let grouped =
      fields validation_schema
      |> List.map ~f:(fun (name, schema, required, conditional) ->
        name, (schema, required, conditional))
      |> String.Map.of_alist_multi
    in
    let descriptors =
      Map.to_alist grouped
      |> List.map ~f:(fun (name, declarations) ->
        let schemas =
          List.map declarations ~f:(fun (schema, _, _) -> schema)
          |> List.dedup_and_sort ~compare:(fun a b ->
            String.compare (Json.canonical a) (Json.canonical b))
        in
        let field_schema =
          match schemas with
          | [ schema ] -> schema
          | _ -> Json.obj [ "allOf", `Array schemas ]
        in
        let required = List.exists declarations ~f:(fun (_, required, _) -> required) in
        let conditional =
          (not required)
          && List.exists declarations ~f:(fun (_, _, conditional) -> conditional)
        in
        Json.obj
          [ "name", Json.string name
          ; ( "requirement"
            , Json.string
                (if required
                 then "required"
                 else if conditional
                 then "conditional"
                 else "optional") )
          ; "summary", Json.string (shape field_schema ~depth:1)
          ; ( "descriptions"
            , `Array (List.map (descriptions_in field_schema) ~f:Json.string) )
          ; "schema", field_schema
          ; ( "json_argument"
            , `Array [ Json.string "--json-field"; Json.string name; Json.string "JSON" ]
            )
          ])
    in
    Ok
      (Json.obj
         [ "method", Json.string method_name
         ; "summary", Json.string (Api_method.summary method_)
         ; "fields", `Array descriptors
         ; "validation_schema", validation_schema
         ; "schema_dialect", Json.string "https://json-schema.org/draft/2020-12/schema"
         ; ( "guidance"
           , Json.string
               "Fields describe inputs, not an independent validator. Cross-field \
                alternatives, references and mapped constraints remain in \
                validation_schema; the executable validator is authoritative. Required \
                means raw API input: context defaults may supply some fields. JSON \
                includes its quotes for strings; arrays/objects use --json-field or \
                --params-file." )
         ])
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
    | "transaction.preflight" ->
      [ "operations: the same 1..32 ordered {method, params, as?} objects as \
         transaction.apply; preview runs domain preparation without committing."
      ; "Supply explicit actor_id/run_id for the intended writer. Generated IDs and \
         proposed revision are unreserved; a later write repeats every check."
      ; "Preview does not check storage commit admission or filesystem health. No \
         mutation_id, durable receipt or automatic plan splitting."
      ; "Discover operation fields with help METHOD; schema transaction.preflight \
         includes the complete union."
      ]
    | "resource.put_text" ->
      [ "Creation requires title; updating may omit it to preserve current title under \
         the exact entity expected_revision guard. Omitted filename/MIME are retained. \
         Content version.revision/digest identify immutable bytes, not the entity guard."
      ]
    | "board.put" | "thread.put" ->
      [ "Use expected_revision 0 to create; updating requires the entity's current \
         revision."
      ]
    | "ticket.start" ->
      [ "The ticket must be ready and claimable; retain the returned token. Supply \
         run_id and attempt_id to start an attempt atomically."
      ]
    | "coordinator.overview" ->
      [ "Select stale_run and unobserved_run to inspect advisory observation_age_ms, \
         clock_regressed and held_work counts. Age uses captured_now_unix_ms and the \
         latest durable observe/advisory heartbeat. Unknown age never proves the \
         external process stopped."
      ; "held_work counts retained ticket claims, named/path reservation targets and \
         nonterminal attempts for the whole run, including expired records; project \
         selection does not narrow counts. Shared targets count once, and attempts can \
         overlap claims."
      ; "Heartbeats never renew leases or release ownership. The harness must \
         monitor/resume/stop or isolate external execution and explicitly renew, release \
         or recover with exact guards. A turn ending is not a Workgraph lifecycle \
         transition."
      ]
    | "participant.list" ->
      [ "Discovers registered catalog identities (including archived) and actors from \
         retained attributed writes. registration is null for unregistered participants; \
         observed is null for catalog-only identities."
      ; "sources identifies catalog/activity/fact/comment/request/run provenance. \
         First/last observed revisions cover retained history, not lifetime or liveness. \
         Merely named recipients/resolvers are not observed writers."
      ; "Pages retain whole records in actor ID order. Continue next_offset with the \
         same at_revision; any intervening mutation requires a rescan. This read never \
         creates actors or runs."
      ]
    | "ticket.read" ->
      [ "Returns the complete ticket in data.ticket, including description and \
         acceptance_criteria. It never silently clips prose: increase max_bytes if \
         necessary. expand_context reads handoffs, amendments and review evidence under \
         the same current-revision guard."
      ]
    | "ticket.brief" ->
      [ "This is a preview, with omitted byte/item counts. Use expand_ticket for \
         complete ticket instructions or expand for coordination context before acting."
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
      [ "Only a registered live run owned by actor_id can receive work; run_id \
         attribution must identify target_run_id. Terminal runs have no eligible work."
      ; "Supply a fresh attempt_id; context does not default target_run_id or attempt_id."
      ; "Standalone empty: meta.durable=false at the unchanged planning revision; no \
         attempt or receipt is consumed. Identical saved bytes reevaluate until a \
         selection commits, then exact retries return that immutable receipt."
      ; "Explicit transaction.apply batches remain durable, including empty allocations."
      ]
    | "ticket.ready" | "ticket.readiness" ->
      [ "Select target_run_id for a registered run, or candidate:{actor_id,capabilities} \
         for read-only prospective eligibility without creating a probe run. The \
         selectors are mutually exclusive and never defaulted from context."
      ; "Without either selector this is graph readiness. Candidate ready means known \
         checks passed; assessment.unknown_checks reports run lifecycle/budget and \
         required path ownership. Actual claim/start rechecks all admission."
      ; "Retain the same selector and filters on subsequent offset pages, with the \
         observed workspace_revision supplied as at_revision."
      ; "ticket.ready leaf_only excludes parents with unfinished children. Inspect \
         ticket.readiness with the same selector for typed exclusion reasons."
      ]
    | "ticket.finish" ->
      [ "Supply nonblank completion evidence and satisfy configured current acceptance \
         gates."
      ]
    | "attention.read" | "attention.wait" ->
      [ "Communication requires filter.recipient and filter.consumer_id together. Select \
         filter.kinds:[\"communication\"] for a communication-only watcher; omitting \
         kinds also selects fact, ticket and readiness activity."
      ; "Keep the exact filter and returned cursor. Drain has_more before waiting; \
         needs_larger_budget means retry that cursor with a larger max_bytes. Reading or \
         waiting never acknowledges delivery. timeout_ms for wait is 1..25000."
      ]
    | "inbox.read" | "inbox.wait" ->
      [ "Unread delivery is scoped to the exact recipient kind/id and consumer_id. Actor \
         and run recipients are separate; acknowledgements for one consumer do not \
         consume another consumer's inbox."
      ; "Empty items may reflect acknowledgements, after/through, kinds, ticket_id or \
         exclude_self. Check echoed recipient/consumer/capture and retain the exact \
         filters across pages; reads never acknowledge."
      ]
      @
      if String.equal name "inbox.wait"
      then
        [ "timeout_ms is capped at 25000; repeat bounded waits and retain the returned \
           next_after."
        ]
      else []
    | _ -> []
  in
  common @ guarded @ specific @ descriptions_in request
;;

let result_paths = function
  | "run.register" | "run.transition" | "run.observe" | "run.link_session" ->
    ".result.data.{run_id,revision,status,actor_id,last_observed_unix_ms,session_ids}; \
     .revision guards this run; observation is caller-reported"
  | "allocation.pool_put" ->
    ".result.data.{name,revision,limit}; .revision guards this pool"
  | "allocation.ticket_policy_put" ->
    ".result.data.{ticket_id,revision,required_capabilities,pools}"
  | "attempt.start" | "attempt.checkpoint" | "attempt.finish" ->
    ".result.data.{attempt_id,revision,state}; .revision guards this attempt"
  | "reservation.acquire" ->
    ".result.data.coordination_revision; .result.data.holds[].{reservation_id,holder}; \
     holder carries the actual actor/run/token/mode/lease"
  | "reservation.paths.acquire" ->
    ".result.data.coordination_revision; .result.data.holds[].{target,holder}; holder \
     carries the actual actor/run/token/mode/lease/origin"
  | "request.ask" ->
    ".result.data.{request_id,request_revision,thread_id,thread_revision,question}"
  | "request.resolve" ->
    ".result.data.{request_id,request_revision,thread_id,thread_revision,status,answer}; \
     answer is the exact comment/version reference or null"
  | "ticket.context" ->
    ".result.data.ticket.{ticket_id,description,status,claim}; .result.data.handoff"
  | "ticket.list" ->
    ".result.data.items[].ticket_id; .result.data.next_offset; \
     .result.meta.workspace_revision"
  | "ticket.ready" ->
    ".result.data.items[].ticket_id; .result.data.next_offset; \
     .result.data.assessment.{scope,unknown_checks}; .result.meta.workspace_revision"
  | "ticket.readiness" ->
    ".result.data.{ready,reasons,assessment}; assessment distinguishes known checks from \
     candidate run-dependent unknowns"
  | "ticket.claim_next" ->
    ".result.data.kind; when selected: .result.data.claim.{ticket_id,token} and \
     .result.data.attempt; when empty: .result.data.explanation and meta.durable=false"
  | "resource.get" ->
    ".result.data.metadata.title; .result.data.revision (entity guard); \
     .result.data.current_version.{revision,digest} (content pin)"
  | "resource.read" ->
    ".result.data.text; .result.data.version (content version); .result.data.digest"
  | "resource.read_text" ->
    ".result.data.text; .result.data.{version,digest,offset,next_offset,eof}; offsets \
     and lengths count UTF-8 bytes"
  | "resource.list" | "fact.list" ->
    ".result.data.items; .result.data.next_offset; .result.meta.workspace_revision"
  | "fact.keys" -> ".result.data.items; .result.data.remaining; .result.data.total"
  | "transaction.apply" ->
    ".result.data.results[] has method and data, in operation order"
  | "request.get" ->
    ".result.data.{revision,thread_revision,status.kind,answer}; answer is the exact \
     pinned comment with body/comment_id/revision, or null; with include_messages: \
     .result.data.related.{source_message,messages.items}"
  | "ticket.progress" ->
    ".result.data.comment_id (new progress comment); .result.meta.workspace_revision is \
     the commit, not the ticket revision; read ticket.get for its current revision"
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
        if
          List.mem
            [ "transaction.apply"; "transaction.preflight" ]
            name
            ~equal:String.equal
          && String.equal field "operations"
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
    if List.mem [ "transaction.apply"; "transaction.preflight" ] name ~equal:String.equal
    then
      Json.obj
        [ "workspace_id", Json.string "workspace"
        ; "actor_id", Json.string "actor"
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
      |> fun sample ->
      if String.equal name "transaction.apply"
      then (
        match sample with
        | `Object fields ->
          Json.obj (("mutation_id", Json.string "unique-mutation") :: fields)
        | _ -> assert false)
      else sample
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
        if String.equal name "resource.put_text"
        then set sample "title" (Json.string "Recorded notes")
        else sample
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
        if String.equal name "request.ask"
        then set sample "title" (Json.string "Question")
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
          workspace_id and writer actor_id/run_id only when admitted by the method, \
          including the intended writer for transaction.preflight."
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
         then
           "\n\
            Local helpers: resource.publish_text, resource.upload, \
            resource.upload-abort, resource.download (help each helper)."
         else if
           Option.equal String.equal method_name (Some "reservation")
           || Option.equal String.equal method_name (Some "reservation.paths")
         then
           "\nLocal helpers: reservation wait, reservation paths wait (help each helper)."
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
             CLI helpers (local workflows): init, bootstrap, journal.inspect, \
             journal.list, resource.publish_text, upload, download, evidence-run, \
             evidence-publish, retry.\n\
             CLI spelling: ticket.get (canonical ticket.context); request get/list/... \
             select request-domain methods with --context/--socket.\n\
             Generic transport: request ABS_SOCKET METHOD; dotted METHOD is also accepted.\n\
             Use methods --core for everyday methods; help METHOD for concise inputs; \
             help METHOD --full for complete contracts.")
;;
