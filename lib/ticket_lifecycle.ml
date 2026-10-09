open Core

let positive_counter =
  Api_codec.map
    (Api_codec.decimal ~max:Int.max_value)
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "counter must be positive"))
    ~encode:Fn.id
    ~description:"Positive canonical decimal counter"
;;

module Handoff = struct
  module Wire = struct
    type t =
      { summary : string
      ; next_steps : string
      ; objective : string option
      ; completed : string option
      ; decisions : string option
      ; blockers : string option
      ; resource_ids : string list option
      ; covers_through : int option
      }
    [@@deriving sexp]

    let codec =
      let open Api_codec in
      let ( ++ ) = Fields.both in
      let text = text ~max_bytes:65536 in
      let reference =
        map
          (Api_codec.text ~max_bytes:97)
          ~decode:(fun value ->
            let identity =
              if String.is_prefix value ~prefix:"$"
              then String.drop_prefix value 1
              else value
            in
            Result.map (Id.Resource.of_string identity) ~f:(fun _ -> value))
          ~encode:Fn.id
          ~description:"Resource identity or transaction alias"
      in
      object_
        (Fields.map
           (Fields.required "summary" text
            ++ Fields.required "next_steps" text
            ++ Fields.optional "objective" text
            ++ Fields.optional "completed" text
            ++ Fields.optional "decisions" text
            ++ Fields.optional "blockers" text
            ++ Fields.optional "resource_ids" (list reference ~max_items:100)
            ++ Fields.optional "covers_through" (decimal ~max:Int.max_value))
           ~decode:
             (fun
               ( ( (((((summary, next_steps), objective), completed), decisions), blockers)
                 , resource_ids )
               , covers_through ) ->
             { summary
             ; next_steps
             ; objective
             ; completed
             ; decisions
             ; blockers
             ; resource_ids
             ; covers_through
             })
           ~encode:(fun t ->
             ( ( ( ((((t.summary, t.next_steps), t.objective), t.completed), t.decisions)
                 , t.blockers )
               , t.resource_ids )
             , t.covers_through )))
    ;;
  end

  type t =
    { summary : string
    ; next_steps : string
    ; objective : string option
    ; completed : string option
    ; decisions : string option
    ; blockers : string option
    ; resource_ids : Id.Resource.t list option
    ; covers_through : int option
    }
  [@@deriving sexp]

  let of_wire (wire : Wire.t) =
    { summary = wire.summary
    ; next_steps = wire.next_steps
    ; objective = wire.objective
    ; completed = wire.completed
    ; decisions = wire.decisions
    ; blockers = wire.blockers
    ; resource_ids =
        Option.map
          wire.resource_ids
          ~f:(List.map ~f:(fun value -> Id.Resource.t_of_jsonaf (Json.string value)))
    ; covers_through = wire.covers_through
    }
  ;;

  let to_wire t =
    { Wire.summary = t.summary
    ; next_steps = t.next_steps
    ; objective = t.objective
    ; completed = t.completed
    ; decisions = t.decisions
    ; blockers = t.blockers
    ; resource_ids = Option.map t.resource_ids ~f:(List.map ~f:Id.Resource.to_string)
    ; covers_through = t.covers_through
    }
  ;;

  let codec =
    Api_codec.map
      Wire.codec
      ~decode:(fun wire -> Json.decode (fun () -> of_wire wire))
      ~encode:to_wire
      ~description:"Finish handoff patch; omitted rich fields preserve previous values."
  ;;
end

