open Core
open Planning_state
open Planning_search

let query_other_with_texts ?now_unix_ms t ~resource_texts ~method_ ~params =
  Json.decode (fun () ->
    let common =
      [ "workspace_id"
      ; "limit"
      ; "offset"
      ; "at_revision"
      ; "include_archived"
      ; "max_bytes"
      ]
    in
    let extra =
      match method_ with
      | "comment.list" -> [ "target"; "include_tombstones" ]
      | "comment.get" | "comment.history" -> [ "comment_id" ]
      | "resource.get" | "resource.history" -> [ "resource_id" ]
      | "resource.list" -> [ "target" ]
      | _ -> []
    in
    Json.fields params ~allowed:(common @ extra);
    let comment_query = Option.is_some (Discussion_api.request_codec ~method_) in
    if comment_query
    then (
      let unscoped =
        match params with
        | `Object fields ->
          Json.obj
            (List.filter fields ~f:(fun (name, _) ->
               not (String.equal name "workspace_id")))
        | _ -> Json.fail Invalid_argument "query params require object"
      in
      Discussion_api.validate_request ~method_ unscoped |> unwrap_domain);
    let resource_request =
      if
        List.mem
          [ "resource.get"; "resource.list"; "resource.history" ]
          method_
          ~equal:String.equal
      then (
        let unscoped =
          match params with
          | `Object fields ->
            Json.obj
              (List.filter fields ~f:(fun (name, _) ->
                 not (String.equal name "workspace_id")))
          | _ -> Json.fail Invalid_argument "query params require object"
        in
        Some (Resource_api.Query.decode ~method_ ~params:unscoped |> unwrap_domain))
      else None
    in
    let max_bytes =
      match resource_request with
      | Some request -> Resource_api.Query.max_bytes request
      | None -> Query_budget.of_params params
    in
    let limit =
      match resource_request with
      | Some request -> Resource_api.Query.limit request
      | None ->
        Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
    in
    require (limit > 0 && limit <= 100) Invalid_argument "limit must be 1..100";
    let offset =
      match resource_request with
      | Some request -> Resource_api.Query.offset request
      | None ->
        Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
    in
    let at_revision =
      match resource_request with
      | Some request -> Resource_api.Query.at_revision request
      | None -> Option.map (Json.optional params "at_revision") ~f:Json.integer
    in
    Option.iter at_revision ~f:(expected t.revision);
    if offset > 0
    then
      require
        (Option.is_some at_revision)
        Invalid_argument
        "pagination requires at_revision";
    let page items =
      let items = List.drop items offset in
      let selected = List.take items limit in
      Json.obj
        [ "items", `Array selected
        ; "offset", Json.int offset
        ; "remaining", Json.int (List.length items - List.length selected)
        ; ( "next_offset"
          , if List.length items > limit then Json.int (offset + limit) else `Null )
        ]
    in
    let include_archived =
      match resource_request with
      | Some request -> Resource_api.Query.include_archived request
      | None ->
        (match Json.optional params "include_archived" with
         | None | Some `False -> false
         | Some `True -> true
         | Some _ -> Json.fail Invalid_argument "include_archived must be boolean")
    in
    let resource_json = Resource_wire.summary_json in
    let body =
      match method_ with
      | "comment.get" | "comment.history" ->
        let id = Id.Comment.t_of_jsonaf (Json.field params "comment_id") in
        if String.equal method_ "comment.get"
        then Discussion.get t.discussion id |> Discussion_wire.comment_json
        else
          page
            (List.map
               (Discussion.history t.discussion id)
               ~f:Discussion_wire.comment_json)
      | "comment.list" ->
        let target =
          Option.map (Json.optional params "target") ~f:(fun value ->
            Api_codec.decode Planning_target.codec value
            |> unwrap_domain
            |> Planning_target.to_ref
            |> unwrap_domain)
        in
        Option.iter target ~f:(validate_target t);
        let include_tombstones =
          match Json.optional params "include_tombstones" with
          | None | Some `False -> false
          | Some `True -> true
          | Some _ -> Json.fail Invalid_argument "include_tombstones must be boolean"
        in
        page
          (List.map
             (Discussion.list t.discussion ~target ~include_tombstones)
             ~f:Discussion_wire.comment_json)
      | "resource.list" ->
        let target =
          match Resource_api.Query.query (Option.value_exn resource_request) with
          | List target -> target
          | Get _ | History _ -> failwith "resource list requires a list query"
        in
        Option.iter target ~f:(validate_target t);
        page
          (Map.data t.resources
           |> List.filter ~f:(fun r ->
             (include_archived || not r.Resource.metadata.archived)
             && Option.for_all target ~f:(fun target ->
               List.mem r.metadata.targets target ~equal:Entity_ref.equal))
           |> List.map ~f:resource_json)
      | "resource.get" | "resource.history" ->
        let id =
          match Resource_api.Query.query (Option.value_exn resource_request) with
          | Get id | History id -> id
          | List _ -> failwith "resource lookup requires an identity query"
        in
        let resource =
          match Map.find t.resources id with
          | Some r -> r
          | None -> Json.fail Not_found "resource not found"
        in
        if String.equal method_ "resource.history"
        then page (List.rev_map resource.versions ~f:Resource_wire.version_json)
        else resource_json resource
      | _ -> Json.fail Invalid_argument ("unknown query method: " ^ method_)
    in
    let result =
      Query_budget.fit
        ~measure:(Api_response.encoded_size Planning_read)
        ~max_bytes
        (Json.obj [ "workspace_revision", Json.int t.revision; "data", body ])
    in
    if comment_query
    then Discussion_api.validate_result ~method_ (Json.field result "data");
    result)
