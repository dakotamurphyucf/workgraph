open Core

module Registration = struct
  type t =
    { root : string
    ; is_open : bool
    ; known_head : string option
    ; known_history_head : string option
    }
end

module Receipt = struct
  type t =
    { request_hash : string
    ; response : Jsonaf.t
    }
end

module Create_intent = struct
  type t =
    { request_hash : string
    ; root : string
    ; workspace : Id.Workspace.t
    ; name : string
    ; token : string
    }
end

type t =
  { registrations : Registration.t String.Map.t
  ; receipts : Receipt.t String.Map.t
  ; creates : Create_intent.t String.Map.t
  ; exports : Export_job.t String.Map.t
  ; restores : Restore_plan.t String.Map.t
  }

let empty =
  { registrations = String.Map.empty
  ; receipts = String.Map.empty
  ; creates = String.Map.empty
  ; exports = String.Map.empty
  ; restores = String.Map.empty
  }
;;

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let absolute path =
  if (not (Filename.is_absolute path)) || String.mem path '\000'
  then Json.fail Corrupt_store "invalid registry root"
;;

let object_map map ~f =
  Json.obj (Map.to_alist map |> List.map ~f:(fun (key, value) -> key, f value))
;;

let validate t =
  let digest value =
    if
      String.length value <> 64
      || not
           (String.for_all value ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Corrupt_store "invalid registry digest"
  in
  let key value =
    match String.split value ~on:':' with
    | [ actor; mutation ] ->
      ignore (unwrap (Id.Actor.of_string actor) : Id.Actor.t);
      ignore (unwrap (Id.Actor.of_string mutation) : Id.Actor.t)
    | _ -> Json.fail Corrupt_store "invalid registry receipt key"
  in
  let roots = ref String.Set.empty in
  let identities = ref String.Set.empty in
  let reserve root id =
    absolute root;
    if Set.mem !roots root || Set.mem !identities id
    then Json.fail Corrupt_store "duplicate registry root or identity";
    roots := Set.add !roots root;
    identities := Set.add !identities id
  in
  Map.iteri t.registrations ~f:(fun ~key:id ~data:r ->
    ignore (unwrap (Id.Workspace.of_string id) : Id.Workspace.t);
    reserve r.root id;
    Option.iter r.known_head ~f:digest;
    Option.iter r.known_history_head ~f:digest);
  Map.iteri t.receipts ~f:(fun ~key:k ~data:r ->
    key k;
    digest r.request_hash);
  Map.iteri t.creates ~f:(fun ~key:k ~data:r ->
    key k;
    digest r.request_hash;
    digest r.token;
    if Map.mem t.receipts k then Json.fail Corrupt_store "intent already has receipt";
    reserve r.root (Id.Workspace.to_string r.workspace);
    if String.is_empty (String.strip r.name) || String.length r.name > 512
    then Json.fail Corrupt_store "invalid pending workspace name");
  Map.iteri t.restores ~f:(fun ~key:k ~data:plan ->
    key k;
    Restore_plan.validate plan;
    if Map.mem t.receipts k || Map.mem t.creates k
    then Json.fail Corrupt_store "restore intent key already used";
    List.iter plan.targets ~f:(fun target ->
      reserve target.root (Id.Workspace.to_string target.capture.workspace)));
  Map.iteri t.exports ~f:(fun ~key ~data:job ->
    if not (String.equal key job.id) then Json.fail Corrupt_store "export job key differs";
    Export_job.validate job)
;;

let encode t =
  Json.decode (fun () ->
    validate t;
    let bytes =
      Json.canonical
        (Json.obj
           [ "version", Json.int 1
           ; "restores", object_map t.restores ~f:Restore_plan.to_json
           ; "exports", object_map t.exports ~f:Export_job.to_json
           ; ( "workspaces"
             , object_map t.registrations ~f:(fun r ->
                 Json.obj
                   [ "root", Json.string r.root
                   ; ("open", if r.is_open then `True else `False)
                   ; ( "known_history_head"
                     , Option.value_map r.known_history_head ~default:`Null ~f:Json.string
                     )
                   ; ( "known_head"
                     , Option.value_map r.known_head ~default:`Null ~f:Json.string )
                   ]) )
           ; ( "receipts"
             , object_map t.receipts ~f:(fun r ->
                 Json.obj
                   [ "request_hash", Json.string r.request_hash; "response", r.response ])
             )
           ; ( "creates"
             , object_map t.creates ~f:(fun r ->
                 Json.obj
                   [ "request_hash", Json.string r.request_hash
                   ; "root", Json.string r.root
                   ; "workspace_id", Id.Workspace.jsonaf_of_t r.workspace
                   ; "name", Json.string r.name
                   ; "token", Json.string r.token
                   ]) )
           ])
    in
    if String.length bytes > 4 * 1024 * 1024
    then Json.fail Invalid_argument "registry capacity exceeded (4MiB)";
    bytes)
;;

let decode bytes =
  Json.decode (fun () ->
    let json = unwrap (Json.parse bytes) in
    let version = Json.integer (Json.field json "version") in
    if version <> 1 then Json.fail Unsupported_version "registry version unsupported";
    Json.fields
      json
      ~allowed:[ "version"; "workspaces"; "receipts"; "creates"; "exports"; "restores" ];
    let map field f =
      match Json.field json field with
      | `Object entries ->
        String.Map.of_alist_exn
          (List.map entries ~f:(fun (key, value) -> key, f key value))
      | _ -> Json.fail Corrupt_store "invalid registry map"
    in
    let registrations =
      map "workspaces" (fun id json ->
        Json.fields json ~allowed:[ "root"; "open"; "known_head"; "known_history_head" ];
        ignore (unwrap (Id.Workspace.of_string id) : Id.Workspace.t);
        let root = Json.text (Json.field json "root") in
        absolute root;
        let is_open =
          match Json.field json "open" with
          | `True -> true
          | `False -> false
          | _ -> Json.fail Corrupt_store "invalid open flag"
        in
        let known_head =
          match Json.field json "known_head" with
          | `Null -> None
          | j -> Some (Json.text j)
        in
        { Registration.root
        ; is_open
        ; known_head
        ; known_history_head =
            (match Json.field json "known_history_head" with
             | `Null -> None
             | value -> Some (Json.text value))
        })
    in
    let receipts, creates =
      ( map "receipts" (fun _ json ->
          Json.fields json ~allowed:[ "request_hash"; "response" ];
          { Receipt.request_hash = Json.text (Json.field json "request_hash")
          ; response = Json.field json "response"
          })
      , map "creates" (fun _ json ->
          Json.fields
            json
            ~allowed:[ "request_hash"; "root"; "workspace_id"; "name"; "token" ];
          { Create_intent.request_hash = Json.text (Json.field json "request_hash")
          ; root = Json.text (Json.field json "root")
          ; workspace = Id.Workspace.t_of_jsonaf (Json.field json "workspace_id")
          ; name = Json.text (Json.field json "name")
          ; token = Json.text (Json.field json "token")
          }) )
    in
    let exports = map "exports" (fun _ json -> Export_job.of_json json) in
    let restores = map "restores" (fun _ json -> Restore_plan.of_json json) in
    let t = { registrations; receipts; creates; exports; restores } in
    validate t;
    t)
;;

let request ~method_ ~params =
  Json.decode (fun () ->
    let actor = Id.Actor.t_of_jsonaf (Json.field params "actor_id") in
    let mutation = Id.Actor.t_of_jsonaf (Json.field params "mutation_id") in
    let key = Id.Actor.to_string actor ^ ":" ^ Id.Actor.to_string mutation in
    let hash =
      Json.hash
        (Json.canonical (Json.obj [ "method", Json.string method_; "params", params ]))
    in
    key, hash)
;;
