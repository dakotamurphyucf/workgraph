open Core
open Planning_state
open Planning_replay

type t =
  { candidate : Planning_state.t
  ; events : Jsonaf.t
  ; result : Jsonaf.t
  ; blobs : (string * string) list
  }

let candidate t = t.candidate
let events t = t.events
let result t = t.result
let blobs t = t.blobs

let check_claim_at ticket ~actor ~run ~token ~now_unix_ms =
  check_claim ticket ~actor ~run ~token;
  let claim = Option.value_exn ticket.Ticket.claim in
  match Allocation_lease.policy claim.lease with
  | Indefinite -> ()
  | Duration_ms _ ->
    let now =
      match now_unix_ms with
      | Some now -> now
      | None -> Json.fail Invalid_argument "timed ownership requires server clock"
    in
    unwrap_domain
      (Allocation_lease.validate_owner claim.lease ~epoch:token ~now_unix_ms:now)
;;

let new_lease ~token ~duration ~now_unix_ms =
  let policy =
    Option.value_map duration ~default:Allocation_lease.Policy.Indefinite ~f:(fun ms ->
      Allocation_lease.Policy.Duration_ms ms)
  in
  let now =
    match duration, now_unix_ms with
    | Some _, None -> Json.fail Invalid_argument "timed ownership requires server clock"
    | _, Some now -> now
    | None, None -> 0L
  in
  unwrap_domain (Allocation_lease.create ~epoch:token ~now_unix_ms:now ~policy ())
;;

let attempt_owner t id ~actor ~run ~now_unix_ms ?(check_lease = true) () =
  let attempt =
    match Agent_run.get_attempt t.agent_runs id with
    | Some a -> a
    | None -> Json.fail Not_found "attempt not found"
  in
  let attributed_run =
    match run with
    | Some run -> run
    | None -> Json.fail Stale_claim "attempt mutation requires run attribution"
  in
  unwrap_domain
    (Agent_run.validate_attempt_owner
       t.agent_runs
       id
       ~actor
       ~run:attributed_run
       ~ticket:attempt.ticket
       ~token:attempt.token);
  if check_lease
  then
    check_claim_at
      (find_ticket t attempt.ticket)
      ~actor
      ~run
      ~token:attempt.token
      ~now_unix_ms
  else check_claim (find_ticket t attempt.ticket) ~actor ~run ~token:attempt.token;
  attempt
;;

let active_attempts t ticket =
  Agent_run.attempts_for_ticket t.agent_runs ticket
  |> List.filter ~f:(fun a -> not (Attempt.State.terminal a.Attempt.state))
;;

let instantiate_plan t ~template ~template_revision ~id ~parameters =
  let registered =
    match
      Agent_run_policy.get_template t.policies template ~revision:template_revision
    with
    | Some x -> x
    | None -> Json.fail Not_found "template version is not registered"
  in
  let plan = unwrap_domain (Workflow_template.instantiate registered ~id ~parameters) in
  let creates =
    List.map plan.tickets ~f:(fun node ->
      Domain_command.Ticket_create
        { id = node.Workflow_template.Planned_ticket.ticket
        ; title = node.title
        ; description = node.description
        ; project = None
        ; parent = node.parent
        ; milestone = None
        })
  in
  let dependencies =
    List.concat_map plan.tickets ~f:(fun node ->
      List.map node.Workflow_template.Planned_ticket.dependencies ~f:(fun prerequisite ->
        Domain_command.Dependency_add { ticket = node.ticket; prerequisite }))
  in
  let capabilities =
    List.filter_map plan.tickets ~f:(fun node ->
      if List.is_empty node.Workflow_template.Planned_ticket.capabilities
      then None
      else
        Some
          (Domain_command.Agent_run
             (Agent_run.Command.Ticket_policy_put
                { ticket = node.ticket
                ; expected_revision = 0
                ; required_capabilities = node.capabilities
                ; pools = []
                })))
  in
  let reviews =
    List.filter_map plan.tickets ~f:(fun node ->
      if List.is_empty node.Workflow_template.Planned_ticket.reviewers
      then None
      else
        Some
          (Domain_command.Evidence
             (Evidence.Command.Policy_put
                { ticket = node.ticket
                ; expected_revision = 0
                ; enabled = true
                ; reviewers =
                    List.map node.reviewers ~f:(fun actor ->
                      Evidence.Policy.Requirement.Named_actor actor)
                ; separate_actor = node.separate_actor
                ; validators = []
                ; weakening_reason = None
                })))
  in
  let commands =
    creates
    @ dependencies
    @ capabilities
    @ reviews
    @ [ Domain_command.Policy (Agent_run_policy.Command.Instance_register plan) ]
  in
  require
    (List.length commands <= 32)
    Invalid_argument
    "expanded template exceeds 32 atomic operations";
  plan, commands
;;

