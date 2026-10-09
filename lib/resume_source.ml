open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

type t =
  | Ticket of
      { id : Id.Ticket.t
      ; revision : int
      }
  | Handoff of
      { ticket : Id.Ticket.t
      ; revision : int
      ; covers_through : int
      }
  | Comment of
      { id : Id.Comment.t
      ; revision : int
      ; sequence : int
      }
  | Fact of
      { scope : Facts.Scope.t
      ; key : Facts.Key.t
      ; revision : int
      ; changed_at_revision : int
      }
  | Run of
      { id : Id.Run.t
      ; revision : int
      }
  | Attempt of
      { id : Attempt.Id.t
      ; revision : int
      }
  | Request of
      { id : Communication_id.Request.t
      ; revision : int
      }
  | Condition of
      { id : Coordination_id.Condition.t
      ; revision : int
      }
  | Ticket_recovery of
      { id : Coordination_id.Recovery.t
      ; sequence : int
      }
  | Reservation_recovery of
      { id : Coordination_id.Recovery.t
      ; sequence : int
      }
  | Resource_version of Evidence_event.Resource_pin.t
  | Planning_change of
      { workspace_revision : int
      ; change_index : int
      }
[@@deriving sexp_of, equal]

let id = W.id

let tag name fields ~decode ~encode =
  Api_codec.object_
    (F.map
       (F.required "kind" (Api_codec.literal name) ++ fields)
       ~decode:(fun ((), fields) -> decode fields)
       ~encode:(fun t -> (), encode t))
;;

let wrong () = Json.fail Invalid_argument "wrong source reference kind"
let revision name codec = F.required name codec ++ F.required "revision" W.positive

let codec =
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "ticket"
        , tag
            "ticket"
            (revision "ticket_id" W.ticket)
            ~decode:(fun (id, revision) -> Ticket { id; revision })
            ~encode:(function
              | Ticket p -> p.id, p.revision
              | _ -> wrong ()) )
      ; ( "handoff"
        , tag
            "handoff"
            (revision "ticket_id" W.ticket ++ F.required "covers_through" W.counter)
            ~decode:(fun ((ticket, revision), covers_through) ->
              Handoff { ticket; revision; covers_through })
            ~encode:(function
              | Handoff p -> (p.ticket, p.revision), p.covers_through
              | _ -> wrong ()) )
      ; ( "comment"
        , tag
            "comment"
            (revision "comment_id" (id Id.Comment.of_string Id.Comment.to_string)
             ++ F.required "sequence" W.positive)
            ~decode:(fun ((id, revision), sequence) -> Comment { id; revision; sequence })
            ~encode:(function
              | Comment p -> (p.id, p.revision), p.sequence
              | _ -> wrong ()) )
      ; ( "fact"
        , tag
            "fact"
            (F.required "scope" Facts.Scope.codec
             ++ F.required "key" Facts.Key.codec
             ++ F.required "revision" W.positive
             ++ F.required "changed_at_revision" W.positive)
            ~decode:(fun (((scope, key), revision), changed_at_revision) ->
              Fact { scope; key; revision; changed_at_revision })
            ~encode:(function
              | Fact p -> ((p.scope, p.key), p.revision), p.changed_at_revision
              | _ -> wrong ()) )
      ; ( "run"
        , tag
            "run"
            (revision "run_id" W.run)
            ~decode:(fun (id, revision) -> Run { id; revision })
            ~encode:(function
              | Run p -> p.id, p.revision
              | _ -> wrong ()) )
      ; ( "attempt"
        , tag
            "attempt"
            (revision "attempt_id" (id Attempt.Id.of_string Attempt.Id.to_string))
            ~decode:(fun (id, revision) -> Attempt { id; revision })
            ~encode:(function
              | Attempt p -> p.id, p.revision
              | _ -> wrong ()) )
      ; ( "request"
        , tag
            "request"
            (revision
               "request_id"
               (id Communication_id.Request.of_string Communication_id.Request.to_string))
            ~decode:(fun (id, revision) -> Request { id; revision })
            ~encode:(function
              | Request p -> p.id, p.revision
              | _ -> wrong ()) )
      ; ( "condition"
        , tag
            "condition"
            (revision
               "condition_id"
               (id
                  Coordination_id.Condition.of_string
                  Coordination_id.Condition.to_string))
            ~decode:(fun (id, revision) -> Condition { id; revision })
            ~encode:(function
              | Condition p -> p.id, p.revision
              | _ -> wrong ()) )
      ; ( "ticket_recovery"
        , tag
            "ticket_recovery"
            (F.required
               "recovery_id"
               (id Coordination_id.Recovery.of_string Coordination_id.Recovery.to_string)
             ++ F.required "sequence" W.positive)
            ~decode:(fun (id, sequence) -> Ticket_recovery { id; sequence })
            ~encode:(function
              | Ticket_recovery p -> p.id, p.sequence
              | _ -> wrong ()) )
      ; ( "reservation_recovery"
        , tag
            "reservation_recovery"
            (F.required
               "recovery_id"
               (id Coordination_id.Recovery.of_string Coordination_id.Recovery.to_string)
             ++ F.required "sequence" W.positive)
            ~decode:(fun (id, sequence) -> Reservation_recovery { id; sequence })
            ~encode:(function
              | Reservation_recovery p -> p.id, p.sequence
              | _ -> wrong ()) )
      ; ( "resource_version"
        , tag
            "resource_version"
            (F.required "resource" Evidence_wire.resource_pin)
            ~decode:(fun p -> Resource_version p)
            ~encode:(function
              | Resource_version p -> p
              | _ -> wrong ()) )
      ; ( "planning_change"
        , tag
            "planning_change"
            (F.required "workspace_revision" W.positive
             ++ F.required "change_index" W.counter)
            ~decode:(fun (workspace_revision, change_index) ->
              Planning_change { workspace_revision; change_index })
            ~encode:(function
              | Planning_change p -> p.workspace_revision, p.change_index
              | _ -> wrong ()) )
      ]
    ~select:(function
      | Ticket _ -> "ticket"
      | Handoff _ -> "handoff"
      | Comment _ -> "comment"
      | Fact _ -> "fact"
      | Run _ -> "run"
      | Attempt _ -> "attempt"
      | Request _ -> "request"
      | Condition _ -> "condition"
      | Ticket_recovery _ -> "ticket_recovery"
      | Reservation_recovery _ -> "reservation_recovery"
      | Resource_version _ -> "resource_version"
      | Planning_change _ -> "planning_change")
