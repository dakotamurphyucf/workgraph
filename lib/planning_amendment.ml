open Core
open Planning_state
module A = Ticket_amendment

let json codec value = Api_codec.encode codec value |> unwrap_domain

let effects state change ~actor ~run ~timestamp =
  match change.A.Change.update with
  | Acknowledged _ -> []
  | Revisions records ->
    let _, invalidations =
      List.fold records ~init:(state.evidence, []) ~f:(fun (evidence, events) record ->
        match A.head state.amendments record.A.Revision.reference.id with
        | None -> evidence, events
        | Some previous ->
          let pin reference =
            Evidence.Pin.Amendment
              { id = reference.A.Reference.id; revision = reference.revision }
          in
          let prepared =
            Evidence.prepare
              evidence
              (Input_changed
                 { previous = pin previous.reference; current = pin record.reference })
              ~ticket_context:(evidence_ticket_context state)
              ~actor
              ~run
              ~timestamp
              ~sequence:(state.revision + 1)
            |> unwrap_domain
          in
          ( Evidence.candidate prepared
          , events
            @ List.map (Evidence.changes prepared) ~f:(fun change ->
              Event.Evidence_changed change) ))
    in
    (match records with
     | [] -> Json.fail Invalid_argument "amendment effects require revisions"
     | first :: _ ->
       let ticket = find_ticket state first.ticket in
       let notifications =
         match ticket.claim with
         | None -> []
         | Some claim ->
           let body =
             Json.obj
               [ "kind", `String "ticket_amendment_announcement"
               ; "ticket_id", Id.Ticket.jsonaf_of_t ticket.id
               ; ( "changes"
                 , `Array
                     (List.map records ~f:(fun record ->
                        let action, source =
                          match record.A.Revision.content with
                          | Published _ -> "published", record.reference
                          | Withdrawn { previous; _ } -> "withdrawn", previous
                          | Superseded { previous; _ } -> "superseded", previous
                        in
                        Json.obj
                          [ "reference", json A.Reference.codec record.reference
                          ; "action", `String action
                          ; "source", json A.Reference.codec source
                          ; "expand_method", `String "ticket.amendment.get"
                          ])) )
               ]
             |> Json.canonical
           in
           let message_id =
             "amendment_"
             ^ String.prefix (Json.hash (Json.canonical (A.Change.to_json change))) 48
             |> Communication_id.Message.of_string
             |> unwrap_domain
           in
           let recipients =
             Communication.Recipient.Actor claim.actor
             :: (Option.to_list claim.run_id
                 |> List.map ~f:(fun run -> Communication.Recipient.Run run))
           in
           let prepared =
             Communication.prepare_message
               state.communication
               { message_id
               ; body
               ; ticket_id = Some ticket.id
               ; recipients
               ; teams = []
               ; reply_to_message_id = None
               ; correlation_id =
                   Some ("amendment:" ^ Amendment_id.to_string first.reference.id)
               }
               ~discussion:state.discussion
               ~actor
               ~run
               ~timestamp
               ~sequence:(state.revision + 1)
             |> unwrap_domain
           in
           Communication.Message_prepared.changes prepared
           |> List.map ~f:(function
             | Discussion_change change -> Event.Comment_changed change
             | Communication_change change -> Event.Communication_changed change)
       in
       invalidations @ notifications)
;;