;;

let base_query t ~request =
  let module Q = Planning_read_api.Query in
  Json.decode (fun () ->
    let include_archived = Q.include_archived request in
    Option.iter (Q.at_revision request) ~f:(expected t.revision);
    let page : 'a. 'a list -> 'a Planning_wire.Page.t =
      fun items ->
      let tail = List.drop items (Q.offset request) in
      let items = List.take tail (Q.limit request) in
      let remaining = List.length tail - List.length items in
      { Planning_wire.Page.items
      ; offset = Q.offset request
      ; remaining
      ; next_offset =
          (if remaining = 0 then None else Some (Q.offset request + List.length items))
      }
    in
    let response =
      match Q.query request with
      | Workspace_get ->
        Planning_wire.Response.Workspace
          { name = name t; settings = workspace_settings_view t.settings }
      | Project_get id -> Project (project_view (find_project t id))
      | Project_list ->
        Projects
          (Map.data t.projects
           |> List.filter ~f:(fun (project : Project.t) ->
             include_archived || not project.archived)
           |> List.map ~f:project_view
           |> page)
      | Milestone_list project ->
        Milestones
          (Map.data t.milestones
           |> List.filter ~f:(fun (milestone : Milestone.t) ->
             Option.for_all project ~f:(Id.Project.equal milestone.project)
             && (include_archived || not milestone.archived))
           |> List.map ~f:milestone_view
           |> page)
      | Milestone_get id ->
        let milestone = find_milestone t id in
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun (ticket : Ticket.t) ->
            Option.exists ticket.milestone ~f:(Id.Milestone.equal id)
            && (include_archived || not ticket.archived))
        in
        Milestone
          { milestone = milestone_view milestone
          ; progress =
              { total = List.length tickets
              ; done_ =
                  List.count tickets ~f:(fun (ticket : Ticket.t) ->
                    Domain_command.Status.equal ticket.status Done)
              ; blocked =
                  List.count tickets ~f:(fun (ticket : Ticket.t) ->
                    Option.is_some ticket.hold || not (List.is_empty (blockers t ticket)))
              }
          }
      | Actor_list ->
        Actors
          (Workflow.actors t.workflow ~include_archived
           |> List.map ~f:Planning_wire.Actor.of_domain
           |> page)
      | Label_list ->
        Labels
          (Workflow.labels t.workflow ~include_archived
           |> List.map ~f:Planning_wire.Label.of_domain
           |> page)
      | Status_list ->
        Statuses
          (Workflow.statuses t.workflow ~include_archived
           |> List.map ~f:Planning_wire.Status.of_domain
           |> page)
    in
    Planning_wire.Response.fit
      response
      ~workspace_revision:t.revision
      ~max_bytes:(Q.max_bytes request)
    |> unwrap_domain)
