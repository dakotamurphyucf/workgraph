open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved query identity."
;;

module Options = Planning_query_options

module Query = struct
  type t =
    | Workspace_get
    | Project_get of Id.Project.t
    | Project_list
    | Milestone_get of Id.Milestone.t
    | Milestone_list of Id.Project.t option
    | Actor_list
    | Label_list
    | Status_list

  type request =
    { query : t
    ; options : Options.t
    }

  let query t = t.query
  let offset t = Options.offset t.options
  let limit t = Options.limit t.options
  let at_revision t = Options.at_revision t.options
  let include_archived t = Options.include_archived t.options
  let max_bytes t = Options.max_bytes t.options

  let codec ?(options = Options.scalar_fields) fields make select =
    Api_codec.object_
      (Fields.map
         (Fields.both fields options)
         ~decode:(fun (value, options) -> { query = make value; options })
         ~encode:(fun { query; options } -> select query, options))
  ;;

  let none ?(options = Options.fields) make select =
    codec
      ~options
      Fields.empty
      (fun () -> make)
      (fun query ->
         select query;
         ())
  ;;

  let project_id = id Id.Project.of_string Id.Project.to_string
  let milestone_id = id Id.Milestone.of_string Id.Milestone.to_string
  let wrong () = Json.fail Invalid_argument "wrong planning query constructor"

  let entries =
    [ ( "workspace.get"
      , none ~options:Options.scalar_fields Workspace_get (function
          | Workspace_get -> ()
          | _ -> wrong ())
      , Api_codec.as_json Planning_wire.Workspace.codec )
    ; ( "project.get"
      , codec
          (Fields.required "project_id" project_id)
          (fun id -> Project_get id)
          (function
            | Project_get id -> id
            | _ -> wrong ())
      , Api_codec.as_json Planning_wire.Project.codec )
    ; ( "project.list"
      , none Project_list (function
          | Project_list -> ()
          | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_wire.Project.codec) )
    ; ( "milestone.get"
      , codec
          (Fields.required "milestone_id" milestone_id)
          (fun id -> Milestone_get id)
          (function
            | Milestone_get id -> id
            | _ -> wrong ())
      , Api_codec.as_json Planning_wire.Milestone_read.codec )
    ; ( "milestone.list"
      , codec
          ~options:Options.fields
          (Fields.optional "project_id" project_id)
          (fun id -> Milestone_list id)
          (function
            | Milestone_list id -> id
            | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_wire.Milestone.codec) )
    ; ( "actor.list"
      , none Actor_list (function
          | Actor_list -> ()
          | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_wire.Actor.codec) )
    ; ( "label.list"
      , none Label_list (function
          | Label_list -> ()
          | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_wire.Label.codec) )
    ; ( "status.list"
      , none Status_list (function
          | Status_list -> ()
          | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_wire.Status.codec) )
    ]
  ;;

  let find method_ = List.find entries ~f:(fun (name, _, _) -> String.equal name method_)

  let decode ~method_ ~params =
    match find method_ with
    | None -> Error (Problem.create Invalid_argument "unknown base planning query")
    | Some (_, codec, _) -> Api_codec.decode codec params
  ;;
end

let request_codec ~method_ =
  Option.map (Query.find method_) ~f:(fun (_, codec, _) -> Api_codec.as_json codec)
;;

let response_codec ~method_ =
  Option.map (Query.find method_) ~f:(fun (_, _, codec) -> codec)
;;

let methods =
  List.map Query.entries ~f:(fun (name, request, response) ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Read canonical base planning metadata: " ^ name)
         ~mode:Read
         ~request
         ~response))
;;

let validate_result ~method_ data =
  match response_codec ~method_ with
  | None -> invalid_arg "unknown base planning result"
  | Some codec ->
    (match Api_codec.decode codec data with
     | Ok _ -> ()
     | Error problem -> raise (Api_method.Invalid_response (method_, problem)))
;;
