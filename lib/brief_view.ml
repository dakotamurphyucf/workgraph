open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let raw fields = Api_codec.as_json (Api_codec.object_ fields)

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let encode codec value = Api_codec.encode codec value |> unwrap
let bool value = if value then `True else `False

let positive =
  W.checked W.counter (fun n ->
    if n = 0 then Json.fail Invalid_argument "positive revision required")
;;

let text n = Api_codec.text ~max_bytes:n
let nullable = Api_codec.nullable
let ticket_id = W.ticket
let resource_id = W.id Id.Resource.of_string Id.Resource.to_string
let comment_id = W.id Id.Comment.of_string Id.Comment.to_string
let project_id = W.id Id.Project.of_string Id.Project.to_string
let milestone_id = W.id Id.Milestone.of_string Id.Milestone.to_string
let workspace_id = W.id Id.Workspace.of_string Id.Workspace.to_string

let status =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

module Excerpt = struct
  type t =
    { text : string
    ; total_bytes : int
    ; omitted_bytes : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (req "text" (text 512)
          ++ req "total_bytes" W.counter
          ++ req "omitted_bytes" W.counter)
         ~decode:(fun ((text, total_bytes), omitted_bytes) ->
           { text; total_bytes; omitted_bytes })
         ~encode:(fun t -> (t.text, t.total_bytes), t.omitted_bytes))
    |> fun codec ->
    W.checked codec (fun t ->
      if
        String.length t.text > t.total_bytes
        || t.omitted_bytes <> t.total_bytes - String.length t.text
      then Json.fail Invalid_argument "excerpt byte counts differ")
  ;;

  let of_text text ~max_bytes =
    let prefix = Query_budget.prefix text ~max_bytes:(Int.min 512 max_bytes) in
    { text = prefix
    ; total_bytes = String.length text
    ; omitted_bytes = String.length text - String.length prefix
    }
  ;;
end

let collection codec ~max_items =
  raw
    (req "items" (Api_codec.list codec ~max_items)
     ++ req "total" W.counter
     ++ req "omitted" W.counter)
  |> fun codec ->
  W.checked codec (fun json ->
    if
      (Json.field json "total" |> Json.integer)
      - List.length (Json.field json "items" |> Json.list)
      <> (Json.field json "omitted" |> Json.integer)
    then Json.fail Invalid_argument "brief collection counts differ")
;;

let same_id json field expansion =
  let source = Json.field json field |> Json.text in
  let target =
    Json.field (Json.field (Json.field json expansion) "params") field |> Json.text
  in
  if not (String.equal source target)
  then Json.fail Invalid_argument "brief expansion identity differs"
;;

let checked_id codec field expansion =
  W.checked codec (fun json -> same_id json field expansion)
;;

