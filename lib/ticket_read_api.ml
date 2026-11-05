open Core
module F = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = F.both

module Request = struct
  type t =
    { ticket : Id.Ticket.t
    ; at_revision : int option
    ; max_bytes : int
    }

  let ticket t = t.ticket
  let at_revision t = t.at_revision
  let max_bytes t = t.max_bytes

  let codec =
    Api_codec.object_
      (F.map
         (F.required "ticket_id" W.ticket
          ++ F.optional "at_revision" W.counter
          ++ F.optional "max_bytes" (Api_codec.decimal ~max:1048576))
         ~decode:(fun ((ticket, at_revision), max_bytes) ->
           { ticket; at_revision; max_bytes = Option.value max_bytes ~default:65536 })
         ~encode:(fun t -> (t.ticket, t.at_revision), Some t.max_bytes))
    |> fun codec ->
    W.checked codec (fun t ->
      if t.max_bytes < 4096
      then Json.fail Invalid_argument "ticket.read max_bytes must be 4096..1048576")
  ;;
end

let expansion_codec =
  Api_codec.object_
    (F.required "method" (Api_codec.literal "ticket.context")
     ++ F.required
          "params"
          (Api_codec.object_
             (F.required
                "workspace_id"
                (W.id Id.Workspace.of_string Id.Workspace.to_string)
              ++ F.required "ticket_id" W.ticket
              ++ F.required "at_revision" W.counter
              ++ F.required "max_bytes" (Api_codec.literal "1048576"))))
;;

let response_codec =
  Api_codec.object_
    (F.required "ticket" Planning_ticket_wire.Ticket.codec
     ++ F.required "expand_context" expansion_codec)
  |> fun codec ->
  W.checked codec (fun (ticket, ((), (((_, id), _), ()))) ->
    if not (Id.Ticket.equal ticket.Planning_ticket_wire.Ticket.ticket_id id)
    then Json.fail Invalid_argument "ticket.read expansion identity differs")
  |> Api_codec.as_json
;;

let method_ =
  Api_method.create
    ~name:"ticket.read"
    ~summary:
      "Read complete ticket description, acceptance criteria and ownership without \
       related histories. Expand ticket.context for handoffs, amendments and evidence."
    ~mode:Read
    ~request:Request.codec
    ~response:response_codec
;;

let response ticket ~workspace ~workspace_revision ~max_bytes =
  Json.decode (fun () ->
    if max_bytes < 4096 || max_bytes > 1048576
    then Json.fail Invalid_argument "ticket.read max_bytes must be 4096..1048576";
    let data =
      Json.obj
        [ ( "ticket"
          , Api_codec.encode Planning_ticket_wire.Ticket.codec ticket |> Disk.unwrap )
        ; ( "expand_context"
          , Json.obj
              [ "method", Json.string "ticket.context"
              ; ( "params"
                , Json.obj
                    [ "workspace_id", Id.Workspace.jsonaf_of_t workspace
                    ; "ticket_id", Id.Ticket.jsonaf_of_t ticket.ticket_id
                    ; "at_revision", Json.int workspace_revision
                    ; "max_bytes", Json.int 1048576
                    ] )
              ] )
        ]
      |> Api_codec.decode response_codec
      |> Disk.unwrap
    in
    let result =
      Json.obj [ "workspace_revision", Json.int workspace_revision; "data", data ]
      |> Query_budget.annotate_whole_items_exn
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items:0
    in
    if Api_response.encoded_size Planning_read result > max_bytes
    then (
      let expected = "complete ticket exceeds max_bytes; no instructions were omitted" in
      raise
        (Json.Decode_error
           (Problem.with_details
              (Problem.create Invalid_argument expected)
              (Field
                 { path = [ "max_bytes" ]
                 ; expected
                 ; suggestion =
                     Some
                       "Retry ticket.read with max_bytes=1048576 and the same selectors"
                 }))));
    result)
;;
