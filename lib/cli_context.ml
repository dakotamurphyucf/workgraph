open Core

type t =
  { socket : string
  ; workspace_id : string
  ; actor_id : string
  ; run_id : string option
  ; request_directory : string option
  }

let socket t = t.socket
let request_directory t = t.request_directory

let of_json value =
  Json.decode (fun () ->
    Json.fields
      value
      ~allowed:[ "socket"; "workspace_id"; "actor_id"; "run_id"; "request_directory" ];
    let socket = Json.field value "socket" |> Json.text in
    Platform.validate_socket_path socket |> Disk.unwrap;
    let workspace_id =
      Json.field value "workspace_id"
      |> Id.Workspace.t_of_jsonaf
      |> Id.Workspace.to_string
    in
    let actor_id =
      Json.field value "actor_id" |> Id.Actor.t_of_jsonaf |> Id.Actor.to_string
    in
    let run_id =
      Option.map (Json.optional value "run_id") ~f:(fun v ->
        Id.Run.t_of_jsonaf v |> Id.Run.to_string)
    in
    let request_directory =
      Option.map (Json.optional value "request_directory") ~f:(fun v ->
        let path = Json.text v in
        Disk.absolute path;
        path)
    in
    { socket; workspace_id; actor_id; run_id; request_directory })
;;

let to_json t =
  Json.obj
    ([ "socket", Json.string t.socket
     ; "workspace_id", Json.string t.workspace_id
     ; "actor_id", Json.string t.actor_id
     ]
     @ Option.to_list (Option.map t.run_id ~f:(fun v -> "run_id", Json.string v))
     @ Option.to_list
         (Option.map t.request_directory ~f:(fun v -> "request_directory", Json.string v))
    )
;;

let apply t ~method_ ~fields =
  let allowed =
    match Api_catalog.find method_ with
    | Some (Api_method.Packed.Pack descriptor) ->
      let fields =
        Api_codec.field_names (Api_method.request_codec descriptor) |> Option.value_exn
      in
      (match Api_method.mode descriptor with
       | Read -> List.filter fields ~f:(String.equal "workspace_id")
       | Write | Mutation -> fields)
    | None ->
      (match method_ with
       | "resource.upload" -> [ "workspace_id"; "actor_id"; "run_id" ]
       | "resource.download" -> [ "workspace_id" ]
       | _ -> [])
  in
  let defaults =
    [ "workspace_id", Json.string t.workspace_id; "actor_id", Json.string t.actor_id ]
    @ Option.to_list (Option.map t.run_id ~f:(fun v -> "run_id", Json.string v))
  in
  fields
  @ List.filter defaults ~f:(fun (key, _) ->
    List.mem allowed key ~equal:String.equal
    && not (List.Assoc.mem fields key ~equal:String.equal))
;;

let load ~fs path =
  Local_file.protect ~operation:"load context" ~path (fun () ->
    Disk.absolute path;
    Local_file.read Eio.Path.(fs / path) ~operation:"load context"
    |> Json.parse
    |> Disk.unwrap
    |> of_json
    |> Disk.unwrap)
;;

let apply_self context ~method_ ~fields =
  Json.decode (fun () ->
    let selector =
      match method_ with
      | "inbox.read"
      | "inbox.wait"
      | "inbox.ack"
      | "request.list"
      | "request.acknowledge"
      | "request.accept" -> "recipient"
      | "run.get" | "run.transition" | "run.observe" | "run.link_session" ->
        "target_run_id"
      | _ ->
        Json.fail
          Invalid_argument
          ("--self is unsupported for " ^ method_ ^ "; supply explicit selectors")
    in
    if List.Assoc.mem fields selector ~equal:String.equal
    then fields
    else (
      let context =
        match context with
        | Some context -> context
        | None ->
          Json.fail
            Invalid_argument
            ("--self for "
             ^ method_
             ^ " requires --context; supply an explicit "
             ^ selector
             ^ " instead")
      in
      let value =
        match selector with
        | "recipient" ->
          Json.obj [ "kind", Json.string "actor"; "id", Json.string context.actor_id ]
        | "target_run_id" ->
          (match context.run_id with
           | Some run -> Json.string run
           | None ->
             Json.fail
               Invalid_argument
               ("--self for "
                ^ method_
                ^ " requires run_id in --context; supply --target-run-id instead"))
        | _ -> assert false
      in
      fields @ [ selector, value ]))
;;

let save t ~fs ~random path =
  Local_file.protect ~operation:"save context" ~path (fun () ->
    Disk.absolute path;
    let bytes = Cstruct.create 32 in
    Eio.Flow.read_exact random bytes;
    let directory = Eio.Path.(fs / Filename.dirname path) in
    let temporary =
      Eio.Path.(directory / (".context-" ^ Json.hash (Cstruct.to_string bytes) ^ ".tmp"))
    in
    Disk.write_new temporary (Json.canonical (to_json t));
    Exn.protect
      ~f:(fun () ->
        Local_file.link_exclusive
          ~src:temporary
          ~dst:Eio.Path.(fs / path)
          ~operation:"save context";
        Platform.sync_directory directory)
      ~finally:(fun () ->
        Eio.Cancel.protect (fun () ->
          Eio.Path.unlink temporary;
          Platform.sync_directory directory)))
;;
