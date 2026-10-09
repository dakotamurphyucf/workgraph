open Core

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required
let opt = Api_codec.Fields.optional

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:
      "Validated literal entity ID; registry administration is outside planning batches."
;;

let unwrap = function
  | Ok v -> v
  | Error p -> raise (Json.Decode_error p)
;;

let count = Api_codec.decimal ~max:Int.max_value
let workspace = id Id.Workspace.of_string Id.Workspace.to_string
let actor = id Id.Actor.of_string Id.Actor.to_string
let mutation = id Id.Mutation.of_string Id.Mutation.to_string

let job =
  Api_codec.map
    (id Id.Actor.of_string Id.Actor.to_string)
    ~decode:(fun id -> Ok (Id.Actor.to_string id))
    ~encode:(fun s -> unwrap (Id.Actor.of_string s))
    ~description:"Validated stable export job identity."
;;

let limit =
  Api_codec.map
    (Api_codec.decimal ~max:100)
    ~decode:(fun n ->
      if n > 0
      then Ok n
      else Error (Problem.create Invalid_argument "limit must be 1..100"))
    ~encode:Fn.id
    ~description:"1..100 complete export jobs."
;;

let max_bytes =
  Api_codec.map
    (Api_codec.decimal ~max:1_048_576)
    ~decode:(fun n ->
      if n >= 4096
      then Ok n
      else Error (Problem.create Invalid_argument "max_bytes must be 4096..1048576"))
    ~encode:Fn.id
    ~description:"Public response envelope byte bound."
;;

let name =
  Api_codec.map
    (Api_codec.text ~max_bytes:512)
    ~decode:(fun s ->
      if String.is_empty (String.strip s)
      then Error (Problem.create Invalid_argument "workspace name must be nonblank")
      else Ok s)
    ~encode:Fn.id
    ~description:"Nonblank workspace name."
;;

module Identity = struct
  type t =
    { actor : Id.Actor.t
    ; mutation : Id.Mutation.t
    }

  let fields =
    Api_codec.Fields.map
      (req "actor_id" actor <*> req "mutation_id" mutation)
      ~decode:(fun (actor, mutation) -> { actor; mutation })
      ~encode:(fun i -> i.actor, i.mutation)
  ;;

  let key i = Id.Actor.to_string i.actor ^ ":" ^ Id.Mutation.to_string i.mutation
end

