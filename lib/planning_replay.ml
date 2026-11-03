open Core
open Planning_state

module Claim_path_transition = struct
  type t =
    | Reserved of Reservation.Claim.t
    | Released of Reservation.Claim.t
end

let apply_event t = function
  | Event.Facts_changed change ->
    require
      (Int.equal (Facts.Change.sequence change) (t.revision + 1))
      Corrupt_store
      "fact sequence differs from transaction";
    { t with facts = unwrap_domain (Facts.apply t.facts change) }
  | Event.Hierarchy_policy_put definition ->
    let ticket = Hierarchy_policy.Definition.ticket definition in
    ignore (find_ticket t ticket : Ticket.t);
    let prior_revision =
      Option.value_map
        (Map.find t.hierarchy_policies ticket)
        ~default:0
        ~f:Hierarchy_policy.Definition.revision
    in
    expected (Hierarchy_policy.Definition.revision definition) (prior_revision + 1);
    { t with
      hierarchy_policies = Map.set t.hierarchy_policies ~key:ticket ~data:definition
    }
  | Event.Amendment_changed change ->
    (match change.Ticket_amendment.Change.update with
     | Revisions records ->
       List.iter records ~f:(fun record ->
         let ticket = find_ticket t record.Ticket_amendment.Revision.ticket in
         Option.iter record.attribution.run ~f:(fun run ->
           unwrap_domain (validate_run_actor t ~run ~actor:record.attribution.actor));
         match record.content with
         | Published { require_ack = true; _ } ->
           require
             (not (Domain_command.Status.equal ticket.status Done))
             Blocked
             "reopen completed ticket before publishing required amendment"
         | Published _ | Withdrawn _ | Superseded _ -> ())
     | Acknowledged ack ->
       let ticket = find_ticket t ack.ticket in
       check_claim
         ticket
         ~actor:ack.ownership.actor
         ~run:ack.ownership.run
         ~token:ack.ownership.token;
       let claim = Option.value_exn ticket.claim in
       unwrap_domain
         (Ticket_amendment.Acknowledgement.validate_lease ack ~lease:claim.lease));
    { t with
      amendments =
        unwrap_domain
          (Ticket_amendment.apply t.amendments change ~ownership:(amendment_ownership t))
    }
  | Event.Amendment_unchanged ack ->
    let ticket = find_ticket t ack.ticket in
    check_claim
      ticket
      ~actor:ack.ownership.actor
      ~run:ack.ownership.run
      ~token:ack.ownership.token;
    unwrap_domain
      (Ticket_amendment.Acknowledgement.validate_lease
         ack
         ~lease:(Option.value_exn ticket.claim).lease);
    let prepared =
      Ticket_amendment.prepare
        t.amendments
        (Acknowledge
           { amendment = ack.amendment; ticket = ack.ticket; token = ack.ownership.token })
        ~actor:ack.ownership.actor
        ~run:ack.ownership.run
        ~timestamp:ack.timestamp
        ~now_unix_ms:ack.observed_unix_ms
        ~ownership:(amendment_ownership t)
      |> unwrap_domain
    in
    require
      (List.is_empty (Ticket_amendment.changes prepared))
      Corrupt_store
      "amendment unchanged marker lacks prior exact acknowledgement";
    t
  | Event.Policy_changed change ->
    (match Agent_run_policy.apply t.policies change with
     | Ok policies -> { t with policies }
     | Error error -> raise (Json.Decode_error error))
  | Event.Policy_unchanged change ->
    let p =
      match Agent_run_policy.prepare t.policies change.command with
      | Ok p -> p
      | Error error -> raise (Json.Decode_error error)
    in
    require
      (List.is_empty (Agent_run_policy.changes p)
       && Int.equal
            change.revision
            (Json.integer (Json.field (Agent_run_policy.result p) "revision")))
      Corrupt_store
      "policy no-op is not an identical duplicate";
    t
  | Event.Allocation_empty _ -> t
  | Event.Agent_run_changed change ->
    (match change.Agent_run.Change.update with
     | Ownership_recovered { recovery; _ } ->
       require
         (not (Map.mem t.ticket_recoveries recovery.request.recovery_id))
         Conflict
         "Recovery ID already exists"
     | _ -> ());
    (match change.Agent_run.Change.update with
     | Attempt_put attempt | Attempt_started { attempt; _ } ->
       if Attempt.State.equal attempt.state Completed
       then check_amendments_complete t (find_ticket t attempt.ticket);
       if Option.is_none (Agent_run.get_attempt t.agent_runs attempt.id)
       then (
         check_prerequisites t (find_ticket t attempt.ticket);
         check_claim
           (find_ticket t attempt.ticket)
           ~actor:change.actor
           ~run:change.actor_run
           ~token:attempt.token;
         unwrap_domain
           (Acquisition.ensure
              t
              ~ticket:(find_ticket t attempt.ticket)
              ~actor:change.actor
              ~run:change.actor_run
              ~intent:Attempt))
     | Claim_paths_reserved { claim; previous_claim; _ } ->
       let ticket = find_ticket t claim.ticket in
       let exact (old : Claim.t) reference =
         Int.equal old.token reference.Reservation.Claim.token
         && Id.Actor.equal old.actor reference.actor
         && Option.equal Id.Run.equal old.run_id (Some reference.run)
       in
       let retained =
         Option.value_map ticket.claim ~default:false ~f:(fun old -> exact old claim)
       in
       require
         (retained || Int.equal claim.token ticket.next_token)
         Corrupt_store
         "Path borrower is not the exact current or next ticket claim";
       if retained || Option.is_none ticket.claim
       then
         require
           (Id.Actor.equal change.actor claim.actor
            && Option.equal Id.Run.equal change.actor_run (Some claim.run))
           Corrupt_store
           "Path reservation invocation differs from claim owner";
       let expected_previous =
         if retained
         then None
         else
           Option.bind ticket.claim ~f:(fun old ->
             Option.map old.run_id ~f:(fun run ->
               { Reservation.Claim.ticket = ticket.id
               ; token = old.token
               ; actor = old.actor
               ; run
               }))
       in
       require
         (Option.equal Reservation.Claim.equal previous_claim expected_previous)
         Corrupt_store
         "Path borrower transfer differs from the exact previous claim";
       if not retained
       then
         require
           (List.for_all
              (Agent_run.attempts_for_ticket t.agent_runs ticket.id)
              ~f:(fun a -> Attempt.State.terminal a.Attempt.state))
           Conflict
           "Cannot transfer paths from an active ticket attempt";
       unwrap_domain
         (Acquisition.ensure
            t
            ~ticket
            ~actor:claim.actor
            ~run:(Some claim.run)
            ~intent:
              (if retained
               then Attempt
               else if Option.is_some ticket.claim
               then Reassign
               else Claim))
     | Claim_paths_released { claim; _ } ->
       let ticket = find_ticket t claim.ticket in
       require
         (Option.value_map ticket.claim ~default:false ~f:(fun old ->
            Int.equal old.token claim.token
            && Id.Actor.equal old.actor claim.actor
            && Option.equal Id.Run.equal old.run_id (Some claim.run)))
         Corrupt_store
         "Released path borrower differs from current exact claim"
     | Ticket_paths_put paths ->
       require
         (Option.is_none (find_ticket t paths.ticket_id).claim
          && List.for_all
               (Agent_run.attempts_for_ticket t.agent_runs paths.ticket_id)
               ~f:(fun a -> Attempt.State.terminal a.Attempt.state))
         Conflict
         "Cannot change required paths while ticket has a claim or active attempt"
     | Ticket_policy_put policy ->
       require
         (Option.is_none (find_ticket t policy.ticket).claim)
         Conflict
         "Cannot change allocation policy while ticket has a claim"
     | Run_put _
     | Reservation_put _
     | Actions_set _
     | Pool_put _
     | Path_reservation_put _
     | External_condition_changed _
     | Ownership_recovered _ -> ());
    (match Agent_run.apply t.agent_runs change with
     | Ok agent_runs -> { t with agent_runs }
     | Error error -> raise (Json.Decode_error error))
  | Event.Evidence_changed change ->
    let active_owner id =
      let attempt =
        match Agent_run.get_attempt t.agent_runs id with
        | Some attempt -> attempt
        | None -> Json.fail Not_found "evidence consumer attempt not found"
      in
      validate_active_attempt_owner
        t
        attempt
        ~actor:change.attribution.actor
        ~run:change.attribution.run
    in
    (match change.Evidence.Change.update with
     | Manifest_put manifest -> active_owner manifest.attempt
     | Submission_put submission ->
       let manifest =
         match Evidence.get_manifest t.evidence submission.manifest with
         | Some manifest -> manifest
         | None -> Json.fail Not_found "submission manifest not found"
       in
       active_owner manifest.attempt
     | Assertion_added assertion -> Option.iter assertion.attempt ~f:active_owner
     | Reconciliation_put reconciliation ->
       let attempt =
         match Agent_run.get_attempt t.agent_runs reconciliation.attempt with
         | Some attempt -> attempt
         | None -> Json.fail Not_found "reconciliation consumer attempt not found"
       in
       if Attempt.State.terminal attempt.state
       then (
         match reconciliation.state with
         | Acknowledged _ | Continued _ ->
           validate_terminal_reconciliation_owner
             t
             attempt
             ~actor:change.attribution.actor
             ~run:change.attribution.run
         | Pending | Revised _ ->
           Json.fail Stale_claim "terminal consumer cannot revise reconciliation inputs")
       else active_owner attempt.id
     | Contract_put _
     | Policy_put _
     | Review_added _
     | Validation_added _
     | Decision_put _
     | Input_changed _ -> ());
    (match
       Evidence.apply t.evidence ~ticket_context:(evidence_ticket_context t) change
     with
     | Ok evidence -> { t with evidence }
     | Error error -> raise (Json.Decode_error error))
  | Event.Communication_changed change ->
    (match Communication.apply t.communication ~discussion:t.discussion change with
     | Ok communication -> { t with communication }
     | Error error -> raise (Json.Decode_error error))
  | Event.Settings_changed change ->
    { t with workflow = Workflow.apply t.workflow change }
  | Workspace_updated settings ->
    expected settings.revision (t.settings.revision + 1);
    { t with settings }
  | Project_put p ->
    let previous = Map.find t.projects p.id in
    let revision =
      Option.value_map previous ~default:0 ~f:(fun old -> old.Project.revision)
    in
    expected p.revision (revision + 1);
    let prior_handoff = Option.bind previous ~f:(fun old -> old.Project.handoff) in
    require
      (Option.is_none prior_handoff || Option.is_some p.handoff)
      Corrupt_store
      "project completion handoff cannot be discarded";
    if not (Option.equal Project_completion.Handoff.equal prior_handoff p.handoff)
    then (
      require
        (Option.is_some previous && Domain_command.Status.equal p.status Done)
        Corrupt_store
        "project handoff requires an existing completed project";
      Option.iter p.handoff ~f:(fun handoff ->
        require
          (Project_completion.Handoff.project_revision handoff = p.revision)
          Corrupt_store
          "new project handoff revision differs"));
    if
      Domain_command.Status.equal p.status Done
      && (Option.is_none previous
          || (not
                (Option.value_map previous ~default:false ~f:(fun old ->
                   Domain_command.Status.equal old.Project.status Done)))
          || not (Option.equal Project_completion.Handoff.equal prior_handoff p.handoff))
    then check_project_complete t p;
    { t with projects = Map.set t.projects ~key:p.id ~data:p }
  | Milestone_put milestone ->
    let previous =
      Option.value_map (Map.find t.milestones milestone.id) ~default:0 ~f:(fun m ->
        m.Milestone.revision)
    in
    expected milestone.revision (previous + 1);
    { t with milestones = Map.set t.milestones ~key:milestone.id ~data:milestone }
  | Signal_receipt _ -> t
  | Ticket_recovered recovery ->
    let request = recovery.Ticket_recovery.request in
    require (recovery.sequence = t.revision + 1) Corrupt_store "Recovery sequence differs";
    require
      ((not (Map.mem t.ticket_recoveries request.recovery_id))
       && Option.is_none (Agent_run.get_recovery t.agent_runs request.recovery_id))
      Conflict
      "Recovery ID already exists";
    let ticket = find_ticket t request.ticket_id in
    let recovered_ticket = ticket_after_recovery_exn ticket ~recovery in
    let agent_runs =
      unwrap_domain (Agent_run.cancel_recovered_attempts t.agent_runs request)
    in
    let agent_runs =
      Option.value_map ticket.claim ~default:agent_runs ~f:(fun claim ->
        Option.value_map claim.run_id ~default:agent_runs ~f:(fun run ->
          let checked =
            unwrap_domain
              (Agent_run.release_claim_reservations
                 agent_runs
                 { Reservation.Claim.ticket = ticket.id
                 ; token = claim.token
                 ; actor = claim.actor
                 ; run
                 })
          in
          require
            (Int.equal (Agent_run.revision checked) (Agent_run.revision agent_runs))
            Corrupt_store
            "Ticket recovery lacks explicit automatic path cleanup";
          agent_runs))
    in
    let ticket = recovered_ticket in
    { t with
      agent_runs
    ; tickets = Map.set t.tickets ~key:ticket.id ~data:ticket
    ; ticket_recoveries =
        Map.set t.ticket_recoveries ~key:request.recovery_id ~data:recovery
    }
  | Ticket_put ticket ->
    if Domain_command.Status.equal ticket.status Done
    then
      Option.iter (Map.find t.tickets ticket.id) ~f:(fun previous ->
        if not (Domain_command.Status.equal previous.Ticket.status Done)
        then check_amendments_complete t previous);
    let display_key =
      Option.value_map
        (Map.find t.tickets ticket.id)
        ~default:("WG-" ^ Int.to_string (Map.length t.tickets + 1))
        ~f:(fun old -> old.Ticket.display_key)
    in
    require
      (String.equal ticket.display_key display_key)
      Corrupt_store
      "ticket display key changed or was allocated out of sequence";
    if not (Map.mem t.tickets ticket.id)
    then (
      require
        (ticket.membership_revision = 1
         && Domain_command.Status.equal ticket.status Todo
         && Option.is_none ticket.claim
         && Option.is_none ticket.reopened_token
         && List.is_empty ticket.reassessments)
        Corrupt_store
        "new ticket must be unclaimed todo without reopening history";
      require
        (Int.equal ticket.created_order (Map.length t.tickets + 1))
        Corrupt_store
        "ticket creation order is not consecutive";
      Option.iter ticket.claim ~f:(validate_new_claim_run t));
    Option.iter (Map.find t.tickets ticket.id) ~f:(fun previous ->
      require
        (ticket.membership_revision
         = previous.Ticket.membership_revision
           +
           if Option.equal Id.Project.equal ticket.project previous.project then 0 else 1
        )
        Corrupt_store
        "ticket membership revision does not match project change";
      let old_count = List.length previous.Ticket.reassessments in
      require
        (List.equal
           String.equal
           (List.map previous.reassessments ~f:(fun r ->
              Json.canonical (Reassessment.jsonaf_of_t r)))
           (List.take ticket.reassessments old_count
            |> List.map ~f:(fun r -> Json.canonical (Reassessment.jsonaf_of_t r))))
        Corrupt_store
        "reassessment history changed";
      let added = List.drop ticket.reassessments old_count in
      List.iter added ~f:(fun r ->
        require
          (Int.equal r.Reassessment.reopened_revision (t.revision + 1))
          Corrupt_store
          "reassessment sequence differs";
        require
          (not (String.is_empty (String.strip r.reason)))
          Corrupt_store
          "reassessment requires reason";
        if not (Id.Ticket.equal r.prerequisite ticket.id)
        then (
          require
            (List.mem ticket.prerequisites r.prerequisite ~equal:Id.Ticket.equal
             && not (waived ticket r.prerequisite))
            Corrupt_store
            "reassessment prerequisite is absent or waived";
          let source = find_ticket t r.prerequisite in
          require
            (List.exists source.reassessments ~f:(fun reopening ->
               Id.Ticket.equal reopening.Reassessment.prerequisite source.id
               && Int.equal reopening.reopened_revision r.reopened_revision
               && String.equal reopening.reason r.reason
               && Id.Actor.equal reopening.actor r.actor
               && String.equal reopening.timestamp r.timestamp))
            Corrupt_store
            "reassessment source reopening not found"));
      let reopening =
        List.filter added ~f:(fun r ->
          Id.Ticket.equal r.Reassessment.prerequisite ticket.id)
      in
      let transitions_from_done =
        Domain_command.Status.equal previous.status Done
        && not (Domain_command.Status.equal ticket.status Done)
      in
      if transitions_from_done
      then (
        require
          (Domain_command.Status.equal ticket.status Todo
           && Option.is_none ticket.claim
           && List.length reopening = 1)
          Corrupt_store
          "completed ticket requires explicit reopening";
        require
          (Option.equal Int.equal ticket.reopened_token (Some previous.next_token))
          Corrupt_store
          "reopening freshness differs")
      else
        require
          (List.is_empty reopening
           && Option.equal Int.equal ticket.reopened_token previous.reopened_token)
          Corrupt_store
          "unexpected reopening history";
      require
        (ticket.next_token >= previous.Ticket.next_token)
        Corrupt_store
        "claim token counter moved backwards";
      require
        (String.equal ticket.created_at previous.created_at)
        Corrupt_store
        "ticket creation time changed";
      require
        (Int.equal ticket.created_sequence previous.created_sequence)
        Corrupt_store
        "ticket creation sequence changed";
      require
        (Int.equal ticket.created_order previous.created_order)
        Corrupt_store
        "ticket creation order changed";
      Option.iter ticket.claim ~f:(fun claim ->
        let unchanged =
          Option.value_map previous.claim ~default:false ~f:(fun old ->
            Id.Actor.equal old.Claim.actor claim.actor
            && Option.equal Id.Run.equal old.run_id claim.run_id
            && Int.equal old.token claim.token)
        in
        require
          (unchanged || claim.token >= previous.next_token)
          Corrupt_store
          "claim token was reused";
        if unchanged
        then (
          let old = Option.value_exn previous.claim in
          if not (Allocation_lease.equal old.lease claim.lease)
          then (
            let renewed =
              match
                Allocation_lease.renew
                  old.lease
                  ~expected_revision:(Allocation_lease.revision old.lease)
                  ~epoch:old.token
                  ~now_unix_ms:(Allocation_lease.last_unix_ms claim.lease)
              with
              | Ok value -> value
              | Error _ -> Json.fail Corrupt_store "invalid claim lease renewal"
            in
            require
              (Allocation_lease.equal renewed claim.lease)
              Corrupt_store
              "claim lease renewal payload differs"))
        else (
          check_prerequisites t ticket;
          validate_new_claim_run t claim;
          unwrap_domain
            (Acquisition.ensure
               t
               ~ticket
               ~actor:claim.actor
               ~run:claim.run_id
               ~intent:(if Option.is_some previous.claim then Reassign else Claim));
          require
            (List.is_empty
               (Agent_run.start_blockers
                  t.agent_runs
                  ~ticket:ticket.id
                  ~run:claim.run_id
                  ~now_unix_ms:(Allocation_lease.last_unix_ms claim.lease)))
            Blocked
            "Claim coordination requirements are unsatisfied";
          Option.iter claim.run_id ~f:(fun run ->
            let prepared =
              unwrap_domain
                (Agent_run.prepare_start_reservations
                   t.agent_runs
                   ~claim:
                     { Reservation.Claim.ticket = ticket.id
                     ; run
                     ; actor = claim.actor
                     ; token = claim.token
                     }
                   ~previous_claim:None
                   ~actor:claim.actor
                   ~run:(Some run)
                   ~timestamp:ticket.updated_at
                   ~sequence:(t.revision + 1)
                   ~now_unix_ms:(Allocation_lease.last_unix_ms claim.lease))
            in
            require
              (List.is_empty (Agent_run.changes prepared))
              Corrupt_store
              "Claim lacks atomic required path grants");
          require
            (Int.equal (Allocation_lease.revision claim.lease) 1)
            Corrupt_store
            "new claim lease revision must start at one")));
    let previous =
      Option.value_map (Map.find t.tickets ticket.id) ~default:0 ~f:(fun t ->
        t.Ticket.revision)
    in
    expected ticket.revision (previous + 1);
    let agent_runs =
      Option.value_map (Map.find t.tickets ticket.id) ~default:t.agent_runs ~f:(fun old ->
        Option.value_map old.claim ~default:t.agent_runs ~f:(fun claim ->
          let retained =
            Option.value_map ticket.claim ~default:false ~f:(fun next ->
              Int.equal claim.token next.token
              && Id.Actor.equal claim.actor next.actor
              && Option.equal Id.Run.equal claim.run_id next.run_id)
          in
          if retained
          then t.agent_runs
          else
            Option.value_map claim.run_id ~default:t.agent_runs ~f:(fun run ->
              let checked =
                unwrap_domain
                  (Agent_run.release_claim_reservations
                     t.agent_runs
                     { Reservation.Claim.ticket = ticket.id
                     ; token = claim.token
                     ; actor = claim.actor
                     ; run
                     })
              in
              require
                (Int.equal (Agent_run.revision checked) (Agent_run.revision t.agent_runs))
                Corrupt_store
                "Claim exit lacks explicit automatic path cleanup";
              t.agent_runs)))
    in
    { t with
      agent_runs
    ; tickets = Map.set t.tickets ~key:ticket.id ~data:ticket
    ; ticket_keys = Map.set t.ticket_keys ~key:display_key ~data:ticket.id
    }
  | Comment_changed change ->
    { t with
      discussion = Discussion.apply t.discussion change ~sequence:(t.revision + 1)
    }
  | Handoff_put handoff ->
    ignore (find_ticket t handoff.ticket : Ticket.t);
    bounded handoff.summary 65_536;
    bounded handoff.next_steps 65_536;
    bounded handoff.evidence 65_536;
    List.iter
      [ handoff.objective; handoff.completed; handoff.decisions; handoff.blockers ]
      ~f:(fun text -> bounded text 65_536);
    bounded handoff.timestamp 128;
    require
      (handoff.covers_through >= 0 && handoff.covers_through <= t.revision)
      Conflict
      "handoff cursor is ahead of observed state";
    let previous =
      Option.value_map (Map.find t.handoffs handoff.ticket) ~default:0 ~f:(fun h ->
        h.Handoff.revision)
    in
    expected handoff.revision (previous + 1);
    { t with handoffs = Map.set t.handoffs ~key:handoff.ticket ~data:handoff }
  | Resource_changed change ->
    (match change with
     | Resource.Change.Published { version; _ } ->
       require
         (Option.is_some version.size_bytes)
         Corrupt_store
         "published resource requires byte size"
     | Metadata_changed _ -> ());
    let id =
      match change with
      | Resource.Change.Published { id; _ } | Metadata_changed { id; _ } -> id
    in
    let resource = Resource.apply (Map.find t.resources id) change in
    { t with resources = Map.set t.resources ~key:id ~data:resource }
