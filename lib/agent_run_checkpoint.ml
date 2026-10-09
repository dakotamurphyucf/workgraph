open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

module Reference = struct
  type t =
    | Resource of
        { id : string
        ; revision : int
        }
    | Handoff of
        { ticket : string
        ; revision : int
        }

  let reference =
    Api_codec.map
      (Api_codec.text ~max_bytes:97)
      ~decode:(fun value ->
        let key =
          if String.is_prefix value ~prefix:"$" then String.drop_prefix value 1 else value
        in
        Result.map (Id.Actor.of_string key) ~f:(fun _ -> value))
      ~encode:Fn.id
      ~description:"Opaque ID or transaction $alias."
  ;;

  let revision =
    Api_codec.map
      (Api_codec.decimal ~max:Int.max_value)
      ~decode:(fun revision ->
        if revision > 0
        then Ok revision
        else
          Error (Problem.create Invalid_argument "checkpoint revision must be positive"))
      ~encode:Fn.id
      ~description:"Positive pinned revision."
  ;;

  let tag name = Fields.required "kind" (Api_codec.enum [ name, () ] ~equal:Unit.equal)

  let codec =
    let resource =
      Api_codec.object_
        (Fields.map
           (tag "resource"
            ++ Fields.required "resource_id" reference
            ++ Fields.required "revision" revision)
           ~decode:(fun (((), id), revision) -> Resource { id; revision })
           ~encode:(function
             | Resource { id; revision } -> ((), id), revision
             | Handoff _ -> Json.fail Invalid_argument "wrong checkpoint kind"))
    in
    let handoff =
      Api_codec.object_
        (Fields.map
           (tag "handoff"
            ++ Fields.required "ticket_id" reference
            ++ Fields.required "revision" revision)
           ~decode:(fun (((), ticket), revision) -> Handoff { ticket; revision })
           ~encode:(function
             | Handoff { ticket; revision } -> ((), ticket), revision
             | Resource _ -> Json.fail Invalid_argument "wrong checkpoint kind"))
    in
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:[ "resource", resource; "handoff", handoff ]
      ~select:(function
        | Resource _ -> "resource"
        | Handoff _ -> "handoff")
  ;;

  let resolve = function
    | Resource { id; revision } ->
      Result.map (Id.Resource.of_string id) ~f:(fun id ->
        Attempt.Checkpoint.Resource { id; revision })
    | Handoff { ticket; revision } ->
      Result.map (Id.Ticket.of_string ticket) ~f:(fun ticket ->
        Attempt.Checkpoint.Handoff { ticket; revision })
  ;;

  let of_checkpoint = function
    | Attempt.Checkpoint.Resource { id; revision } ->
      Resource { id = Id.Resource.to_string id; revision }
    | Handoff { ticket; revision } ->
      Handoff { ticket = Id.Ticket.to_string ticket; revision }
  ;;
end

let codec =
  Api_codec.map
    Reference.codec
    ~decode:Reference.resolve
    ~encode:Reference.of_checkpoint
    ~description:"Resolved pinned checkpoint reference."
;;
