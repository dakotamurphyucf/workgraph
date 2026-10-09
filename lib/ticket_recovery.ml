open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

type t =
  { request : Ticket_lifecycle.Recovery.t
  ; actor_id : Id.Actor.t
  ; run_id : Id.Run.t option
  ; timestamp : string
  ; sequence : int
  }
[@@deriving sexp]

let codec =
  Api_codec.object_
    (F.map
       (F.required "request" Ticket_lifecycle.Recovery.codec
        ++ F.required "actor_id" W.actor
        ++ F.required "run_id" (Api_codec.nullable W.run)
        ++ F.required "timestamp" (W.nonblank ~max_bytes:128)
        ++ F.required "sequence" W.positive)
       ~decode:(fun ((((request, actor_id), run_id), timestamp), sequence) ->
         { request; actor_id; run_id; timestamp; sequence })
       ~encode:(fun t -> (((t.request, t.actor_id), t.run_id), t.timestamp), t.sequence))
;;

let jsonaf_of_t = W.encode_exn codec
let t_of_jsonaf = W.decode_exn codec
let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match Api_codec.encode codec t with
  | Ok _ -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
;;

module Query = struct
  type t =
    | Get of
        { id : Coordination_id.Recovery.t
        ; max_bytes : int
        }
    | List of
        { ticket : Id.Ticket.t option
        ; limit : int
        ; max_bytes : int
        ; offset : int
        ; expected_revision : int option
        }

  let bound min max =
    W.checked (Api_codec.decimal ~max) (fun n ->
      if n < min then Json.fail Invalid_argument "Query bound too small")
  ;;

  let entries =
    [ ( "ticket.recovery.get"
      , Api_codec.object_
          (F.map
             (F.required
                "recovery_id"
                (W.id
                   Coordination_id.Recovery.of_string
                   Coordination_id.Recovery.to_string)
              ++ F.optional "max_bytes" (bound 4096 1_048_576))
             ~decode:(fun (id, max_bytes) ->
               Get { id; max_bytes = Option.value max_bytes ~default:65_536 })
             ~encode:(function
               | Get p -> p.id, Some p.max_bytes
               | List _ -> Json.fail Invalid_argument "Wrong query")) )
    ; ( "ticket.recovery.list"
      , W.checked
          (Api_codec.object_
             (F.map
                (F.optional "ticket_id" W.ticket
                 ++ F.optional "limit" (bound 1 100)
                 ++ F.optional "max_bytes" (bound 4096 1_048_576)
                 ++ F.optional "offset" W.counter
                 ++ F.optional "expected_revision" W.counter)
                ~decode:
                  (fun
                    ((((ticket, limit), max_bytes), offset), expected_revision) ->
                  List
                    { ticket
                    ; limit = Option.value limit ~default:50
                    ; max_bytes = Option.value max_bytes ~default:65_536
                    ; offset = Option.value offset ~default:0
                    ; expected_revision
                    })
                ~encode:(function
                  | List p ->
                    ( (((p.ticket, Some p.limit), Some p.max_bytes), Some p.offset)
                    , p.expected_revision )
                  | Get _ -> Json.fail Invalid_argument "Wrong query")))
          (function
            | List p when p.offset > 0 && Option.is_none p.expected_revision ->
              Json.fail Invalid_argument "Offset requires expected_revision"
            | Get _ | List _ -> ()) )
    ]
  ;;
end

let query_methods = List.map Query.entries ~f:fst

let json codec =
  Api_codec.map
    codec
    ~decode:(Api_codec.encode codec)
    ~encode:(W.decode_exn codec)
    ~description:"Validated ticket recovery audit."
;;

let response_codec ~method_ =
  match method_ with
  | "ticket.recovery.get" -> Some (json codec)
  | "ticket.recovery.list" ->
    Some
      (json
         (Api_codec.object_
            (F.map
               (F.required "items" (Api_codec.list codec ~max_items:100)
                ++ F.required "next_offset" (Api_codec.nullable W.counter)
                ++ F.required "omitted" W.counter)
               ~decode:(fun ((items, next), omitted) -> items, next, omitted)
               ~encode:(fun (items, next, omitted) -> (items, next), omitted))))
  | _ -> None
;;

let descriptor ~method_ =
  match
    List.Assoc.find Query.entries method_ ~equal:String.equal, response_codec ~method_
  with
  | Some request, Some response ->
    Some
      (Api_method.Packed.Pack
         (Api_method.create
            ~name:method_
            ~summary:"Read immutable guarded ticket recovery audit."
            ~mode:Read
            ~request:(Api_codec.as_json request)
            ~response))
  | _ -> None
;;

let query ~revision records ~method_ ~params =
  Json.decode (fun () ->
    let envelope data =
      Json.obj [ "workspace_revision", Json.int revision; "data", data ]
    in
    let request =
      match List.Assoc.find Query.entries method_ ~equal:String.equal with
      | Some c -> W.decode_exn c params
      | None -> Json.fail Invalid_argument "Unknown ticket recovery query"
    in
    match request with
    | Query.Get { id; max_bytes } ->
      let record =
        match
          List.find records ~f:(fun r ->
            Coordination_id.Recovery.equal r.request.recovery_id id)
        with
        | Some r -> r
        | None -> Json.fail Not_found "Ticket recovery audit missing"
      in
      let json = jsonaf_of_t record in
      if Api_response.encoded_size Planning_read (envelope json) > max_bytes
      then Json.fail Invalid_argument "Complete audit cannot fit; increase max_bytes";
      envelope json
    | List p ->
      if
        p.offset > 0
        && not
             (Option.value_map p.expected_revision ~default:false ~f:(Int.equal revision))
      then Json.fail Conflict "Ticket recovery query revision changed";
      let records =
        List.filter records ~f:(fun r ->
          Option.value_map p.ticket ~default:true ~f:(Id.Ticket.equal r.request.ticket_id))
      in
      let result items =
        let next = p.offset + List.length items in
        Json.obj
          [ "items", `Array items
          ; ("next_offset", if next < List.length records then Json.int next else `Null)
          ; "omitted", Json.int (Int.max 0 (List.length records - next))
          ]
      in
      let selected =
        List.take (List.drop records p.offset) p.limit |> List.map ~f:jsonaf_of_t
      in
      let rec fit acc = function
        | [] -> List.rev acc
        | item :: rest ->
          if
            Api_response.encoded_size
              Planning_read
              (envelope (result (List.rev (item :: acc))))
            > p.max_bytes
          then List.rev acc
          else fit (item :: acc) rest
      in
      let items = fit [] selected in
      if (not (List.is_empty selected)) && List.is_empty items
      then Json.fail Invalid_argument "Complete audit cannot fit; increase max_bytes";
      envelope (result items))
;;

let event_references records =
  List.concat_map records ~f:(fun r ->
    List.filter_map r.request.evidence ~f:(function
      | Evidence_event.Pin.Event ref_ -> Some ref_
      | Resource _ | Commit _ | Checksum _ | Comment _ | Contract _ | Decision _ -> None))
  |> List.dedup_and_sort ~compare:Session.Event_ref.compare
;;
