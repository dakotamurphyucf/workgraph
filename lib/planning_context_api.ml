open Core
module Fields = Api_codec.Fields
module Options = Planning_query_options

let ( ++ ) = Fields.both
let id of_string to_string = Coordination_wire.id of_string to_string
let ticket = id Id.Ticket.of_string Id.Ticket.to_string
let project = id Id.Project.of_string Id.Project.to_string
let milestone = id Id.Milestone.of_string Id.Milestone.to_string
let actor = id Id.Actor.of_string Id.Actor.to_string
let label = id Id.Label.of_string Id.Label.to_string

let category =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

module Query = struct
  module Filter = struct
    type t =
      { text : string option
      ; project_id : Id.Project.t option
      ; milestone_id : Id.Milestone.t option
      ; status : Workflow.Category.t option
      ; assignee_id : Id.Actor.t option
      ; label_id : Id.Label.t option
      ; priority : int option
      }

    let fields =
      Fields.map
        (Fields.optional "text" (Api_codec.text ~max_bytes:256)
         ++ Fields.optional "project_id" project
         ++ Fields.optional "milestone_id" milestone
         ++ Fields.optional "status" category
         ++ Fields.optional "assignee_id" actor
         ++ Fields.optional "label_id" label
         ++ Fields.optional "priority" (Api_codec.decimal ~max:4))
        ~decode:
          (fun
            ( (((((text, project_id), milestone_id), status), assignee_id), label_id)
            , priority ) ->
          { text; project_id; milestone_id; status; assignee_id; label_id; priority })
        ~encode:
          (fun
            { text; project_id; milestone_id; status; assignee_id; label_id; priority } ->
          ( (((((text, project_id), milestone_id), status), assignee_id), label_id)
          , priority ))
    ;;
  end

  module Search_kind = struct
    type t =
      | Workspace
      | Project
      | Milestone
      | Ticket
      | Comment
      | Handoff
      | Resource
      | Resource_text
      | Fact
    [@@deriving equal]

    let names =
      [ "workspace", Workspace
      ; "project", Project
      ; "milestone", Milestone
      ; "ticket", Ticket
      ; "comment", Comment
      ; "handoff", Handoff
      ; "resource", Resource
      ; "resource_text", Resource_text
      ; "fact", Fact
      ]
    ;;

    let name t =
      List.find_map_exn names ~f:(fun (name, value) ->
        if equal t value then Some name else None)
    ;;

    let codec = Api_codec.enum names ~equal

    let list =
      Api_codec.map
        (Api_codec.list codec ~max_items:9)
        ~decode:(fun values ->
          if
            (not (List.is_empty values))
            && List.length values
               = List.length
                   (List.dedup_and_sort values ~compare:(fun a b ->
                      String.compare (name a) (name b)))
          then Ok values
          else
            Error
              (Problem.create
                 Invalid_argument
                 "search kinds require nonempty distinct names"))
        ~encode:Fn.id
        ~description:"Nonempty distinct source kinds."
    ;;
  end

  type t =
    | Activity_since of
        { after : int
        ; target : Entity_ref.t option
        ; actor_id : Id.Actor.t option
        }
    | Search of
        { text : string
        ; project_id : Id.Project.t option
        ; target : Entity_ref.t option
        ; kinds : Search_kind.t list option
        }
    | Workspace_overview of
        { actor_id : Id.Actor.t option
        ; run_id : Id.Run.t option
        }
    | Project_brief of Id.Project.t
    | Ticket_context of Id.Ticket.t
    | Ticket_list of Filter.t
    | Ticket_ready of Filter.t
    | Ticket_readiness of Id.Ticket.t
    | Ticket_blockers of Id.Ticket.t
    | Ticket_resolve of string
    | Handoff_get of Id.Ticket.t
    | Handoff_history of Id.Ticket.t

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

  let make ?(options = Options.scalar_fields) fields create select =
    Api_codec.object_
      (Fields.map
         (Fields.both fields options)
         ~decode:(fun (value, options) -> { query = create value; options })
         ~encode:(fun { query; options } -> select query, options))
  ;;

  let wrong () = Json.fail Invalid_argument "wrong rich planning query constructor"
  let ticket_field = Fields.required "ticket_id" ticket

  let entries =
    [ ( "activity.since"
      , make
          ~options:Options.page_fields
          (Fields.optional "after" Coordination_wire.counter
           ++ Fields.optional "target" Evidence_wire.entity_ref
           ++ Fields.optional "project_id" project
           ++ Fields.optional "actor_id" actor)
          (fun (((after, target), project_id), actor_id) ->
             let target =
               match target, project_id with
               | None, None -> None
               | Some target, None -> Some target
               | None, Some id -> Some (Entity_ref.Project id)
               | Some _, Some _ ->
                 Json.fail Invalid_argument "provide target or project_id, not both"
             in
             Activity_since { after = Option.value after ~default:0; target; actor_id })
          (function
            | Activity_since { after; target; actor_id } ->
              ((Some after, target), None), actor_id
            | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_activity_wire.Activity.codec)
      )
    ; ( "search.query"
      , make
          ~options:Options.fields
          (Fields.required "text" (Coordination_wire.nonblank ~max_bytes:256)
           ++ Fields.optional "project_id" project
           ++ Fields.optional "target" Evidence_wire.entity_ref
           ++ Fields.optional "kinds" Search_kind.list)
          (fun (((text, project_id), target), kinds) ->
             Search { text; project_id; target; kinds })
          (function
            | Search { text; project_id; target; kinds } ->
              ((text, project_id), target), kinds
            | _ -> wrong ())
      , Api_codec.as_json Planning_context_wire.Search.codec )
    ; ( "workspace.overview"
      , make
          ~options:Options.fields
          (Fields.both
             (Fields.optional "actor_id" actor)
             (Fields.optional "run_id" (id Id.Run.of_string Id.Run.to_string)))
          (fun (actor_id, run_id) -> Workspace_overview { actor_id; run_id })
          (function
            | Workspace_overview { actor_id; run_id } -> actor_id, run_id
            | _ -> wrong ())
      , Api_codec.as_json Planning_context_wire.Workspace_overview.codec )
    ; ( "project.brief"
      , make
          ~options:Options.fields
          (Fields.required "project_id" project)
          (fun value -> Project_brief value)
          (function
            | Project_brief value -> value
            | _ -> wrong ())
      , Api_codec.as_json Planning_context_wire.Project_brief.codec )
    ; ( "ticket.context"
      , make
          ~options:Options.fields
          ticket_field
          (fun value -> Ticket_context value)
          (function
            | Ticket_context value -> value
            | _ -> wrong ())
      , Api_codec.as_json Planning_context_wire.Ticket_context.codec )
    ; ( "ticket.list"
      , make
          ~options:Options.fields
          Filter.fields
          (fun value -> Ticket_list value)
          (function
            | Ticket_list value -> value
            | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_ticket_wire.Ticket.codec) )
    ; ( "ticket.ready"
      , make
          ~options:Options.fields
          Filter.fields
          (fun value -> Ticket_ready value)
          (function
            | Ticket_ready value -> value
            | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_ticket_wire.Ticket.codec) )
    ; ( "ticket.readiness"
      , make
          ticket_field
          (fun value -> Ticket_readiness value)
          (function
            | Ticket_readiness value -> value
            | _ -> wrong ())
      , Api_codec.as_json Planning_ticket_wire.Readiness.codec )
    ; ( "ticket.blockers"
      , make
          ~options:Options.page_fields
          ticket_field
          (fun value -> Ticket_blockers value)
          (function
            | Ticket_blockers value -> value
            | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec) )
    ; ( "ticket.resolve"
      , make
          (Fields.required "display_key" (Coordination_wire.nonblank ~max_bytes:96))
          (fun value -> Ticket_resolve value)
          (function
            | Ticket_resolve value -> value
            | _ -> wrong ())
      , Api_codec.as_json Planning_context_wire.Resolve.codec )
    ; ( "handoff.get"
      , make
          ticket_field
          (fun value -> Handoff_get value)
          (function
            | Handoff_get value -> value
            | _ -> wrong ())
      , Api_codec.as_json Planning_ticket_wire.Handoff.codec )
    ; ( "handoff.history"
      , make
          ~options:Options.page_fields
          ticket_field
          (fun value -> Handoff_history value)
          (function
            | Handoff_history value -> value
            | _ -> wrong ())
      , Api_codec.as_json (Planning_wire.Page.codec Planning_ticket_wire.Handoff.codec) )
    ]
  ;;

  let decode ~method_ ~params =
    match List.find entries ~f:(fun (name, _, _) -> String.equal name method_) with
    | None -> Error (Problem.create Invalid_argument "unknown rich planning query")
    | Some (_, codec, _) -> Api_codec.decode codec params
  ;;
end

let request_codec ~method_ =
  List.find_map Query.entries ~f:(fun (name, request, _) ->
    if String.equal name method_ then Some (Api_codec.as_json request) else None)
;;

let response_codec ~method_ =
  List.find_map Query.entries ~f:(fun (name, _, response) ->
    if String.equal name method_ then Some response else None)
;;

let methods =
  List.map Query.entries ~f:(fun (name, request, response) ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Typed captured planning query: " ^ name)
         ~mode:Read
         ~request:(Api_codec.as_json request)
         ~response))
;;

let validate_result ~method_ json =
  match response_codec ~method_ with
  | None -> ()
  | Some codec ->
    (match Api_codec.decode codec json with
     | Ok _ -> ()
     | Error problem -> raise (Api_method.Invalid_response (method_, problem)))
;;