let collection_json items ~total =
  Json.obj
    [ "items", `Array items
    ; "total", Json.int total
    ; "omitted", Json.int (total - List.length items)
    ]
;;

let expand_codec method_ selector =
  raw
    (req "method" (Api_codec.literal method_)
     ++ req
          "params"
          (raw
             (req "workspace_id" workspace_id
              ++ selector
              ++
              if String.equal method_ "resource.read"
              then F.empty
              else
                F.map
                  (req "max_bytes" (Api_codec.literal "1048576"))
                  ~decode:(fun () -> ())
                  ~encode:(fun () -> ()))))
;;

let ticket_expand method_ =
  expand_codec method_ (req "ticket_id" ticket_id ++ req "at_revision" W.counter)
;;

let resource_expand =
  expand_codec
    "resource.get"
    (req "resource_id" resource_id ++ req "at_revision" W.counter)
;;

let content_expand =
  expand_codec "resource.read" (req "resource_id" resource_id ++ req "version" positive)
;;

let comment_expand =
  expand_codec
    "comment.history"
    (req "comment_id" comment_id ++ req "at_revision" W.counter)
;;

let expand method_ ~workspace fields =
  Json.obj
    [ "method", Json.string method_
    ; ( "params"
      , Json.obj
          ((("workspace_id", Id.Workspace.jsonaf_of_t workspace) :: fields)
           @
           if String.equal method_ "resource.read"
           then []
           else [ "max_bytes", Json.int 1048576 ]) )
    ]
;;

let ticket_expansion method_ id ~workspace ~workspace_revision =
  expand
    method_
    ~workspace
    [ "ticket_id", Id.Ticket.jsonaf_of_t id; "at_revision", Json.int workspace_revision ]
;;

let resource_expansion id ~workspace ~workspace_revision =
  expand
    "resource.get"
    ~workspace
    [ "resource_id", Id.Resource.jsonaf_of_t id
    ; "at_revision", Json.int workspace_revision
    ]
;;

let hold =
  raw (req "actor_id" W.actor ++ req "timestamp" (text 128) ++ req "reason" Excerpt.codec)
;;

let ticket_head =
  raw
    (req "ticket_id" ticket_id
     ++ req "display_key" (W.nonblank ~max_bytes:128)
     ++ req "revision" positive
     ++ req "membership_revision" positive
     ++ req "title" (W.nonblank ~max_bytes:512)
     ++ req "status" status
     ++ req "priority" (Api_codec.decimal ~max:4)
     ++ req "archived" Api_codec.boolean
     ++ req "project_id" (nullable project_id)
     ++ req "milestone_id" (nullable milestone_id)
     ++ req "parent_ticket_id" (nullable ticket_id)
     ++ req "assignee_id" (nullable W.actor)
     ++ req "claim" (nullable Planning_ticket_wire.Ownership.codec)
     ++ req "hold" (nullable hold)
     ++ req "reopened_token" (nullable positive))
;;

let decision =
  raw
    (req "comment_id" comment_id
     ++ req "revision" positive
     ++ req "serial" positive
     ++ req "actor_id" W.actor
     ++ req "timestamp" (text 128)
     ++ req "body" Excerpt.codec
     ++ req "expand" comment_expand)
  |> fun codec -> checked_id codec "comment_id" "expand"
;;

let handoff =
  raw
    (req "revision" positive
     ++ req "covers_through" W.counter
     ++ req "actor_id" W.actor
     ++ req "timestamp" (text 128)
     ++ req "summary" Excerpt.codec
     ++ req "next_steps" Excerpt.codec
     ++ req "decisions" Excerpt.codec
     ++ req "resource_count" W.counter
     ++ req "expand" (ticket_expand "handoff.get"))
;;

let resource_ref =
  raw
    (req "resource_id" resource_id
     ++ req "entity_revision" positive
     ++ req "title" (W.nonblank ~max_bytes:512)
     ++ req "content_version" positive
     ++ req "digest" Resource_wire.digest
     ++ req "size_bytes" (nullable (Api_codec.decimal ~max:Resource.max_blob_bytes))
     ++ req "expand" resource_expand)
  |> fun codec ->
  W.checked codec (fun json ->
    same_id json "resource_id" "expand";
    if
      Json.field json "entity_revision"
      |> Json.integer
      < (Json.field json "content_version" |> Json.integer)
    then Json.fail Invalid_argument "content version exceeds entity revision")
;;

let ticket_codec =
  raw
    (req "representation" (Api_codec.literal "brief")
     ++ req "ticket" ticket_head
     ++ req "description" Excerpt.codec
     ++ req "acceptance_criteria" Excerpt.codec
     ++ req "observed_unix_ms" (nullable (Api_codec.decimal64 ~max:Int64.max_value))
     ++ req "ready" Api_codec.boolean
     ++ req "readiness_reason_count" W.counter
     ++ req "handoff" (nullable handoff)
     ++ req "decision_comments" (collection decision ~max_items:5)
     ++ req "resources" (collection resource_ref ~max_items:8)
     ++ req "expand" (ticket_expand "ticket.context")
     ++ req "readiness_expand" (ticket_expand "ticket.readiness"))
  |> fun codec ->
  W.checked codec (fun json ->
    let count = Json.field json "readiness_reason_count" |> Json.integer in
    if
      not
        (Bool.equal
           (match Json.field json "ready" with
            | `True -> true
            | _ -> false)
           (count = 0))
    then Json.fail Invalid_argument "brief readiness count mismatch";
    let id = Json.field (Json.field json "ticket") "ticket_id" |> Json.text in
    List.iter [ "expand"; "readiness_expand" ] ~f:(fun field ->
      let selected =
        Json.field (Json.field (Json.field json field) "params") "ticket_id" |> Json.text
      in
      if not (String.equal id selected)
      then Json.fail Invalid_argument "brief ticket expansion differs");
    let notes = Json.field (Json.field json "decision_comments") "items" |> Json.list in
    if
      (not
         (List.is_sorted_strictly notes ~compare:(fun a b ->
            Int.compare
              (Json.field b "serial" |> Json.integer)
              (Json.field a "serial" |> Json.integer))))
      || List.contains_dup notes ~compare:(fun a b ->
        String.compare
          (Json.field a "comment_id" |> Json.text)
          (Json.field b "comment_id" |> Json.text))
    then
      Json.fail Invalid_argument "brief decisions must be distinct in recent serial order")
;;

