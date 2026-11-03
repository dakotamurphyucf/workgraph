open Core
open Planning_state

let readable_files t =
  let values map = Map.to_sequence map |> Sequence.map ~f:snd in
  let discussion target =
    Discussion.since t.discussion ~target ~after:0
    |> List.map ~f:(fun version ->
      let field name = Json.field version name |> Json.text in
      "\n## "
      ^ String.capitalize (field "kind")
      ^ " — "
      ^ field "comment_id"
      ^ " (revision "
      ^ field "revision"
      ^ ")\n\nActor: "
      ^ field "actor"
      ^ "; recorded: "
      ^ field "timestamp"
      ^ ".\n\n"
      ^ (if
           Api_codec.decode Api_codec.boolean (Json.field version "tombstone")
           |> Disk.unwrap
         then "_This revision removed the comment._\n"
         else Readable_markdown.literal (field "body"))
      ^ "\n<details><summary>Exact comment version</summary>\n\n"
      ^ Readable_markdown.literal (Json.pretty version)
      ^ "\n</details>\n")
    |> String.concat
  in
  let resources =
    values t.resources
    |> Sequence.map ~f:(fun resource ->
      ( "resources/" ^ Id.Resource.to_string resource.Resource.id ^ ".md"
      , "# "
        ^ resource.metadata.title
        ^ "\n\n"
        ^ resource.metadata.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Resource.jsonaf_of_t resource)
        ^ "\n```\n\n"
        ^ String.concat
            (List.rev_map resource.versions ~f:(fun version ->
               "- Version "
               ^ Int.to_string version.Resource.Version.revision
               ^ ": [bytes]("
               ^ version.digest
               ^ ".bin)\n")) ))
  in
  let projects =
    values t.projects
    |> Sequence.map ~f:(fun p ->
      let handoff =
        Option.value_map p.Project.handoff ~default:"" ~f:(fun handoff ->
          let record = Project_completion.Handoff.jsonaf_of_t handoff in
          let content = Json.field record "content" in
          "\n## Completion handoff\n\n"
          ^ "Actor: "
          ^ (Json.field record "actor_id" |> Json.text)
          ^ "; recorded: "
          ^ (Json.field record "timestamp" |> Json.text)
          ^ "; observed workspace revision: "
          ^ (Json.field record "workspace_revision" |> Json.text)
          ^ ".\n"
          ^ (List.map
               [ "Summary", Json.field content "summary"
               ; "Objective", Json.field content "objective"
               ; "Completed", Json.field content "completed"
               ; "Decisions", Json.field content "decisions"
               ; "Blockers", Json.field content "blockers"
               ; "Next steps", Json.field content "next_steps"
               ; "Evidence and checks", Json.field record "evidence"
               ]
               ~f:(fun (heading, body) ->
                 Readable_markdown.section ~heading (Json.text body))
             |> String.concat)
          ^ "\n### Resources\n\n"
          ^ (Project_completion.Handoff.resource_ids handoff
             |> List.map ~f:(fun id ->
               let id = Id.Resource.to_string id in
               "- [" ^ id ^ "](../resources/" ^ id ^ ".md)\n")
             |> String.concat))
      in
      ( "projects/" ^ Id.Project.to_string p.Project.id ^ ".md"
      , "# "
        ^ p.title
        ^ "\n\n"
        ^ p.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Project.jsonaf_of_t p)
        ^ "\n```\n"
        ^ handoff
        ^ discussion (Entity_ref.Project p.id) ))
  in
  let milestones =
    values t.milestones
    |> Sequence.map ~f:(fun m ->
      ( "milestones/" ^ Id.Milestone.to_string m.Milestone.id ^ ".md"
      , "# "
        ^ m.title
        ^ "\n\n"
        ^ m.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Milestone.jsonaf_of_t m)
        ^ "\n```\n" ))
  in
  let comments =
    Discussion.ids t.discussion
    |> Sequence.map ~f:(fun id ->
      let comment = Discussion.get t.discussion id in
      ( "comments/" ^ Id.Comment.to_string id ^ ".md"
      , "# Comment "
        ^ Id.Comment.to_string id
        ^ "\n\n"
        ^ Json.text (Json.field comment "body")
        ^ "\n\n## Revision history\n\n```json\n"
        ^ Json.pretty (`Array (Discussion.history t.discussion id))
        ^ "\n```\n" ))
  in
  let tickets =
    values t.tickets
    |> Sequence.map ~f:(fun ticket ->
      let handoff =
        Option.value_map (Map.find t.handoffs ticket.id) ~default:"" ~f:(fun h ->
          "\n## Handoff\n\nRevision "
          ^ Int.to_string h.Handoff.revision
          ^ "; actor "
          ^ Id.Actor.to_string h.actor
          ^ "; recorded "
          ^ h.timestamp
          ^ "; covers through workspace revision "
          ^ Int.to_string h.covers_through
          ^ ".\n"
          ^ (List.map
               [ "Summary", h.summary
               ; "Objective", h.objective
               ; "Completed", h.completed
               ; "Decisions", h.decisions
               ; "Blockers", h.blockers
               ; "Next steps", h.next_steps
               ; "Evidence and checks", h.evidence
               ]
               ~f:(fun (heading, body) -> Readable_markdown.section ~heading body)
             |> String.concat)
          ^ "\n### Resources\n\n"
          ^
          if List.is_empty h.resources
          then "_None recorded._\n"
          else
            List.map h.resources ~f:(fun id ->
              let id = Id.Resource.to_string id in
              "- [" ^ id ^ "](../resources/" ^ id ^ ".md)\n")
            |> String.concat)
      in
      ( "tickets/" ^ Id.Ticket.to_string ticket.id ^ ".md"
      , "# "
        ^ ticket.display_key
        ^ " "
        ^ ticket.title
        ^ "\n\n"
        ^ ticket.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Ticket.jsonaf_of_t ticket)
        ^ "\n```\n"
        ^ handoff
        ^ discussion (Entity_ref.Ticket ticket.id) ))
  in
  Sequence.append
    (Sequence.of_lazy
       (lazy
         (Sequence.of_list
            [ "workspace.json", Json.pretty (to_json t) ^ "\n"
            ; ( "communication.json"
              , Json.pretty (Communication.to_json t.communication) ^ "\n" )
            ; "runs.json", Json.pretty (Agent_run.to_json t.agent_runs) ^ "\n"
            ; "evidence.json", Json.pretty (Evidence.to_json t.evidence) ^ "\n"
            ; "policies.json", Json.pretty (Agent_run_policy.to_json t.policies) ^ "\n"
            ; ( "README.md"
              , "# "
                ^ name t
                ^ "\n\nWorkspace revision "
                ^ Int.to_string t.revision
                ^ ".\n" )
            ])))
    (Sequence.of_list
       [ projects
       ; milestones
       ; comments
       ; resources
       ; tickets
       ; Facts.readable_files t.facts
       ]
     |> Sequence.concat)
;;
