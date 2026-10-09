open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both
let counter = Coordination_wire.counter
let name = Coordination_wire.nonblank ~max_bytes:512
let display_key = Coordination_wire.nonblank ~max_bytes:96
let entity = Evidence_wire.entity_ref

let public_json codec value =
  match Api_codec.encode codec value with
  | Ok json -> json
  | Error problem -> raise (Api_method.Invalid_response ("planning context", problem))
;;

let evidence_capture =
  Api_codec.as_json
    (Api_codec.object_
       (Fields.required
          "data"
          (Option.value_exn (Evidence.response_codec ~method_:"evidence.context"))
        ++ Fields.required "meta" (Api_codec.as_json Api_metadata.codec)))
;;

let condition =
  Option.value_exn (Agent_coordination_api.response_codec ~method_:"condition.get")
;;

let counts_by_status =
  Api_codec.object_
    (Fields.map
       (Fields.required "backlog" counter
        ++ Fields.required "todo" counter
        ++ Fields.required "in_progress" counter
        ++ Fields.required "done" counter
        ++ Fields.required "canceled" counter)
       ~decode:(fun ((((backlog, todo), in_progress), done_), canceled) ->
         [ Workflow.Category.Backlog, backlog
         ; Todo, todo
         ; In_progress, in_progress
         ; Done, done_
         ; Canceled, canceled
         ])
       ~encode:(fun values ->
         if List.length values <> 5
         then Json.fail Invalid_argument "expected five category counts";
         let count category =
           match
             List.filter values ~f:(fun (key, _) -> Workflow.Category.equal key category)
           with
           | [ (_, value) ] -> value
           | _ -> Json.fail Invalid_argument "duplicate or missing category count"
         in
         (((count Backlog, count Todo), count In_progress), count Done), count Canceled))
;;

module Communication = struct
  type t =
    { threads : Jsonaf.t Planning_wire.Page.t
    ; requests : Jsonaf.t Planning_wire.Page.t
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "threads" (Planning_wire.Page.codec Communication_wire.thread)
          ++ Fields.required
               "requests"
               (Planning_wire.Page.codec Communication_wire.request))
         ~decode:(fun (threads, requests) -> { threads; requests })
         ~encode:(fun ({ threads; requests } : t) -> threads, requests))
  ;;

  let codec = base
end

module Fact_keys = struct
  type t =
    { items : Jsonaf.t list
    ; total : int
    ; remaining : int
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "items" (Api_codec.list Facts.key_metadata_codec ~max_items:100)
          ++ Fields.required "total" counter
          ++ Fields.required "remaining" counter)
         ~decode:(fun ((items, total), remaining) -> { items; total; remaining })
         ~encode:(fun ({ items; total; remaining } : t) -> (items, total), remaining))
  ;;

  let codec =
    Api_codec.map
      base
      ~decode:(fun t ->
        if
          t.remaining <= Int.max_value - List.length t.items
          && t.total = List.length t.items + t.remaining
        then Ok t
        else Error (Problem.create Invalid_argument "inconsistent fact discovery counts"))
      ~encode:Fn.id
      ~description:"Complete attributed fact key metadata with exact discovery counts."
  ;;
end