let resource_codec =
  raw
    (req "representation" (Api_codec.literal "brief")
     ++ req "resource_id" resource_id
     ++ req "entity_revision" positive
     ++ req "title" (W.nonblank ~max_bytes:512)
     ++ req "filename" (text 255)
     ++ req "mime_type" (text 128)
     ++ req "archived" Api_codec.boolean
     ++ req "description" Excerpt.codec
     ++ req "current_version" Resource_wire.version
     ++ req "targets" (collection Evidence_wire.entity_ref ~max_items:8)
     ++ req "expand" resource_expand
     ++ req "content_expand" content_expand)
  |> fun codec ->
  W.checked codec (fun json ->
    same_id json "resource_id" "expand";
    same_id json "resource_id" "content_expand";
    let version =
      Json.field (Json.field json "current_version") "revision" |> Json.integer
    in
    if
      version > (Json.field json "entity_revision" |> Json.integer)
      || version
         <> (Json.field (Json.field (Json.field json "content_expand") "params") "version"
             |> Json.integer)
    then Json.fail Invalid_argument "brief resource version differs")
;;

module Ticket = struct
  type t =
    { ticket : Planning_ticket_wire.Ticket.t
    ; observed_unix_ms : int64 option
    ; ready : bool
    ; readiness_reason_count : int
    ; handoff : Planning_ticket_wire.Handoff.t option
    ; decisions : Jsonaf.t list
    ; resources : Resource.t list
    }
end

let response data ~workspace_revision ~max_bytes ~omitted_items =
  Json.obj [ "workspace_revision", Json.int workspace_revision; "data", data ]
  |> Query_budget.annotate_whole_items_exn
       ~measure:(Api_response.encoded_size Planning_read)
       ~max_bytes
       ~omitted_items
;;

let fit ~max_bytes build =
  let rec loop notes resources prose =
    let result = build ~notes ~resources ~prose in
    if Api_response.encoded_size Planning_read result <= max_bytes
    then result
    else if resources > 0
    then loop notes (resources - 1) prose
    else if notes > 0
    then loop (notes - 1) 0 prose
    else if prose > 0
    then loop 0 0 (prose / 2)
    else
      Json.fail
        Invalid_argument
        "brief identity metadata exceeds budget; increase max_bytes"
  in
  if max_bytes < 4096 || max_bytes > 1048576
  then Json.fail Invalid_argument "brief budget must be 4096..1048576";
  loop 5 8 512
;;

let excerpt prose text = encode Excerpt.codec (Excerpt.of_text text ~max_bytes:prose)