module Request = struct
  type t =
    | Health
    | Workspace_list
    | Workspace_create of
        { identity : Identity.t
        ; workspace : Id.Workspace.t option
        ; name : string
        ; root : string
        }
    | Workspace_register of
        { identity : Identity.t
        ; root : string
        }
    | Workspace_open of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        }
    | Workspace_close of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        }
    | Workspace_unregister of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        }
    | Workspace_receipt of Mutation_request.t
    | Registry_receipt of Identity.t
    | Workspace_export of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        ; destination : string
        }
    | Export_all of
        { identity : Identity.t
        ; destination : string
        ; allow_partial : bool
        }
    | Export_get of string
    | Export_list of
        { offset : int
        ; limit : int
        ; max_bytes : int
        ; at_snapshot : string option
        }
    | Export_cancel of
        { identity : Identity.t
        ; job : string
        }
    | Export_retry of
        { identity : Identity.t
        ; job : string
        }
    | Export_verify of string
    | Workspace_restore of
        { identity : Identity.t
        ; directory : string
        ; root : string
        }
    | Restore_all of
        { identity : Identity.t
        ; directory : string
        ; roots : (Id.Workspace.t * string) list
        }
    | Restore_cancel of
        { identity : Identity.t
        ; target : Identity.t
        }

  type entry =
    { name : string
    ; raw : Jsonaf.t Api_codec.t
    ; typed : t Api_codec.t
    }

  let entry name fields ~decode ~encode =
    { name
    ; raw = Api_codec.as_json (Api_codec.object_ fields)
    ; typed = obj fields ~decode ~encode
    }
  ;;

  let constant name command =
    entry name Api_codec.Fields.empty ~decode:(fun () -> command) ~encode:(fun _ -> ())
  ;;

  let wrong () =
    Json.fail Invalid_argument "administrative command differs from selected method"
  ;;

  let roots =
    Api_codec.map
      (Api_codec.dictionary Administration_wire.path ~max_items:1000 ~max_key_bytes:96)
      ~decode:(fun pairs ->
        Json.decode (fun () ->
          if List.is_empty pairs
          then Json.fail Invalid_argument "restore roots must not be empty";
          List.map pairs ~f:(fun (key, root) -> unwrap (Id.Workspace.of_string key), root)))
      ~encode:(fun pairs ->
        List.map pairs ~f:(fun (key, root) -> Id.Workspace.to_string key, root))
      ~description:
        "Exactly the exported workspace IDs map to fresh absolute destinations; \
         inventory equality is verified at runtime."
  ;;

  let export_list_entry =
    let fields =
      opt "offset" count
      <*> opt "limit" limit
      <*> opt "max_bytes" max_bytes
      <*> opt "at_snapshot" Administration_wire.digest
    in
    let fields =
      Api_codec.Fields.map
        fields
        ~decode:(fun (((offset, limit), max_bytes), at_snapshot) ->
          let offset = Option.value offset ~default:0 in
          if offset > 0 && Option.is_none at_snapshot
          then Json.fail Invalid_argument "export pagination requires at_snapshot";
          Export_list
            { offset
            ; limit = Option.value limit ~default:50
            ; max_bytes = Option.value max_bytes ~default:65_536
            ; at_snapshot
            })
        ~encode:(function
          | Export_list { offset; limit; max_bytes; at_snapshot } ->
            ((Some offset, Some limit), Some max_bytes), at_snapshot
          | _ -> wrong ())
    in
    { name = "export.list"
    ; raw = Api_codec.as_json (Api_codec.object_ fields)
    ; typed = Api_codec.object_ fields
    }
  ;;

  let entries =
    [ constant "daemon.health" Health
    ; constant "workspace.list" Workspace_list
    ; entry
        "workspace.create"
        (Identity.fields
         <*> opt "workspace_id" workspace
         <*> req "name" name
         <*> req "root" Administration_wire.path)
        ~decode:(fun (((identity, workspace), name), root) ->
          Workspace_create { identity; workspace; name; root })
        ~encode:(function
          | Workspace_create { identity; workspace; name; root } ->
            ((identity, workspace), name), root
          | _ -> wrong ())
    ; entry
        "workspace.register"
        (Identity.fields <*> req "root" Administration_wire.path)
        ~decode:(fun (identity, root) -> Workspace_register { identity; root })
        ~encode:(function
          | Workspace_register { identity; root } -> identity, root
          | _ -> wrong ())
    ; entry
        "workspace.open"
        (Identity.fields <*> req "workspace_id" workspace)
        ~decode:(fun (identity, workspace) -> Workspace_open { identity; workspace })
        ~encode:(function
          | Workspace_open { identity; workspace } -> identity, workspace
          | _ -> wrong ())
    ; entry
        "workspace.close"
        (Identity.fields <*> req "workspace_id" workspace)
        ~decode:(fun (identity, workspace) -> Workspace_close { identity; workspace })
        ~encode:(function
          | Workspace_close { identity; workspace } -> identity, workspace
          | _ -> wrong ())
    ; entry
        "workspace.unregister"
        (Identity.fields <*> req "workspace_id" workspace)
        ~decode:(fun (identity, workspace) ->
          Workspace_unregister { identity; workspace })
        ~encode:(function
          | Workspace_unregister { identity; workspace } -> identity, workspace
          | _ -> wrong ())
    ; { name = "workspace.receipt"
      ; raw = Api_codec.as_json Mutation_request.codec
      ; typed =
          Api_codec.map
            Mutation_request.codec
            ~decode:(fun i -> Ok (Workspace_receipt i))
            ~encode:(function
              | Workspace_receipt i -> i
              | _ -> wrong ())
            ~description:
              "Exact saved planning receipt identity; run attribution is optional."
      }
    ; entry
        "registry.receipt"
        Identity.fields
        ~decode:(fun i -> Registry_receipt i)
        ~encode:(function
          | Registry_receipt i -> i
          | _ -> wrong ())
    ; entry
        "workspace.export"
        (Identity.fields
         <*> req "workspace_id" workspace
         <*> req "destination" Administration_wire.path)
        ~decode:(fun ((identity, workspace), destination) ->
          Workspace_export { identity; workspace; destination })
        ~encode:(function
          | Workspace_export { identity; workspace; destination } ->
            (identity, workspace), destination
          | _ -> wrong ())
    ; entry
        "daemon.export_all"
        (Identity.fields
         <*> req "destination" Administration_wire.path
         <*> opt "allow_partial" Api_codec.boolean)
        ~decode:(fun ((identity, destination), allow_partial) ->
          Export_all
            { identity
            ; destination
            ; allow_partial = Option.value allow_partial ~default:false
            })
        ~encode:(function
          | Export_all { identity; destination; allow_partial } ->
            (identity, destination), Some allow_partial
          | _ -> wrong ())
    ; entry
        "export.get"
        (req "job_id" job)
        ~decode:(fun id -> Export_get id)
        ~encode:(function
          | Export_get id -> id
          | _ -> wrong ())
    ; export_list_entry
    ; entry
        "export.cancel"
        (Identity.fields <*> req "job_id" job)
        ~decode:(fun (identity, job) -> Export_cancel { identity; job })
        ~encode:(function
          | Export_cancel { identity; job } -> identity, job
          | _ -> wrong ())
    ; entry
        "export.retry"
        (Identity.fields <*> req "job_id" job)
        ~decode:(fun (identity, job) -> Export_retry { identity; job })
        ~encode:(function
          | Export_retry { identity; job } -> identity, job
          | _ -> wrong ())
    ; entry
        "export.verify"
        (req "directory" Administration_wire.path)
        ~decode:(fun directory -> Export_verify directory)
        ~encode:(function
          | Export_verify directory -> directory
          | _ -> wrong ())
    ; entry
        "workspace.restore"
        (Identity.fields
         <*> req "directory" Administration_wire.path
         <*> req "root" Administration_wire.path)
        ~decode:(fun ((identity, directory), root) ->
          Workspace_restore { identity; directory; root })
        ~encode:(function
          | Workspace_restore { identity; directory; root } -> (identity, directory), root
          | _ -> wrong ())
    ; entry
        "daemon.restore_all"
        (Identity.fields
         <*> req "directory" Administration_wire.path
         <*> req "roots" roots)
        ~decode:(fun ((identity, directory), roots) ->
          Restore_all { identity; directory; roots })
        ~encode:(function
          | Restore_all { identity; directory; roots } -> (identity, directory), roots
          | _ -> wrong ())
    ; entry
        "restore.cancel"
        (Identity.fields
         <*> req "target_actor_id" actor
         <*> req "target_mutation_id" mutation)
        ~decode:(fun ((identity, actor), mutation) ->
          Restore_cancel { identity; target = { Identity.actor; mutation } })
        ~encode:(function
          | Restore_cancel { identity; target } ->
            (identity, target.actor), target.mutation
          | _ -> wrong ())
    ]
  ;;

  let method_name = function
    | Health -> "daemon.health"
    | Workspace_list -> "workspace.list"
    | Workspace_create _ -> "workspace.create"
    | Workspace_register _ -> "workspace.register"
    | Workspace_open _ -> "workspace.open"
    | Workspace_close _ -> "workspace.close"
    | Workspace_unregister _ -> "workspace.unregister"
    | Workspace_receipt _ -> "workspace.receipt"
    | Registry_receipt _ -> "registry.receipt"
    | Workspace_export _ -> "workspace.export"
    | Export_all _ -> "daemon.export_all"
    | Export_get _ -> "export.get"
    | Export_list _ -> "export.list"
    | Export_cancel _ -> "export.cancel"
    | Export_retry _ -> "export.retry"
    | Export_verify _ -> "export.verify"
    | Workspace_restore _ -> "workspace.restore"
    | Restore_all _ -> "daemon.restore_all"
    | Restore_cancel _ -> "restore.cancel"
  ;;

  let find method_ = List.find entries ~f:(fun e -> String.equal e.name method_)

  let decode ~method_ ~params =
    match find method_ with
    | Some e -> Api_codec.decode e.typed params
    | None -> Error (Problem.create Invalid_argument "unknown administration method")
  ;;

  let encode request =
    let name = method_name request in
    Result.map
      (Api_codec.encode (Option.value_exn (find name)).typed request)
      ~f:(fun json -> name, json)
  ;;
