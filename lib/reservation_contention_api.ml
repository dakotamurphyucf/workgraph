open Core
module D = Reservation_contention
module F = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = F.both
let clock = Api_codec.decimal64 ~max:Int64.max_value
let check b message = if not b then Json.fail Invalid_argument message

let advisory =
  W.checked Api_codec.boolean (fun b -> check b "contention records are advisory")
;;

let mutation_methods = [ "reservation.waiter.put"; "reservation.holder_note.put" ]
let request_codec ~method_ = D.Command.raw_codec ~method_

let mutation_data codec =
  Api_codec.as_json
    (Api_codec.object_ (F.required "advisory" advisory ++ F.required "record" codec))
;;

let response_codec ~method_ =
  match method_ with
  | "reservation.waiter.put" -> Some (mutation_data D.Waiter.codec)
  | "reservation.holder_note.put" -> Some (mutation_data D.Holder_note.codec)
  | _ -> None
;;

let descriptor ~method_ =
  Option.bind (request_codec ~method_) ~f:(fun request ->
    Option.map (response_codec ~method_) ~f:(fun response ->
      Api_method.Packed.Pack
        (Api_method.create
           ~name:method_
           ~summary:
             "Explicit advisory contention metadata; never grants, renews or releases \
              ownership."
           ~mode:Mutation
           ~request
           ~response)))
;;