let resource_reference r ~workspace ~workspace_revision =
  Resource.validate r;
  let v = Resource.get_version r ~revision:None in
  Json.obj
    [ "resource_id", Id.Resource.jsonaf_of_t r.id
    ; "entity_revision", Json.int r.revision
    ; "title", Json.string r.metadata.title
    ; "content_version", Json.int v.revision
    ; "digest", Json.string v.digest
    ; "size_bytes", Option.value_map v.size_bytes ~default:`Null ~f:Json.int
    ; "expand", resource_expansion r.id ~workspace ~workspace_revision
    ]
;;

let ticket input ~workspace ~workspace_revision ~max_bytes =
  Json.decode (fun () ->
    let t = input.Ticket.ticket in
    let notes =
      List.sort input.decisions ~compare:(fun a b ->
        Int.compare
          (Json.field b "serial" |> Json.integer)
          (Json.field a "serial" |> Json.integer))
    in
    List.iter notes ~f:(fun json ->
      ignore (Api_codec.decode Discussion_wire.comment json |> unwrap : Jsonaf.t);
      if
        (not (String.equal (Json.field json "kind" |> Json.text) "decision"))
        ||
        match Json.field json "tombstone" with
        | `True -> true
        | _ -> false
      then Json.fail Invalid_argument "brief requires live decision comments";
      let target =
        Api_codec.decode Planning_target.codec (Json.field json "target")
        |> unwrap
        |> Planning_target.to_ref
        |> unwrap
      in
      if not (Entity_ref.equal target (Entity_ref.Ticket t.ticket_id))
      then Json.fail Invalid_argument "brief decision belongs to another ticket");
    fit ~max_bytes (fun ~notes:note_limit ~resources:resource_limit ~prose ->
      let hold =
        Option.value_map t.hold ~default:`Null ~f:(fun h ->
          Json.obj
            [ "actor_id", Id.Actor.jsonaf_of_t h.actor_id
            ; "timestamp", Json.string h.timestamp
            ; "reason", excerpt prose h.reason
            ])
      in
      let head =
        Json.obj
          [ "ticket_id", Id.Ticket.jsonaf_of_t t.ticket_id
          ; "display_key", Json.string t.display_key
          ; "revision", Json.int t.revision
          ; "membership_revision", Json.int t.membership_revision
          ; "title", Json.string t.title
          ; "status", encode status t.status
          ; "priority", Json.int t.priority
          ; "archived", bool t.archived
          ; ( "project_id"
            , Option.value_map t.project_id ~default:`Null ~f:Id.Project.jsonaf_of_t )
          ; ( "milestone_id"
            , Option.value_map t.milestone_id ~default:`Null ~f:Id.Milestone.jsonaf_of_t )
          ; ( "parent_ticket_id"
            , Option.value_map t.parent_ticket_id ~default:`Null ~f:Id.Ticket.jsonaf_of_t
            )
          ; ( "assignee_id"
            , Option.value_map t.assignee_id ~default:`Null ~f:Id.Actor.jsonaf_of_t )
          ; ( "claim"
            , Option.value_map
                t.claim
                ~default:`Null
                ~f:(encode Planning_ticket_wire.Ownership.codec) )
          ; "hold", hold
          ; "reopened_token", Option.value_map t.reopened_token ~default:`Null ~f:Json.int
          ]
      in
      let handoff =
        Option.value_map input.handoff ~default:`Null ~f:(fun h ->
          Json.obj
            [ "revision", Json.int h.revision
            ; "covers_through", Json.int h.covers_through
            ; "actor_id", Id.Actor.jsonaf_of_t h.actor_id
            ; "timestamp", Json.string h.timestamp
            ; "summary", excerpt prose h.summary
            ; "next_steps", excerpt prose h.next_steps
            ; "decisions", excerpt prose h.decisions
            ; "resource_count", Json.int (List.length h.resource_ids)
            ; ( "expand"
              , ticket_expansion "handoff.get" t.ticket_id ~workspace ~workspace_revision
              )
            ])
      in
      let selected_notes =
        List.take notes note_limit
        |> List.map ~f:(fun json ->
          let id = Json.field json "comment_id" in
          Json.obj
            [ "comment_id", id
            ; "revision", Json.field json "revision"
            ; "serial", Json.field json "serial"
            ; "actor_id", Json.field json "actor_id"
            ; "timestamp", Json.field json "timestamp"
            ; "body", excerpt prose (Json.field json "body" |> Json.text)
            ; ( "expand"
              , expand
                  "comment.history"
                  ~workspace
                  [ "comment_id", id; "at_revision", Json.int workspace_revision ] )
            ])
      in
      let selected_resources =
        List.take input.resources resource_limit
        |> List.map ~f:(fun r -> resource_reference r ~workspace ~workspace_revision)
      in
      let data =
        Json.obj
          [ "representation", Json.string "brief"
          ; "ticket", head
          ; "description", excerpt prose t.description
          ; "acceptance_criteria", excerpt prose t.acceptance_criteria
          ; ( "observed_unix_ms"
            , Option.value_map input.observed_unix_ms ~default:`Null ~f:Json.int64 )
          ; "ready", bool input.ready
          ; "readiness_reason_count", Json.int input.readiness_reason_count
          ; "handoff", handoff
          ; "decision_comments", collection_json selected_notes ~total:(List.length notes)
          ; ( "resources"
            , collection_json selected_resources ~total:(List.length input.resources) )
          ; ( "expand"
            , ticket_expansion "ticket.context" t.ticket_id ~workspace ~workspace_revision
            )
          ; ( "readiness_expand"
            , ticket_expansion
                "ticket.readiness"
                t.ticket_id
                ~workspace
                ~workspace_revision )
          ]
      in
      ignore (Api_codec.decode ticket_codec data |> unwrap : Jsonaf.t);
      response
        data
        ~workspace_revision
        ~max_bytes
        ~omitted_items:
          (List.length notes
           - List.length selected_notes
           + List.length input.resources
           - List.length selected_resources)))
;;

let resource r ~workspace ~workspace_revision ~max_bytes =
  Json.decode (fun () ->
    Resource.validate r;
    let v = Resource.get_version r ~revision:None in
    fit ~max_bytes (fun ~notes:_ ~resources:limit ~prose ->
      let targets =
        List.take r.metadata.targets limit
        |> List.map ~f:(encode Evidence_wire.entity_ref)
      in
      let data =
        Json.obj
          [ "representation", Json.string "brief"
          ; "resource_id", Id.Resource.jsonaf_of_t r.id
          ; "entity_revision", Json.int r.revision
          ; "title", Json.string r.metadata.title
          ; "filename", Json.string r.metadata.filename
          ; "mime_type", Json.string r.metadata.mime_type
          ; "archived", bool r.metadata.archived
          ; "description", excerpt prose r.metadata.description
          ; "current_version", encode Resource_wire.version v
          ; "targets", collection_json targets ~total:(List.length r.metadata.targets)
          ; "expand", resource_expansion r.id ~workspace ~workspace_revision
          ; ( "content_expand"
            , expand
                "resource.read"
                ~workspace
                [ "resource_id", Id.Resource.jsonaf_of_t r.id
                ; "version", Json.int v.revision
                ] )
          ]
      in
      ignore (Api_codec.decode resource_codec data |> unwrap : Jsonaf.t);
      response
        data
        ~workspace_revision
        ~max_bytes
        ~omitted_items:(List.length r.metadata.targets - List.length targets)))
;;