;;

let label t =
  match t with
  | Ticket p ->
    Printf.sprintf "ticket %s revision %d" (Id.Ticket.to_string p.id) p.revision
  | Handoff p ->
    Printf.sprintf
      "handoff %s revision %d covering through %d"
      (Id.Ticket.to_string p.ticket)
      p.revision
      p.covers_through
  | Comment p ->
    Printf.sprintf "comment %s revision %d" (Id.Comment.to_string p.id) p.revision
  | Fact p -> Printf.sprintf "fact %s revision %d" (Facts.Key.to_string p.key) p.revision
  | Run p -> Printf.sprintf "run %s revision %d" (Id.Run.to_string p.id) p.revision
  | Attempt p ->
    Printf.sprintf "attempt %s revision %d" (Attempt.Id.to_string p.id) p.revision
  | Request p ->
    Printf.sprintf
      "request %s revision %d"
      (Communication_id.Request.to_string p.id)
      p.revision
  | Condition p ->
    Printf.sprintf
      "condition %s revision %d"
      (Coordination_id.Condition.to_string p.id)
      p.revision
  | Ticket_recovery p ->
    Printf.sprintf
      "recovery %s at %d"
      (Coordination_id.Recovery.to_string p.id)
      p.sequence
  | Reservation_recovery p ->
    Printf.sprintf
      "recovery %s at %d"
      (Coordination_id.Recovery.to_string p.id)
      p.sequence
  | Resource_version p ->
    Printf.sprintf "resource %s version %d" (Id.Resource.to_string p.id) p.revision
  | Planning_change p ->
    Printf.sprintf "workspace revision %d change %d" p.workspace_revision p.change_index
;;