;;

let audit_payload previous current payload changes =
  let _, captures =
    List.fold_map changes ~init:previous ~f:(fun state change ->
      apply_event state change, (state, change))
  in
  let direct =
    List.concat_map captures ~f:(fun (before, change) ->
      match change with
      | Event.Hierarchy_policy_put definition ->
        [ Entity_ref.Ticket (Hierarchy_policy.Definition.ticket definition) ]
      | Event.Amendment_unchanged ack -> [ Entity_ref.Ticket ack.ticket ]
      | Event.Amendment_changed change ->
        Ticket_amendment.Change.targets change
        |> List.map ~f:(fun id -> Entity_ref.Ticket id)
      | Event.Facts_changed change -> [ Facts.Change.target change ]
      | Event.Policy_changed change | Policy_unchanged change ->
        (match change.Agent_run_policy.Change.command with
         | Template_register template -> [ Entity_ref.Resource template.resource ]
         | Instance_register instance ->
           List.map instance.tickets ~f:(fun p ->
             Entity_ref.Ticket p.Workflow_template.Planned_ticket.ticket)
         | Budget_put _ | Usage_report _ -> [ Entity_ref.Workspace ])
      | Event.Allocation_empty _ -> [ Entity_ref.Workspace ]
      | Event.Evidence_changed change -> Evidence.change_targets before.evidence change
      | Event.Agent_run_changed change ->
        let targets =
          match change.Agent_run.Change.update with
          | Agent_run.Change.Update.Attempt_put attempt | Attempt_started { attempt; _ }
            -> [ Entity_ref.Ticket attempt.ticket ]
          | Ticket_paths_put paths -> [ Entity_ref.Ticket paths.ticket_id ]
          | External_condition_changed (Put declaration) ->
            [ Entity_ref.Ticket declaration.ticket_id ]
          | External_condition_changed (Signal signal) ->
            let declaration =
              match
                External_condition.get
                  (Agent_run.external_conditions before.agent_runs)
                  signal.condition_id
              with
              | Some declaration -> declaration
              | None -> Json.fail Corrupt_store "condition signal has no declaration"
            in
            [ Entity_ref.Ticket declaration.ticket_id ]
          | Claim_paths_reserved { claim; _ } | Claim_paths_released { claim; _ } ->
            [ Entity_ref.Ticket claim.ticket ]
          | Path_reservation_put _ | Ownership_recovered _ -> [ Entity_ref.Workspace ]
          | Run_put _
          | Reservation_put _
          | Actions_set _
          | Pool_put _
          | Ticket_policy_put _ -> [ Entity_ref.Workspace ]
        in
        targets
      | Event.Communication_changed change ->
        Communication.change_targets before.communication change
      | Event.Project_put p -> [ Entity_ref.Project p.id ]
      | Milestone_put m -> [ Milestone m.id; Project m.project ]
      | Ticket_recovered r -> [ Entity_ref.Ticket r.request.ticket_id ]
      | Signal_receipt receipt ->
        let d =
          External_condition.get
            (Agent_run.external_conditions before.agent_runs)
            receipt.original.condition_id
          |> Option.value_exn
        in
        [ Entity_ref.Ticket d.ticket_id ]
      | Ticket_put ticket ->
        Entity_ref.Ticket ticket.id
        :: (Option.to_list ticket.project |> List.map ~f:(fun id -> Entity_ref.Project id))
      | Comment_changed (Discussion.Change.Create { target; _ }) -> [ target ]
      | Comment_changed (Revise { id; _ }) -> [ Discussion.target current.discussion id ]
      | Handoff_put h -> [ Ticket h.ticket ]
      | Resource_changed
          ( Resource.Change.Published { id; metadata; _ }
          | Metadata_changed { id; metadata; _ } ) ->
        Entity_ref.Resource id
        :: (metadata.targets
            @ Option.value_map (Map.find previous.resources id) ~default:[] ~f:(fun r ->
              r.Resource.metadata.targets))
      | Settings_changed _ | Workspace_updated _ -> [ Workspace ])
  in
  let parents state target =
    match target with
    | Entity_ref.Ticket id ->
      Option.value_map (Map.find state.tickets id) ~default:[] ~f:(fun ticket ->
        (Option.to_list ticket.Ticket.project
         |> List.map ~f:(fun id -> Entity_ref.Project id))
        @ (Option.to_list ticket.milestone
           |> List.map ~f:(fun id -> Entity_ref.Milestone id)))
    | Milestone id ->
      Option.value_map (Map.find state.milestones id) ~default:[] ~f:(fun m ->
        [ Entity_ref.Project m.Milestone.project ])
    | Workspace | Project _ | Resource _ -> []
  in
  let targets =
    Entity_ref.Workspace
    :: List.concat_map direct ~f:(fun target ->
      target :: (parents previous target @ parents current target))
    |> List.dedup_and_sort ~compare:Entity_ref.compare
  in
  match payload with
  | `Object fields ->
    Json.obj (fields @ [ "targets", `Array (List.map targets ~f:Entity_ref.jsonaf_of_t) ])
  | _ -> assert false
