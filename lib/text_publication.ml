open Core

type t = { parameters : Jsonaf.t }

let params t = t.parameters

let of_params value =
  Json.decode (fun () ->
    let attribution = [ "workspace_id"; "actor_id"; "run_id"; "mutation_id" ] in
    let publication_codec =
      Planning_api.request_codec ~method_:"resource.put_text" |> Option.value_exn
    in
    let publication_fields =
      Api_codec.field_names publication_codec |> Option.value_exn
    in
    Json.fields value ~allowed:(("ticket_id" :: attribution) @ publication_fields);
    ignore (Id.Workspace.t_of_jsonaf (Json.field value "workspace_id") : Id.Workspace.t);
    ignore (Id.Actor.t_of_jsonaf (Json.field value "actor_id") : Id.Actor.t);
    Option.iter (Json.optional value "run_id") ~f:(fun value ->
      ignore (Id.Run.t_of_jsonaf value : Id.Run.t));
    Option.iter (Json.optional value "mutation_id") ~f:(fun value ->
      ignore (Id.Mutation.t_of_jsonaf value : Id.Mutation.t));
    let ticket = Id.Ticket.t_of_jsonaf (Json.field value "ticket_id") in
    let fields =
      match value with
      | `Object fields -> fields
      | _ -> assert false
    in
    let publication =
      Json.obj
        (List.filter fields ~f:(fun (key, _) ->
           List.mem publication_fields key ~equal:String.equal))
    in
    ignore (Api_codec.decode publication_codec publication |> Disk.unwrap : Jsonaf.t);
    let resource =
      Option.map (Json.optional publication "resource_id") ~f:(fun value ->
        Id.Resource.t_of_jsonaf value |> Id.Resource.jsonaf_of_t)
    in
    let revision = Json.integer (Json.field publication "expected_revision") in
    if revision > Int.max_value - 2
    then
      Json.fail
        Invalid_argument
        "expected_revision requires two representable metadata advances";
    let operation =
      Json.obj
        ([ "method", Json.string "resource.put_text"; "params", publication ]
         @ if Option.is_none resource then [ "as", Json.string "published" ] else [])
    in
    let link =
      Json.obj
        [ "method", Json.string "resource.link"
        ; ( "params"
          , Json.obj
              [ "resource_id", Option.value resource ~default:(Json.string "$published")
              ; "expected_revision", Json.int (revision + 1)
              ; ( "target"
                , Json.obj
                    [ "kind", Json.string "ticket"; "id", Id.Ticket.jsonaf_of_t ticket ] )
              ] )
        ]
    in
    let operations = Json.obj [ "operations", `Array [ operation; link ] ] in
    ignore
      (Api_codec.decode Transaction_api.request operations |> Disk.unwrap
       : Planning_api.Operation.t list);
    let parameters =
      Json.obj
        (("operations", Json.field operations "operations")
         :: List.filter fields ~f:(fun (key, _) ->
           List.mem attribution key ~equal:String.equal))
    in
    { parameters })
;;