let rec stage t command ~actor ~run ~timestamp ~now_unix_ms =
  let update (ticket : Ticket.t) =
    Event.Ticket_put
      { ticket with Ticket.revision = ticket.revision + 1; updated_at = timestamp }
  in
  let version ~revision body ~tombstone =
    { Discussion.Version.revision
    ; serial = Discussion.next_serial t.discussion
    ; sequence = t.revision + 1
    ; actor
    ; timestamp
    ; body
    ; tombstone
    }
  in
  let create_comment
        ?(origin = Discussion.Origin.Authored)
        ~id
        ~target
        ~reply_to
        ~kind
        body
    =
    let id =
      Option.value
        id
        ~default:(Discussion.generated_id t.discussion ~sequence:(t.revision + 1))
    in
    ( Event.Comment_changed
        (Discussion.Change.Create
           { id
           ; target
           ; reply_to
           ; kind
           ; origin
           ; version = version ~revision:1 body ~tombstone:false
           })
    , id )
  in
  let comment ?origin ticket kind body =
    fst
      (create_comment
         ?origin
         ~id:None
         ~target:(Entity_ref.Ticket ticket)
         ~reply_to:None
         ~kind
         body)
  in
  let publish ~id ~expected_revision ~title ~filename ~mime_type ~digest ~size_bytes =
    let previous = Map.find t.resources id in
    expected
      (Option.value_map previous ~default:0 ~f:(fun r -> r.Resource.revision))
      expected_revision;
    let metadata =
      Option.value_map
        previous
        ~default:
          { Resource.Metadata.title
          ; filename
          ; mime_type
          ; description = ""
          ; archived = false
          ; targets = []
          }
        ~f:(fun r -> { r.Resource.metadata with title; filename; mime_type })
    in
    require (not metadata.archived) Conflict "resource is archived";
    let version =
      { Resource.Version.revision =
          Option.value_map previous ~default:1 ~f:(fun r ->
            List.length r.Resource.versions + 1)
      ; digest
      ; size_bytes = Some size_bytes
      ; actor
      ; timestamp
      ; filename
      ; mime_type
      }
    in
    let result =
      Json.obj
        [ "resource_id", Id.Resource.jsonaf_of_t id
        ; "revision", Json.int (expected_revision + 1)
        ; "version", Resource_wire.version_json version
        ]
    in
    Resource_api.validate_publication result;
    ( Event.Resource_changed
        (Published { id; revision = expected_revision + 1; metadata; version })
    , result )
  in
  let changes, result, blobs =
    match command with
    | Domain_command.Lifecycle lifecycle ->
      let apply state command = stage state command ~actor ~run ~timestamp ~now_unix_ms in
      let claim ticket_id expected_revision lease_duration_ms : Domain_command.t =
        let ticket = find_ticket t ticket_id in
        Option.iter expected_revision ~f:(expected ticket.revision);
        require
          (Option.is_none ticket.claim)
          Already_claimed
          ("ticket is claimed: "
           ^ Json.canonical
               (Json.obj
                  [ "ticket_id", Id.Ticket.jsonaf_of_t ticket.id
                  ; "revision", Json.int ticket.revision
                  ; ( "claim"
                    , Option.value_map ticket.claim ~default:`Null ~f:Claim.jsonaf_of_t )
                  ]));
        match lease_duration_ms with
        | None -> Ticket_claim { id = ticket_id; expected_revision = ticket.revision }
        | Some lease_duration_ms ->
          Ticket_claim_with_lease
            { id = ticket_id; expected_revision = ticket.revision; lease_duration_ms }
      in
      (match lifecycle with
       | Ticket_lifecycle.Command.Claim
           { ticket_id; expected_revision; lease_duration_ms } ->
         let _, events, result, blobs =
           apply t (claim ticket_id expected_revision lease_duration_ms)
         in
         events, result, blobs
       | Start
           { ticket_id; expected_revision; lease_duration_ms; initial_note; attempt_id }
         ->
         let claimed, events, result, blobs =
           apply t (claim ticket_id expected_revision lease_duration_ms)
         in
         let token = Json.integer (Json.field result "token") in
         let commands =
           Option.to_list
             (Option.map initial_note ~f:(fun body ->
                Domain_command.Ticket_progress
                  { ticket = ticket_id; token; kind = Progress; body }))
           @ Option.to_list
               (Option.map attempt_id ~f:(fun id ->
                  let target_run =
                    match run with
                    | Some run -> run
                    | None ->
                      Json.fail
                        Invalid_argument
                        "starting an attempt requires run attribution"
                  in
                  Domain_command.Agent_run
                    (Attempt_start
                       { id; run = target_run; ticket = ticket_id; token; sessions = [] })))
         in
         let _, events, blobs =
           List.fold
             commands
             ~init:(claimed, events, blobs)
             ~f:(fun (state, events, blobs) command ->
               let state, added, _, new_blobs = apply state command in
               state, events @ added, blobs @ new_blobs)
         in
         events, result, blobs
       | Finish { ticket_id; token; evidence; handoff } ->
         let staged, events, blobs =
           match handoff with
           | None -> t, [], []
           | Some h ->
             let revision =
               Option.value_map (Map.find t.handoffs ticket_id) ~default:0 ~f:(fun h ->
                 h.Handoff.revision)
             in
             let state, events, _, blobs =
               apply
                 t
                 (Handoff_set
                    { ticket = ticket_id
                    ; expected_revision = revision
                    ; token = Some token
                    ; summary = h.summary
                    ; next_steps = h.next_steps
                    ; evidence
                    ; objective = ""
                    ; completed = ""
                    ; decisions = ""
                    ; blockers = ""
                    ; resources = []
                    ; covers_through = h.covers_through
                    })
             in
             state, events, blobs
         in
         let _, completion, result, new_blobs =
           apply staged (Ticket_complete { id = ticket_id; token; evidence })
         in
         events @ completion, result, blobs @ new_blobs
       | Recover request ->
         let recovery =
           { Ticket_recovery.request
           ; actor_id = actor
           ; run_id = run
           ; timestamp
           ; sequence = t.revision + 1
           }
         in
         let event = Event.Ticket_recovered recovery in
         let recovered = apply_event t event in
         let ticket = find_ticket recovered request.ticket_id in
         ( [ event ]
         , Json.obj
             [ "ticket_id", Id.Ticket.jsonaf_of_t ticket.id
             ; "revision", Json.int ticket.revision
             ]
         , [] )
       | Reopen { ticket_id; expected_revision; reason } ->
         let ticket = find_ticket t ticket_id in
         expected ticket.revision expected_revision;
         bounded reason 65536;
         require
           (not (String.is_empty (String.strip reason)))
           Invalid_argument
           "reopening requires a reason";
         require
           (Domain_command.Status.equal ticket.status Done)
           Conflict
           "only completed tickets can be reopened";
         let reopening =
           { Reassessment.prerequisite = ticket_id
           ; reopened_revision = t.revision + 1
           ; reason
           ; actor
           ; timestamp
           }
         in
         let reopened =
           { ticket with
             status = Todo
           ; status_id = None
           ; claim = None
           ; reopened_token = Some ticket.next_token
           ; reassessments = ticket.reassessments @ [ reopening ]
           }
         in
         let first = update reopened in
         let initial = apply_event t first in
         let initial, first_comment, _, _ =
           apply
             initial
             (Comment_add
                { id = None
                ; target = Ticket ticket_id
                ; reply_to = None
                ; kind = Decision
                ; body = "Reopened: " ^ reason
                })
         in
         let dependents =
           Map.data t.tickets
           |> List.filter ~f:(fun dependent ->
             List.mem dependent.Ticket.prerequisites ticket_id ~equal:Id.Ticket.equal
             && not (waived dependent ticket_id))
         in
         let _, events =
           List.fold
             dependents
             ~init:(initial, first :: first_comment)
             ~f:(fun (state, events) dependent ->
               let reassessment =
                 { Reassessment.prerequisite = ticket_id
                 ; reopened_revision = t.revision + 1
                 ; reason
                 ; actor
                 ; timestamp
                 }
               in
               let event =
                 update
                   { dependent with
                     reassessments = dependent.reassessments @ [ reassessment ]
                   }
               in
               let state = apply_event state event in
               let state, comments, _, _ =
                 apply
                   state
                   (Comment_add
                      { id = None
                      ; target = Ticket dependent.id
                      ; reply_to = None
                      ; kind = Decision
                      ; body =
                          "Prerequisite "
                          ^ Id.Ticket.to_string ticket_id
                          ^ " reopened: "
                          ^ reason
                      })
               in
               let state, notifications =
                 match dependent.claim with
                 | None -> state, []
                 | Some claim ->
                   let identity =
                     String.concat
                       ~sep:":"
                       [ Int.to_string (t.revision + 1)
                       ; Id.Ticket.to_string ticket_id
                       ; Id.Ticket.to_string dependent.id
                       ]
                   in
                   let message_id =
                     unwrap_domain
                       (Communication_id.Message.of_string
                          ("reopen-" ^ Json.hash identity))
                   in
                   let recipients =
                     [ (match claim.run_id with
                        | Some run -> Communication.Recipient.Run run
                        | None -> Actor claim.actor)
                     ]
                   in
                   let state, changes, _, _ =
                     apply
                       state
                       (Message_send
                          { message_id
                          ; body =
                              "Prerequisite "
                              ^ Id.Ticket.to_string ticket_id
                              ^ " reopened: "
                              ^ Query_budget.prefix reason ~max_bytes:32768
                          ; ticket_id = Some dependent.id
                          ; recipients
                          ; teams = []
                          ; reply_to_message_id = None
                          ; correlation_id = Some (Id.Ticket.to_string ticket_id)
                          })
                   in
                   state, changes
               in
               state, events @ (event :: comments) @ notifications)
         in
         ( events
         , Json.obj
             [ "ticket_id", Id.Ticket.jsonaf_of_t ticket_id
             ; "revision", Json.int (ticket.revision + 1)
             ]
         , [] ))
    | Domain_command.Template_instantiate { template; template_revision; id; parameters }
      ->
      let plan, commands =
        instantiate_plan t ~template ~template_revision ~id ~parameters
      in
      (match Agent_run_policy.get_instance t.policies id with
       | Some existing ->
         require
           (Workflow_template.Instance.equal existing plan)
           Idempotency_conflict
           "instance retry parameters differ";
         let _, events, result, _ =
           stage t (Policy (Instance_register plan)) ~actor ~run ~timestamp ~now_unix_ms
         in
         let receipt =
           unwrap_domain
             (Planning_result.Template.operation Instance_register ~data:result)
         in
         let result =
           unwrap_domain
             (Planning_result.Template.create plan ~results:[ receipt ] ~duplicate:true)
         in
         events, result, []
       | None ->
         let _, events, results, blobs =
           List.fold
             commands
             ~init:(t, [], [], [])
             ~f:(fun (state, events, results, blobs) command ->
               let state, changes, result, new_blobs =
                 stage state command ~actor ~run ~timestamp ~now_unix_ms
               in
               let kind, data =
                 match command with
                 | Domain_command.Ticket_create _ ->
                   Planning_result.Template.Kind.Ticket_create, result
                 | Dependency_add _ -> Dependency_add, result
                 | Agent_run (Ticket_policy_put _) -> Ticket_policy_put, result
                 | Evidence (Policy_put _) ->
                   let policy =
                     List.find_map changes ~f:(function
                       | Event.Evidence_changed
                           { update = Evidence_event.Update.Policy_put policy; _ } ->
                         Evidence.policy_view policy
                       | _ -> None)
                     |> Option.value_exn
                   in
                   ( Review_policy_put
                   , unwrap_domain (Planning_result.Template.review_policy policy) )
                 | Policy (Instance_register _) -> Instance_register, result
                 | _ -> failwith "unexpected template operation"
               in
               let receipt =
                 unwrap_domain (Planning_result.Template.operation kind ~data)
               in
               ( state
               , List.rev_append changes events
               , receipt :: results
               , List.rev_append new_blobs blobs ))
         in
         ( List.rev events
         , unwrap_domain
             (Planning_result.Template.create
                plan
                ~results:(List.rev results)
                ~duplicate:false)
         , List.rev blobs ))
    | Domain_command.Policy command ->
      (match command with
       | Agent_run_policy.Command.Usage_report record ->
         require
           (Id.Actor.equal record.actor actor)
           Conflict
           "usage reporter attribution differs"
       | Instance_register plan ->
         List.iter plan.tickets ~f:(fun node ->
           let actual = find_ticket t node.Workflow_template.Planned_ticket.ticket in
           require
             (String.equal actual.title node.title
              && String.equal actual.description node.description
              && Option.equal Id.Ticket.equal actual.parent node.parent
              && List.equal
                   Id.Ticket.equal
                   (List.dedup_and_sort actual.prerequisites ~compare:Id.Ticket.compare)
                   (List.dedup_and_sort node.dependencies ~compare:Id.Ticket.compare))
             Conflict
             "instance ticket graph differs from its plan";
           let policy = Agent_run.get_ticket_policy t.agent_runs node.ticket in
           require
             (if List.is_empty node.capabilities
              then
                Option.is_none policy
                || Option.value_map policy ~default:false ~f:(fun p ->
                  List.is_empty p.Allocation.Ticket_policy.required_capabilities)
              else
                Option.value_map policy ~default:false ~f:(fun p ->
                  List.equal
                    String.equal
                    (List.dedup_and_sort
                       p.Allocation.Ticket_policy.required_capabilities
                       ~compare:String.compare)
                    (List.dedup_and_sort node.capabilities ~compare:String.compare)))
             Conflict
             "instance capabilities differ from plan";
           require
             (List.equal
                Id.Actor.equal
                (Evidence.review_recipients
                   t.evidence
                   ~ticket_context:(evidence_ticket_context t)
                   ~ticket:node.ticket)
                (List.dedup_and_sort node.reviewers ~compare:Id.Actor.compare))
             Conflict
             "instance reviewers differ from plan")
       | Template_register _ | Budget_put _ -> ());
      let p = unwrap_domain (Agent_run_policy.prepare t.policies command) in
      let events =
        match Agent_run_policy.changes p with
        | [] ->
          [ Event.Policy_unchanged
              { revision =
                  Json.integer (Json.field (Agent_run_policy.result p) "revision")
              ; command
              }
          ]
        | changes -> List.map changes ~f:(fun change -> Event.Policy_changed change)
      in
      events, Agent_run_policy.result p, []
    | Domain_command.Evidence command ->
      (match command with
       | Evidence.Command.Assert { ticket; token; _ } ->
         check_claim_at (find_ticket t ticket) ~actor ~run ~token ~now_unix_ms
       | Contract_put _
       | Manifest_publish _
       | Policy_put _
       | Acceptance_policy_put _
       | Submit _
       | Review _
       | Accept _
       | Validate _
       | Decision_put _
       | Input_changed _
       | Reconcile _ -> ());
      List.iter (Evidence.command_attempts t.evidence command) ~f:(fun id ->
        let terminal_reconciliation =
          match command with
          | Evidence.Command.Reconcile { disposition = Acknowledge | Continue _; _ } ->
            (match Agent_run.get_attempt t.agent_runs id with
             | Some attempt when Attempt.State.terminal attempt.state -> Some attempt
             | Some _ | None -> None)
          | Reconcile { disposition = Revised _; _ }
          | Contract_put _
          | Manifest_publish _
          | Policy_put _
          | Acceptance_policy_put _
          | Assert _
          | Submit _
          | Review _
          | Accept _
          | Validate _
          | Decision_put _
          | Input_changed _ -> None
        in
        match terminal_reconciliation with
        | Some attempt -> validate_terminal_reconciliation_owner t attempt ~actor ~run
        | None -> ignore (attempt_owner t id ~actor ~run ~now_unix_ms () : Attempt.t));
      let make_request
            state
            ~key
            ~ticket
            ~manifest
            ~contract
            ~recipients
            ~kind
            ~reply_to
            ~body
        =
        let prefix = "review-" ^ String.prefix (Json.hash key) 32 in
        let board =
          Communication_id.Board.of_string (prefix ^ "-board") |> unwrap_domain
        in
        let thread =
          Communication_id.Thread.of_string (prefix ^ "-thread") |> unwrap_domain
        in
        let request =
          Communication_id.Request.of_string (prefix ^ "-request") |> unwrap_domain
        in
        let comment = Id.Comment.of_string (prefix ^ "-comment") |> unwrap_domain in
        let correlation_id =
          "review:"
          ^ Json.hash
              (Json.canonical
                 (Json.obj
                    [ "ticket", Id.Ticket.jsonaf_of_t ticket
                    ; "manifest", Evidence.Manifest_ref.jsonaf_of_t manifest
                    ; "contract", Evidence.Contract_ref.jsonaf_of_t contract
                    ]))
        in
        let participants =
          List.filter_map recipients ~f:(function
            | Communication.Recipient.Actor a -> Some a
            | Run _ -> None)
          |> List.dedup_and_sort ~compare:Id.Actor.compare
        in
        let thread, revision, comment_parent, creates =
          match reply_to with
          | Some id ->
            let parent =
              Communication.get_request state.communication id |> Option.value_exn
            in
            let record =
              Communication.get_thread state.communication parent.thread
              |> Option.value_exn
            in
            parent.thread, record.revision, Some parent.message, []
          | None ->
            ( thread
            , 1
            , None
            , [ Domain_command.Communication
                  (Board_put
                     { id = board
                     ; expected_revision = 0
                     ; scope = Workspace
                     ; title = "Output reviews"
                     })
              ; Communication
                  (Thread_put
                     { id = thread
                     ; expected_revision = 0
                     ; board
                     ; title = "Review " ^ Id.Ticket.to_string ticket
                     ; participants
                     ; mentions = []
                     ; links = [ Ticket ticket ]
                     ; state = Awaiting_response
                     ; pinned = false
                     })
              ] )
        in
        let commands =
          creates
          @ [ Domain_command.Thread_reply
                { id = thread
                ; expected_revision = revision
                ; comment_id = Some comment
                ; reply_to = comment_parent
                ; kind = Discussion.Kind.Evidence
                ; body
                }
            ; Communication
                (Request_create
                   { id = request
                   ; thread
                   ; kind
                   ; message = comment
                   ; recipients
                   ; teams = []
                   ; resolver = actor
                   ; correlation_id = Some correlation_id
                   ; reply_to
                   ; deadline_unix_ms = None
                   })
            ]
        in
        let state, events =
          List.fold commands ~init:(state, []) ~f:(fun (state, events) command ->
            let state, changes, _, _ =
              stage state command ~actor ~run ~timestamp ~now_unix_ms
            in
            state, List.rev_append changes events)
        in
        state, List.rev events, request
      in
      let prepared_state, before, command =
        match command with
        | Evidence.Command.Submit
            ({ ticket; manifest; review_request = None; expected_revision } as fields) ->
          let m =
            match Evidence.get_manifest t.evidence manifest with
            | Some m -> m
            | None -> Json.fail Not_found "manifest not found"
          in
          let recipients =
            Evidence.review_recipients
              t.evidence
              ~ticket_context:(evidence_ticket_context t)
              ~ticket
            |> List.map ~f:(fun a -> Communication.Recipient.Actor a)
          in
          if List.is_empty recipients
          then t, [], command
          else (
            let state, events, request =
              make_request
                t
                ~key:
                  (Id.Ticket.to_string ticket
                   ^ ":"
                   ^ Int.to_string expected_revision
                   ^ ":"
                   ^ Json.canonical (Evidence.Manifest_ref.jsonaf_of_t manifest))
                ~ticket
                ~manifest
                ~contract:m.contract
                ~recipients
                ~kind:Communication.Request.Kind.Review
                ~reply_to:None
                ~body:"Review the exact output manifest and contract."
            in
            ( state
            , events
            , Evidence.Command.Submit { fields with review_request = Some request } ))
        | _ -> t, [], command
      in
      let p =
        unwrap_domain
          (Evidence.prepare
             prepared_state.evidence
             ~ticket_context:(evidence_ticket_context prepared_state)
             command
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      let evidence_changes =
        List.map (Evidence.changes p) ~f:(fun change -> Event.Evidence_changed change)
      in
      let with_evidence =
        List.fold evidence_changes ~init:prepared_state ~f:apply_event
      in
      let after =
        match command with
        | Evidence.Command.Review { id; ticket; verdict = Request_changes; evidence; _ }
          ->
          let submission =
            Evidence.get_submission with_evidence.evidence ticket |> Option.value_exn
          in
          let m =
            Evidence.get_manifest with_evidence.evidence submission.manifest
            |> Option.value_exn
          in
          let a = Agent_run.get_attempt t.agent_runs m.attempt |> Option.value_exn in
          let recipients =
            [ Communication.Recipient.Actor submission.author.actor; Run a.run ]
          in
          let _, events, _ =
            make_request
              with_evidence
              ~key:("changes:" ^ Evidence_id.Review.to_string id)
              ~ticket
              ~manifest:submission.manifest
              ~contract:submission.contract
              ~recipients
              ~kind:Communication.Request.Kind.Blocker_resolution
              ~reply_to:submission.review_request
              ~body:evidence
          in
          events
        | Evidence.Command.Accept { ticket; _ } ->
          let submission =
            Evidence.get_submission with_evidence.evidence ticket |> Option.value_exn
          in
          (match submission.review_request with
           | None -> []
           | Some id ->
             let request =
               Communication.get_request with_evidence.communication id
               |> Option.value_exn
             in
             if
               Communication.Request.Status.equal request.status Open
               && Id.Actor.equal request.resolver actor
             then (
               let _, events, _, _ =
                 stage
                   with_evidence
                   (Communication
                      (Request_resolve { id; expected_revision = request.revision }))
                   ~actor
                   ~run
                   ~timestamp
                   ~now_unix_ms
               in
               events)
             else [])
        | _ -> []
      in
      before @ evidence_changes @ after, Evidence.result p, []
    | Domain_command.Agent_run command ->
      (match command with
       | Agent_run.Command.Coordination (Recover request) ->
         require
           (not (Map.mem t.ticket_recoveries request.recovery_id))
           Conflict
           "Recovery ID already exists"
       | Agent_run.Command.Attempt_start { run = target_run; ticket; token; _ } ->
         unwrap_domain
           (Agent_run_policy.validate_allocation t.policies target_run ~runs:t.agent_runs);
         require
           (Option.value_map run ~default:false ~f:(Id.Run.equal target_run))
           Stale_claim
           "attempt run and attribution differ";
         check_claim_at (find_ticket t ticket) ~actor ~run ~token ~now_unix_ms
       | Attempt_checkpoint { id; _ } ->
         ignore (attempt_owner t id ~actor ~run ~now_unix_ms () : Attempt.t)
       | Attempt_finish { id; state; _ } ->
         let a =
           attempt_owner
             t
             id
             ~actor
             ~run
             ~now_unix_ms
             ~check_lease:(Attempt.State.equal state Completed)
             ()
         in
         if Attempt.State.equal state Completed
         then (
           check_complete t (find_ticket t a.ticket);
           unwrap_domain
             (Evidence.ensure_attempt_can_complete
                t.evidence
                ~ticket_context:(evidence_ticket_context t)
                ~attempt:a.id
                ~ticket:a.ticket))
       | Register _
       | Transition _
       | Observe _
       | Link_session _
       | Reservation_acquire _
       | Reservation_release _
       | Reservation_renew _
       | Action_acknowledge _
       | Pool_put _
       | Coordination _
       | Ticket_policy_put _ -> ());
      let path_prepared =
        match command with
        | Agent_run.Command.Attempt_start { run = target_run; ticket; _ } ->
          Some
            (unwrap_domain
               (Agent_run.prepare_start_reservations
                  t.agent_runs
                  ~ticket
                  ~run:target_run
                  ~actor
                  ~timestamp
                  ~sequence:(t.revision + 1)
                  ~now_unix_ms:(Option.value now_unix_ms ~default:0L)))
        | _ -> None
      in
      let prepared_runs =
        Option.value_map path_prepared ~default:t.agent_runs ~f:Agent_run.candidate
      in
      let path_changes =
        Option.value_map path_prepared ~default:[] ~f:Agent_run.changes
      in
      let p =
        unwrap_domain
          (Agent_run.prepare
             ?now_unix_ms
             prepared_runs
             command
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      let changes =
        List.map
          (path_changes @ Agent_run.changes p)
          ~f:(fun c -> Event.Agent_run_changed c)
      in
      let changes =
        if List.is_empty changes
        then (
          match command with
          | Agent_run.Command.Coordination
              (Condition (External_condition.Command.Signal _ as command)) ->
            [ Event.Signal_receipt
                { command
                ; original =
                    External_condition.Signal.t_of_jsonaf
                      (Json.field (Agent_run.result p) "signal")
                }
            ]
          | _ -> changes)
        else changes
      in
      let with_runs = List.fold changes ~init:t ~f:apply_event in
      let _, notifications =
        List.fold
          (Agent_run.changes p)
          ~init:(with_runs, [])
          ~f:(fun (state, notifications) change ->
            match change.Agent_run.Change.update with
            | External_condition_changed changed ->
              let condition_id, summary =
                match changed with
                | External_condition.Change.Put d -> d.condition_id, "Declaration changed"
                | Signal s -> s.condition_id, s.summary
              in
              let d =
                External_condition.get
                  (Agent_run.external_conditions state.agent_runs)
                  condition_id
                |> Option.value_exn
              in
              let ticket = find_ticket state d.ticket_id in
              let actors =
                List.dedup_and_sort
                  ((d.creator :: d.recipients)
                   @ Option.to_list (Option.map ticket.claim ~f:(fun c -> c.Claim.actor))
                  )
                  ~compare:Id.Actor.compare
              in
              let message_id =
                External_condition.notification_id changed ~sequence:(t.revision + 1)
              in
              let body =
                Json.canonical
                  (Json.obj
                     [ "condition_id", Coordination_id.Condition.jsonaf_of_t condition_id
                     ; "revision", Json.int d.revision
                     ; ( "operation_id"
                       , Coordination_id.Operation.jsonaf_of_t d.operation_id )
                     ; ( "artifact"
                       , Coordination_wire.encode_exn Evidence_wire.pin d.artifact )
                     ; "label", Json.string d.label
                     ; ( "update"
                       , Json.string (Query_budget.prefix summary ~max_bytes:32768) )
                     ])
              in
              let state, added, _, _ =
                stage
                  state
                  (Domain_command.Message_send
                     { message_id
                     ; body
                     ; ticket_id = Some d.ticket_id
                     ; recipients =
                         List.map actors ~f:(fun a -> Communication.Recipient.Actor a)
                     ; teams = []
                     ; reply_to_message_id = None
                     ; correlation_id =
                         Some (Coordination_id.Condition.to_string condition_id)
                     })
                  ~actor
                  ~run
                  ~timestamp
                  ~now_unix_ms
              in
              state, notifications @ added
            | _ -> state, notifications)
      in
      changes @ notifications, Agent_run.result p, []
    | Domain_command.Claim_next
        { attempt; run = target_run; project; lease_duration_ms; leaf_only } ->
      unwrap_domain
        (Agent_run_policy.validate_allocation t.policies target_run ~runs:t.agent_runs);
      require
        (Option.value_map run ~default:false ~f:(Id.Run.equal target_run))
        Stale_claim
        "claim-next run and attribution differ";
      let registered =
        match Agent_run.get_run t.agent_runs target_run with
        | Some r -> r
        | None -> Json.fail Not_found "run is not registered"
      in
      require
        (Id.Actor.equal registered.actor actor
         && not (Agent_run.Status.terminal registered.status))
        Conflict
        "claim-next run actor differs or run is terminal";
      Option.iter project ~f:(fun id -> ignore (find_project t id : Project.t));
      require
        (Option.is_none (Agent_run.get_attempt t.agent_runs attempt))
        Conflict
        "attempt ID already exists";
      let candidates =
        Map.data t.tickets
        |> List.filter ~f:(fun ticket ->
          Option.value_map project ~default:true ~f:(fun id ->
            Option.value_map ticket.Ticket.project ~default:false ~f:(Id.Project.equal id)))
        |> List.map ~f:(fun ticket ->
          Agent_run.allocation_candidate
            t.agent_runs
            ~ticket:ticket.Ticket.id
            ~priority:ticket.priority
            ~creation_sequence:ticket.created_order
            ~ready:
              (ready ?now_unix_ms ~run:target_run t ticket
               && ((not leaf_only) || List.is_empty (unfinished_children t ticket)))
            ~available:(Option.is_none ticket.claim))
      in
      (match
         unwrap_domain
           (Allocation.choose candidates ~capabilities:registered.capabilities)
       with
       | Empty ->
         ( [ Event.Allocation_empty { run = target_run; attempt } ]
         , Json.obj [ "kind", Json.string "empty" ]
         , [] )
       | Selected selected ->
         let ticket = find_ticket t selected.ticket in
         let claimed, claim_events, claim_result, _ =
           stage
             t
             (match lease_duration_ms with
              | None ->
                Ticket_claim { id = ticket.id; expected_revision = ticket.revision }
              | Some lease_duration_ms ->
                Ticket_claim_with_lease
                  { id = ticket.id
                  ; expected_revision = ticket.revision
                  ; lease_duration_ms
                  })
             ~actor
             ~run
             ~timestamp
             ~now_unix_ms
         in
         let _, attempt_events, attempt_result, _ =
           stage
             claimed
             (Agent_run
                (Attempt_start
                   { id = attempt
                   ; run = target_run
                   ; ticket = ticket.id
                   ; token = ticket.next_token
                   ; sessions = []
                   }))
             ~actor
             ~run
             ~timestamp
             ~now_unix_ms
         in
         ( claim_events @ attempt_events
         , Json.obj
             [ "kind", Json.string "selected"
             ; "claim", claim_result
             ; "attempt", attempt_result
             ]
         , [] ))
    | Domain_command.Thread_reply
        { id; expected_revision; comment_id; reply_to; kind; body } ->
      let thread =
        match Communication.get_thread t.communication id with
        | Some thread -> thread
        | None -> Json.fail Not_found "thread not found"
      in
      expected thread.revision expected_revision;
      Option.iter reply_to ~f:(fun parent ->
        require
          (List.mem thread.messages parent ~equal:Id.Comment.equal)
          Conflict
          "reply parent is not attached to this thread");
      let target = unwrap_domain (Communication.thread_target t.communication id) in
      let comment_event, message =
        create_comment ~id:comment_id ~target ~reply_to ~kind body
      in
      let p =
        unwrap_domain
          (Communication.prepare
             t.communication
             (Thread_attach { id; expected_revision; message })
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      ( comment_event
        :: List.map (Communication.changes p) ~f:(fun change ->
          Event.Communication_changed change)
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t message
          ; "thread", Communication.result p
          ]
      , [] )
    | Domain_command.Message_send command ->
      let prepared =
        unwrap_domain
          (Communication.prepare_message
             t.communication
             command
             ~discussion:t.discussion
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      ( List.map (Communication.Message_prepared.changes prepared) ~f:(function
          | Discussion_change change -> Event.Comment_changed change
          | Communication_change change -> Event.Communication_changed change)
      , Communication.Message_prepared.result prepared
      , [] )
    | Domain_command.Communication command ->
      let prepared =
        match
          Communication.prepare
            t.communication
            command
            ~actor
            ~run
            ~timestamp
            ~sequence:(t.revision + 1)
        with
        | Ok prepared -> prepared
        | Error error -> raise (Json.Decode_error error)
      in
      ( List.map (Communication.changes prepared) ~f:(fun change ->
          Event.Communication_changed change)
      , Communication.result prepared
      , [] )
    | Domain_command.Batch _ ->
      Json.fail Invalid_argument "nested transactions are unsupported"
    | Facts command ->
      let change, result =
        unwrap_domain
          (Facts.prepare
             t.facts
             command
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      let method_, _ = unwrap_domain (Facts.Command.encode command) in
      let codec = unwrap_domain (Facts.response_codec method_) in
      (match Api_codec.encode codec result with
       | Ok _ -> ()
       | Error problem -> raise (Api_method.Invalid_response (method_, problem)));
      [ Event.Facts_changed change ], result, []
    | Settings_put command ->
      let change = Workflow.prepare t.workflow command in
      ( [ Event.Settings_changed change ]
      , unwrap_domain (Planning_result.settings change)
      , [] )
    | Workspace_update
        { expected_revision; name; description; instructions; summary; archived } ->
      expected t.settings.revision expected_revision;
      let settings =
        { Workspace_settings.description =
            Option.value description ~default:t.settings.description
        ; instructions = Option.value instructions ~default:t.settings.instructions
        ; summary = Option.value summary ~default:t.settings.summary
        ; name =
            (match name with
             | None -> t.settings.name
             | Some _ -> name)
        ; archived = Option.value archived ~default:t.settings.archived
        ; revision = expected_revision + 1
        }
      in
      [ Event.Workspace_updated settings ], Workspace_settings.jsonaf_of_t settings, []
    | Ticket_metadata
        { id
        ; expected_revision
        ; priority
        ; assignee
        ; labels
        ; acceptance_criteria
        ; status_id
        } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      Option.iter (Option.join assignee) ~f:(fun id ->
        require (not (Workflow.actor t.workflow id).archived) Conflict "actor is archived");
      Option.iter
        labels
        ~f:
          (List.iter ~f:(fun id ->
             require
               (not (Workflow.label t.workflow id).archived)
               Conflict
               "label is archived"));
      let status =
        match status_id with
        | None | Some None -> ticket.status
        | Some (Some id) ->
          let value = Workflow.status t.workflow id in
          require (not value.archived) Conflict "status is archived";
          require
            (Option.is_none ticket.claim)
            Already_claimed
            "release claim before changing status";
          value.category
      in
      require
        ((not (Domain_command.Status.equal ticket.status Done))
         || Domain_command.Status.equal status Done)
        Conflict
        "use ticket.reopen to replace completed work";
      require
        ((not (Domain_command.Status.equal status Done))
         || Domain_command.Status.equal ticket.status Done)
        Conflict
        "completion requires ownership and evidence; use ticket.finish or ticket.complete";
      let ticket =
        { ticket with
          status
        ; status_id = Option.value status_id ~default:ticket.status_id
        ; priority = Option.value priority ~default:ticket.priority
        ; assignee = Option.value assignee ~default:ticket.assignee
        ; labels =
            Option.value labels ~default:ticket.labels
            |> List.sort ~compare:Id.Label.compare
        ; acceptance_criteria =
            Option.value acceptance_criteria ~default:ticket.acceptance_criteria
        }
      in
      if Option.is_some (Option.join status_id) && Domain_command.Status.equal status Done
      then check_complete t ticket;
      [ update ticket ], Json.obj [ "revision", Json.int (ticket.revision + 1) ], []
    | Project_create { id; title; description } ->
      require (not (Map.mem t.projects id)) Conflict "project already exists";
      let p =
        { Project.id
        ; title
        ; description
        ; revision = 1
        ; status = Todo
        ; priority = 0
        ; summary = ""
        ; acceptance_criteria = ""
        ; archived = false
        }
      in
      [ Event.Project_put p ], project_view_json p, []
    | Project_update
        { id
        ; expected_revision
        ; title
        ; description
        ; status
        ; priority
        ; summary
        ; acceptance_criteria
        ; archived
        } ->
      let p = find_project t id in
      expected p.revision expected_revision;
      let p =
        { p with
          title = Option.value title ~default:p.title
        ; description = Option.value description ~default:p.description
        ; priority = Option.value priority ~default:p.priority
        ; status = Option.value status ~default:p.status
        ; summary = Option.value summary ~default:p.summary
        ; acceptance_criteria =
            Option.value acceptance_criteria ~default:p.acceptance_criteria
        ; archived = Option.value archived ~default:p.archived
        ; revision = p.revision + 1
        }
      in
      [ Event.Project_put p ], project_view_json p, []
    | Milestone_create { id; project; title; description; target_date } ->
      require (not (Map.mem t.milestones id)) Conflict "milestone already exists";
      let milestone =
        { Milestone.id
        ; project
        ; title
        ; description
        ; target_date
        ; status = Todo
        ; revision = 1
        ; archived = false
        }
      in
      [ Event.Milestone_put milestone ], milestone_view_json milestone, []
    | Milestone_update { id; expected_revision; title; description; status; archived } ->
      let milestone = find_milestone t id in
      expected milestone.revision expected_revision;
      let milestone =
        { milestone with
          title = Option.value title ~default:milestone.title
        ; description = Option.value description ~default:milestone.description
        ; status = Option.value status ~default:milestone.status
        ; archived = Option.value archived ~default:milestone.archived
        ; revision = milestone.revision + 1
        }
      in
      [ Event.Milestone_put milestone ], milestone_view_json milestone, []
    | Milestone_schedule { id; expected_revision; target_date } ->
      let milestone = find_milestone t id in
      expected milestone.revision expected_revision;
      let milestone = { milestone with target_date; revision = milestone.revision + 1 } in
      [ Event.Milestone_put milestone ], milestone_view_json milestone, []
    | Ticket_move { id; expected_revision; project; milestone; parent } ->
      let root = find_ticket t id in
      expected root.revision expected_revision;
      let tickets =
        Map.data t.tickets
        |> List.filter ~f:(fun ticket ->
          reachable t ~from:ticket.Ticket.id ~target:id ~parents:true)
      in
      let changes =
        List.map tickets ~f:(fun ticket ->
          let is_root = Id.Ticket.equal ticket.Ticket.id id in
          let milestone =
            if is_root
            then milestone
            else if Option.equal Id.Project.equal project ticket.project
            then ticket.milestone
            else None
          in
          update
            { ticket with
              project
            ; membership_revision =
                (ticket.membership_revision
                 + if Option.equal Id.Project.equal project ticket.project then 0 else 1)
            ; milestone
            ; parent = (if is_root then parent else ticket.parent)
            })
      in
      changes, Json.obj [ "moved", Json.int (List.length changes) ], []
    | Ticket_archive { id; expected_revision; archived } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      ( [ update { ticket with archived } ]
      , Json.obj [ ("archived", if archived then `True else `False) ]
      , [] )
    | Ticket_create { id; title; description; project; parent; milestone } ->
      require (not (Map.mem t.tickets id)) Conflict "ticket already exists";
      let ticket =
        { Ticket.id
        ; display_key = "WG-" ^ Int.to_string (Map.length t.tickets + 1)
        ; title
        ; description
        ; project
        ; membership_revision = 1
        ; parent
        ; milestone
        ; archived = false
        ; status_id = None
        ; priority = 0
        ; assignee = None
        ; labels = []
        ; acceptance_criteria = ""
        ; status = Todo
        ; revision = 1
        ; hold = None
        ; waivers = []
        ; prerequisites = []
        ; related = []
        ; claim = None
        ; created_order = Map.length t.tickets + 1
        ; reopened_token = None
        ; reassessments = []
        ; created_sequence = t.revision + 1
        ; created_at = timestamp
        ; updated_at = timestamp
        ; next_token = 1
        }
      in
      [ Event.Ticket_put ticket ], ticket_view_json ticket, []
    | Ticket_update { id; expected_revision; title; description; status } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      require
        (Option.is_none ticket.claim)
        Already_claimed
        "release the claim or use ticket.complete";
      require
        ((not (Domain_command.Status.equal ticket.status Done))
         || Option.for_all status ~f:(Domain_command.Status.equal Done))
        Conflict
        "use ticket.reopen to replace completed work";
      require
        ((not
            (Option.value_map status ~default:false ~f:(Domain_command.Status.equal Done)))
         || Domain_command.Status.equal ticket.status Done)
        Conflict
        "completion requires ownership and evidence; use ticket.finish or ticket.complete";
      let ticket =
        { ticket with
          title = Option.value title ~default:ticket.title
        ; description = Option.value description ~default:ticket.description
        ; status = Option.value status ~default:ticket.status
        ; status_id = (if Option.is_some status then None else ticket.status_id)
        }
      in
      if Option.value_map status ~default:false ~f:(Domain_command.Status.equal Done)
      then check_complete t ticket;
      let event = update ticket in
      ( [ event ]
      , Json.obj
          [ "ticket_id", Id.Ticket.jsonaf_of_t id
          ; "revision", Json.int (ticket.revision + 1)
          ]
      , [] )
    | Ticket_hold { id; expected_revision; reason } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      let hold = Option.map reason ~f:(fun reason -> { Hold.actor; reason; timestamp }) in
      ( [ update { ticket with hold } ]
      , Json.obj [ "revision", Json.int (ticket.revision + 1) ]
      , [] )
    | Dependency_waive { ticket; prerequisite; expected_revision; reason } ->
      let ticket = find_ticket t ticket in
      expected ticket.revision expected_revision;
      require
        (List.mem ticket.prerequisites prerequisite ~equal:Id.Ticket.equal)
        Not_found
        "dependency absent";
      let waivers =
        List.filter ticket.waivers ~f:(fun waiver ->
          not (Id.Ticket.equal waiver.Waiver.prerequisite prerequisite))
      in
      let waivers =
        match reason with
        | None -> waivers
        | Some reason -> { Waiver.prerequisite; actor; reason; timestamp } :: waivers
      in
      let waivers =
        List.sort waivers ~compare:(fun a b ->
          Id.Ticket.compare a.Waiver.prerequisite b.prerequisite)
      in
      ( [ update { ticket with waivers } ]
      , Json.obj [ "revision", Json.int (ticket.revision + 1) ]
      , [] )
    | Related_link
        { ticket; related; expected_revision; related_expected_revision; linked } ->
      require
        (not (Id.Ticket.equal ticket related))
        Conflict
        "ticket cannot relate to itself";
      let ticket = find_ticket t ticket
      and related = find_ticket t related in
      expected ticket.revision expected_revision;
      expected related.revision related_expected_revision;
      let present = List.mem ticket.related related.id ~equal:Id.Ticket.equal in
      require
        (not (Bool.equal present linked))
        (if linked then Conflict else Not_found)
        (if linked then "related link already exists" else "related link absent");
      let change (item : Ticket.t) id =
        let values =
          if linked
          then id :: item.related
          else
            List.filter item.related ~f:(fun candidate ->
              not (Id.Ticket.equal candidate id))
        in
        update { item with related = List.sort values ~compare:Id.Ticket.compare }
      in
      ( [ change ticket related.id; change related ticket.id ]
      , Json.obj
          [ "ticket_revision", Json.int (ticket.revision + 1)
          ; "related_revision", Json.int (related.revision + 1)
          ]
      , [] )
    | Ticket_reassign { id; expected_revision; claimant; claimant_run; reason } ->
      require
        (List.is_empty (active_attempts t id))
        Conflict
        "finish the active attempt before reassigning its ticket";
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      bounded reason 65_536;
      require
        (not (String.is_empty (String.strip reason)))
        Invalid_argument
        "reassignment requires a reason";
      require (Option.is_some ticket.claim) Conflict "ticket has no claim to reassign";
      let token = ticket.next_token in
      require
        (Option.is_some claimant || Option.is_none claimant_run)
        Invalid_argument
        "claimant run requires a claimant";
      let claim =
        Option.map claimant ~f:(fun actor ->
          { Claim.actor
          ; run_id = claimant_run
          ; token
          ; lease = new_lease ~token ~duration:None ~now_unix_ms
          })
      in
      let status =
        if Option.is_some claim then Domain_command.Status.In_progress else Todo
      in
      ( [ update { ticket with claim; status; status_id = None; next_token = token + 1 }
        ; comment id Decision reason
        ]
      , Json.obj [ ("token", if Option.is_some claim then Json.int token else `Null) ]
      , [] )
    | Dependency_add { ticket; prerequisite } ->
      let value = find_ticket t ticket in
      ignore (find_ticket t prerequisite : Ticket.t);
      require
        (not (List.mem value.prerequisites prerequisite ~equal:Id.Ticket.equal))
        Conflict
        "dependency exists";
      let value =
        { value with
          prerequisites =
            List.sort (prerequisite :: value.prerequisites) ~compare:Id.Ticket.compare
        }
      in
      [ update value ], Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t ticket ], []
    | Dependency_remove { ticket; prerequisite } ->
      let value = find_ticket t ticket in
      require
        (List.mem value.prerequisites prerequisite ~equal:Id.Ticket.equal)
        Not_found
        "dependency absent";
      ( [ update
            { value with
              prerequisites =
                List.filter value.prerequisites ~f:(fun id ->
                  not (Id.Ticket.equal id prerequisite))
            ; waivers =
                List.filter value.waivers ~f:(fun waiver ->
                  not (Id.Ticket.equal waiver.Waiver.prerequisite prerequisite))
            }
        ]
      , Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t ticket ]
      , [] )
    | Ticket_claim { id; expected_revision }
    | Ticket_claim_with_lease { id; expected_revision; lease_duration_ms = _ } ->
      let duration =
        match command with
        | Ticket_claim_with_lease { lease_duration_ms; _ } -> Some lease_duration_ms
        | _ -> None
      in
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      require (Option.is_none ticket.claim) Already_claimed "ticket is claimed";
      require
        (ready ?run ?now_unix_ms t ticket)
        Blocked
        ("ticket is not ready: " ^ Json.canonical (readiness ?run ?now_unix_ms t ticket));
      let path_changes =
        match run with
        | None -> []
        | Some run ->
          Agent_run.prepare_start_reservations
            t.agent_runs
            ~ticket:id
            ~run
            ~actor
            ~timestamp
            ~sequence:(t.revision + 1)
            ~now_unix_ms:(Option.value now_unix_ms ~default:0L)
          |> unwrap_domain
          |> Agent_run.changes
          |> List.map ~f:(fun c -> Event.Agent_run_changed c)
      in
      let token = ticket.next_token in
      ( path_changes
        @ [ update
              { ticket with
                claim =
                  Some
                    { Claim.actor
                    ; run_id = run
                    ; token
                    ; lease = new_lease ~token ~duration ~now_unix_ms
                    }
              ; next_token = token + 1
              ; status = In_progress
              ; status_id = None
              }
          ]
      , Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t id; "token", Json.int token ]
      , [] )
    | Ticket_renew_lease { id; token; expected_lease_revision } ->
      let ticket = find_ticket t id in
      check_claim_at ticket ~actor ~run ~token ~now_unix_ms;
      let claim = Option.value_exn ticket.claim in
      let now =
        match now_unix_ms with
        | Some now -> now
        | None -> Json.fail Invalid_argument "lease renewal requires server clock"
      in
      let lease =
        unwrap_domain
          (Allocation_lease.renew
             claim.lease
             ~expected_revision:expected_lease_revision
             ~epoch:token
             ~now_unix_ms:now)
      in
      ( [ update { ticket with claim = Some { claim with lease } } ]
      , Json.obj
          [ "ticket_id", Id.Ticket.jsonaf_of_t id
          ; "lease", Allocation_lease.to_json lease
          ]
      , [] )
    | Ticket_release { id; token } ->
      let ticket = find_ticket t id in
      check_claim ticket ~actor ~run ~token;
      let finished =
        List.concat_map (active_attempts t ticket.id) ~f:(fun a ->
          let p =
            unwrap_domain
              (Agent_run.prepare
                 ?now_unix_ms
                 t.agent_runs
                 (Attempt_finish
                    { id = a.id
                    ; expected_revision = a.revision
                    ; state = Cancelled
                    ; evidence = "ticket claim released"
                    })
                 ~actor
                 ~run
                 ~timestamp
                 ~sequence:(t.revision + 1))
          in
          List.map (Agent_run.changes p) ~f:(fun c -> Event.Agent_run_changed c))
      in
      ( finished @ [ update { ticket with claim = None; status = Todo; status_id = None } ]
      , Json.obj [ "released", `True ]
      , [] )
    | Ticket_complete { id; token; evidence } ->
      let ticket = find_ticket t id in
      check_claim_at ticket ~actor ~run ~token ~now_unix_ms;
      check_complete t ticket;
      require
        (not (String.is_empty (String.strip evidence)))
        Invalid_argument
        "completion requires evidence";
      let finished =
        List.concat_map (active_attempts t ticket.id) ~f:(fun a ->
          ignore (attempt_owner t a.id ~actor ~run ~now_unix_ms () : Attempt.t);
          unwrap_domain
            (Evidence.ensure_attempt_can_complete
               t.evidence
               ~ticket_context:(evidence_ticket_context t)
               ~attempt:a.id
               ~ticket:a.ticket);
          let p =
            unwrap_domain
              (Agent_run.prepare
                 ?now_unix_ms
                 t.agent_runs
                 (Attempt_finish
                    { id = a.id
                    ; expected_revision = a.revision
                    ; state = Completed
                    ; evidence
                    })
                 ~actor
                 ~run
                 ~timestamp
                 ~sequence:(t.revision + 1))
          in
          List.map (Agent_run.changes p) ~f:(fun c -> Event.Agent_run_changed c))
      in
      ( finished
        @ [ update { ticket with claim = None; status = Done; status_id = None }
          ; comment ~origin:Completion id Evidence evidence
          ]
      , Json.obj [ "completed", `True ]
      , [] )
    | Comment_add { id; target; reply_to; kind; body } ->
      let change, id = create_comment ~id ~target ~reply_to ~kind body in
      ( [ change ]
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t id
          ; "sequence", Json.int (t.revision + 1)
          ; "revision", Json.int 1
          ]
      , [] )
    | Comment_edit { id; expected_revision; body; tombstone } ->
      expected (Discussion.revision t.discussion id) expected_revision;
      let change =
        Discussion.Change.Revise
          { id; version = version ~revision:(expected_revision + 1) body ~tombstone }
      in
      ( [ Event.Comment_changed change ]
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t id
          ; "revision", Json.int (expected_revision + 1)
          ]
      , [] )
    | Ticket_progress { ticket; token; kind; body } ->
      check_claim_at (find_ticket t ticket) ~actor ~run ~token ~now_unix_ms;
      let change, id =
        create_comment
          ~id:None
          ~target:(Entity_ref.Ticket ticket)
          ~reply_to:None
          ~kind
          body
      in
      ( [ change ]
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t id
          ; "sequence", Json.int (t.revision + 1)
          ]
      , [] )
    | Handoff_set
        { ticket
        ; expected_revision
        ; token
        ; summary
        ; next_steps
        ; evidence
        ; objective
        ; completed
        ; decisions
        ; blockers
        ; resources
        ; covers_through
        } ->
      let value = find_ticket t ticket in
      (match value.claim, token with
       | None, None -> ()
       | Some _, Some token -> check_claim_at value ~actor ~run ~token ~now_unix_ms
       | Some _, None | None, Some _ ->
         Json.fail Stale_claim "handoff requires current claim token");
      let current =
        Option.value_map (Map.find t.handoffs ticket) ~default:0 ~f:(fun h ->
          h.Handoff.revision)
      in
      expected current expected_revision;
      let handoff =
        { Handoff.ticket
        ; actor
        ; summary
        ; next_steps
        ; evidence
        ; objective
        ; completed
        ; decisions
        ; blockers
        ; resources
        ; timestamp
        ; revision = current + 1
        ; covers_through = Option.value covers_through ~default:0
        }
      in
      [ Event.Handoff_put handoff ], handoff_view_json handoff, []
    | Resource_put { id; expected_revision; title; text; filename; mime_type } ->
      bounded text 65_536;
      let digest = Json.hash text in
      let previous = Map.find t.resources id in
      let filename =
        Option.value
          filename
          ~default:
            (Option.value_map
               previous
               ~default:(Id.Resource.to_string id ^ ".txt")
               ~f:(fun r -> r.Resource.metadata.filename))
      in
      let mime_type =
        Option.value
          mime_type
          ~default:
            (Option.value_map previous ~default:"text/plain" ~f:(fun r ->
               r.Resource.metadata.mime_type))
      in
      let event, result =
        publish
          ~id
          ~expected_revision
          ~title
          ~filename
          ~mime_type
          ~digest
          ~size_bytes:(String.length text)
      in
      [ event ], result, [ digest, text ]
    | Resource_publish
        { id; expected_revision; title; filename; mime_type; digest; size_bytes } ->
      let event, result =
        publish ~id ~expected_revision ~title ~filename ~mime_type ~digest ~size_bytes
      in
      [ event ], result, []
    | Resource_metadata
        { id; expected_revision; title; filename; mime_type; description; archived } ->
      let resource =
        match Map.find t.resources id with
        | Some r -> r
        | None -> Json.fail Not_found "resource not found"
      in
      expected resource.revision expected_revision;
      let old = resource.metadata in
      let metadata =
        { old with
          title = Option.value title ~default:old.title
        ; filename = Option.value filename ~default:old.filename
        ; mime_type = Option.value mime_type ~default:old.mime_type
        ; description = Option.value description ~default:old.description
        ; archived = Option.value archived ~default:old.archived
        }
      in
      ( [ Event.Resource_changed
            (Metadata_changed { id; revision = resource.revision + 1; metadata })
        ]
      , Json.obj [ "revision", Json.int (resource.revision + 1) ]
      , [] )
    | Resource_link { id; expected_revision; target; remove } ->
      let resource =
        match Map.find t.resources id with
        | Some r -> r
        | None -> Json.fail Not_found "resource not found"
      in
      expected resource.revision expected_revision;
      require
        (not (Entity_ref.equal target (Entity_ref.Resource id)))
        Invalid_argument
        "resource cannot attach to itself";
      let targets = resource.metadata.targets in
      require
        (Bool.equal (List.mem targets target ~equal:Entity_ref.equal) remove)
        Conflict
        "resource link already exists or is absent";
      let targets =
        if remove
        then List.filter targets ~f:(fun old -> not (Entity_ref.equal target old))
        else target :: targets |> List.sort ~compare:Entity_ref.compare
      in
      let metadata = { resource.metadata with targets } in
      ( [ Event.Resource_changed
            (Metadata_changed { id; revision = resource.revision + 1; metadata })
        ]
      , Json.obj [ "revision", Json.int (resource.revision + 1) ]
      , [] )
  in
  (* Validate covered public receipts while preparation is still pure, including
     each operation in a batch. No malformed receipt reaches durable storage. *)
  (match Planning_api.encode command with
   | Some encoded ->
     let method_, _ = unwrap_domain encoded in
     ignore (Planning_api.validate_result ~method_ result : unit option)
   | None -> ());
  (match command with
   | Agent_run command ->
     let method_, _ = Agent_run.encode command in
     ignore (Agent_run_api.validate_result ~method_ result : unit option)
   | Lifecycle command ->
     let method_, _ = unwrap_domain (Ticket_lifecycle.Command.encode command) in
     ignore
       (unwrap_domain
          (Api_codec.decode
             (unwrap_domain (Ticket_lifecycle.response_codec method_))
             result)
        : Jsonaf.t)
   | _ -> ());
  let staged, resolved =
    List.fold changes ~init:(t, []) ~f:(fun (state, resolved) change ->
      let updated = apply_event state change in
      match change with
      | Event.Resource_changed (Resource.Change.Published { id; version; _ }) ->
        (match Map.find state.resources id with
         | None -> updated, change :: resolved
         | Some old ->
           let previous = Resource.get_version old ~revision:None in
           let resource_pin (v : Resource.Version.t) =
             Evidence.Pin.Resource { id; revision = v.revision; digest = v.digest }
           in
           let p =
             unwrap_domain
               (Evidence.prepare
                  updated.evidence
                  ~ticket_context:(evidence_ticket_context updated)
                  (Input_changed
                     { previous = resource_pin previous; current = resource_pin version })
                  ~actor
                  ~run
                  ~timestamp
                  ~sequence:(t.revision + 1))
           in
           let evidence_changes =
             List.map (Evidence.changes p) ~f:(fun event -> Event.Evidence_changed event)
           in
           let final = List.fold evidence_changes ~init:updated ~f:apply_event in
           final, List.rev_append evidence_changes (change :: resolved))
      | Event.Comment_changed (Discussion.Change.Revise { id; version }) ->
        let previous =
          Evidence.Pin.Comment { id; revision = Discussion.revision state.discussion id }
        in
        let current = Evidence.Pin.Comment { id; revision = version.revision } in
        let p =
          unwrap_domain
            (Evidence.prepare
               updated.evidence
               ~ticket_context:(evidence_ticket_context updated)
               (Input_changed { previous; current })
               ~actor
               ~run
               ~timestamp
               ~sequence:(t.revision + 1))
        in
        let evidence_changes =
          List.map (Evidence.changes p) ~f:(fun event -> Event.Evidence_changed event)
        in
        let final = List.fold evidence_changes ~init:updated ~f:apply_event in
        final, List.rev_append evidence_changes (change :: resolved)
      | Facts_changed _
      | Communication_changed _
      | Agent_run_changed _
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
      | Comment_changed (Create _)
      | Handoff_put _
      | Resource_changed (Metadata_changed _) -> updated, change :: resolved)
  in
  staged, List.rev resolved, result, blobs
