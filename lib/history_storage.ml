open Core

let validate_digest value =
  let text = Json.text value in
  if
    String.length text <> 64
    || not
         (String.for_all text ~f:(fun c -> Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
  then Json.fail Corrupt_store "invalid frozen history digest";
  text
;;

let id value =
  let text = Json.text value in
  if
    String.is_empty text
    || String.length text > 96
    || not
         (String.for_all text ~f:(fun c ->
            Char.is_alphanum c || Char.equal c '_' || Char.equal c '-'))
  then Json.fail Corrupt_store "invalid frozen history ID";
  text
;;

let nullable value f =
  match value with
  | `Null -> None
  | value -> Some (f value)
;;

let version json =
  if Json.integer (Json.field json "version") <> 1
  then Json.fail Unsupported_version "unsupported history schema version"
;;

let ref_ json =
  Json.fields json ~allowed:[ "session_id"; "sequence" ];
  ignore (id (Json.field json "session_id") : string);
  let n = Json.integer (Json.field json "sequence") in
  if n < 1 || n > 1_000_000 then Json.fail Corrupt_store "invalid frozen event sequence"
;;

let blob json =
  Json.fields json ~allowed:[ "digest"; "size_bytes" ];
  ignore (validate_digest (Json.field json "digest") : string);
  if Json.integer (Json.field json "size_bytes") > 64 * 1024 * 1024
  then Json.fail Corrupt_store "invalid frozen blob size"
;;

let session json =
  Json.fields
    json
    ~allowed:
      [ "workspace_id"; "id"; "title"; "actor"; "run"; "parent"; "scopes"; "archived" ];
  List.iter [ "workspace_id"; "id"; "actor" ] ~f:(fun key ->
    ignore (id (Json.field json key) : string));
  ignore (nullable (Json.field json "run") id : string option);
  ignore (nullable (Json.field json "parent") ref_ : unit option);
  ignore (Json.bounded_text (Json.field json "title") ~max_bytes:512 : string);
  (match Json.field json "archived" with
   | `True | `False -> ()
   | _ -> Json.fail Corrupt_store "invalid frozen archived flag");
  let scopes = Json.list (Json.field json "scopes") in
  if List.length scopes > 100
  then Json.fail Corrupt_store "too many frozen session scopes";
  List.iter scopes ~f:(fun json ->
    Json.fields json ~allowed:[ "kind"; "id" ];
    match Json.text (Json.field json "kind") with
    | "workspace" ->
      if Option.is_some (Json.optional json "id")
      then Json.fail Corrupt_store "workspace scope has id"
    | "project" | "milestone" | "ticket" | "resource" ->
      ignore (id (Json.field json "id") : string)
    | _ -> Json.fail Unsupported_version "unsupported frozen scope kind")
;;

let event json =
  Json.fields json ~allowed:[ "ref"; "identity_hash"; "actor"; "run"; "event" ];
  ref_ (Json.field json "ref");
  ignore (id (Json.field json "actor") : string);
  ignore (nullable (Json.field json "run") id : string option);
  ignore (validate_digest (Json.field json "identity_hash") : string);
  let input = Json.field json "event" in
  Json.fields
    input
    ~allowed:
      [ "client_id"
      ; "role"
      ; "kind"
      ; "phase"
      ; "correlation"
      ; "provenance"
      ; "payload"
      ; "searchable_text"
      ; "resource_versions"
      ; "attachments"
      ];
  List.iter [ "client_id"; "role"; "kind"; "phase" ] ~f:(fun key ->
    ignore (Json.bounded_text (Json.field input key) ~max_bytes:256 : string));
  ignore
    (nullable (Json.field input "correlation") (fun value ->
       Json.bounded_text value ~max_bytes:256)
     : string option);
  if String.length (Json.canonical (Json.field input "provenance")) > 4096
  then Json.fail Corrupt_store "frozen provenance too large";
  let content json =
    Json.fields json ~allowed:[ "blob" ];
    blob (Json.field json "blob")
  in
  content (Json.field input "payload");
  ignore (nullable (Json.field input "searchable_text") content : unit option);
  let attachments = Json.list (Json.field input "attachments") in
  if List.length attachments > 100
  then Json.fail Corrupt_store "too many frozen attachments";
  List.iter attachments ~f:blob;
  let resources = Json.list (Json.field input "resource_versions") in
  if List.length resources > 100
  then Json.fail Corrupt_store "too many resource references";
  List.iter resources ~f:(fun json ->
    Json.fields json ~allowed:[ "resource_id"; "revision" ];
    ignore (id (Json.field json "resource_id") : string);
    let revision = Json.integer (Json.field json "revision") in
    if revision < 1 || revision > 100_000
    then Json.fail Corrupt_store "invalid frozen resource revision")
;;

let change json =
  match Json.text (Json.field json "kind") with
  | "create" ->
    Json.fields json ~allowed:[ "kind"; "session" ];
    session (Json.field json "session")
  | "archive" ->
    Json.fields json ~allowed:[ "kind"; "session_id" ];
    ignore (id (Json.field json "session_id") : string)
  | "append" ->
    Json.fields json ~allowed:[ "kind"; "session_id"; "actor"; "run"; "events" ];
    ignore (id (Json.field json "session_id") : string);
    ignore (id (Json.field json "actor") : string);
    ignore (nullable (Json.field json "run") id : string option);
    let events = Json.list (Json.field json "events") in
    if List.length events > 128
    then Json.fail Corrupt_store "frozen batch event limit exceeded";
    List.iter events ~f:event
  | _ -> Json.fail Unsupported_version "unsupported frozen history change"
;;

let validate_receipt ~workspace ~actor ~change:change_json response =
  (match Json.field response "durable" with
   | `True -> ()
   | _ -> Json.fail Corrupt_store "frozen receipt must be durable");
  let same_id left right = String.equal (id left) (id right) in
  match Json.text (Json.field change_json "kind") with
  | "create" ->
    Json.fields response ~allowed:[ "durable"; "session"; "through" ];
    let metadata = Json.field change_json "session" in
    if
      (not (String.equal actor (id (Json.field metadata "actor"))))
      || Json.integer (Json.field response "through") <> 0
      || not
           (String.equal
              (Json.canonical metadata)
              (Json.canonical (Json.field response "session")))
    then Json.fail Corrupt_store "frozen create receipt differs from change"
  | "archive" ->
    Json.fields response ~allowed:[ "durable"; "session" ];
    let metadata = Json.field response "session" in
    session metadata;
    if
      (not (same_id (Json.field metadata "id") (Json.field change_json "session_id")))
      || not (String.equal (id (Json.field metadata "workspace_id")) workspace)
    then Json.fail Corrupt_store "frozen archive receipt identity differs";
    (match Json.field metadata "archived" with
     | `True -> ()
     | `False -> Json.fail Corrupt_store "frozen archive receipt is not archived"
     | _ -> assert false)
  | "append" ->
    Json.fields response ~allowed:[ "durable"; "session_id"; "through"; "events" ];
    let session_id = Json.field change_json "session_id" in
    if
      (not (same_id (Json.field response "session_id") session_id))
      || not (String.equal actor (id (Json.field change_json "actor")))
    then Json.fail Corrupt_store "frozen append receipt attribution differs";
    let run = nullable (Json.field change_json "run") id in
    List.iter
      (Json.list (Json.field change_json "events"))
      ~f:(fun event ->
        if
          (not (String.equal actor (id (Json.field event "actor"))))
          || not (Option.equal String.equal run (nullable (Json.field event "run") id))
        then Json.fail Corrupt_store "frozen event attribution differs from append");
    let through = Json.integer (Json.field response "through") in
    let refs = Json.list (Json.field response "events") in
    if through < 1 || through > 1_000_000 || List.is_empty refs || List.length refs > 128
    then Json.fail Corrupt_store "invalid frozen append receipt bounds";
    List.iter refs ~f:(fun reference ->
      ref_ reference;
      if
        (not (same_id (Json.field reference "session_id") session_id))
        || Json.integer (Json.field reference "sequence") > through
      then Json.fail Corrupt_store "frozen receipt event is outside append bounds")
  | _ -> Json.fail Unsupported_version "unsupported frozen receipt change"
;;

module Head = struct
  type t =
    { workspace : Id.Workspace.t
    ; sequence : int
    ; digest : string option
    }

  let create ~workspace ~sequence ~digest =
    Json.decode (fun () ->
      Option.iter digest ~f:(fun text ->
        ignore (validate_digest (Json.string text) : string));
      if
        sequence < 0
        || sequence > 1_000_000
        || Bool.(Int.equal sequence 0 <> Option.is_none digest)
      then Json.fail Corrupt_store "history HEAD sequence/digest mismatch";
      { workspace; sequence; digest })
  ;;

  let to_json t =
    Json.obj
      [ "version", Json.int 1
      ; "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
      ; "sequence", Json.int t.sequence
      ; "digest", Option.value_map t.digest ~default:`Null ~f:Json.string
      ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "version"; "workspace_id"; "sequence"; "digest" ];
      version json;
      create
        ~workspace:(Id.Workspace.t_of_jsonaf (Json.field json "workspace_id"))
        ~sequence:(Json.integer (Json.field json "sequence"))
        ~digest:(nullable (Json.field json "digest") validate_digest)
      |> Disk.unwrap)
  ;;

  let workspace t = t.workspace
  let sequence t = t.sequence
  let digest t = t.digest
end

module Batch = struct
  type t = Jsonaf.t

  let of_json json =
    Json.decode (fun () ->
      Json.fields
        json
        ~allowed:
          [ "version"
          ; "workspace_id"
          ; "sequence"
          ; "previous"
          ; "key"
          ; "request_hash"
          ; "change"
          ; "response"
          ];
      version json;
      let workspace = id (Json.field json "workspace_id") in
      let sequence = Json.integer (Json.field json "sequence") in
      let previous = nullable (Json.field json "previous") validate_digest in
      if
        sequence < 1
        || sequence > 1_000_000
        || Bool.(Int.equal sequence 1 <> Option.is_none previous)
      then Json.fail Corrupt_store "invalid frozen batch predecessor";
      let key = Json.text (Json.field json "key") in
      if
        String.is_empty key
        || String.length key > 256
        || not
             (String.for_all key ~f:(fun c ->
                Char.is_alphanum c || List.mem [ '_'; '-'; ':' ] c ~equal:Char.equal))
      then Json.fail Corrupt_store "invalid frozen receipt key";
      let actor =
        match String.split key ~on:':' with
        | [ actor; mutation ] ->
          ignore (id (Json.string mutation) : string);
          id (Json.string actor)
        | _ -> Json.fail Corrupt_store "frozen receipt requires actor:mutation"
      in
      ignore (validate_digest (Json.field json "request_hash") : string);
      change (Json.field json "change");
      validate_receipt
        ~workspace
        ~actor
        ~change:(Json.field json "change")
        (Json.field json "response");
      json)
  ;;

  let to_json t = t

  let create ~workspace ~sequence ~previous ~key ~request_hash ~change ~response =
    of_json
      (Json.obj
         [ "version", Json.int 1
         ; "workspace_id", Id.Workspace.jsonaf_of_t workspace
         ; "sequence", Json.int sequence
         ; "previous", Option.value_map previous ~default:`Null ~f:Json.string
         ; "key", Json.string key
         ; "request_hash", Json.string request_hash
         ; "change", change
         ; "response", response
         ])
  ;;
end