module Workspace_overview = struct
  type t =
    { name : string
    ; settings : Planning_wire.Workspace_settings.t
    ; projects : int
    ; tickets : int
    ; ready : int
    ; counts_by_status : (Workflow.Category.t * int) list
    ; active_projects : Planning_wire.Project.t Planning_wire.Page.t
    ; held_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; blocked_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; recent_changes : Planning_activity_wire.Summary.t Planning_wire.Page.t
    ; resources : Jsonaf.t Planning_wire.Page.t
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "name" name
          ++ Fields.required "settings" Planning_wire.Workspace_settings.codec
          ++ Fields.required "projects" counter
          ++ Fields.required "tickets" counter
          ++ Fields.required "ready" counter
          ++ Fields.required "counts_by_status" counts_by_status
          ++ Fields.required
               "active_projects"
               (Planning_wire.Page.codec Planning_wire.Project.codec)
          ++ Fields.required
               "held_work"
               (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec)
          ++ Fields.required
               "blocked_work"
               (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec)
          ++ Fields.required
               "recent_changes"
               (Planning_wire.Page.codec Planning_activity_wire.Summary.codec)
          ++ Fields.required "resources" (Planning_wire.Page.codec Resource_wire.summary)
         )
         ~decode:
           (fun
             ( ( ( ( ( (((((name, settings), projects), tickets), ready), counts_by_status)
                     , active_projects )
                   , held_work )
                 , blocked_work )
               , recent_changes )
             , resources ) ->
           { name
           ; settings
           ; projects
           ; tickets
           ; ready
           ; counts_by_status
           ; active_projects
           ; held_work
           ; blocked_work
           ; recent_changes
           ; resources
           })
         ~encode:
           (fun
             ({ name
              ; settings
              ; projects
              ; tickets
              ; ready
              ; counts_by_status
              ; active_projects
              ; held_work
              ; blocked_work
              ; recent_changes
              ; resources
              } :
               t) ->
           ( ( ( ( ( (((((name, settings), projects), tickets), ready), counts_by_status)
                   , active_projects )
                 , held_work )
               , blocked_work )
             , recent_changes )
           , resources )))
  ;;

  let codec = base
end

module Project_brief = struct
  type t =
    { project : Planning_wire.Project.t
    ; resources : Jsonaf.t Planning_wire.Page.t
    ; communication : Communication.t
    ; progress : Planning_wire.Progress.t
    ; ready_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; in_progress_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; blocked_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; tickets : Planning_ticket_wire.Ticket.t Planning_wire.Page.t
    ; milestones : Planning_wire.Milestone.t Planning_wire.Page.t
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "project" Planning_wire.Project.codec
          ++ Fields.required "resources" (Planning_wire.Page.codec Resource_wire.summary)
          ++ Fields.required "communication" Communication.codec
          ++ Fields.required "progress" Planning_wire.Progress.codec
          ++ Fields.required
               "ready_work"
               (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec)
          ++ Fields.required
               "in_progress_work"
               (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec)
          ++ Fields.required
               "blocked_work"
               (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec)
          ++ Fields.required
               "tickets"
               (Planning_wire.Page.codec Planning_ticket_wire.Ticket.codec)
          ++ Fields.required
               "milestones"
               (Planning_wire.Page.codec Planning_wire.Milestone.codec))
         ~decode:
           (fun
             ( ( ( ( ((((project, resources), communication), progress), ready_work)
                   , in_progress_work )
                 , blocked_work )
               , tickets )
             , milestones ) ->
           { project
           ; resources
           ; communication
           ; progress
           ; ready_work
           ; in_progress_work
           ; blocked_work
           ; tickets
           ; milestones
           })
         ~encode:
           (fun
             ({ project
              ; resources
              ; communication
              ; progress
              ; ready_work
              ; in_progress_work
              ; blocked_work
              ; tickets
              ; milestones
              } :
               t) ->
           ( ( ( ( ((((project, resources), communication), progress), ready_work)
                 , in_progress_work )
               , blocked_work )
             , tickets )
           , milestones )))
  ;;

  let codec = base
end