module Recovery = struct
  module Recovery_id = Ownership_recovery.Recovery_id
  module Confirmation = Ownership_recovery.Confirmation

  module Wire = struct
    type t =
      { recovery_id : Recovery_id.t
      ; ticket_id : string
      ; expected_revision : int
      ; old_actor_id : Id.Actor.t
      ; old_run_id : Id.Run.t option
      ; token : int
      ; expected_lease_revision : int
      ; confirmation : Confirmation.t
      ; reason : string
      ; evidence : Evidence_event.Pin.t list
      }
    [@@deriving sexp]

    let codec =
      let ( <*> ) = Api_codec.Fields.both in
      let req = Api_codec.Fields.required in
      let opt = Api_codec.Fields.optional in
      let reference =
        Api_codec.map
          (Api_codec.text ~max_bytes:96)
          ~decode:(fun value ->
            let identity =
              if String.is_prefix value ~prefix:"$"
              then String.drop_prefix value 1
              else value
            in
            Result.map (Id.Ticket.of_string identity) ~f:(fun _ -> value))
          ~encode:Fn.id
          ~description:"Ticket identity or transaction alias."
      in
      Api_codec.object_
        (Api_codec.Fields.map
           (req
              "recovery_id"
              (Coordination_wire.id Recovery_id.of_string Recovery_id.to_string)
            <*> req "ticket_id" reference
            <*> req "expected_revision" Coordination_wire.counter
            <*> req "old_actor_id" Coordination_wire.actor
            <*> req "old_run_id" (Api_codec.nullable Coordination_wire.run)
            <*> req "token" Coordination_wire.positive
            <*> req "expected_lease_revision" Coordination_wire.positive
            <*> req "confirmation" Confirmation.codec
            <*> req "reason" (Coordination_wire.nonblank ~max_bytes:4096)
            <*> opt "evidence" Coordination_wire.evidence)
           ~decode:
             (fun
               ( ( ( ( ( ( (((recovery_id, ticket_id), expected_revision), old_actor_id)
                         , old_run_id )
                       , token )
                     , expected_lease_revision )
                   , confirmation )
                 , reason )
               , evidence ) ->
             { recovery_id
             ; ticket_id
             ; expected_revision
             ; old_actor_id
             ; old_run_id
             ; token
             ; expected_lease_revision
             ; confirmation
             ; reason
             ; evidence = Option.value evidence ~default:[]
             })
           ~encode:(fun t ->
             ( ( ( ( ( ( ( ((t.recovery_id, t.ticket_id), t.expected_revision)
                         , t.old_actor_id )
                       , t.old_run_id )
                     , t.token )
                   , t.expected_lease_revision )
                 , t.confirmation )
               , t.reason )
             , Some t.evidence )))
    ;;
  end

  type t =
    { recovery_id : Recovery_id.t
    ; ticket_id : Id.Ticket.t
    ; expected_revision : int
    ; old_actor_id : Id.Actor.t
    ; old_run_id : Id.Run.t option
    ; token : int
    ; expected_lease_revision : int
    ; confirmation : Confirmation.t
    ; reason : string
    ; evidence : Evidence_event.Pin.t list
    }
  [@@deriving sexp]

  let of_wire (request : Wire.t) =
    { recovery_id = request.recovery_id
    ; ticket_id = Id.Ticket.t_of_jsonaf (Json.string request.ticket_id)
    ; expected_revision = request.expected_revision
    ; old_actor_id = request.old_actor_id
    ; old_run_id = request.old_run_id
    ; token = request.token
    ; expected_lease_revision = request.expected_lease_revision
    ; confirmation = request.confirmation
    ; reason = request.reason
    ; evidence = request.evidence
    }
  ;;

  let to_wire t =
    { Wire.recovery_id = t.recovery_id
    ; ticket_id = Id.Ticket.to_string t.ticket_id
    ; expected_revision = t.expected_revision
    ; old_actor_id = t.old_actor_id
    ; old_run_id = t.old_run_id
    ; token = t.token
    ; expected_lease_revision = t.expected_lease_revision
    ; confirmation = t.confirmation
    ; reason = t.reason
    ; evidence = t.evidence
    }
  ;;

  let codec =
    Api_codec.map
      Wire.codec
      ~decode:(fun wire -> Json.decode (fun () -> of_wire wire))
      ~encode:to_wire
      ~description:"Guarded explicit ticket ownership recovery."
  ;;

  let jsonaf_of_t t = Coordination_wire.encode_exn codec t
  let t_of_jsonaf json = Coordination_wire.decode_exn codec json

  let validate_owner t ~revision ~actor ~run ~token ~lease_revision =
    Json.decode (fun () ->
      ignore (jsonaf_of_t t : Jsonaf.t);
      if not (Int.equal t.expected_revision revision)
      then Json.fail Conflict "ticket recovery revision changed";
      if
        not
          (Id.Actor.equal t.old_actor_id actor
           && Option.equal Id.Run.equal t.old_run_id run
           && Int.equal t.token token)
      then Json.fail Stale_claim "ticket recovery ownership changed";
      if not (Int.equal t.expected_lease_revision lease_revision)
      then Json.fail Conflict "ticket recovery lease revision changed")
  ;;
end