;;

let rich_query ?now_unix_ms t ~resource_texts ~params ~request =
  let module Q = Planning_context_api.Query in
  Json.decode (fun () ->
    Option.iter (Q.at_revision request) ~f:(expected t.revision);
    let include_archived = Q.include_archived request in
    let page : 'a. 'a list -> 'a Planning_wire.Page.t =
      fun records ->
      let tail = List.drop records (Q.offset request) in
      let items = List.take tail (Q.limit request) in
      let remaining = List.length tail - List.length items in
      { Planning_wire.Page.items
      ; offset = Q.offset request
      ; remaining
      ; next_offset =
          (if remaining = 0 then None else Some (Q.offset request + List.length items))
      }
    in
    let summary (ticket : Ticket.t) : Planning_ticket_wire.Summary.t =
      { ticket_id = ticket.id
      ; display_key = ticket.display_key
      ; title = ticket.title
      ; revision = ticket.revision
      ; status = ticket.status
      ; priority = ticket.priority
      ; readiness = readiness_view ?now_unix_ms t ticket
      }
    in
    let blocked (ticket : Ticket.t) =
      Option.is_some ticket.hold || not (List.is_empty (blockers t ticket))
    in
    let resources target =
      Map.data t.resources
      |> List.filter ~f:(fun value ->
        (include_archived || not value.Resource.metadata.archived)
        && List.mem value.metadata.targets target ~equal:Entity_ref.equal)
      |> List.map ~f:Resource_wire.summary_json
      |> page
    in
    let communication target : Planning_context_wire.Communication.t =
      let threads =
        Communication.threads t.communication
        |> List.filter ~f:(fun thread ->
          List.mem thread.Communication.Thread.links target ~equal:Entity_ref.equal
          ||
          match Communication.thread_target t.communication thread.id with
          | Ok scope -> Entity_ref.equal scope target
          | Error _ -> false)
      in
      let ids =
        Communication_id.Thread.Set.of_list
          (List.map threads ~f:(fun thread -> thread.Communication.Thread.id))
      in
      { threads = List.map threads ~f:Communication_wire.thread_json |> page
      ; requests =
          Communication.requests t.communication
          |> List.filter ~f:(fun value -> Set.mem ids value.Communication.Request.thread)
          |> List.map ~f:Communication_wire.request_json
          |> page
      }
    in
    let scoped_activity target =
      match target with
      | None -> t.activity
      | Some target -> Option.value (Map.find t.activity_by_target target) ~default:[]
    in
    let event_summary value : Planning_activity_wire.Summary.t =
      { revision = Json.integer (Json.field value "revision")
      ; actor_id = Id.Actor.t_of_jsonaf (Json.field value "actor")
      ; run_id =
          Option.bind (Json.optional value "run_id") ~f:(function
            | `Null -> None
            | value -> Some (Id.Run.t_of_jsonaf value))
      ; timestamp = Json.text (Json.field value "timestamp")
      ; targets =
          Json.list (Json.field value "targets") |> List.map ~f:Entity_ref.t_of_jsonaf
      ; changes = Json.list (Json.field value "changes") |> List.length
      }
    in
    let response : Planning_context_wire.Response.t =
      match Q.query request with
      | Activity_since { after; target; actor_id } ->
        Option.iter target ~f:(validate_target t);
        let change : Event.t -> Planning_activity_wire.Change.t = function
          | Facts_changed value -> Facts_changed value
          | Communication_changed value -> Communication_changed value
          | Agent_run_changed value -> Agent_run_changed value
          | Evidence_changed value -> Evidence_changed value
          | Policy_changed value -> Policy_changed value
          | Policy_unchanged value -> Policy_unchanged value
          | Allocation_empty { run; attempt } ->
            Allocation_empty { run_id = run; attempt_id = attempt }
          | Ticket_recovered value -> Ticket_recovered value
          | Signal_receipt value -> Signal_receipt value
          | Settings_changed value -> Settings_changed value
          | Workspace_updated value -> Workspace_updated (workspace_settings_view value)
          | Project_put value -> Project_put (project_view value)
          | Milestone_put value -> Milestone_put (milestone_view value)
          | Ticket_put value -> Ticket_put (ticket_view value)
          | Comment_changed value -> Comment_changed value
          | Handoff_put value -> Handoff_put (handoff_view value)
          | Resource_changed value -> Resource_changed value
        in
        let items =
          scoped_activity target
          |> List.rev
          |> List.filter ~f:(fun value ->
            Json.integer (Json.field value "revision") > after
            && Option.for_all actor_id ~f:(fun actor ->
              Id.Actor.equal actor (Id.Actor.t_of_jsonaf (Json.field value "actor"))))
          |> List.map ~f:(fun value ->
            let header = event_summary value in
            { Planning_activity_wire.Activity.revision = header.revision
            ; actor_id = header.actor_id
            ; run_id = header.run_id
            ; timestamp = header.timestamp
            ; targets = header.targets
            ; changes =
                Json.list (Json.field value "changes")
                |> List.map ~f:(fun value -> change (Event.t_of_jsonaf value))
            })
        in
        Activity (page items)
      | Search { text; project_id = _; target = _; kinds = _ } ->
        let module Wire = Planning_context_wire.Search in
        let kinds = search_kinds params in
        let documents = search_documents t ~params ~resource_texts in
        let matches =
          Search.typed_matches
            documents
            ~text
            ~kinds
            ~offset:(Q.offset request)
            ~limit:(Q.limit request)
        in
        let source : Search.Source.t -> Wire.Source.t = function
          | Workspace id -> Workspace id
          | Project id -> Project id
          | Milestone id -> Milestone id
          | Ticket id -> Ticket id
          | Comment id -> Comment id
          | Handoff id -> Handoff id
          | Resource id -> Resource id
          | Resource_text id -> Resource_text id
          | Fact { scope; key } ->
            let scope : Facts.Scope.t =
              match scope with
              | Entity_ref.Workspace -> Workspace
              | Project id -> Project id
              | Milestone id -> Milestone id
              | Ticket id -> Ticket id
              | Resource _ ->
                raise
                  (Api_method.Invalid_response
                     ( "search.query"
                     , Problem.create
                         Invalid_argument
                         "fact search source has invalid resource scope" ))
            in
            Fact { scope; key = Facts.Key.of_string key |> unwrap_domain }
        in
        let items =
          List.map matches.items ~f:(fun (value : Search.Item.t) ->
            { Wire.Item.source =
                { source = source value.source; revision = value.revision }
            ; target = value.target
            ; matches =
                List.map value.matches ~f:(fun (value : Search.Match.t) ->
                  { Wire.Match.field = value.field
                  ; match_offset = value.match_offset
                  ; match_bytes = value.match_bytes
                  ; snippet_offset = value.snippet_offset
                  ; snippet = value.snippet
                  })
            })
        in
        let remaining =
          Int.max 0 (matches.total - Q.offset request - List.length items)
        in
        let results : Wire.Item.t Planning_wire.Page.t =
          { items
          ; offset = Q.offset request
          ; remaining
          ; next_offset =
              (if remaining = 0 then None else Some (Q.offset request + List.length items))
          }
        in
        let scope = search_scope t params in
        let omitted =
          Map.data t.resources
          |> List.filter ~f:(fun value -> scope (Entity_ref.Resource value.Resource.id))
          |> List.filter_map ~f:(fun resource ->
            let version = Resource.get_version resource ~revision:None in
            let reason =
              match
                List.find resource_texts ~f:(fun value ->
                  Id.Resource.equal value.Search.Text.id resource.id)
              with
              | Some { outcome = Search.Text.Content { text; total_bytes }; _ }
                when String.length text < total_bytes ->
                Some
                  ( Wire.Unindexed_resource.Prefix_only
                  , String.length text
                  , total_bytes - String.length text )
              | Some { outcome = Content _; _ } -> None
              | Some { outcome = Invalid_utf8; _ } ->
                Some
                  ( Wire.Unindexed_resource.Invalid_utf8
                  , 0
                  , Option.value version.size_bytes ~default:0 )
              | None ->
                Some
                  ( (if
                       not
                         (Option.for_all kinds ~f:(fun kinds ->
                            List.mem kinds "resource_text" ~equal:String.equal))
                     then Wire.Unindexed_resource.Not_requested
                     else if searchable_text version.mime_type
                     then Query_text_budget
                     else Unsupported_mime)
                  , 0
                  , Option.value version.size_bytes ~default:0 )
            in
            Option.map reason ~f:(fun (reason, indexed_bytes, omitted_bytes) ->
              { Wire.Unindexed_resource.source =
                  { source = Resource_text resource.id; revision = version.revision }
              ; reason
              ; indexed_bytes
              ; omitted_bytes
              ; size_known = Option.is_some version.size_bytes
              }))
        in
        let eligible = search_resources t ~params |> unwrap_domain in
        let indexed =
          List.count resource_texts ~f:(fun value ->
            match value.Search.Text.outcome with
            | Content _ -> true
            | Invalid_utf8 -> false)
        in
        let truncated =
          List.count resource_texts ~f:(fun value ->
            match value.Search.Text.outcome with
            | Content { text; total_bytes } -> String.length text < total_bytes
            | Invalid_utf8 -> false)
        in
        Search
          { results
          ; unindexed_resources = page omitted
          ; index_revision = t.revision
          ; sources_scanned = List.length documents
          ; coverage =
              { current_revisions_only = true
              ; eligible_text_resources = List.length eligible
              ; indexed_text_resources = indexed
              ; unindexed_text_resources = List.length eligible - indexed
              ; truncated_text_resources = truncated
              ; resource_prefix_bytes = 65536
              ; request_text_bytes = 1048576
              }
          }
      | Workspace_overview { actor_id; run_id } ->
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun ticket -> include_archived || active_scope t ticket)
        in
        Workspace_overview
          { name = name t
          ; settings = workspace_settings_view t.settings
          ; projects = Map.length t.projects
          ; tickets = Map.length t.tickets
          ; ready = List.count tickets ~f:(ready ?now_unix_ms t)
          ; counts_by_status =
              List.map
                [ Workflow.Category.Backlog; Todo; In_progress; Done; Canceled ]
                ~f:(fun status ->
                  ( status
                  , List.count tickets ~f:(fun ticket ->
                      Workflow.Category.equal ticket.Ticket.status status) ))
          ; active_projects =
              Map.data t.projects
              |> List.filter ~f:(fun project ->
                (not project.Project.archived)
                && not
                     (Workflow.Category.equal project.status Done
                      || Workflow.Category.equal project.status Canceled))
              |> List.map ~f:project_view
              |> page
          ; held_work =
              tickets
              |> List.filter ~f:(fun ticket ->
                Option.exists ticket.Ticket.claim ~f:(fun claim ->
                  Option.for_all actor_id ~f:(Id.Actor.equal claim.Claim.actor)
                  && Option.for_all run_id ~f:(fun run ->
                    Option.exists claim.run_id ~f:(Id.Run.equal run))))
              |> List.map ~f:summary
              |> page
          ; blocked_work =
              tickets |> List.filter ~f:blocked |> List.map ~f:summary |> page
          ; recent_changes = List.map t.activity ~f:event_summary |> page
          ; resources = resources Entity_ref.Workspace
          }
      | Project_brief id ->
        let project = find_project t id in
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun ticket ->
            Option.exists ticket.Ticket.project ~f:(Id.Project.equal id)
            && (include_archived || not ticket.archived))
        in
        let milestones =
          Map.data t.milestones
          |> List.filter ~f:(fun milestone ->
            Id.Project.equal milestone.Milestone.project id
            && (include_archived || not milestone.archived))
        in
        Project_brief
          { project = project_view project
          ; resources = resources (Entity_ref.Project id)
          ; communication = communication (Entity_ref.Project id)
          ; progress =
              { total = List.length tickets
              ; done_ =
                  List.count tickets ~f:(fun ticket ->
                    Workflow.Category.equal ticket.Ticket.status Done)
              ; blocked = List.count tickets ~f:blocked
              }
          ; ready_work =
              List.filter tickets ~f:(ready ?now_unix_ms t)
              |> sort_ready
              |> List.map ~f:summary
              |> page
          ; in_progress_work =
              List.filter tickets ~f:(fun ticket ->
                Workflow.Category.equal ticket.Ticket.status In_progress)
              |> List.map ~f:summary
              |> page
          ; blocked_work = List.filter tickets ~f:blocked |> List.map ~f:summary |> page
          ; tickets = List.map tickets ~f:ticket_view |> page
          ; milestones = List.map milestones ~f:milestone_view |> page
          }
      | Ticket_context id ->
        let ticket = find_ticket t id in
        let handoff = Map.find t.handoffs id in
        let after =
          Option.value_map handoff ~default:0 ~f:(fun value ->
            value.Handoff.covers_through)
        in
        let fact_keys =
          Facts.keys t.facts ~scope:(Facts.Scope.Ticket id) ~limit:(Q.limit request)
          |> Api_codec.decode Planning_context_wire.Fact_keys.codec
          |> unwrap_domain
        in
        let evidence =
          Evidence.query
            t.evidence
            ~ticket_context:(evidence_ticket_context t)
            ~method_:"evidence.context"
            ~params:
              (Json.obj
                 [ "ticket_id", Id.Ticket.jsonaf_of_t id
                 ; "max_bytes", Json.int (Q.max_bytes request)
                 ])
          |> unwrap_domain
          |> Api_response.project (Domain_query Evidence)
          |> Api_response.to_json
        in
        Ticket_context
          { ticket = ticket_view ticket
          ; fact_keys
          ; related =
              List.map ticket.related ~f:(fun id -> summary (find_ticket t id)) |> page
          ; resources = resources (Entity_ref.Ticket id)
          ; communication = communication (Entity_ref.Ticket id)
          ; attempts = Agent_run.attempts_for_ticket t.agent_runs id |> page
          ; evidence
          ; completion_readiness = completion_view t ticket
          ; readiness = readiness_view ?now_unix_ms t ticket
          ; recoveries =
              Map.data t.ticket_recoveries
              |> List.filter ~f:(fun recovery ->
                Id.Ticket.equal recovery.Ticket_recovery.request.ticket_id id)
              |> page
          ; paths = Agent_run.get_ticket_paths t.agent_runs id
          ; external_conditions =
              External_condition.declarations (Agent_run.external_conditions t.agent_runs)
              |> List.filter ~f:(fun declaration ->
                Id.Ticket.equal declaration.External_condition.Declaration.ticket_id id)
              |> List.map
                   ~f:
                     (Agent_coordination_api.condition_json
                        (Agent_run.external_conditions t.agent_runs))
          ; parent =
              Option.map ticket.parent ~f:(fun id -> ticket_view (find_ticket t id))
          ; children =
              Map.data t.tickets
              |> List.filter ~f:(fun child ->
                Option.exists child.Ticket.parent ~f:(Id.Ticket.equal id))
              |> List.map ~f:ticket_view
              |> page
          ; blocker_ticket_ids = blockers t ticket
          ; handoff = Option.map handoff ~f:handoff_view
          ; updates =
              Discussion.since t.discussion ~target:(Entity_ref.Ticket id) ~after
              |> List.map ~f:Discussion_wire.comment_json
              |> page
          ; activity_since_handoff =
              scoped_activity (Some (Entity_ref.Ticket id))
              |> List.rev
              |> List.filter ~f:(fun event ->
                Json.integer (Json.field event "revision") > after
                && not
                     (List.for_all
                        (Json.list (Json.field event "changes"))
                        ~f:(fun change ->
                          match Event.t_of_jsonaf change, handoff with
                          | Handoff_put value, Some current ->
                            Id.Ticket.equal value.ticket id
                            && Int.equal value.revision current.revision
                          | _ -> false)))
              |> List.map ~f:event_summary
              |> page
          }
      | Ticket_list filter | Ticket_ready filter ->
        let only_ready =
          match Q.query request with
          | Ticket_ready _ -> true
          | _ -> false
        in
        let search = Option.value filter.text ~default:"" |> String.lowercase in
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun (ticket : Ticket.t) ->
            (include_archived || active_scope t ticket)
            && ((not only_ready) || ready ?now_unix_ms t ticket)
            && Option.for_all filter.project_id ~f:(fun id ->
              Option.exists ticket.project ~f:(Id.Project.equal id))
            && Option.for_all filter.milestone_id ~f:(fun id ->
              Option.exists ticket.milestone ~f:(Id.Milestone.equal id))
            && Option.for_all filter.assignee_id ~f:(fun id ->
              Option.exists ticket.assignee ~f:(Id.Actor.equal id))
            && Option.for_all filter.label_id ~f:(fun id ->
              List.mem ticket.labels id ~equal:Id.Label.equal)
            && Option.for_all filter.status ~f:(Domain_command.Status.equal ticket.status)
            && Option.for_all filter.priority ~f:(Int.equal ticket.priority)
            && String.is_substring
                 (String.lowercase (ticket.title ^ "\n" ^ ticket.description))
                 ~substring:search)
        in
        let tickets = if only_ready then sort_ready tickets else tickets in
        Tickets (List.map tickets ~f:ticket_view |> page)
      | Ticket_readiness id ->
        Readiness (readiness_view ?now_unix_ms t (find_ticket t id))
      | Ticket_blockers id ->
        let ticket = find_ticket t id in
        Blockers
          (List.map (blockers t ticket) ~f:(fun id -> summary (find_ticket t id)) |> page)
      | Ticket_resolve display_key ->
        let ticket_id =
          match Map.find t.ticket_keys display_key with
          | Some id -> id
          | None -> Json.fail Not_found "ticket display key not found"
        in
        Resolve { ticket_id; display_key }
      | Handoff_get id ->
        ignore (find_ticket t id : Ticket.t);
        (match Map.find t.handoffs id with
         | Some value -> Handoff (handoff_view value)
         | None -> Json.fail Not_found "handoff not found")
      | Handoff_history id ->
        ignore (find_ticket t id : Ticket.t);
        let records =
          List.rev t.activity
          |> List.concat_map ~f:(fun event ->
            Json.list (Json.field event "changes")
            |> List.filter_map ~f:(fun change ->
              match Event.t_of_jsonaf change with
              | Handoff_put value when Id.Ticket.equal value.ticket id ->
                Some (handoff_view value)
              | Handoff_put _
              | Facts_changed _
              | Communication_changed _
              | Agent_run_changed _
              | Evidence_changed _
              | Allocation_empty _
              | Ticket_recovered _
              | Signal_receipt _
              | Policy_changed _
              | Policy_unchanged _
              | Settings_changed _
              | Workspace_updated _
              | Project_put _
              | Milestone_put _
              | Ticket_put _
              | Comment_changed _
              | Resource_changed _ -> None))
        in
        Handoffs (page records)
    in
    Planning_context_wire.Response.fit
      response
      ~workspace_revision:t.revision
      ~max_bytes:(Q.max_bytes request)
    |> unwrap_domain)
;;

let query_with_texts ?now_unix_ms t ~resource_texts ~method_ ~params =
  match Planning_read_api.request_codec ~method_ with
  | None ->
    (match Planning_context_api.request_codec ~method_ with
     | None -> query_other_with_texts ?now_unix_ms t ~resource_texts ~method_ ~params
     | Some _ ->
       Json.decode (fun () ->
         let unscoped =
           match params with
           | `Object fields ->
             Json.obj
               (List.filter fields ~f:(fun (name, _) ->
                  not (String.equal name "workspace_id")))
           | _ -> Json.fail Invalid_argument "query params require object"
         in
         let request =
           Planning_context_api.Query.decode ~method_ ~params:unscoped |> unwrap_domain
         in
         let result =
           rich_query ?now_unix_ms t ~resource_texts ~params ~request |> unwrap_domain
         in
         Planning_context_api.validate_result ~method_ (Json.field result "data");
         result))
  | Some _ ->
    Json.decode (fun () ->
      let unscoped =
        match params with
        | `Object fields ->
          Json.obj
            (List.filter fields ~f:(fun (name, _) ->
               not (String.equal name "workspace_id")))
        | _ -> Json.fail Invalid_argument "query params require object"
      in
      let request =
        Planning_read_api.Query.decode ~method_ ~params:unscoped |> unwrap_domain
      in
      let result = base_query t ~request |> unwrap_domain in
      Planning_read_api.validate_result ~method_ (Json.field result "data");
      result)
;;

let query ?now_unix_ms t ~method_ ~params =
  if List.mem Resume_api.query_methods method_ ~equal:String.equal
  then
    Json.decode (fun () ->
      let unscoped =
        match params with
        | `Object fields ->
          Json.obj
            (List.filter fields ~f:(fun (key, _) -> not (String.equal key "workspace_id")))
        | _ -> Json.fail Invalid_argument "query params require object"
      in
      match method_ with
      | "ticket.resume" ->
        let request =
          Api_codec.decode Resume_api.Resume_request.codec unscoped |> unwrap_domain
        in
        Planning_resume.build ?now_unix_ms t request
        |> unwrap_domain
        |> Planning_resume.result
      | "activity.digest" ->
        let request =
          Api_codec.decode Resume_api.Digest_request.codec unscoped |> unwrap_domain
        in
        Activity_digest.build t request |> unwrap_domain |> Activity_digest.result
      | _ -> Json.fail Invalid_argument "unsupported resume method")
  else if String.equal method_ "changes.read"
  then
    Change_feed.read
      ~workspace:t.workspace
      ~revision:t.revision
      ~activity:t.activity
      ~params
  else if List.mem Facts.query_methods method_ ~equal:String.equal
  then
    Json.decode (fun () ->
      let fields =
        match params with
        | `Object fields -> fields
        | _ -> Json.fail Invalid_argument "query params require object"
      in
      let scope =
        Json.field params "scope" |> Api_codec.decode Facts.Scope.codec |> unwrap_domain
      in
      validate_target t (Facts.Scope.target scope);
      let result =
        Facts.query
          t.facts
          ~workspace_revision:t.revision
          ~method_
          ~params:
            (Json.obj
               (List.filter fields ~f:(fun (key, _) ->
                  not (String.equal key "workspace_id"))))
        |> unwrap_domain
      in
      let codec = unwrap_domain (Facts.response_codec method_) in
      (match Api_codec.encode codec (Json.field result "data") with
       | Ok _ -> ()
       | Error problem -> raise (Api_method.Invalid_response (method_, problem)));
      result)
  else if List.mem Agent_run_policy.query_methods method_ ~equal:String.equal
  then Agent_run_policy.query t.policies ~runs:t.agent_runs ~method_ ~params
  else if List.mem Ticket_recovery.query_methods method_ ~equal:String.equal
  then
    Ticket_recovery.query
      ~revision:t.revision
      (Map.data t.ticket_recoveries)
      ~method_
      ~params
  else if List.mem Agent_run.query_methods method_ ~equal:String.equal
  then Agent_run.query t.agent_runs ~method_ ~params
  else if List.mem Evidence.query_methods method_ ~equal:String.equal
  then
    Evidence.query t.evidence ~ticket_context:(evidence_ticket_context t) ~method_ ~params
  else if List.mem Communication.query_methods method_ ~equal:String.equal
  then Communication.query t.communication ~discussion:t.discussion ~method_ ~params
  else query_with_texts ?now_unix_ms t ~resource_texts:[] ~method_ ~params
;;