module Ticket_context = struct
  type t =
    { ticket : Planning_ticket_wire.Ticket.t
    ; fact_keys : Fact_keys.t
    ; related : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; resources : Jsonaf.t Planning_wire.Page.t
    ; communication : Communication.t
    ; attempts : Attempt.t Planning_wire.Page.t
    ; evidence : Jsonaf.t
    ; completion_readiness : Planning_ticket_wire.Completion.t
    ; readiness : Planning_ticket_wire.Readiness.t
    ; recoveries : Ticket_recovery.t Planning_wire.Page.t
    ; paths : Ticket_paths.t option
    ; external_conditions : Jsonaf.t list
    ; parent : Planning_ticket_wire.Ticket.t option
    ; children : Planning_ticket_wire.Ticket.t Planning_wire.Page.t
    ; blocker_ticket_ids : Id.Ticket.t list
    ; handoff : Planning_ticket_wire.Handoff.t option
    ; updates : Jsonaf.t Planning_wire.Page.t
    ; activity_since_handoff : Planning_activity_wire.Summary.t Planning_wire.Page.t
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required "ticket" Planning_ticket_wire.Ticket.codec
          ++ Fields.required "fact_keys" Fact_keys.codec
          ++ Fields.required
               "related"
               (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec)
          ++ Fields.required "resources" (Planning_wire.Page.codec Resource_wire.summary)
          ++ Fields.required "communication" Communication.codec
          ++ Fields.required "attempts" (Planning_wire.Page.codec Agent_run_wire.attempt)
          ++ Fields.required "evidence" evidence_capture
          ++ Fields.required "completion_readiness" Planning_ticket_wire.Completion.codec
          ++ Fields.required "readiness" Planning_ticket_wire.Readiness.codec
          ++ Fields.required "recoveries" (Planning_wire.Page.codec Ticket_recovery.codec)
          ++ Fields.required "paths" (Api_codec.nullable Ticket_paths.codec)
          ++ Fields.required
               "external_conditions"
               (Api_codec.list condition ~max_items:100000)
          ++ Fields.required
               "parent"
               (Api_codec.nullable Planning_ticket_wire.Ticket.codec)
          ++ Fields.required
               "children"
               (Planning_wire.Page.codec Planning_ticket_wire.Ticket.codec)
          ++ Fields.required
               "blocker_ticket_ids"
               (Api_codec.list
                  (Coordination_wire.id Id.Ticket.of_string Id.Ticket.to_string)
                  ~max_items:100000)
          ++ Fields.required
               "handoff"
               (Api_codec.nullable Planning_ticket_wire.Handoff.codec)
          ++ Fields.required "updates" (Planning_wire.Page.codec Discussion_wire.comment)
          ++ Fields.required
               "activity_since_handoff"
               (Planning_wire.Page.codec Planning_activity_wire.Summary.codec))
         ~decode:
           (fun
             ( ( ( ( ( ( ( ( ( ( ( ( ( ( (((ticket, fact_keys), related), resources)
                                       , communication )
                                     , attempts )
                                   , evidence )
                                 , completion_readiness )
                               , readiness )
                             , recoveries )
                           , paths )
                         , external_conditions )
                       , parent )
                     , children )
                   , blocker_ticket_ids )
                 , handoff )
               , updates )
             , activity_since_handoff ) ->
           { ticket
           ; fact_keys
           ; related
           ; resources
           ; communication
           ; attempts
           ; evidence
           ; completion_readiness
           ; readiness
           ; recoveries
           ; paths
           ; external_conditions
           ; parent
           ; children
           ; blocker_ticket_ids
           ; handoff
           ; updates
           ; activity_since_handoff
           })
         ~encode:
           (fun
             ({ ticket
              ; fact_keys
              ; related
              ; resources
              ; communication
              ; attempts
              ; evidence
              ; completion_readiness
              ; readiness
              ; recoveries
              ; paths
              ; external_conditions
              ; parent
              ; children
              ; blocker_ticket_ids
              ; handoff
              ; updates
              ; activity_since_handoff
              } :
               t) ->
           ( ( ( ( ( ( ( ( ( ( ( ( ( ( (((ticket, fact_keys), related), resources)
                                     , communication )
                                   , attempts )
                                 , evidence )
                               , completion_readiness )
                             , readiness )
                           , recoveries )
                         , paths )
                       , external_conditions )
                     , parent )
                   , children )
                 , blocker_ticket_ids )
               , handoff )
             , updates )
           , activity_since_handoff )))
  ;;

  let codec = base
end

module Resolve = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; display_key : string
    }

  let base =
    Api_codec.object_
      (Fields.map
         (Fields.required
            "ticket_id"
            (Coordination_wire.id Id.Ticket.of_string Id.Ticket.to_string)
          ++ Fields.required "display_key" display_key)
         ~decode:(fun (ticket_id, display_key) -> { ticket_id; display_key })
         ~encode:(fun ({ ticket_id; display_key } : t) -> ticket_id, display_key))
  ;;

  let codec = base
end