module Wire = struct
  type t =
    | Claim of
        { ticket_id : string
        ; expected_revision : int option
        ; lease_duration_ms : int64 option
        }
    | Start of
        { ticket_id : string
        ; expected_revision : int option
        ; lease_duration_ms : int64 option
        ; initial_note : string option
        ; attempt_id : string option
        }
    | Finish of
        { ticket_id : string
        ; token : int
        ; evidence : string
        ; handoff : Handoff.Wire.t option
        }
    | Recover of Recovery.Wire.t
    | Reopen of
        { ticket_id : string
        ; expected_revision : int
        ; reason : string
        }
  [@@deriving sexp]

  let codec method_ =
    let open Api_codec in
    let reference =
      map
        (text ~max_bytes:96)
        ~decode:(fun value ->
          let identity =
            if String.is_prefix value ~prefix:"$"
            then String.drop_prefix value 1
            else value
          in
          Result.map (Id.Ticket.of_string identity) ~f:(fun _ -> value))
        ~encode:Fn.id
        ~description:"Identity or transaction alias"
    in
    let id = reference in
    let attempt = reference in
    let revision = decimal ~max:Int.max_value in
    let nonblank =
      map
        (text ~max_bytes:65536)
        ~decode:(fun text ->
          if String.is_empty (String.strip text)
          then Error (Problem.create Invalid_argument "nonblank text required")
          else Ok text)
        ~encode:Fn.id
        ~description:"Nonblank bounded UTF-8 text"
    in
    let token = positive_counter in
    let lease =
      map
        (decimal64 ~max:86_400_000L)
        ~decode:(fun duration ->
          if Int64.(duration > 0L)
          then Ok duration
          else Error (Problem.create Invalid_argument "lease duration must be positive"))
        ~encode:Fn.id
        ~description:"Lease duration in milliseconds, 1..86400000"
    in
    let common =
      Fields.both
        (Fields.required "ticket_id" id)
        (Fields.both
           (Fields.optional "expected_revision" revision)
           (Fields.optional "lease_duration_ms" lease))
    in
    let mismatch () = Json.fail Invalid_argument "lifecycle command mismatch" in
    match method_ with
    | "ticket.claim" ->
      Ok
        (object_
           (Fields.map
              common
              ~decode:(fun (ticket_id, (expected_revision, lease_duration_ms)) ->
                Claim { ticket_id; expected_revision; lease_duration_ms })
              ~encode:(function
                | Claim { ticket_id; expected_revision; lease_duration_ms } ->
                  ticket_id, (expected_revision, lease_duration_ms)
                | Start _ | Finish _ | Reopen _ | Recover _ -> mismatch ())))
    | "ticket.start" ->
      Ok
        (object_
           (Fields.map
              (Fields.both
                 common
                 (Fields.both
                    (Fields.optional "initial_note" nonblank)
                    (Fields.optional "attempt_id" attempt)))
              ~decode:
                (fun
                  ( (ticket_id, (expected_revision, lease_duration_ms))
                  , (initial_note, attempt_id) ) ->
                Start
                  { ticket_id
                  ; expected_revision
                  ; lease_duration_ms
                  ; initial_note
                  ; attempt_id
                  })
              ~encode:(function
                | Start
                    { ticket_id
                    ; expected_revision
                    ; lease_duration_ms
                    ; initial_note
                    ; attempt_id
                    } ->
                  ( (ticket_id, (expected_revision, lease_duration_ms))
                  , (initial_note, attempt_id) )
                | Claim _ | Finish _ | Reopen _ | Recover _ -> mismatch ())))
    | "ticket.finish" ->
      Ok
        (object_
           (Fields.map
              (Fields.both
                 (Fields.required "ticket_id" id)
                 (Fields.both
                    (Fields.required "token" token)
                    (Fields.both
                       (Fields.required "evidence" nonblank)
                       (Fields.optional "handoff" Handoff.Wire.codec))))
              ~decode:(fun (ticket_id, (token, (evidence, handoff))) ->
                Finish { ticket_id; token; evidence; handoff })
              ~encode:(function
                | Finish { ticket_id; token; evidence; handoff } ->
                  ticket_id, (token, (evidence, handoff))
                | Claim _ | Start _ | Reopen _ | Recover _ -> mismatch ())))
    | "ticket.recover" ->
      Ok
        (Api_codec.map
           Recovery.Wire.codec
           ~decode:(fun request -> Ok (Recover request))
           ~encode:(function
             | Recover request -> request
             | Claim _ | Start _ | Finish _ | Reopen _ -> mismatch ())
           ~description:"Exact old ownership guards and stopped or isolated confirmation.")
    | "ticket.reopen" ->
      Ok
        (object_
           (Fields.map
              (Fields.both
                 (Fields.required "ticket_id" id)
                 (Fields.both
                    (Fields.required "expected_revision" revision)
                    (Fields.required "reason" nonblank)))
              ~decode:(fun (ticket_id, (expected_revision, reason)) ->
                Reopen { ticket_id; expected_revision; reason })
              ~encode:(function
                | Reopen { ticket_id; expected_revision; reason } ->
                  ticket_id, (expected_revision, reason)
                | Claim _ | Start _ | Finish _ | Recover _ -> mismatch ())))
    | _ -> Error (Problem.create Invalid_argument "unknown lifecycle mutation")
  ;;

  let decode ~method_ ~params =
    Result.bind (codec method_) ~f:(fun codec -> Api_codec.decode codec params)
  ;;

  let encode command =
    let method_ =
      match command with
      | Claim _ -> "ticket.claim"
      | Start _ -> "ticket.start"
      | Finish _ -> "ticket.finish"
      | Recover _ -> "ticket.recover"
      | Reopen _ -> "ticket.reopen"
    in
    Result.bind (codec method_) ~f:(fun codec ->
      Result.map (Api_codec.encode codec command) ~f:(fun params -> method_, params))
  ;;
