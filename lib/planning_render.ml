open Core
open Planning_state

let readable_files t =
  let values map = Map.to_sequence map |> Sequence.map ~f:snd in
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
      ( "projects/" ^ Id.Project.to_string p.Project.id ^ ".md"
      , "# "
        ^ p.title
        ^ "\n\n"
        ^ p.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Project.jsonaf_of_t p)
        ^ "\n```\n" ))
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
      let updates =
        Discussion.since
          t.discussion
          ~target:(Entity_ref.Ticket ticket.Ticket.id)
          ~after:0
        |> List.map ~f:(fun update ->
          "\n## Comment revision\n\n```json\n" ^ Json.pretty update ^ "\n```\n")
      in
      let handoff =
        Option.value_map (Map.find t.handoffs ticket.id) ~default:"" ~f:(fun h ->
          "\n## Handoff\n\n"
          ^ h.Handoff.summary
          ^ "\n\nNext steps: "
          ^ h.next_steps
          ^ "\n\nEvidence: "
          ^ h.evidence
          ^ "\n")
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
        ^ String.concat updates ))
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
