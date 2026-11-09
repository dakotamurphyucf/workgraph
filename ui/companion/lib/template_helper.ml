open Core
open Workgraph

module Publication = struct
  type t = Template_publication.t

  let of_params = Template_publication.of_params
  let prepare = Template_publication.prepare
end

module Instance_preview = struct
  type t =
    { request : Protocol.Request.t
    ; workspace : Id.Workspace.t
    ; template : Id.Resource.t
    ; revision : int
    ; digest : string
    ; instance : Workflow_template.Instance_id.t
    ; parameters : (string * string) list
    ; bindings : Workflow_template.Bindings.t
    }

  type prepared =
    { template : Workflow_template.t
    ; instance : Workflow_template.Instance.t
    ; request : Protocol.Request.t
    }

  let attribution = [ "workspace_id"; "actor_id"; "run_id"; "mutation_id" ]

  let of_params value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:
          (attribution
           @ [ "expected_digest"
             ; "template_id"
             ; "template_revision"
             ; "instance_id"
             ; "parameters"
             ; "project_id"
             ; "milestone_id"
             ; "parent_ticket_id"
             ]);
      let workspace = Id.Workspace.t_of_jsonaf (Json.field value "workspace_id") in
      ignore (Id.Actor.t_of_jsonaf (Json.field value "actor_id") : Id.Actor.t);
      Option.iter (Json.optional value "run_id") ~f:(fun value ->
        ignore (Id.Run.t_of_jsonaf value : Id.Run.t));
      Option.iter (Json.optional value "mutation_id") ~f:(fun value ->
        ignore (Id.Mutation.t_of_jsonaf value : Id.Mutation.t));
      let digest = Json.field value "expected_digest" |> Json.text in
      if
        String.length digest <> 64
        || not
             (String.for_all digest ~f:(fun c ->
                Char.is_digit c || Char.between c ~low:'a' ~high:'f'))
      then Json.fail Invalid_argument "expected_digest must be lowercase SHA-256";
      let fields =
        match value with
        | `Object fields -> fields
        | _ -> assert false
      in
      let command_params =
        Json.obj
          (List.filter fields ~f:(fun (name, _) ->
             not
               (String.equal name "expected_digest"
                || List.mem attribution name ~equal:String.equal)))
      in
      let codec =
        Planning_api.request_codec ~method_:"template.instantiate" |> Option.value_exn
      in
      ignore (Api_codec.decode codec command_params |> Disk.unwrap : Jsonaf.t);
      let command =
        Planning_api.decode_resolved
          ~method_:"template.instantiate"
          ~params:command_params
        |> Option.value_exn
        |> Disk.unwrap
      in
      match command with
      | Planning_command.Template_instantiate
          { template; template_revision; id; parameters; bindings } ->
        if template_revision <= 0
        then Json.fail Invalid_argument "template_revision must be positive";
        let request =
          Protocol.Request.create
            ~id:"ui-template-instance-preview"
            ~method_:"template.instantiate"
            ~params:
              (Json.obj
                 (List.filter fields ~f:(fun (name, _) ->
                    not (String.equal name "expected_digest"))))
          |> Disk.unwrap
        in
        { request
        ; workspace
        ; template
        ; revision = template_revision
        ; digest
        ; instance = id
        ; parameters
        ; bindings
        }
      | _ -> assert false)
  ;;

  let prepare (t : t) ~fetch =
    let captured =
      Protocol.Request.create
        ~id:"ui-template-instance-capture"
        ~method_:"template.get"
        ~params:
          (Json.obj
             [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
             ; "template_id", Id.Resource.jsonaf_of_t t.template
             ; "template_revision", Json.int t.revision
             ; "max_bytes", Json.int 1_048_576
             ])
      |> Result.bind ~f:fetch
    in
    Result.bind captured ~f:(fun response ->
      Json.decode (fun () ->
        let response = Api_response.of_json response |> Disk.unwrap in
        let template =
          Api_codec.decode Workflow_template_wire.template (Api_response.data response)
          |> Disk.unwrap
        in
        if
          (not (Id.Resource.equal template.resource t.template))
          || template.resource_revision <> t.revision
          || not (String.equal template.digest t.digest)
        then Json.fail Conflict "template preview identity/version/digest differs";
        let instance =
          Workflow_template.instantiate
            template
            ~id:t.instance
            ~bindings:t.bindings
            ~parameters:t.parameters
          |> Disk.unwrap
        in
        { template; instance; request = t.request }))
  ;;

  let to_json t =
    Json.obj
      [ ( "template"
        , Api_codec.encode Workflow_template_wire.template t.template |> Disk.unwrap )
      ; ( "instance"
        , Api_codec.encode Workflow_template_wire.instance t.instance |> Disk.unwrap )
      ; "request", Protocol.Request.to_json t.request
      ]
  ;;
end