end

module Command = struct
  type t =
    | Claim of
        { ticket_id : Id.Ticket.t
        ; expected_revision : int option
        ; lease_duration_ms : int64 option
        }
    | Start of
        { ticket_id : Id.Ticket.t
        ; expected_revision : int option
        ; lease_duration_ms : int64 option
        ; initial_note : string option
        ; attempt_id : Attempt.Id.t option
        }
    | Finish of
        { ticket_id : Id.Ticket.t
        ; token : int
        ; evidence : string
        ; handoff : Handoff.t option
        }
    | Recover of Recovery.t
    | Reopen of
        { ticket_id : Id.Ticket.t
        ; expected_revision : int
        ; reason : string
        }
  [@@deriving sexp]

  let of_wire = function
    | Wire.Claim { ticket_id; expected_revision; lease_duration_ms } ->
      Claim
        { ticket_id = Id.Ticket.t_of_jsonaf (Json.string ticket_id)
        ; expected_revision
        ; lease_duration_ms
        }
    | Wire.Start
        { ticket_id; expected_revision; lease_duration_ms; initial_note; attempt_id } ->
      Start
        { ticket_id = Id.Ticket.t_of_jsonaf (Json.string ticket_id)
        ; expected_revision
        ; lease_duration_ms
        ; initial_note
        ; attempt_id =
            Option.map attempt_id ~f:(fun id -> Attempt.Id.t_of_jsonaf (Json.string id))
        }
    | Wire.Finish { ticket_id; token; evidence; handoff } ->
      Finish
        { ticket_id = Id.Ticket.t_of_jsonaf (Json.string ticket_id)
        ; token
        ; evidence
        ; handoff = Option.map handoff ~f:Handoff.of_wire
        }
    | Wire.Recover request -> Recover (Recovery.of_wire request)
    | Wire.Reopen { ticket_id; expected_revision; reason } ->
      Reopen
        { ticket_id = Id.Ticket.t_of_jsonaf (Json.string ticket_id)
        ; expected_revision
        ; reason
        }
  ;;

  let to_wire = function
    | Claim { ticket_id; expected_revision; lease_duration_ms } ->
      Wire.Claim
        { ticket_id = Id.Ticket.to_string ticket_id
        ; expected_revision
        ; lease_duration_ms
        }
    | Start { ticket_id; expected_revision; lease_duration_ms; initial_note; attempt_id }
      ->
      Wire.Start
        { ticket_id = Id.Ticket.to_string ticket_id
        ; expected_revision
        ; lease_duration_ms
        ; initial_note
        ; attempt_id = Option.map attempt_id ~f:Attempt.Id.to_string
        }
    | Finish { ticket_id; token; evidence; handoff } ->
      Wire.Finish
        { ticket_id = Id.Ticket.to_string ticket_id
        ; token
        ; evidence
        ; handoff = Option.map handoff ~f:Handoff.to_wire
        }
    | Recover request -> Wire.Recover (Recovery.to_wire request)
    | Reopen { ticket_id; expected_revision; reason } ->
      Wire.Reopen { ticket_id = Id.Ticket.to_string ticket_id; expected_revision; reason }
  ;;

  let codec method_ =
    Result.map (Wire.codec method_) ~f:(fun codec ->
      Api_codec.map
        codec
        ~decode:(fun wire -> Json.decode (fun () -> of_wire wire))
        ~encode:to_wire
        ~description:"Resolved lifecycle command")
  ;;

  let decode ~method_ ~params =
    Result.bind (codec method_) ~f:(fun codec -> Api_codec.decode codec params)
  ;;

  let encode command = Wire.encode (to_wire command)
