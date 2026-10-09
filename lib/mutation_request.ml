open Core

type t =
  { workspace : Id.Workspace.t
  ; actor : Id.Actor.t
  ; mutation : Id.Mutation.t
  ; run : Id.Run.t option
  }

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"1..96 ASCII letters, digits, underscores or hyphens"
;;

let fields =
  let open Api_codec.Fields in
  both
    (both
       (required "workspace_id" (id Id.Workspace.of_string Id.Workspace.to_string))
       (required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)))
    (both
       (required "mutation_id" (id Id.Mutation.of_string Id.Mutation.to_string))
       (optional "run_id" (id Id.Run.of_string Id.Run.to_string)))
  |> map
       ~decode:(fun ((workspace, actor), (mutation, run)) ->
         { workspace; actor; mutation; run })
       ~encode:(fun { workspace; actor; mutation; run } ->
         (workspace, actor), (mutation, run))
;;

let codec = Api_codec.object_ fields
let names = Api_codec.Fields.names fields
let key t = Id.Actor.to_string t.actor ^ ":" ^ Id.Mutation.to_string t.mutation

let of_params params =
  Json.decode (fun () ->
    match params with
    | `Object fields ->
      Json.fields params ~allowed:(List.map fields ~f:fst);
      let identity, parameters =
        List.partition_tf fields ~f:(fun (name, _) ->
          List.mem names name ~equal:String.equal)
      in
      let identity =
        match Api_codec.decode codec (Json.obj identity) with
        | Ok value -> value
        | Error problem -> raise (Json.Decode_error problem)
      in
      identity, Json.obj parameters
    | _ -> Json.fail Invalid_argument "params must be an object")
;;

let params t ~parameters =
  Json.decode (fun () ->
    let identity =
      match Api_codec.encode codec t with
      | Ok (`Object fields) -> fields
      | Ok _ -> assert false
      | Error problem -> raise (Json.Decode_error problem)
    in
    match parameters with
    | `Object fields ->
      List.iter fields ~f:(fun (name, _) ->
        if List.mem names name ~equal:String.equal
        then Json.fail Invalid_argument ("reserved mutation parameter: " ^ name));
      let result = Json.obj (identity @ fields) in
      Json.fields result ~allowed:(List.map (identity @ fields) ~f:fst);
      result
    | _ -> Json.fail Invalid_argument "params must be an object")
;;
