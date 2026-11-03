open Core
module F = Api_codec.Fields

let ( ++ ) = F.both

module Put = struct
  type t =
    { ticket : Id.Ticket.t
    ; expected_revision : int
    ; policy : Hierarchy_policy.t
    ; reason : string
    }
  [@@deriving sexp]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "ticket_id" Coordination_wire.ticket
          ++ F.required "expected_revision" Coordination_wire.counter
          ++ F.required
               "descendant_prerequisites"
               Hierarchy_policy.Descendant_prerequisites.codec
          ++ F.required "child_completion" Hierarchy_policy.Child_completion.codec
          ++ F.required "reason" (Coordination_wire.nonblank ~max_bytes:65_536))
         ~decode:
           (fun
             ( (((ticket, expected_revision), descendant_prerequisites), child_completion)
             , reason ) ->
           { ticket
           ; expected_revision
           ; policy = { descendant_prerequisites; child_completion }
           ; reason
           })
         ~encode:(fun t ->
           ( ( ((t.ticket, t.expected_revision), t.policy.descendant_prerequisites)
             , t.policy.child_completion )
           , t.reason )))
  ;;

  let t_of_sexp_unchecked = t_of_sexp

  let t_of_sexp sexp =
    let value = t_of_sexp_unchecked sexp in
    match Result.bind (Api_codec.encode codec value) ~f:(Api_codec.decode codec) with
    | Ok value -> value
    | Error problem -> Sexplib.Conv.of_sexp_error problem.message sexp
  ;;
end

module Get = struct
  type t = { ticket : Id.Ticket.t }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "ticket_id" Coordination_wire.ticket)
         ~decode:(fun ticket -> { ticket })
         ~encode:(fun t -> t.ticket))
  ;;
end

module Snapshot = struct
  type t =
    { ticket : Id.Ticket.t
    ; stored : Hierarchy_policy.Definition.t option
    ; effective : Hierarchy_policy.t
    }

  let create ~ticket ~policy =
    match policy with
    | Some definition
      when not (Id.Ticket.equal ticket (Hierarchy_policy.Definition.ticket definition)) ->
      Error (Problem.create Invalid_argument "Hierarchy policy snapshot ticket differs")
    | None | Some _ ->
      Ok
        { ticket
        ; stored = policy
        ; effective =
            Option.value_map
              policy
              ~default:Hierarchy_policy.default
              ~f:Hierarchy_policy.Definition.policy
        }
  ;;

  let ticket t = t.ticket
  let stored t = t.stored
  let effective t = t.effective

  let codec =
    Api_codec.map
      (Api_codec.object_
         (F.required "ticket_id" Coordination_wire.ticket
          ++ F.required "policy" (Api_codec.nullable Hierarchy_policy.Definition.codec)
          ++ F.required "effective" Hierarchy_policy.codec))
      ~decode:(fun ((ticket, policy), effective) ->
        Result.bind (create ~ticket ~policy) ~f:(fun t ->
          if Hierarchy_policy.equal t.effective effective
          then Ok t
          else
            Error
              (Problem.create
                 Invalid_argument
                 "Hierarchy effective policy differs from stored/default policy")))
      ~encode:(fun t -> (t.ticket, t.stored), t.effective)
      ~description:
        "Absent stored policy remains distinct from explicit effective defaults."
  ;;
end

let put =
  Api_method.create
    ~name:"ticket.hierarchy.put"
    ~mode:Mutation
    ~summary:
      "Set explicit descendant prerequisite and child completion policy, with revision \
       guard and audit reason."
    ~request:Put.codec
    ~response:Hierarchy_policy.Definition.codec
;;

let get =
  Api_method.create
    ~name:"ticket.hierarchy.get"
    ~mode:Read
    ~summary:"Read stored hierarchy policy and effective flat-plan defaults."
    ~request:Get.codec
    ~response:Snapshot.codec
;;

let methods = [ Api_method.Packed.Pack put; Api_method.Packed.Pack get ]