end

let request_codec method_ = Result.map (Wire.codec method_) ~f:Api_codec.as_json

let mutation_methods =
  [ "ticket.claim"; "ticket.start"; "ticket.finish"; "ticket.reopen"; "ticket.recover" ]
;;

let response_codec method_ =
  Json.decode (fun () ->
    let open Api_codec in
    let identifier =
      map
        (text ~max_bytes:96)
        ~decode:(fun id -> Result.map (Id.Ticket.of_string id) ~f:Id.Ticket.to_string)
        ~encode:Fn.id
        ~description:"Validated ticket identity"
    in
    let ticket_id = Fields.required "ticket_id" identifier in
    let fields =
      match method_ with
      | "ticket.claim" ->
        Fields.map
          (Fields.both ticket_id (Fields.required "token" positive_counter))
          ~decode:(fun (id, token) ->
            Json.obj [ "ticket_id", Json.string id; "token", Json.int token ])
          ~encode:(fun j ->
            Json.text (Json.field j "ticket_id"), Json.integer (Json.field j "token"))
      | "ticket.start" ->
        Fields.map
          (Fields.both
             (Fields.both ticket_id (Fields.required "token" positive_counter))
             (Fields.optional
                "attempt"
                (Coordination_wire.checked
                   Agent_run_api.Attempt_result.codec
                   (fun attempt ->
                      if not (Attempt.State.equal attempt.state Running)
                      then Json.fail Invalid_argument "start attempt must be running"))))
          ~decode:(fun ((id, token), attempt) ->
            Json.obj
              ([ "ticket_id", Json.string id; "token", Json.int token ]
               @ Option.to_list
                   (Option.map attempt ~f:(fun attempt ->
                      "attempt", Agent_run_api.Attempt_result.to_json attempt))))
          ~encode:(fun j ->
            ( (Json.text (Json.field j "ticket_id"), Json.integer (Json.field j "token"))
            , Option.map
                (Json.optional j "attempt")
                ~f:(Coordination_wire.decode_exn Agent_run_api.Attempt_result.codec) ))
      | "ticket.finish" ->
        Fields.map
          (Fields.both
             (Fields.required "completed" boolean)
             (Fields.optional
                "attempt"
                (Coordination_wire.checked
                   Agent_run_api.Attempt_result.codec
                   (fun attempt ->
                      if not (Attempt.State.equal attempt.state Completed)
                      then Json.fail Invalid_argument "finish attempt must be completed"))))
          ~decode:(fun (b, attempt) ->
            Json.obj
              ([ ("completed", if b then `True else `False) ]
               @ Option.to_list
                   (Option.map attempt ~f:(fun attempt ->
                      "attempt", Agent_run_api.Attempt_result.to_json attempt))))
          ~encode:(fun j ->
            let completed =
              match Json.field j "completed" with
              | `True -> true
              | `False -> false
              | _ -> Json.fail Invalid_argument "boolean required"
            in
            ( completed
            , Option.map
                (Json.optional j "attempt")
                ~f:(Coordination_wire.decode_exn Agent_run_api.Attempt_result.codec) ))
      | "ticket.reopen" | "ticket.recover" ->
        Fields.map
          (Fields.both ticket_id (Fields.required "revision" positive_counter))
          ~decode:(fun (id, rev) ->
            Json.obj [ "ticket_id", Json.string id; "revision", Json.int rev ])
          ~encode:(fun j ->
            Json.text (Json.field j "ticket_id"), Json.integer (Json.field j "revision"))
      | _ -> Json.fail Invalid_argument "unknown lifecycle mutation"
    in
    object_ fields)
;;
