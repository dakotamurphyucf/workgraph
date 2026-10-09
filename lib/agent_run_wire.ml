open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both
let text = Api_codec.text ~max_bytes:65_536

let name =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:(fun value ->
      if String.is_empty (String.strip value)
      then Error (Problem.create Invalid_argument "name must not be blank")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonblank name of at most 96 UTF-8 bytes."
;;

let decimal = Api_codec.decimal ~max:Int.max_value
let decimal64 = Api_codec.decimal64 ~max:Int64.max_value

let positive =
  Api_codec.map
    decimal
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "counter must be positive"))
    ~encode:Fn.id
    ~description:"Positive counter."
;;

let id of_string to_string =
  Api_codec.map
    name
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved opaque identity."
;;

let run_id = id Id.Run.of_string Id.Run.to_string
let ticket_id = id Id.Ticket.of_string Id.Ticket.to_string
let actor_id = id Id.Actor.of_string Id.Actor.to_string
let session_id = id Session_id.of_string Session_id.to_string
let attempt_id = id Attempt.Id.of_string Attempt.Id.to_string
let reservation_id = id Reservation.Name.of_string Reservation.Name.to_string
let strings = Api_codec.list name ~max_items:100
let sessions = Api_codec.list session_id ~max_items:100

let status =
  Api_codec.enum
    [ "running", Agent_run_event.Status.Running
    ; "waiting", Waiting
    ; "completed", Completed
    ; "failed", Failed
    ; "cancelled", Cancelled
    ]
    ~equal:Agent_run_event.Status.equal
;;

let parent_stop_policy =
  Api_codec.enum
    [ "continue", Agent_run_event.Parent_stop_policy.Continue
    ; "request_cancel", Request_cancel
    ; "request_wait", Request_wait
    ]
    ~equal:Agent_run_event.Parent_stop_policy.equal
;;

let attempt_state =
  Api_codec.enum
    [ "running", Attempt.State.Running
    ; "waiting", Waiting
    ; "completed", Completed
    ; "failed", Failed
    ; "cancelled", Cancelled
    ]
    ~equal:Attempt.State.equal
;;

let reservation_mode =
  Api_codec.enum
    [ "exclusive", Reservation.Mode.Exclusive; "shared", Shared ]
    ~equal:Reservation.Mode.equal
;;

let validate codec f description =
  Api_codec.map
    codec
    ~decode:(fun value ->
      Json.decode (fun () ->
        f value;
        value))
    ~encode:Fn.id
    ~description
;;

let checkpoint = Agent_run_checkpoint.codec

let lease =
  Api_codec.map
    (Api_codec.object_
       (Fields.map
          (Fields.required "epoch" positive
           ++ Fields.required "revision" positive
           ++ Fields.required "duration_ms" (Api_codec.nullable decimal64)
           ++ Fields.required "last_unix_ms" decimal64
           ++ Fields.required "deadline_unix_ms" (Api_codec.nullable decimal64))
          ~decode:(fun ((((epoch, revision), duration), last), deadline) ->
            Json.obj
              [ "epoch", Json.int epoch
              ; "revision", Json.int revision
              ; "duration_ms", Option.value_map duration ~default:`Null ~f:Json.int64
              ; "last_unix_ms", Json.int64 last
              ; "deadline_unix_ms", Option.value_map deadline ~default:`Null ~f:Json.int64
              ])
          ~encode:(fun json ->
            let duration =
              match Json.field json "duration_ms" with
              | `Null -> None
              | value -> Some (Json.integer64 value)
            in
            let deadline =
              match Json.field json "deadline_unix_ms" with
              | `Null -> None
              | value -> Some (Json.integer64 value)
            in
            ( ( ( ( Json.integer (Json.field json "epoch")
                  , Json.integer (Json.field json "revision") )
                , duration )
              , Json.integer64 (Json.field json "last_unix_ms") )
            , deadline ))))
    ~decode:Allocation_lease.of_json
    ~encode:Allocation_lease.to_json
    ~description:"Validated fenced lease with consistent policy and deadline."
;;

let run =
  let fields =
    Fields.required "run_id" run_id
    ++ Fields.required "revision" positive
    ++ Fields.required "parent_run_id" (Api_codec.nullable run_id)
    ++ Fields.required "parent_stop_policy" parent_stop_policy
    ++ Fields.required "objective" text
    ++ Fields.required "actor_id" actor_id
    ++ Fields.required "capabilities" strings
    ++ Fields.required "session_ids" sessions
    ++ Fields.required "process_ref" (Api_codec.nullable text)
    ++ Fields.required "worktree_ref" (Api_codec.nullable text)
    ++ Fields.required "status" status
    ++ Fields.required "last_observed_unix_ms" (Api_codec.nullable decimal64)
    ++ Fields.required "evidence" text
  in
  let codec =
    Api_codec.object_
      (Fields.map
         fields
         ~decode:
           (fun
             ( ( ( ( ( ( ( ( ((((id, revision), parent), parent_stop_policy), objective)
                           , actor )
                         , capabilities )
                       , sessions )
                     , process_ref )
                   , worktree_ref )
                 , status )
               , last_observed_unix_ms )
             , evidence ) ->
           { Agent_run_event.Record.id
           ; revision
           ; parent
           ; parent_stop_policy
           ; objective
           ; actor
           ; capabilities
           ; sessions
           ; process_ref
           ; worktree_ref
           ; status
           ; last_observed_unix_ms
           ; evidence
           })
         ~encode:
           (fun
             ({ id
              ; revision
              ; parent
              ; parent_stop_policy
              ; objective
              ; actor
              ; capabilities
              ; sessions
              ; process_ref
              ; worktree_ref
              ; status
              ; last_observed_unix_ms
              ; evidence
              } :
               Agent_run_event.Record.t) ->
           ( ( ( ( ( ( ( ( ((((id, revision), parent), parent_stop_policy), objective)
                         , actor )
                       , capabilities )
                     , sessions )
                   , process_ref )
                 , worktree_ref )
               , status )
             , last_observed_unix_ms )
           , evidence )))
  in
  validate
    codec
    Agent_run_event.Record.validate
    "Validated current run record with unique links and terminal evidence."