module Search = struct
  module Match = struct
    type t =
      { field : string
      ; match_offset : int
      ; match_bytes : int
      ; snippet_offset : int
      ; snippet : string
      }

    let base =
      Api_codec.object_
        (Fields.map
           (Fields.required "field" (Coordination_wire.nonblank ~max_bytes:512)
            ++ Fields.required "match_offset" counter
            ++ Fields.required "match_bytes" Coordination_wire.positive
            ++ Fields.required "snippet_offset" counter
            ++ Fields.required "snippet" (Api_codec.text ~max_bytes:512))
           ~decode:
             (fun
               ((((field, match_offset), match_bytes), snippet_offset), snippet) ->
             { field; match_offset; match_bytes; snippet_offset; snippet })
           ~encode:
             (fun
               ({ field; match_offset; match_bytes; snippet_offset; snippet } : t) ->
             (((field, match_offset), match_bytes), snippet_offset), snippet))
    ;;

    let codec =
      Api_codec.map
        base
        ~decode:(fun t ->
          if
            let boundary offset =
              offset = String.length t.snippet
              || Char.to_int t.snippet.[offset] land 0xc0 <> 0x80
            in
            t.match_bytes <= 256
            && t.snippet_offset <= t.match_offset
            && t.match_offset - t.snippet_offset <= String.length t.snippet
            && t.match_bytes
               <= String.length t.snippet - (t.match_offset - t.snippet_offset)
            && boundary (t.match_offset - t.snippet_offset)
            && boundary (t.match_offset - t.snippet_offset + t.match_bytes)
          then Ok t
          else Error (Problem.create Invalid_argument "inconsistent Match record"))
        ~encode:Fn.id
        ~description:"Validated Match metadata."
    ;;
  end

  module Source = struct
    type t =
      | Workspace of Id.Workspace.t
      | Project of Id.Project.t
      | Milestone of Id.Milestone.t
      | Ticket of Id.Ticket.t
      | Comment of Id.Comment.t
      | Handoff of Id.Ticket.t
      | Resource of Id.Resource.t
      | Resource_text of Id.Resource.t
      | Fact of
          { scope : Facts.Scope.t
          ; key : Facts.Key.t
          }

    let kind = function
      | Workspace _ -> "workspace"
      | Project _ -> "project"
      | Milestone _ -> "milestone"
      | Ticket _ -> "ticket"
      | Comment _ -> "comment"
      | Handoff _ -> "handoff"
      | Resource _ -> "resource"
      | Resource_text _ -> "resource_text"
      | Fact _ -> "fact"
    ;;

    let codec =
      Api_codec.tagged
        ~discriminator:"kind"
        ~select:kind
        ~cases:
          [ ( "workspace"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "workspace")
                    ++ Fields.required
                         "workspace_id"
                         (Coordination_wire.id
                            Id.Workspace.of_string
                            Id.Workspace.to_string))
                   ~decode:(fun ((), value) -> Workspace value)
                   ~encode:(function
                     | Workspace value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "project"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "project")
                    ++ Fields.required
                         "project_id"
                         (Coordination_wire.id Id.Project.of_string Id.Project.to_string)
                   )
                   ~decode:(fun ((), value) -> Project value)
                   ~encode:(function
                     | Project value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "milestone"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "milestone")
                    ++ Fields.required
                         "milestone_id"
                         (Coordination_wire.id
                            Id.Milestone.of_string
                            Id.Milestone.to_string))
                   ~decode:(fun ((), value) -> Milestone value)
                   ~encode:(function
                     | Milestone value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "ticket"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "ticket")
                    ++ Fields.required
                         "ticket_id"
                         (Coordination_wire.id Id.Ticket.of_string Id.Ticket.to_string))
                   ~decode:(fun ((), value) -> Ticket value)
                   ~encode:(function
                     | Ticket value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "comment"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "comment")
                    ++ Fields.required
                         "comment_id"
                         (Coordination_wire.id Id.Comment.of_string Id.Comment.to_string)
                   )
                   ~decode:(fun ((), value) -> Comment value)
                   ~encode:(function
                     | Comment value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "handoff"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "handoff")
                    ++ Fields.required
                         "ticket_id"
                         (Coordination_wire.id Id.Ticket.of_string Id.Ticket.to_string))
                   ~decode:(fun ((), value) -> Handoff value)
                   ~encode:(function
                     | Handoff value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "resource"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "resource")
                    ++ Fields.required
                         "resource_id"
                         (Coordination_wire.id
                            Id.Resource.of_string
                            Id.Resource.to_string))
                   ~decode:(fun ((), value) -> Resource value)
                   ~encode:(function
                     | Resource value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "resource_text"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "resource_text")
                    ++ Fields.required
                         "resource_id"
                         (Coordination_wire.id
                            Id.Resource.of_string
                            Id.Resource.to_string))
                   ~decode:(fun ((), value) -> Resource_text value)
                   ~encode:(function
                     | Resource_text value -> (), value
                     | _ -> Json.fail Invalid_argument "wrong source constructor")) )
          ; ( "fact"
            , Api_codec.object_
                (Fields.map
                   (Fields.required "kind" (Api_codec.literal "fact")
                    ++ Fields.required "scope" Facts.Scope.codec
                    ++ Fields.required "key" Facts.Key.codec)
                   ~decode:(fun (((), scope), key) -> Fact { scope; key })
                   ~encode:(function
                     | Fact { scope; key } -> ((), scope), key
                     | _ -> Json.fail Invalid_argument "wrong fact source")) )
          ]
    ;;
  end

  module Version = struct
    type t =
      { source : Source.t
      ; revision : int
      }

    let codec =
      Api_codec.map
        (Api_codec.merge_objects
           Source.codec
           (Api_codec.object_ (Fields.required "revision" counter)))
        ~decode:(fun (source, revision) ->
          if
            revision > 0
            ||
            match source with
            | Source.Workspace _ -> true
            | _ -> false
          then Ok { source; revision }
          else Error (Problem.create Invalid_argument "source revision must be positive"))
        ~encode:(fun { source; revision } -> source, revision)
        ~description:
          "Current source identity and exact revision. Workspace settings alone may \
           start at revision zero."
    ;;
  end

  module Item = struct
    type t =
      { source : Version.t
      ; target : Entity_ref.t
      ; matches : Match.t list
      }

    let base =
      Api_codec.object_
        (Fields.map
           (Fields.required "source" Version.codec
            ++ Fields.required "target" entity
            ++ Fields.required "matches" (Api_codec.list Match.codec ~max_items:100))
           ~decode:(fun ((source, target), matches) -> { source; target; matches })
           ~encode:(fun ({ source; target; matches } : t) -> (source, target), matches))
    ;;

    let codec =
      Api_codec.map
        base
        ~decode:(fun t ->
          if not (List.is_empty t.matches)
          then Ok t
          else Error (Problem.create Invalid_argument "inconsistent Item record"))
        ~encode:Fn.id
        ~description:"Validated Item metadata."
    ;;
  end

  module Unindexed_resource = struct
    type reason =
      | Prefix_only
      | Invalid_utf8
      | Not_requested
      | Query_text_budget
      | Unsupported_mime
    [@@deriving equal]

    let reason =
      Api_codec.enum
        [ "prefix_only", Prefix_only
        ; "invalid_utf8", Invalid_utf8
        ; "not_requested", Not_requested
        ; "query_text_budget", Query_text_budget
        ; "unsupported_mime", Unsupported_mime
        ]
        ~equal:equal_reason
    ;;

    type t =
      { source : Version.t
      ; reason : reason
      ; indexed_bytes : int
      ; omitted_bytes : int
      ; size_known : bool
      }

    let base =
      Api_codec.object_
        (Fields.map
           (Fields.required "source" Version.codec
            ++ Fields.required "reason" reason
            ++ Fields.required "indexed_bytes" counter
            ++ Fields.required "omitted_bytes" counter
            ++ Fields.required "size_known" Api_codec.boolean)
           ~decode:
             (fun
               ((((source, reason), indexed_bytes), omitted_bytes), size_known) ->
             { source; reason; indexed_bytes; omitted_bytes; size_known })
           ~encode:
             (fun
               ({ source; reason; indexed_bytes; omitted_bytes; size_known } : t) ->
             (((source, reason), indexed_bytes), omitted_bytes), size_known))
    ;;

    let codec =
      Api_codec.map
        base
        ~decode:(fun t ->
          if
            (match t.source.source with
             | Source.Resource_text _ -> true
             | _ -> false)
            &&
            match t.reason with
            | Prefix_only -> t.indexed_bytes > 0 && t.omitted_bytes > 0
            | Invalid_utf8 | Not_requested | Query_text_budget | Unsupported_mime ->
              t.indexed_bytes = 0
          then Ok t
          else
            Error
              (Problem.create Invalid_argument "inconsistent unindexed resource record"))
        ~encode:Fn.id
        ~description:"Current resource coverage and omitted byte counts."
    ;;
  end

  module Coverage = struct
    type t =
      { current_revisions_only : bool
      ; eligible_text_resources : int
      ; indexed_text_resources : int
      ; unindexed_text_resources : int
      ; truncated_text_resources : int
      ; resource_prefix_bytes : int
      ; request_text_bytes : int
      }

    let base =
      Api_codec.object_
        (Fields.map
           (Fields.required "current_revisions_only" Api_codec.boolean
            ++ Fields.required "eligible_text_resources" counter
            ++ Fields.required "indexed_text_resources" counter
            ++ Fields.required "unindexed_text_resources" counter
            ++ Fields.required "truncated_text_resources" counter
            ++ Fields.required "resource_prefix_bytes" counter
            ++ Fields.required "request_text_bytes" counter)
           ~decode:
             (fun
               ( ( ( ( ( (current_revisions_only, eligible_text_resources)
                       , indexed_text_resources )
                     , unindexed_text_resources )
                   , truncated_text_resources )
                 , resource_prefix_bytes )
               , request_text_bytes ) ->
             { current_revisions_only
             ; eligible_text_resources
             ; indexed_text_resources
             ; unindexed_text_resources
             ; truncated_text_resources
             ; resource_prefix_bytes
             ; request_text_bytes
             })
           ~encode:
             (fun
               ({ current_revisions_only
                ; eligible_text_resources
                ; indexed_text_resources
                ; unindexed_text_resources
                ; truncated_text_resources
                ; resource_prefix_bytes
                ; request_text_bytes
                } :
                 t) ->
             ( ( ( ( ( (current_revisions_only, eligible_text_resources)
                     , indexed_text_resources )
                   , unindexed_text_resources )
                 , truncated_text_resources )
               , resource_prefix_bytes )
             , request_text_bytes )))
    ;;

    let codec =
      Api_codec.map
        base
        ~decode:(fun t ->
          if
            t.current_revisions_only
            && t.indexed_text_resources <= t.eligible_text_resources
            && t.unindexed_text_resources
               = t.eligible_text_resources - t.indexed_text_resources
            && t.truncated_text_resources <= t.indexed_text_resources
            && t.resource_prefix_bytes = 65536
            && t.request_text_bytes = 1048576
          then Ok t
          else Error (Problem.create Invalid_argument "inconsistent Coverage record"))
        ~encode:Fn.id
        ~description:"Validated Coverage metadata."
    ;;
  end

  type t =
    { results : Item.t Planning_wire.Page.t
    ; unindexed_resources : Unindexed_resource.t Planning_wire.Page.t
    ; index_revision : int
    ; sources_scanned : int
    ; coverage : Coverage.t
    }

  let codec =
    Api_codec.map
      (Api_codec.merge_objects
         (Planning_wire.Page.codec Item.codec)
         (Api_codec.object_
            (Fields.required
               "unindexed_resources"
               (Planning_wire.Page.codec Unindexed_resource.codec)
             ++ Fields.required "index_revision" counter
             ++ Fields.required "sources_scanned" counter
             ++ Fields.required "coverage" Coverage.codec)))
      ~decode:
        (fun
          (results, (((unindexed_resources, index_revision), sources_scanned), coverage)) ->
        Ok { results; unindexed_resources; index_revision; sources_scanned; coverage })
      ~encode:
        (fun
          { results; unindexed_resources; index_revision; sources_scanned; coverage } ->
        results, (((unindexed_resources, index_revision), sources_scanned), coverage))
      ~description:
        "Whole current search hits, exact byte offsets, and complete coverage counts."
  ;;
