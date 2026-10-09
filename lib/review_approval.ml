open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let explanation =
  "One reviewer approved this submission. Other review and validation requirements may \
   remain."
;;

type t =
  { ticket : Id.Ticket.t
  ; generation : int
  ; manifest : Evidence.Manifest_ref.t
  ; contract : Evidence.Contract_ref.t
  ; review : Evidence_id.Review.t
  ; review_serial : int
  ; submitter : Evidence_event.Attribution.t
  ; reviewer : Evidence_event.Attribution.t
  }

let codec =
  Api_codec.object_
    (Fields.map
       (Fields.required "kind" (Api_codec.literal "review_approved")
        ++ Fields.required "ticket_id" Coordination_wire.ticket
        ++ Fields.required "generation" Coordination_wire.positive
        ++ Fields.required "manifest" Evidence_wire.manifest_ref
        ++ Fields.required "contract" Evidence_wire.contract_ref
        ++ Fields.required
             "review_id"
             (Coordination_wire.id
                Evidence_id.Review.of_string
                Evidence_id.Review.to_string)
        ++ Fields.required "review_serial" Coordination_wire.positive
        ++ Fields.required "submitter" Evidence_wire.attribution
        ++ Fields.required "reviewer" Evidence_wire.attribution
        ++ Fields.required "gate_status" (Api_codec.literal "not_evaluated")
        ++ Fields.required "summary" (Api_codec.literal explanation))
       ~decode:
         (fun
           ( ( ( ( ( ((((((), ticket), generation), manifest), contract), review)
                   , review_serial )
                 , submitter )
               , reviewer )
             , () )
           , () ) ->
         { ticket
         ; generation
         ; manifest
         ; contract
         ; review
         ; review_serial
         ; submitter
         ; reviewer
         })
       ~encode:(fun t ->
         ( ( ( ( ( ((((((), t.ticket), t.generation), t.manifest), t.contract), t.review)
                 , t.review_serial )
               , t.submitter )
             , t.reviewer )
           , () )
         , () )))
;;

let create ~(review : Evidence.Review.t) ~(submission : Evidence.Submission.t) =
  Json.decode (fun () ->
    if
      not
        (Evidence.Review.Verdict.equal review.verdict Approve
         && Evidence.Submission.State.equal submission.state Pending
         && Id.Ticket.equal review.ticket submission.ticket
         && Int.equal review.generation submission.generation
         && Evidence.Manifest_ref.equal review.manifest submission.manifest
         && Evidence.Contract_ref.equal review.contract submission.contract
         && Acceptance_policy.Effective.Binding.equal
              review.policy_binding
              submission.policy_binding)
    then Json.fail Invalid_argument "approval does not match the pending submission";
    let t =
      { ticket = submission.ticket
      ; generation = submission.generation
      ; manifest = submission.manifest
      ; contract = submission.contract
      ; review = review.id
      ; review_serial = review.serial
      ; submitter = submission.author
      ; reviewer = review.reviewer
      }
    in
    ignore (Coordination_wire.encode_exn codec t : Jsonaf.t);
    t)
;;

let message t =
  let identity =
    Json.canonical
      (Json.obj
         [ "review_id", Evidence_id.Review.jsonaf_of_t t.review
         ; "review_serial", Json.int t.review_serial
         ])
    |> Json.hash
  in
  let message_id =
    Communication_id.Message.of_string ("review-approved-" ^ String.prefix identity 48)
    |> function
    | Ok id -> id
    | Error problem -> raise (Json.Decode_error problem)
  in
  { Communication.Message_send.message_id
  ; body = Json.canonical (Coordination_wire.encode_exn codec t)
  ; ticket_id = Some t.ticket
  ; recipients =
      Communication.Recipient.Actor t.submitter.actor
      :: Option.to_list
           (Option.map t.submitter.run ~f:(fun run -> Communication.Recipient.Run run))
  ; teams = []
  ; reply_to_message_id = None
  ; correlation_id = Some ("review-approved:" ^ identity)
  }
;;