;;

let replay t payload =
  Json.decode (fun () ->
    let wire =
      match Storage_event.of_json payload with
      | Ok wire -> wire
      | Error error -> raise (Json.Decode_error error)
    in
    let payload = Storage_event.to_json wire in
    expected (Json.integer (Json.field payload "revision")) (t.revision + 1);
    let events =
      try List.map (Json.list (Json.field payload "changes")) ~f:Event.t_of_jsonaf with
      | Jsonaf_kernel.Conv.Of_jsonaf_error (exn, _) ->
        Json.fail Corrupt_store (Exn.to_string exn)
    in
    require
      (List.length events > 0 && List.length events <= 10_064)
      Corrupt_store
      "invalid event count";
    let rec apply_resolved
              state
              pending_completion
              (pending_paths : Claim_path_transition.t option)
      = function
      | [] ->
        require
          (Option.is_none pending_paths)
          Corrupt_store
          "Automatic path transition lacks its ordered claim transition";
        require
          (Option.is_none pending_completion)
          Corrupt_store
          "ticket completion lacks immutable evidence";
        state
      | event :: remaining ->
        let pending_paths =
          let open Claim_path_transition in
          let decision id =
            match remaining with
            | Event.Comment_changed
                (Discussion.Change.Create
                   { target = Ticket target
                   ; kind = Decision
                   ; origin = Authored
                   ; version
                   ; _
                   })
              :: _ ->
              Id.Ticket.equal id target
              && not (String.is_empty (String.strip version.body))
            | _ -> false
          in
          let invocation_matches (claim : Reservation.Claim.t) =
            Id.Actor.equal claim.actor (Id.Actor.t_of_jsonaf (Json.field payload "actor"))
            && Option.equal
                 Id.Run.equal
                 (Some claim.run)
                 (Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf)
          in
          let exact (claim : Claim.t) (borrower : Reservation.Claim.t) =
            Int.equal claim.token borrower.token
            && Id.Actor.equal claim.actor borrower.actor
            && Option.equal Id.Run.equal claim.run_id (Some borrower.run)
          in
          match pending_paths, event with
          | ( None
            , Event.Agent_run_changed { update = Claim_paths_reserved { claim; _ }; _ } )
            -> Some (Reserved claim)
          | ( None
            , Event.Agent_run_changed { update = Claim_paths_released { claim; _ }; _ } )
            -> Some (Released claim)
          | Some (Reserved claim), Event.Ticket_put ticket
            when Id.Ticket.equal ticket.id claim.ticket
                 && Option.value_map ticket.claim ~default:false ~f:(fun c ->
                   exact c claim) ->
            let previous = find_ticket state ticket.id in
            require
              (not
                 (Option.value_map previous.claim ~default:false ~f:(fun c ->
                    exact c claim)))
              Corrupt_store
              "Reserved paths require a new claim installation or attempt start";
            require
              (Option.is_none previous.claim || decision ticket.id)
              Corrupt_store
              "Path transfer lacks its reassignment decision";
            None
          | ( Some (Reserved claim)
            , Event.Agent_run_changed { update = Attempt_started { attempt; _ }; _ } )
            when Id.Ticket.equal attempt.ticket claim.ticket
                 && Int.equal attempt.token claim.token
                 && Id.Run.equal attempt.run claim.run -> None
          | Some (Released claim), Event.Ticket_put ticket
            when Id.Ticket.equal ticket.id claim.ticket
                 && not
                      (Option.value_map ticket.claim ~default:false ~f:(fun c ->
                         exact c claim)) ->
            require
              ((invocation_matches claim && Option.is_none ticket.claim)
               || decision ticket.id)
              Corrupt_store
              "Path release attribution lacks owner or explicit reassignment decision";
            None
          | Some (Released claim), Event.Ticket_recovered recovery
            when Id.Ticket.equal recovery.request.ticket_id claim.ticket
                 && Int.equal recovery.request.token claim.token
                 && Id.Actor.equal recovery.request.old_actor_id claim.actor
                 && Option.equal Id.Run.equal recovery.request.old_run_id (Some claim.run)
            -> None
          | None, _ -> None
          | Some _, _ ->
            Json.fail
              Corrupt_store
              "Automatic path transition lacks its exact ordered claim transition"
        in
        (match event with
         | Event.Ticket_put ticket ->
           Option.iter (Map.find state.tickets ticket.id) ~f:(fun source ->
             let added =
               List.drop ticket.reassessments (List.length source.Ticket.reassessments)
             in
             List.iter added ~f:(fun reopening ->
               if Id.Ticket.equal reopening.Reassessment.prerequisite ticket.id
               then (
                 let expected_effects =
                   Planning_reopening.effects_exn
                     state
                     ~source
                     ~reason:reopening.reason
                     ~actor:reopening.actor
                     ~run:
                       (Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf)
                     ~timestamp:reopening.timestamp
                 in
                 require
                   (List.equal
                      String.equal
                      (List.map expected_effects ~f:(fun event ->
                         Json.canonical (Event.jsonaf_of_t event)))
                      (List.take (event :: remaining) (List.length expected_effects)
                       |> List.map ~f:(fun event ->
                         Json.canonical (Event.jsonaf_of_t event))))
                   Corrupt_store
                   "reopening lacks its exact atomic reassessments, decisions or \
                    notifications")))
         | _ -> ());
        (match event with
         | Event.Evidence_changed
             { update = Evidence_event.Update.Review_added { review; submission }
             ; attribution
             ; _
             }
           when Evidence.Review.Verdict.equal review.verdict Approve ->
           let approval = unwrap_domain (Review_approval.create ~review ~submission) in
           let prepared =
             unwrap_domain
               (Communication.prepare_message
                  state.communication
                  (Review_approval.message approval)
                  ~discussion:state.discussion
                  ~actor:attribution.actor
                  ~run:attribution.run
                  ~timestamp:attribution.timestamp
                  ~sequence:(state.revision + 1))
           in
           let expected_effects =
             List.map (Communication.Message_prepared.changes prepared) ~f:(function
               | Discussion_change change -> Event.Comment_changed change
               | Communication_change change -> Event.Communication_changed change)
           in
           require
             (List.equal
                String.equal
                (List.map expected_effects ~f:(fun event ->
                   Json.canonical (Event.jsonaf_of_t event)))
                (List.take remaining (List.length expected_effects)
                 |> List.map ~f:(fun event -> Json.canonical (Event.jsonaf_of_t event))))
             Corrupt_store
             "approval lacks its exact atomic notification"
         | _ -> ());
        (match pending_completion, event with
         | ( Some ticket
           , Event.Comment_changed
               (Discussion.Change.Create
                  { target = Ticket target; origin = Completion; version; _ }) ) ->
           require
             (Id.Ticket.equal ticket target
              && not (String.is_empty (String.strip version.body)))
             Corrupt_store
             "completion evidence differs from completed ticket"
         | Some _, _ ->
           Json.fail Corrupt_store "ticket completion lacks immutable evidence"
         | None, Comment_changed (Create { origin = Completion; _ }) ->
           Json.fail Corrupt_store "completion evidence lacks its ticket transition"
         | None, _ -> ());
        let pending_completion =
          match event with
          | Event.Ticket_put ticket when Domain_command.Status.equal ticket.status Done ->
            (match Map.find state.tickets ticket.id with
             | Some previous when Domain_command.Status.equal previous.Ticket.status Done
               -> None
             | Some previous ->
               let claim =
                 match previous.claim with
                 | Some claim -> claim
                 | None ->
                   Json.fail Corrupt_store "completion requires existing ownership"
               in
               require
                 (Id.Actor.equal
                    claim.actor
                    (Id.Actor.t_of_jsonaf (Json.field payload "actor"))
                  && Option.equal
                       Id.Run.equal
                       claim.run_id
                       (Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf)
                 )
                 Corrupt_store
                 "completion attribution differs from ticket owner";
               Some ticket.id
             | None -> Json.fail Corrupt_store "new ticket cannot start completed")
          | _ -> None
        in
        (match event with
         | Event.Signal_receipt receipt ->
           unwrap_domain
             (External_condition.Repeat.validate
                receipt
                ~state:(Agent_run.external_conditions state.agent_runs)
                ~actor:(Id.Actor.t_of_jsonaf (Json.field payload "actor"))
                ~run:(Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf)
                ~timestamp:(Json.text (Json.field payload "timestamp"))
                ~sequence:(state.revision + 1))
         | Event.Ticket_recovered r ->
           require
             (Id.Actor.equal
                r.actor_id
                (Id.Actor.t_of_jsonaf (Json.field payload "actor"))
              && Option.equal
                   Id.Run.equal
                   r.run_id
                   (Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf)
              && String.equal r.timestamp (Json.text (Json.field payload "timestamp")))
             Corrupt_store
             "Recovery attribution differs"
         | Event.Ticket_put ticket ->
           let old_count =
             Option.value_map
               (Map.find state.tickets ticket.id)
               ~default:0
               ~f:(fun previous -> List.length previous.Ticket.reassessments)
           in
           List.iter (List.drop ticket.reassessments old_count) ~f:(fun r ->
             require
               (Id.Actor.equal
                  r.Reassessment.actor
                  (Id.Actor.t_of_jsonaf (Json.field payload "actor"))
                && String.equal r.timestamp (Json.text (Json.field payload "timestamp")))
               Corrupt_store
               "reassessment attribution differs from transaction")
         | _ -> ());
        (match event with
         | Event.Agent_run_changed
             { update = External_condition_changed changed; sequence; _ } ->
           let d =
             match changed with
             | External_condition.Change.Put d -> d
             | Signal s ->
               External_condition.get
                 (Agent_run.external_conditions state.agent_runs)
                 s.condition_id
               |> Option.value_exn
           in
           let actors =
             List.dedup_and_sort
               ((d.creator :: d.recipients)
                @ Option.to_list
                    (Option.map (find_ticket state d.ticket_id).claim ~f:(fun c ->
                       c.Claim.actor)))
               ~compare:Id.Actor.compare
           in
           let expected_id = External_condition.notification_id changed ~sequence in
           let message =
             List.find_map remaining ~f:(function
               | Event.Communication_changed { update = Message_put m; _ }
                 when Communication_id.Message.equal m.message_id expected_id -> Some m
               | _ -> None)
           in
           (match message with
            | None ->
              Json.fail Corrupt_store "Condition transition lacks its atomic notification"
            | Some m ->
              require
                (Option.equal Id.Ticket.equal m.ticket_id (Some d.ticket_id)
                 && Option.equal
                      String.equal
                      m.correlation_id
                      (Some (Coordination_id.Condition.to_string d.condition_id))
                 && List.is_empty m.teams
                 && List.equal
                      Communication.Recipient.equal
                      m.direct_recipients
                      (List.map actors ~f:(fun a -> Communication.Recipient.Actor a)))
                Corrupt_store
                "Condition notification routing differs")
         | _ -> ());
        (match event with
         | Event.Project_put project ->
           let previous =
             Option.bind (Map.find state.projects project.id) ~f:(fun p ->
               p.Project.handoff)
           in
           if not (Option.equal Project_completion.Handoff.equal previous project.handoff)
           then
             Option.iter project.handoff ~f:(fun handoff ->
               let actor = Id.Actor.t_of_jsonaf (Json.field payload "actor") in
               let run =
                 Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf
               in
               Option.iter run ~f:(fun run ->
                 validate_run_actor state ~run ~actor |> unwrap_domain);
               Project_completion.Handoff.validate_publication
                 handoff
                 ~actor
                 ~run
                 ~timestamp:(Json.field payload "timestamp" |> Json.text)
                 ~project_revision:project.revision
                 ~workspace_revision:t.revision
               |> unwrap_domain)
         | Event.Amendment_unchanged ack ->
           require
             (Id.Actor.equal
                ack.ownership.actor
                (Id.Actor.t_of_jsonaf (Json.field payload "actor"))
              && Option.equal
                   Id.Run.equal
                   ack.ownership.run
                   (Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf)
              && String.equal ack.timestamp (Json.field payload "timestamp" |> Json.text)
             )
             Corrupt_store
             "amendment unchanged attribution differs from transaction"
         | Event.Amendment_changed change ->
           let actor = Id.Actor.t_of_jsonaf (Json.field payload "actor") in
           let run = Option.map (Json.optional payload "run_id") ~f:Id.Run.t_of_jsonaf in
           let timestamp = Json.field payload "timestamp" |> Json.text in
           (match change.update with
            | Revisions records ->
              List.iter records ~f:(fun record ->
                require
                  (Id.Actor.equal record.Ticket_amendment.Revision.attribution.actor actor
                   && Option.equal Id.Run.equal record.attribution.run run
                   && String.equal record.attribution.timestamp timestamp)
                  Corrupt_store
                  "amendment attribution differs from transaction")
            | Acknowledged ack ->
              require
                (Id.Actor.equal ack.ownership.actor actor
                 && Option.equal Id.Run.equal ack.ownership.run run
                 && String.equal ack.timestamp timestamp)
                Corrupt_store
                "amendment ack attribution differs from transaction");
           let effects = Planning_amendment.effects state change ~actor ~run ~timestamp in
           require
             (List.equal
                String.equal
                (List.map effects ~f:(fun event ->
                   Json.canonical (Event.jsonaf_of_t event)))
                (List.take remaining (List.length effects)
                 |> List.map ~f:(fun event -> Json.canonical (Event.jsonaf_of_t event))))
             Corrupt_store
             "amendment lacks its exact atomic invalidations and announcement"
         | _ -> ());
        let publication =
          match event with
          | Event.Resource_changed (Resource.Change.Published { id; version; _ }) ->
            Option.map (Map.find state.resources id) ~f:(fun old ->
              let old = Resource.get_version old ~revision:None in
              let pin (version : Resource.Version.t) =
                Evidence.Pin.Resource
                  { id; revision = version.revision; digest = version.digest }
              in
              pin old, pin version)
          | Comment_changed (Discussion.Change.Revise { id; version }) ->
            Some
              ( Evidence.Pin.Comment
                  { id; revision = Discussion.revision state.discussion id }
              , Evidence.Pin.Comment { id; revision = version.revision } )
          | _ -> None
        in
        Option.iter publication ~f:(fun (previous, current) ->
          require
            (match remaining with
             | Evidence_changed { update = Evidence_event.Update.Input_changed pins; _ }
               :: _ ->
               Evidence.Pin.equal previous pins.previous
               && Evidence.Pin.equal current pins.current
             | _ -> false)
            Corrupt_store
            "publication lacks its exact atomic input change");
        apply_resolved
          (apply_event state event)
          pending_completion
          pending_paths
          remaining
    in
    let state = apply_resolved t None None events in
    validate ~previous:t state;
    List.iter events ~f:(function
      | Event.Project_put project when Domain_command.Status.equal project.status Done ->
        let current = find_project state project.id in
        if Domain_command.Status.equal current.status Done
        then check_project_complete state current
      | Project_put _
      | Milestone_put _
      | Ticket_put _
      | Facts_changed _
      | Communication_changed _
      | Agent_run_changed _
      | Hierarchy_policy_put _
      | Amendment_changed _
      | Amendment_unchanged _
      | Evidence_changed _
      | Policy_changed _
      | Policy_unchanged _
      | Allocation_empty _
      | Settings_changed _
      | Workspace_updated _
      | Signal_receipt _
      | Ticket_recovered _
      | Comment_changed _
      | Handoff_put _
      | Resource_changed _ -> ());
    Map.iter state.tickets ~f:(fun ticket ->
      if
        Domain_command.Status.equal ticket.Ticket.status Done
        && not
             (Option.value_map
                (Map.find t.tickets ticket.id)
                ~default:false
                ~f:(fun previous ->
                  Domain_command.Status.equal previous.Ticket.status Done))
      then check_complete state ticket);
    List.iter events ~f:(function
      | Event.Agent_run_changed { update = Agent_run_event.Update.Attempt_put attempt; _ }
        when Attempt.State.equal attempt.state Completed ->
        check_complete state (find_ticket state attempt.ticket);
        (match
           Evidence.ensure_attempt_can_complete
             state.evidence
             ~ticket_context:(evidence_ticket_context state)
             ~attempt:attempt.id
             ~ticket:attempt.ticket
         with
         | Ok () -> ()
         | Error error -> raise (Json.Decode_error error))
      | _ -> ());
    let retained_bytes = t.retained_bytes + String.length (Json.canonical payload) in
    if retained_bytes > Admission.Limit.maximum Planning_payload_bytes
    then
      raise
        (Json.Decode_error
           (Admission.refusal
              Planning_payload_bytes
              ~used:t.retained_bytes
              ~attempted:retained_bytes
              ~kind:Invalid_argument));
    let audit = audit_payload t state payload events in
    let activity_by_target =
      List.fold
        (Json.list (Json.field audit "targets"))
        ~init:t.activity_by_target
        ~f:(fun index json ->
          Map.update index (Entity_ref.t_of_jsonaf json) ~f:(fun previous ->
            audit :: Option.value previous ~default:[]))
    in
    { state with
      revision = t.revision + 1
    ; activity = audit :: t.activity
    ; activity_by_target
    ; retained_bytes
    })
;;