;;

let prepare t ?run ?now_unix_ms command ~actor ~timestamp =
  Json.decode (fun () ->
    require (t.revision < 100_000) Invalid_argument "MVP transaction limit is 100000";
    let commands, is_batch =
      match command with
      | Domain_command.Batch commands -> commands, true
      | command -> [ command ], false
    in
    require
      ((not (List.is_empty commands)) && List.length commands <= 32)
      Invalid_argument
      "transaction requires 1..32 operations";
    let staged, changes, results, blobs, _ =
      List.fold
        commands
        ~init:(t, [], [], [], 0)
        ~f:(fun (state, events, results, blobs, operations) command ->
          let count =
            match command with
            | Domain_command.Template_instantiate
                { template; template_revision; id; parameters } ->
              if Option.is_some (Agent_run_policy.get_instance state.policies id)
              then 1
              else
                List.length
                  (snd
                     (instantiate_plan state ~template ~template_revision ~id ~parameters))
            | Batch _
            | Message_send _
            | Communication _
            | Agent_run _
            | Evidence _
            | Policy _
            | Claim_next _
            | Thread_reply _
            | Facts _
            | Lifecycle _
            | Settings_put _
            | Workspace_update _
            | Ticket_metadata _
            | Project_create _
            | Project_update _
            | Milestone_create _
            | Milestone_update _
            | Milestone_schedule _
            | Ticket_move _
            | Ticket_archive _
            | Ticket_create _
            | Ticket_update _
            | Ticket_hold _
            | Dependency_waive _
            | Ticket_reassign _
            | Dependency_add _
            | Dependency_remove _
            | Related_link _
            | Ticket_claim _
            | Ticket_claim_with_lease _
            | Ticket_renew_lease _
            | Ticket_release _
            | Ticket_complete _
            | Comment_add _
            | Comment_edit _
            | Ticket_progress _
            | Handoff_set _
            | Resource_put _
            | Resource_publish _
            | Resource_metadata _
            | Resource_link _ -> 1
          in
          require
            (operations + count <= 32)
            Invalid_argument
            "expanded transaction exceeds 32 atomic operations";
          let state, changes, result, new_blobs =
            stage state command ~actor ~run ~timestamp ~now_unix_ms
          in
          ( state
          , List.rev_append changes events
          , result :: results
          , List.rev_append new_blobs blobs
          , operations + count ))
    in
    validate staged;
    List.iter changes ~f:(function
      | Event.Agent_run_changed { update = Agent_run_event.Update.Attempt_put attempt; _ }
        when Attempt.State.equal attempt.state Completed ->
        check_complete staged (find_ticket staged attempt.ticket);
        unwrap_domain
          (Evidence.ensure_attempt_can_complete
             staged.evidence
             ~ticket_context:(evidence_ticket_context staged)
             ~attempt:attempt.id
             ~ticket:attempt.ticket)
      | _ -> ());
    (* Later operations must not invalidate a completion performed in this batch. *)
    List.iter commands ~f:(function
      | Domain_command.Lifecycle (Ticket_lifecycle.Command.Finish { ticket_id = id; _ })
      | Domain_command.Ticket_complete { id; _ }
      | Ticket_update { id; status = Some Done; _ }
      | Ticket_metadata { id; status_id = Some (Some _); _ } ->
        let ticket = find_ticket staged id in
        if Domain_command.Status.equal ticket.status Done
        then check_complete staged ticket
      | Agent_run
          (Agent_run.Command.Attempt_finish { id; state = Attempt.State.Completed; _ }) ->
        let attempt =
          match Agent_run.get_attempt staged.agent_runs id with
          | Some a -> a
          | None -> Json.fail Not_found "completed attempt not found"
        in
        unwrap_domain
          (Evidence.ensure_attempt_can_complete
             staged.evidence
             ~ticket_context:(evidence_ticket_context staged)
             ~attempt:attempt.id
             ~ticket:attempt.ticket)
      | Batch _
      | Message_send _
      | Communication _
      | Agent_run _
      | Evidence _
      | Policy _
      | Template_instantiate _
      | Claim_next _
      | Thread_reply _
      | Facts _
      | Lifecycle _
      | Settings_put _
      | Workspace_update _
      | Project_create _
      | Project_update _
      | Milestone_create _
      | Milestone_update _
      | Milestone_schedule _
      | Ticket_hold _
      | Ticket_reassign _
      | Dependency_waive _
      | Ticket_move _
      | Ticket_archive _
      | Ticket_create _
      | Ticket_update _
      | Ticket_metadata _
      | Dependency_add _
      | Dependency_remove _
      | Ticket_claim _
      | Ticket_claim_with_lease _
      | Ticket_renew_lease _
      | Ticket_release _
      | Comment_edit _
      | Ticket_progress _
      | Comment_add _
      | Handoff_set _
      | Resource_publish _
      | Resource_metadata _
      | Resource_link _
      | Related_link _
      | Resource_put _ -> ());
    let events =
      Json.obj
        [ "version", Json.int 1
        ; "revision", Json.int (t.revision + 1)
        ; "actor", Id.Actor.jsonaf_of_t actor
        ; "timestamp", Json.string timestamp
        ; "changes", `Array (List.map (List.rev changes) ~f:Event.jsonaf_of_t)
        ]
    in
    let events =
      match events, run with
      | `Object fields, Some run -> Json.obj (("run_id", Id.Run.jsonaf_of_t run) :: fields)
      | _, None -> events
      | _, Some _ -> assert false
    in
    let candidate =
      match replay t events with
      | Ok state -> state
      | Error error -> raise (Json.Decode_error error)
    in
    let result =
      if is_batch
      then
        Transaction_api.result
          (List.map2_exn commands (List.rev results) ~f:(fun command data ->
             let method_, _ = unwrap_domain (Wire_command.encode command) in
             { Transaction_api.Result_item.method_; data }))
      else List.hd_exn results
    in
    { candidate; events; result; blobs = List.rev blobs })
;;

let required_blobs prepared =
  Json.list (Json.field prepared.events "changes")
  |> List.filter_map ~f:(fun change ->
    match Event.t_of_jsonaf change with
    | Resource_changed (Resource.Change.Published { version; _ }) ->
      Some (version.digest, version.size_bytes)
    | Resource_changed (Metadata_changed _)
    | Facts_changed _
    | Communication_changed _
    | Agent_run_changed _
    | Evidence_changed _
    | Allocation_empty _
    | Ticket_recovered _
    | Signal_receipt _
    | Policy_changed _
    | Policy_unchanged _
    | Project_put _
    | Milestone_put _
    | Ticket_put _
    | Comment_changed _
    | Handoff_put _
    | Settings_changed _
    | Workspace_updated _ -> None)
;;