let result change =
  let record =
    match change with
    | D.Change.Waiter_begin r | Waiter_refresh r | Waiter_close r ->
      W.encode_exn D.Waiter.codec r
    | Holder_note_put r -> W.encode_exn D.Holder_note.codec r
  in
  Json.obj [ "advisory", `True; "record", record ]
;;

module Request = struct
  type t =
    { target : D.Target.t
    ; include_inactive : bool
    ; cursor : string option
    ; limit : int
    ; max_bytes : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "target" D.Target.codec
          ++ F.optional "include_inactive" Api_codec.boolean
          ++ F.optional "cursor" (W.nonblank ~max_bytes:2048)
          ++ F.optional "limit" (Api_codec.decimal ~max:100)
          ++ F.optional "max_bytes" (Api_codec.decimal ~max:1048576))
         ~decode:(fun ((((target, include_inactive), cursor), limit), max_bytes) ->
           { target
           ; include_inactive = Option.value include_inactive ~default:false
           ; cursor
           ; limit = Option.value limit ~default:50
           ; max_bytes = Option.value max_bytes ~default:65536
           })
         ~encode:(fun t ->
           ( (((t.target, Some t.include_inactive), t.cursor), Some t.limit)
           , Some t.max_bytes )))
    |> fun c ->
    W.checked c (fun t ->
      check (t.limit >= 1) "limit must be 1..100";
      check (t.max_bytes >= 4096) "max_bytes must be 4096..1048576")
  ;;

  let target t = t.target
  let include_inactive t = t.include_inactive
  let cursor t = t.cursor
  let limit t = t.limit
  let max_bytes t = t.max_bytes
end

module Row = struct
  type phase =
    | Waiting
    | Closed
    | Expired
    | Run_terminal
  [@@deriving equal, sexp]

  type t =
    | Waiter of
        { record : D.Waiter.t
        ; run_status : Agent_run_event.Status.t
        ; phase : phase
        ; elapsed_ms : int64 option
        ; clock_regressed : bool
        }
    | Holder of
        { target : D.Target.t
        ; holder : Reservation.Holder.t
        ; note : D.Holder_note.t option
        ; note_clock_regressed : bool
        }

  let phase_codec =
    Api_codec.enum
      [ "waiting", Waiting
      ; "closed", Closed
      ; "expired", Expired
      ; "run_terminal", Run_terminal
      ]
      ~equal:equal_phase
  ;;

  let waiter record ~run_status ~now_unix_ms =
    let phase =
      match record.D.Waiter.state with
      | Closed _ -> Closed
      | Waiting ->
        if Agent_run_event.Status.terminal run_status
        then Run_terminal
        else if Int64.(now_unix_ms >= record.expires_unix_ms)
        then Expired
        else Waiting
    in
    let clock_regressed = Int64.(now_unix_ms < record.updated_unix_ms) in
    let elapsed_ms =
      if clock_regressed then None else Some Int64.(now_unix_ms - record.started_unix_ms)
    in
    Waiter { record; run_status; phase; elapsed_ms; clock_regressed }
  ;;

  let fields =
    Api_codec.tagged
      ~discriminator:"kind"
      ~select:(function
        | Waiter _ -> "waiter"
        | Holder _ -> "holder")
      ~cases:
        [ ( "waiter"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "waiter")
                  ++ F.required "record" D.Waiter.codec
                  ++ F.required "run_status" Agent_run_wire.status
                  ++ F.required "phase" phase_codec
                  ++ F.required "elapsed_ms" (Api_codec.nullable clock)
                  ++ F.required "clock_regressed" Api_codec.boolean)
                 ~decode:
                   (fun
                     ((((((), record), run_status), phase), elapsed_ms), clock_regressed) ->
                   Waiter { record; run_status; phase; elapsed_ms; clock_regressed })
                 ~encode:(function
                   | Waiter x ->
                     ( (((((), x.record), x.run_status), x.phase), x.elapsed_ms)
                     , x.clock_regressed )
                   | Holder _ -> Json.fail Invalid_argument "wrong contention row")) )
        ; ( "holder"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "holder")
                  ++ F.required "target" D.Target.codec
                  ++ F.required "holder" Agent_run_wire.holder
                  ++ F.required "note" (Api_codec.nullable D.Holder_note.codec)
                  ++ F.required "note_clock_regressed" Api_codec.boolean)
                 ~decode:(fun (((((), target), holder), note), note_clock_regressed) ->
                   Holder { target; holder; note; note_clock_regressed })
                 ~encode:(function
                   | Holder x ->
                     ((((), x.target), x.holder), x.note), x.note_clock_regressed
                   | Waiter _ -> Json.fail Invalid_argument "wrong contention row")) )
        ]
  ;;

  let codec =
    Api_codec.map
      (Api_codec.merge_objects
         fields
         (Api_codec.object_ (F.required "advisory" advisory)))
      ~decode:(fun (row, _) -> Ok row)
      ~encode:(fun row -> row, true)
      ~description:"Advisory waiter or actual stored holder, with no queue order."
    |> fun c ->
    W.checked c (function
      | Waiter _ -> ()
      | Holder { target; holder; note; note_clock_regressed } ->
        Option.iter note ~f:(fun n ->
          check
            (D.Target.equal target n.target
             && Id.Run.equal holder.run n.run
             && Id.Actor.equal holder.actor n.actor
             && Int.equal holder.token n.token)
            "holder note fence/identity differs";
          check (Option.is_some n.contents) "cleared holder note cannot be visible");
        if Option.is_none note
        then
          check
            (not note_clock_regressed)
            "missing holder note cannot have regressed clock")
  ;;

  let order_key row =
    let prefix, target, run =
      match row with
      | Waiter x -> "waiter:", x.record.target, x.record.run
      | Holder x -> "holder:", x.target, x.holder.run
    in
    prefix
    ^ Json.canonical (W.encode_exn D.Target.codec target)
    ^ ":"
    ^ Id.Run.to_string run
  ;;

  let validate_clock row now =
    match row with
    | Waiter x ->
      (match waiter x.record ~run_status:x.run_status ~now_unix_ms:now with
       | Waiter expected ->
         check
           (equal_phase x.phase expected.phase
            && Option.equal Int64.equal x.elapsed_ms expected.elapsed_ms
            && Bool.equal x.clock_regressed expected.clock_regressed)
           "waiter observation differs from captured clock/status"
       | Holder _ -> assert false)
    | Holder x ->
      Option.iter x.note ~f:(fun n ->
        check
          (Bool.equal x.note_clock_regressed Int64.(now < n.updated_unix_ms))
          "holder note clock differs from captured clock";
        Option.iter n.contents ~f:(fun contents ->
          check
            Int64.(now < contents.expires_unix_ms)
            "expired holder note cannot be visible"))
  ;;
end

let read_response_codec =
  Api_codec.object_
    (F.required "workspace_revision" W.counter
     ++ F.required "observed_unix_ms" clock
     ++ F.required "items" (Api_codec.list Row.codec ~max_items:100)
     ++ F.required "cursor" (Api_codec.nullable (W.nonblank ~max_bytes:2048))
     ++ F.required "has_more" Api_codec.boolean
     ++ F.required "needs_larger_budget" Api_codec.boolean
     ++ F.required "required_bytes" (Api_codec.nullable W.positive))
  |> fun c ->
  W.checked c (fun ((((((_, now), items), cursor), has_more), needs_larger), required) ->
    check
      (Bool.equal has_more (Option.is_some cursor))
      "contention page continuation differs";
    check
      (Bool.equal needs_larger (Option.is_some required))
      "contention required bytes differ";
    if needs_larger
    then check (has_more && List.is_empty items) "contention oversized position differs";
    check
      (List.is_sorted_strictly items ~compare:(fun a b ->
         String.compare (Row.order_key a) (Row.order_key b)))
      "contention rows must be ordered and distinct";
    List.iter items ~f:(fun row -> Row.validate_clock row now))
  |> Api_codec.as_json
;;

let read_descriptor =
  Api_method.Packed.Pack
    (Api_method.create
       ~name:"reservation.contention"
       ~summary:
         "Read actual holders and explicit advisory waiters/expected-release notes; no \
          FIFO or automatic grant."
       ~mode:Read
       ~request:Request.codec
       ~response:read_response_codec)
;;
