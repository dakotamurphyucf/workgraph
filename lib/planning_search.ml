open Core
open Planning_state

let search_scope t params =
  let include_archived =
    match Json.optional params "include_archived" with
    | None | Some `False -> false
    | Some `True -> true
    | Some _ -> Json.fail Invalid_argument "include_archived must be boolean"
  in
  let project =
    Option.map (Json.optional params "project_id") ~f:Id.Project.t_of_jsonaf
  in
  Option.iter project ~f:(fun id -> ignore (find_project t id : Project.t));
  let target =
    Option.map (Json.optional params "target") ~f:(fun json ->
      Api_codec.decode Evidence_wire.entity_ref json |> unwrap_domain)
  in
  Option.iter target ~f:(validate_target t);
  let rec visible = function
    | Entity_ref.Workspace -> true
    | Project id -> include_archived || not (find_project t id).archived
    | Milestone id ->
      let m = find_milestone t id in
      include_archived || ((not m.archived) && visible (Project m.project))
    | Ticket id -> include_archived || active_scope t (find_ticket t id)
    | Resource id ->
      let r = Map.find_exn t.resources id in
      include_archived || not r.metadata.archived
  in
  let belongs target =
    match target with
    | Entity_ref.Workspace -> None
    | Project id -> Some id
    | Milestone id -> Some (find_milestone t id).project
    | Ticket id -> (find_ticket t id).project
    | Resource _ -> None
  in
  fun entity ->
    visible entity
    && Option.for_all target ~f:(fun target ->
      Entity_ref.equal entity target
      ||
      match entity with
      | Resource id ->
        List.mem
          (Map.find_exn t.resources id).metadata.targets
          target
          ~equal:Entity_ref.equal
      | Workspace | Project _ | Milestone _ | Ticket _ -> false)
    && Option.for_all project ~f:(fun project ->
      match entity with
      | Resource id ->
        (Map.find_exn t.resources id).metadata.targets
        |> List.exists ~f:(fun target ->
          Option.equal Id.Project.equal (belongs target) (Some project))
      | Workspace | Project _ | Milestone _ | Ticket _ ->
        Option.equal Id.Project.equal (belongs entity) (Some project))
;;

let search_kinds params =
  Option.map (Json.optional params "kinds") ~f:(fun value ->
    let kinds = Json.list value |> List.map ~f:Json.text in
    require
      ((not (List.is_empty kinds))
       && List.length kinds <= List.length Search.kinds
       && List.length kinds
          = List.length (List.dedup_and_sort kinds ~compare:String.compare)
       && List.for_all kinds ~f:(fun kind ->
         List.mem Search.kinds kind ~equal:String.equal))
      Invalid_argument
      "invalid search kinds";
    kinds)
;;

let searchable_text mime =
  let mime = String.lowercase mime in
  String.is_prefix mime ~prefix:"text/"
  || List.mem
       [ "application/json"; "application/xml"; "application/javascript" ]
       mime
       ~equal:String.equal
;;

let search_resources t ~params =
  Json.decode (fun () ->
    Json.fields
      params
      ~allowed:
        [ "workspace_id"
        ; "limit"
        ; "offset"
        ; "at_revision"
        ; "include_archived"
        ; "max_bytes"
        ; "text"
        ; "project_id"
        ; "target"
        ; "kinds"
        ];
    ignore (Query_budget.of_params params : int);
    let text = Json.bounded_text (Json.field params "text") ~max_bytes:256 in
    require
      (not (String.is_empty (String.strip text)))
      Invalid_argument
      "search text cannot be empty";
    let limit =
      Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
    in
    require (limit > 0 && limit <= 100) Invalid_argument "limit must be 1..100";
    let offset =
      Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
    in
    Option.iter (Json.optional params "at_revision") ~f:(fun value ->
      expected t.revision (Json.integer value));
    require
      (offset = 0 || Option.is_some (Json.optional params "at_revision"))
      Invalid_argument
      "pagination requires at_revision";
    let scope = search_scope t params in
    let kinds = search_kinds params in
    if
      not
        (Option.for_all kinds ~f:(fun kinds ->
           List.mem kinds "resource_text" ~equal:String.equal))
    then []
    else
      Map.data t.resources
      |> List.filter ~f:(fun r ->
        scope (Entity_ref.Resource r.Resource.id)
        && searchable_text (Resource.get_version r ~revision:None).mime_type))
;;

let search_documents t ~params ~resource_texts =
  let scope = search_scope t params in
  let doc source target revision fields =
    { Search.Document.source; target; revision; fields }
  in
  let documents =
    [ doc
        (Workspace t.workspace)
        Workspace
        t.settings.revision
        [ "name", name t
        ; "description", t.settings.description
        ; "instructions", t.settings.instructions
        ; "summary", t.settings.summary
        ]
    ]
    @ (Map.data t.projects
       |> List.map ~f:(fun p ->
         doc
           (Project p.Project.id)
           (Project p.id)
           p.revision
           [ "title", p.title
           ; "description", p.description
           ; "summary", p.summary
           ; "acceptance_criteria", p.acceptance_criteria
           ]))
    @ (Map.data t.milestones
       |> List.map ~f:(fun m ->
         doc
           (Milestone m.Milestone.id)
           (Milestone m.id)
           m.revision
           [ "title", m.title; "description", m.description ]))
    @ (Map.data t.tickets
       |> List.map ~f:(fun ticket ->
         doc
           (Ticket ticket.Ticket.id)
           (Ticket ticket.id)
           ticket.revision
           [ "title", ticket.title
           ; "description", ticket.description
           ; "acceptance_criteria", ticket.acceptance_criteria
           ]))
    @ Discussion.search_documents t.discussion
    @ (Map.data t.handoffs
       |> List.map ~f:(fun h ->
         doc
           (Handoff h.Handoff.ticket)
           (Ticket h.ticket)
           h.revision
           [ "summary", h.summary
           ; "objective", h.objective
           ; "completed", h.completed
           ; "decisions", h.decisions
           ; "blockers", h.blockers
           ; "next_steps", h.next_steps
           ; "evidence", h.evidence
           ]))
    @ Facts.search_documents t.facts
    @ (Map.data t.resources
       |> List.map ~f:(fun r ->
         doc
           (Resource r.Resource.id)
           (Resource r.id)
           r.revision
           [ "title", r.metadata.title
           ; "filename", r.metadata.filename
           ; "description", r.metadata.description
           ]))
    @ List.filter_map resource_texts ~f:(fun extracted ->
      let resource =
        match Map.find t.resources extracted.Search.Text.id with
        | Some resource -> resource
        | None -> Json.fail Not_found "unknown extracted resource"
      in
      let current = Resource.get_version resource ~revision:None in
      require
        (scope (Entity_ref.Resource resource.id) && searchable_text current.mime_type)
        Invalid_argument
        "resource extraction is outside search scope";
      require
        (Int.equal current.revision extracted.version
         && String.equal current.digest extracted.digest)
        Conflict
        "stale resource text extraction";
      match extracted.outcome with
      | Invalid_utf8 -> None
      | Content { text; total_bytes } ->
        require
          (String.length text <= 65_536 && total_bytes >= String.length text)
          Invalid_argument
          "invalid extracted text bounds";
        Some
          (doc
             (Resource_text resource.id)
             (Resource resource.id)
             current.revision
             [ "text", text ]))
  in
  List.filter documents ~f:(fun document -> scope document.Search.Document.target)
;;
