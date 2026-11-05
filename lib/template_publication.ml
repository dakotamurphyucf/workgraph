open Core

type t =
  { fields : (string * Jsonaf.t) list
  ; template : Id.Resource.t
  ; expected_revision : int
  ; spec : Workflow_template.Spec.t
  ; publication : Jsonaf.t
  }

let attribution = [ "workspace_id"; "actor_id"; "run_id"; "mutation_id" ]

let of_params value =
  Json.decode (fun () ->
    Json.fields
      value
      ~allowed:(attribution @ [ "template_id"; "expected_revision"; "title"; "spec" ]);
    ignore (Id.Workspace.t_of_jsonaf (Json.field value "workspace_id") : Id.Workspace.t);
    ignore (Id.Actor.t_of_jsonaf (Json.field value "actor_id") : Id.Actor.t);
    Option.iter (Json.optional value "run_id") ~f:(fun value ->
      ignore (Id.Run.t_of_jsonaf value : Id.Run.t));
    Option.iter (Json.optional value "mutation_id") ~f:(fun value ->
      ignore (Id.Mutation.t_of_jsonaf value : Id.Mutation.t));
    let template = Id.Resource.t_of_jsonaf (Json.field value "template_id") in
    let expected_revision = Json.integer (Json.field value "expected_revision") in
    let spec =
      Api_codec.decode Workflow_template_wire.spec (Json.field value "spec")
      |> Disk.unwrap
    in
    let publication =
      Json.obj
        [ "resource_id", Id.Resource.jsonaf_of_t template
        ; "expected_revision", Json.int expected_revision
        ; "title", Json.field value "title"
        ; "text", Json.string (Json.canonical (Workflow_template.Spec.to_json spec))
        ; "filename", Json.string "template.json"
        ; "mime_type", Json.string "application/json"
        ]
    in
    let codec =
      Planning_api.request_codec ~method_:"resource.put_text" |> Option.value_exn
    in
    ignore (Api_codec.decode codec publication |> Disk.unwrap : Jsonaf.t);
    let fields =
      match value with
      | `Object fields -> fields
      | _ -> assert false
    in
    { fields; template; expected_revision; spec; publication })
;;

let prepare t ~fetch =
  let captured =
    Protocol.Request.create
      ~id:"template-publication-capture"
      ~method_:"resource.get"
      ~params:
        (Json.obj
           [ ( "workspace_id"
             , List.Assoc.find_exn t.fields "workspace_id" ~equal:String.equal )
           ; "resource_id", Id.Resource.jsonaf_of_t t.template
           ; "max_bytes", Json.int 4096
           ])
    |> Result.bind ~f:fetch
  in
  match captured with
  | Error problem
    when not (Problem.equal_kind problem.kind Not_found && t.expected_revision = 0) ->
    Error problem
  | captured ->
    Json.decode (fun () ->
      let version =
        match captured with
        | Error _ -> 1
        | Ok response ->
          let response = Api_response.of_json response |> Disk.unwrap in
          let resource = Api_response.data response in
          ignore
            (Api_codec.decode Resource_wire.summary resource |> Disk.unwrap : Jsonaf.t);
          if
            not
              (Id.Resource.equal
                 (Id.Resource.t_of_jsonaf (Json.field resource "resource_id"))
                 t.template)
          then Json.fail Invalid_argument "template capture resource identity differs";
          let actual = Json.integer (Json.field resource "revision") in
          if actual <> t.expected_revision
          then
            raise
              (Json.Decode_error
                 (Problem.create Conflict "template publication resource revision differs"
                  |> fun problem ->
                  Problem.with_details
                    problem
                    (Revision { expected = t.expected_revision; actual })));
          let latest =
            Api_codec.decode Resource_wire.version (Json.field resource "current_version")
            |> Disk.unwrap
          in
          if latest.revision = Int.max_value
          then Json.fail Invalid_argument "template content version exhausted";
          latest.revision + 1
      in
      let template =
        Workflow_template.create
          ~resource:t.template
          ~resource_revision:version
          ~spec:t.spec
        |> Disk.unwrap
      in
      let registration =
        Json.obj
          [ "template_id", Id.Resource.jsonaf_of_t t.template
          ; "template_revision", Json.int version
          ; "digest", Json.string template.digest
          ; "spec", Api_codec.encode Workflow_template_wire.spec t.spec |> Disk.unwrap
          ]
      in
      let operation method_ params =
        Json.obj [ "method", Json.string method_; "params", params ]
      in
      let operations =
        `Array
          [ operation "resource.put_text" t.publication
          ; operation "template.register" registration
          ]
      in
      ignore
        (Api_codec.decode Transaction_api.request (Json.obj [ "operations", operations ])
         |> Disk.unwrap
         : Planning_api.Operation.t list);
      Protocol.Request.create
        ~id:"cli"
        ~method_:"transaction.apply"
        ~params:
          (Json.obj
             (("operations", operations)
              :: List.filter t.fields ~f:(fun (key, _) ->
                List.mem attribution key ~equal:String.equal)))
      |> Disk.unwrap)
;;