;;

let attempt =
  let fields =
    Fields.required "attempt_id" attempt_id
    ++ Fields.required "revision" positive
    ++ Fields.required "run_id" run_id
    ++ Fields.required "ticket_id" ticket_id
    ++ Fields.required "token" positive
    ++ Fields.required "state" attempt_state
    ++ Fields.required "session_ids" sessions
    ++ Fields.required "checkpoints" (Api_codec.list checkpoint ~max_items:100)
    ++ Fields.required "evidence" text
  in
  let codec =
    Api_codec.object_
      (Fields.map
         fields
         ~decode:
           (fun
             ( (((((((id, revision), run), ticket), token), state), sessions), checkpoints)
             , evidence ) ->
           { Attempt.id
           ; revision
           ; run
           ; ticket
           ; token
           ; state
           ; sessions
           ; checkpoints
           ; evidence
           })
         ~encode:
           (fun
             ({ id; revision; run; ticket; token; state; sessions; checkpoints; evidence } :
               Attempt.t) ->
           ( (((((((id, revision), run), ticket), token), state), sessions), checkpoints)
           , evidence )))
  in
  validate
    codec
    Attempt.validate
    "Validated attempt counters, unique links, checkpoints and terminal evidence."
;;

let holder =
  Api_codec.object_
    (Fields.map
       (Fields.required "run_id" run_id
        ++ Fields.required "actor_id" actor_id
        ++ Fields.required "token" positive
        ++ Fields.required "mode" reservation_mode
        ++ Fields.required "lease" lease)
       ~decode:(fun ((((run, actor), token), mode), lease) ->
         { Reservation.Holder.run; actor; token; mode; lease })
       ~encode:(fun ({ run; actor; token; mode; lease } : Reservation.Holder.t) ->
         (((run, actor), token), mode), lease))
;;

let reservation =
  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "reservation_id" reservation_id
          ++ Fields.required "epoch" decimal
          ++ Fields.required "holders" (Api_codec.list holder ~max_items:100))
         ~decode:(fun ((name, epoch), holders) -> { Reservation.name; epoch; holders })
         ~encode:(fun ({ name; epoch; holders } : Reservation.t) ->
           (name, epoch), holders))
  in
  validate
    codec
    Reservation.validate
    "Validated reservation holders and ownership fences."
;;

let action =
  Api_codec.object_
    (Fields.map
       (Fields.required "parent_run_id" run_id
        ++ Fields.required "child_run_id" run_id
        ++ Fields.required "policy" parent_stop_policy)
       ~decode:(fun ((parent, child), policy) ->
         { Agent_run_event.Runner_action.parent; child; policy })
       ~encode:(fun ({ parent; child; policy } : Agent_run_event.Runner_action.t) ->
         (parent, child), policy))
;;

let pool =
  Api_codec.object_
    (Fields.map
       (Fields.required "name" name
        ++ Fields.required "revision" positive
        ++ Fields.required
             "limit"
             (Api_codec.map
                (Api_codec.decimal ~max:10_000)
                ~decode:(fun value ->
                  if value > 0
                  then Ok value
                  else
                    Error (Problem.create Invalid_argument "pool limit must be positive"))
                ~encode:Fn.id
                ~description:"Pool concurrency limit from 1 through 10000."))
       ~decode:(fun ((name, revision), limit) ->
         { Allocation.Definition.name; revision; limit })
       ~encode:(fun ({ name; revision; limit } : Allocation.Definition.t) ->
         (name, revision), limit))
;;

let ticket_policy =
  Api_codec.object_
    (Fields.map
       (Fields.required "ticket_id" ticket_id
        ++ Fields.required "revision" positive
        ++ Fields.required "required_capabilities" strings
        ++ Fields.required "pools" strings)
       ~decode:(fun (((ticket, revision), required_capabilities), pools) ->
         { Allocation.Ticket_policy.ticket; revision; required_capabilities; pools })
       ~encode:
         (fun
           ({ ticket; revision; required_capabilities; pools } :
             Allocation.Ticket_policy.t) ->
         ((ticket, revision), required_capabilities), pools))
;;
