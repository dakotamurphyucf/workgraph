open Core

module Kind = struct
  type t =
    | Project
    | Milestone
    | Ticket
    | Comment
    | Resource
end

let resolve ~method_ ~params ~fresh =
  Json.decode (fun () ->
    let one method_ params =
      let generated =
        match method_ with
        | "project.create" -> Some ("project_id", Kind.Project)
        | "milestone.create" -> Some ("milestone_id", Kind.Milestone)
        | "ticket.create" -> Some ("ticket_id", Kind.Ticket)
        | "comment.add" -> Some ("comment_id", Kind.Comment)
        | "resource.put_text" | "resource.finish_upload" ->
          (match Json.optional params "expected_revision" with
           | Some (`String "0") -> Some ("resource_id", Kind.Resource)
           | _ -> None)
        | _ -> None
      in
      match generated, params with
      | Some (field, kind), `Object fields
        when Option.is_none (Json.optional params field) ->
        let id = fresh kind in
        (match Id.Actor.of_string id with
         | Ok _ -> ()
         | Error error -> raise (Json.Decode_error error));
        Json.obj ((field, Json.string id) :: fields)
      | _ -> params
    in
    if String.equal method_ "transaction.apply"
    then (
      let operations = Json.list (Json.field params "operations") in
      if List.is_empty operations || List.length operations > 32
      then Json.fail Invalid_argument "transaction requires1..32 operations";
      let operations =
        List.map operations ~f:(fun operation ->
          let method_ = Json.text (Json.field operation "method") in
          let resolved = one method_ (Json.field operation "params") in
          match operation with
          | `Object fields ->
            Json.obj
              (List.map fields ~f:(fun (key, value) ->
                 key, if String.equal key "params" then resolved else value))
          | _ -> Json.fail Invalid_argument "operation must be an object")
      in
      match params with
      | `Object fields ->
        Json.obj
          (List.map fields ~f:(fun (key, value) ->
             key, if String.equal key "operations" then `Array operations else value))
      | _ -> Json.fail Invalid_argument "params must be an object")
    else one method_ params)
;;