end

let request_codec ~method_ = Option.map (Request.find method_) ~f:(fun e -> e.Request.raw)

let response_codec ~method_ =
  let raw codec = Some (Api_codec.as_json codec) in
  match method_ with
  | "daemon.health" | "workspace.list" -> raw Administration_wire.Health.codec
  | "workspace.create" | "workspace.register" ->
    raw (Api_codec.object_ (req "workspace_id" workspace))
  | "workspace.open" ->
    raw (Api_codec.object_ (req "opened" (Administration_wire.flag true)))
  | "workspace.close" ->
    raw (Api_codec.object_ (req "closed" (Administration_wire.flag true)))
  | "workspace.unregister" ->
    raw (Api_codec.object_ (req "unregistered" (Administration_wire.flag true)))
  | "workspace.receipt" -> raw Administration_wire.Receipt.planning_codec
  | "registry.receipt" -> raw Administration_wire.Receipt.codec
  | "workspace.export"
  | "daemon.export_all"
  | "export.get"
  | "export.cancel"
  | "export.retry" -> raw Administration_wire.export_job
  | "export.list" -> raw Administration_wire.Export_page.codec
  | "export.verify" -> raw Administration_wire.Verification.codec
  | "workspace.restore" | "daemon.restore_all" -> raw Administration_wire.Restore.codec
  | "restore.cancel" ->
    raw (Api_codec.object_ (req "kind" (Api_codec.literal "canceled")))
  | _ -> None
;;

let validate_result ~method_ json =
  match response_codec ~method_ with
  | None -> invalid_arg "unknown administrative response"
  | Some codec ->
    (match Api_codec.decode codec json with
     | Ok _ -> ()
     | Error p -> raise (Api_method.Invalid_response (method_, p)))
;;

let methods =
  List.map Request.entries ~f:(fun e ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name:e.name
         ~summary:("Local registry, complete exports and verified restores: " ^ e.name)
         ~mode:
           (match e.name with
            | "daemon.health"
            | "workspace.list"
            | "workspace.receipt"
            | "registry.receipt"
            | "export.get"
            | "export.list"
            | "export.verify" -> Read
            | _ -> Mutation)
         ~request:e.raw
         ~response:(Option.value_exn (response_codec ~method_:e.name))))
;;
