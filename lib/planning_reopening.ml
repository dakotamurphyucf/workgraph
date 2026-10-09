open Core
open Planning_state

let excerpt ~prefix reason =
  let max_bytes = 65_536 in
  if String.length prefix + String.length reason <= max_bytes
  then prefix ^ reason
  else (
    let suffix =
      "\n[Reason excerpt; full reason retained in the reopening reassessment.]"
    in
    prefix
    ^ Query_budget.prefix
        reason
        ~max_bytes:(max_bytes - String.length prefix - String.length suffix)
    ^ suffix)
;;

let effects_exn t ~source ~reason ~actor ~run ~timestamp =
  bounded reason 65_536;
  require
    (not (String.is_empty (String.strip reason)))
    Invalid_argument
    "reopening requires a reason";
  require
    (Domain_command.Status.equal source.Ticket.status Done)
    Conflict
    "only completed tickets can be reopened";
  let reassessment =
    { Reassessment.prerequisite = source.id
    ; reopened_revision = t.revision + 1
    ; reason
    ; actor
    ; timestamp
    }
  in
  let update (ticket : Ticket.t) =
    Event.Ticket_put
      { ticket with Ticket.revision = ticket.revision + 1; updated_at = timestamp }
  in
  let decision state ticket body =
    let change =
      Discussion.Change.Create
        { id = Discussion.generated_id state.discussion ~sequence:(t.revision + 1)
        ; target = Ticket ticket
        ; reply_to = None
        ; kind = Decision
        ; origin = Authored
        ; version =
            { revision = 1
            ; serial = Discussion.next_serial state.discussion
            ; sequence = t.revision + 1
            ; actor
            ; timestamp
            ; body
            ; tombstone = false
            }
        }
    in
    ( { state with
        discussion = Discussion.apply state.discussion change ~sequence:(t.revision + 1)
      }
    , Event.Comment_changed change )
  in
  let first =
    update
      { source with
        status = Todo
      ; status_id = None
      ; claim = None
      ; reopened_token = Some source.next_token
      ; reassessments = source.reassessments @ [ reassessment ]
      }
  in
  let state, source_decision =
    decision t source.id (excerpt ~prefix:"Reopened: " reason)
  in
  let dependents =
    Map.data t.tickets
    |> List.filter ~f:(fun dependent ->
      List.mem dependent.Ticket.prerequisites source.id ~equal:Id.Ticket.equal
      && not (waived dependent source.id))
  in
  let _, effects =
    List.fold
      dependents
      ~init:(state, [ source_decision; first ])
      ~f:(fun (state, effects) dependent ->
        let dependent_event =
          update
            { dependent with reassessments = dependent.reassessments @ [ reassessment ] }
        in
        let prefix = "Prerequisite " ^ Id.Ticket.to_string source.id ^ " reopened: " in
        let state, comment = decision state dependent.id (excerpt ~prefix reason) in
        let state, notifications =
          match dependent.claim with
          | None -> state, []
          | Some claim ->
            let identity =
              String.concat
                ~sep:":"
                [ Int.to_string (t.revision + 1)
                ; Id.Ticket.to_string source.id
                ; Int.to_string (source.revision + 1)
                ; Id.Ticket.to_string dependent.id
                ]
            in
            let message_id =
              unwrap_domain
                (Communication_id.Message.of_string ("reopen-" ^ Json.hash identity))
            in
            let recipient =
              match claim.run_id with
              | Some run -> Communication.Recipient.Run run
              | None -> Actor claim.actor
            in
            let prepared =
              unwrap_domain
                (Communication.prepare_message
                   state.communication
                   { message_id
                   ; body = excerpt ~prefix reason
                   ; ticket_id = Some dependent.id
                   ; recipients = [ recipient ]
                   ; teams = []
                   ; reply_to_message_id = None
                   ; correlation_id = Some (Id.Ticket.to_string source.id)
                   }
                   ~discussion:state.discussion
                   ~actor
                   ~run
                   ~timestamp
                   ~sequence:(t.revision + 1))
            in
            let notifications =
              List.map (Communication.Message_prepared.changes prepared) ~f:(function
                | Discussion_change change -> Event.Comment_changed change
                | Communication_change change -> Event.Communication_changed change)
            in
            ( { state with
                discussion = Communication.Message_prepared.discussion prepared
              ; communication = Communication.Message_prepared.candidate prepared
              }
            , notifications )
        in
        state, List.rev_append notifications (comment :: dependent_event :: effects))
  in
  List.rev effects
;;
