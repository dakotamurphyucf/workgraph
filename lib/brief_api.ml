open Core
module F = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = F.both

module Request = struct
  type selector =
    | Ticket of Id.Ticket.t
    | Resource of Id.Resource.t

  type t =
    { selector : selector
    ; at_revision : int option
    ; max_bytes : int
    }

  let ticket t =
    match t.selector with
    | Ticket id -> Some id
    | Resource _ -> None
  ;;

  let resource t =
    match t.selector with
    | Resource id -> Some id
    | Ticket _ -> None
  ;;

  let at_revision t = t.at_revision
  let max_bytes t = t.max_bytes

  let codec selector create project =
    Api_codec.object_
      (F.map
         (selector
          ++ F.optional "at_revision" W.counter
          ++ F.optional "max_bytes" (Api_codec.decimal ~max:1048576))
         ~decode:(fun ((selector, at_revision), max_bytes) ->
           { selector = create selector
           ; at_revision
           ; max_bytes = Option.value max_bytes ~default:65536
           })
         ~encode:(fun t -> (project t.selector, t.at_revision), Some t.max_bytes))
    |> fun codec ->
    W.checked codec (fun t ->
      if t.max_bytes < 4096
      then Json.fail Invalid_argument "brief max_bytes must be 4096..1048576")
  ;;

  let ticket_codec =
    codec
      (F.required "ticket_id" W.ticket)
      (fun x -> Ticket x)
      (function
        | Ticket x -> x
        | Resource _ -> Json.fail Invalid_argument "ticket selector required")
  ;;

  let resource_codec =
    codec
      (F.required "resource_id" (W.id Id.Resource.of_string Id.Resource.to_string))
      (fun x -> Resource x)
      (function
        | Resource x -> x
        | Ticket _ -> Json.fail Invalid_argument "resource selector required")
  ;;

  let codec_for = function
    | "ticket.brief" -> Some ticket_codec
    | "resource.brief" -> Some resource_codec
    | _ -> None
  ;;

  let decode ~method_ json =
    match codec_for method_ with
    | Some codec -> Api_codec.decode codec json
    | None -> Error (Problem.create Invalid_argument "unknown brief query")
  ;;
end

let query_methods = [ "ticket.brief"; "resource.brief" ]

let methods =
  List.map query_methods ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:
           "Read an explicit bounded brief with exact expansion references and omission \
            counts."
         ~mode:Read
         ~request:(Option.value_exn (Request.codec_for name))
         ~response:
           (if String.equal name "ticket.brief"
            then Brief_view.ticket_codec
            else Brief_view.resource_codec)))
;;