end

module Response = struct
  type t =
    | Activity of Planning_activity_wire.Activity.t Planning_wire.Page.t
    | Search of Search.t
    | Workspace_overview of Workspace_overview.t
    | Project_brief of Project_brief.t
    | Ticket_context of Ticket_context.t
    | Tickets of Planning_ticket_wire.Ticket.t Planning_wire.Page.t
    | Readiness of Planning_ticket_wire.Readiness.t
    | Blockers of Planning_ticket_wire.Summary.t Planning_wire.Page.t
    | Resolve of Resolve.t
    | Handoff of Planning_ticket_wire.Handoff.t
    | Handoffs of Planning_ticket_wire.Handoff.t Planning_wire.Page.t

  let encode codec value =
    match Api_codec.encode codec value with
    | Ok json -> json
    | Error problem -> raise (Api_method.Invalid_response ("rich planning view", problem))
  ;;

  let data = function
    | Activity value ->
      encode (Planning_wire.Page.codec Planning_activity_wire.Activity.codec) value
    | Search value -> encode Search.codec value
    | Workspace_overview value -> encode Workspace_overview.codec value
    | Project_brief value -> encode Project_brief.codec value
    | Ticket_context value -> encode Ticket_context.codec value
    | Tickets value ->
      encode (Planning_wire.Page.codec Planning_ticket_wire.Ticket.codec) value
    | Readiness value -> encode Planning_ticket_wire.Readiness.codec value
    | Blockers value ->
      encode (Planning_wire.Page.codec Planning_ticket_wire.Summary.codec) value
    | Resolve value -> encode Resolve.codec value
    | Handoff value -> encode Planning_ticket_wire.Handoff.codec value
    | Handoffs value ->
      encode (Planning_wire.Page.codec Planning_ticket_wire.Handoff.codec) value
  ;;

  let fit t ~workspace_revision ~max_bytes =
    ignore (data t : Jsonaf.t);
    Json.decode (fun () ->
      if workspace_revision < 0 || max_bytes < 4096 || max_bytes > 1048576
      then Json.fail Invalid_argument "invalid planning capture/budget";
      let attempt text_cap item_cap =
        let omitted_fields = ref 0
        and omitted_items = ref 0
        and locations = ref 0
        and details = ref [] in
        let note path kind omitted =
          incr locations;
          if List.length !details < 4
          then
            details
            := Json.obj
                 [ "path", Json.string path
                 ; "kind", Json.string kind
                 ; "omitted", Json.int omitted
                 ]
               :: !details
        in
        let text path value =
          let selected = Query_budget.prefix value ~max_bytes:text_cap in
          let removed = String.length value - String.length selected in
          if removed > 0
          then (
            incr omitted_fields;
            note path "text_bytes" removed);
          selected
        in
        let ticket path (value : Planning_ticket_wire.Ticket.t) =
          { value with
            description = text (path ^ "/description") value.description
          ; acceptance_criteria =
              text (path ^ "/acceptance_criteria") value.acceptance_criteria
          }
        in
        let page
          :  'a.
             path:string
          -> (string -> 'a -> 'a)
          -> 'a Planning_wire.Page.t
          -> 'a Planning_wire.Page.t
          =
          fun ~path map value ->
          let selected = List.take value.items item_cap in
          let removed = List.length value.items - List.length selected in
          if removed > 0
          then (
            omitted_items := !omitted_items + removed;
            note (path ^ "/items") "items" removed);
          let items =
            List.mapi selected ~f:(fun index value ->
              map (path ^ "/items/" ^ Int.to_string index) value)
          in
          let remaining = value.remaining + removed in
          { Planning_wire.Page.items
          ; offset = value.offset
          ; remaining
          ; next_offset =
              (if remaining = 0 then None else Some (value.offset + List.length items))
          }
        in
        let project path (value : Planning_wire.Project.t) =
          { value with
            description = text (path ^ "/description") value.description
          ; summary = text (path ^ "/summary") value.summary
          ; acceptance_criteria =
              text (path ^ "/acceptance_criteria") value.acceptance_criteria
          }
        in
        let milestone path (value : Planning_wire.Milestone.t) =
          { value with description = text (path ^ "/description") value.description }
        in
        let settings path (value : Planning_wire.Workspace_settings.t) =
          { value with
            description = text (path ^ "/description") value.description
          ; instructions = text (path ^ "/instructions") value.instructions
          ; summary = text (path ^ "/summary") value.summary
          }
        in
        let exact _ value = value in
        let communication (value : Communication.t) : Communication.t =
          { threads = page ~path:"/data/communication/threads" exact value.threads
          ; requests = page ~path:"/data/communication/requests" exact value.requests
          }
        in
        let selected =
          match t with
          | Activity value -> Activity (page ~path:"/data" exact value)
          | Search value ->
            Search
              { value with
                results = page ~path:"/data" exact value.results
              ; unindexed_resources =
                  page ~path:"/data/unindexed_resources" exact value.unindexed_resources
              }
          | Workspace_overview value ->
            Workspace_overview
              { value with
                settings = settings "/data/settings" value.settings
              ; active_projects =
                  page ~path:"/data/active_projects" project value.active_projects
              ; held_work = page ~path:"/data/held_work" exact value.held_work
              ; blocked_work = page ~path:"/data/blocked_work" exact value.blocked_work
              ; recent_changes =
                  page ~path:"/data/recent_changes" exact value.recent_changes
              ; resources = page ~path:"/data/resources" exact value.resources
              }
          | Project_brief value ->
            Project_brief
              { value with
                project = project "/data/project" value.project
              ; resources = page ~path:"/data/resources" exact value.resources
              ; communication = communication value.communication
              ; ready_work = page ~path:"/data/ready_work" exact value.ready_work
              ; in_progress_work =
                  page ~path:"/data/in_progress_work" exact value.in_progress_work
              ; blocked_work = page ~path:"/data/blocked_work" exact value.blocked_work
              ; tickets = page ~path:"/data/tickets" ticket value.tickets
              ; milestones = page ~path:"/data/milestones" milestone value.milestones
              }
          | Ticket_context value ->
            let fact_items = List.take value.fact_keys.items item_cap in
            let removed = List.length value.fact_keys.items - List.length fact_items in
            if removed > 0
            then (
              omitted_items := !omitted_items + removed;
              note "/data/fact_keys/items" "items" removed);
            Ticket_context
              { value with
                ticket = ticket "/data/ticket" value.ticket
              ; fact_keys =
                  { value.fact_keys with
                    items = fact_items
                  ; remaining = value.fact_keys.remaining + removed
                  }
              ; related = page ~path:"/data/related" exact value.related
              ; resources = page ~path:"/data/resources" exact value.resources
              ; communication = communication value.communication
              ; attempts = page ~path:"/data/attempts" exact value.attempts
              ; recoveries = page ~path:"/data/recoveries" exact value.recoveries
              ; parent = Option.map value.parent ~f:(ticket "/data/parent")
              ; children = page ~path:"/data/children" ticket value.children
              ; updates = page ~path:"/data/updates" exact value.updates
              ; activity_since_handoff =
                  page
                    ~path:"/data/activity_since_handoff"
                    exact
                    value.activity_since_handoff
              }
          | Tickets value -> Tickets (page ~path:"/data" ticket value)
          | Blockers value -> Blockers (page ~path:"/data" (fun _ value -> value) value)
          | Handoffs value -> Handoffs (page ~path:"/data" (fun _ value -> value) value)
          | Readiness _ | Resolve _ | Handoff _ -> t
        in
        let value = data selected in
        let truncated = !omitted_fields > 0 || !omitted_items > 0 in
        let budget bytes =
          Json.obj
            [ "max_bytes", Json.int max_bytes
            ; "returned_bytes", Json.int bytes
            ; ("truncated", if truncated then `True else `False)
            ; "omitted_fields", Json.int !omitted_fields
            ; "omitted_items", Json.int !omitted_items
            ; "details", `Array (List.rev !details)
            ; ("details_complete", if !locations <= 4 then `True else `False)
            ]
        in
        let rec sized bytes =
          let result =
            Json.obj
              [ "workspace_revision", Json.int workspace_revision
              ; "data", value
              ; "budget", budget bytes
              ]
          in
          let actual = Api_response.encoded_size Planning_read result in
          if actual = bytes then result, actual else sized actual
        in
        sized 0
      in
      let rec choose = function
        | [] ->
          Json.fail
            Invalid_argument
            "first planning record or essential metadata exceeds max_bytes; increase \
             max_bytes or narrow the query"
        | (text_cap, item_cap) :: rest ->
          let result, bytes = attempt text_cap item_cap in
          if bytes <= max_bytes then result else choose rest
      in
      choose
        [ Int.max_value, 100
        ; 32768, 100
        ; 16384, 100
        ; 8192, 100
        ; 4096, 50
        ; 2048, 25
        ; 1024, 10
        ; 512, 5
        ; 128, 1
        ; 0, 1
        ])
  ;;
end
