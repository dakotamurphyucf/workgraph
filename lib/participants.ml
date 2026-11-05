open Core
open Planning_state
module A = Participant_api
module Source = A.Source
module W = Coordination_wire

let read t request =
  Json.decode (fun () ->
    Option.iter (A.Request.at_revision request) ~f:(fun revision ->
      if revision <> t.revision
      then Json.fail Conflict "participant capture changed; rescan required");
    let rows =
      Workflow.actors t.workflow ~include_archived:true
      |> List.fold ~init:Id.Actor.Map.empty ~f:(fun rows actor ->
        Map.set
          rows
          ~key:actor.id
          ~data:
            { A.Participant.actor_id = actor.id
            ; registration = Some (Planning_wire.Actor.of_domain actor)
            ; observed = None
            ; sources = [ Source.Catalog ]
            })
    in
    let rows =
      List.fold t.activity ~init:rows ~f:(fun rows activity ->
        let actor = Json.field activity "actor" |> Id.Actor.t_of_jsonaf in
        let revision = Json.field activity "revision" |> Json.integer in
        let sources =
          List.filter_map
            (Json.field activity "changes" |> Json.list)
            ~f:(fun json ->
              match Event.t_of_jsonaf json with
              | Facts_changed _ -> Some Source.Fact
              | Comment_changed _ -> Some Comment
              | Communication_changed { update = Request_put _; _ } -> Some Request
              | Agent_run_changed _ -> Some Run
              | Communication_changed _
              | Hierarchy_policy_put _
              | Amendment_changed _
              | Amendment_unchanged _
              | Evidence_changed _
              | Policy_changed _
              | Policy_unchanged _
              | Allocation_empty _
              | Ticket_recovered _
              | Signal_receipt _
              | Settings_changed _
              | Workspace_updated _
              | Project_put _
              | Milestone_put _
              | Ticket_put _
              | Handoff_put _
              | Resource_changed _ -> None)
        in
        Map.update rows actor ~f:(fun prior ->
          let prior =
            Option.value
              prior
              ~default:
                { A.Participant.actor_id = actor
                ; registration = None
                ; observed = None
                ; sources = []
                }
          in
          let observed =
            match prior.observed with
            | None ->
              { A.Observation.first_revision = revision; last_revision = revision }
            | Some observed ->
              { A.Observation.first_revision = Int.min observed.first_revision revision
              ; last_revision = Int.max observed.last_revision revision
              }
          in
          { prior with
            observed = Some observed
          ; sources =
              List.dedup_and_sort
                ((Source.Activity :: sources) @ prior.sources)
                ~compare:Source.compare
          }))
      |> Map.data
    in
    let offset = A.Request.offset request in
    let remaining = List.drop rows offset in
    let selected = List.take remaining (A.Request.limit request) in
    let max_bytes = A.Request.max_bytes request in
    let envelope items =
      let count = List.length items in
      let tail = List.length remaining - count in
      let page =
        { Planning_wire.Page.items
        ; offset
        ; remaining = tail
        ; next_offset = (if tail > 0 then Some (offset + count) else None)
        }
      in
      Json.obj
        [ "workspace_revision", Json.int t.revision
        ; "data", W.encode_exn A.response_codec page
        ]
      |> Query_budget.annotate_whole_items_exn
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items:(List.length selected - count)
    in
    let rec fit count =
      let result = envelope (List.take selected count) in
      if Api_response.encoded_size Planning_read result <= max_bytes
      then result
      else if count > 1
      then fit (count - 1)
      else
        Json.fail
          Invalid_argument
          "participant record exceeds max_bytes; increase the budget"
    in
    fit (List.length selected))
;;
