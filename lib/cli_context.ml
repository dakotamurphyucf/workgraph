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
    Disk.absolute socket;
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
  Disk.protect (fun () ->
    Disk.absolute path;
    Disk.read Eio.Path.(fs / path) |> Json.parse |> Disk.unwrap |> of_json |> Disk.unwrap)
;;

let save t ~fs ~random path =
  Disk.protect (fun () ->
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
        Platform.link_exclusive ~src:temporary ~dst:Eio.Path.(fs / path);
        Platform.sync_directory directory)
      ~finally:(fun () ->
        Eio.Cancel.protect (fun () ->
          Eio.Path.unlink temporary;
          Platform.sync_directory directory)))
;;
