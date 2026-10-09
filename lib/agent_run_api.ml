open Core
open Agent_run_command
module Fields = Api_codec.Fields

module Attempt_result = struct
  type t =
    { attempt_id : Attempt.Id.t
    ; revision : int
    ; state : Attempt.State.t
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.both
            (Fields.required
               "attempt_id"
               (Coordination_wire.id Attempt.Id.of_string Attempt.Id.to_string))
            (Fields.both
               (Fields.required "revision" Coordination_wire.positive)
               (Fields.required "state" Agent_run_wire.attempt_state)))
         ~decode:(fun (attempt_id, (revision, state)) -> { attempt_id; revision; state })
         ~encode:(fun t -> t.attempt_id, (t.revision, t.state)))
  ;;

  let of_attempt (attempt : Attempt.t) =
    { attempt_id = attempt.id; revision = attempt.revision; state = attempt.state }
  ;;

  let to_json t = Coordination_wire.encode_exn codec t
end

let ( ++ ) = Fields.both
let text = Api_codec.text ~max_bytes:65_536

let nonblank max_bytes =
  Api_codec.map
    (Api_codec.text ~max_bytes)
    ~decode:(fun value ->
      if String.is_empty (String.strip value)
      then Error (Problem.create Invalid_argument "text must not be blank")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonblank UTF-8 text."
;;

let name = nonblank 96
let objective = nonblank 16_384
let decimal = Api_codec.decimal ~max:Int.max_value

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

let pool_limit =
  Api_codec.map
    (Api_codec.decimal ~max:10_000)
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "pool limit must be 1..10000"))
    ~encode:Fn.id
    ~description:"Pool concurrency limit from 1 through 10000."
;;

let decimal64 = Api_codec.decimal64 ~max:Int64.max_value

let lease_duration =
  Api_codec.map
    (Api_codec.decimal64 ~max:86_400_000L)
    ~decode:(fun duration ->
      if Int64.compare duration 0L > 0
      then Ok duration
      else
        Error
          (Problem.create
             Invalid_argument
             "lease duration must be 1..86400000 milliseconds"))
    ~encode:Fn.id
    ~description:"Explicit lease duration from 1 millisecond through 24 hours."
;;

let reference =
  Api_codec.map
    (Api_codec.text ~max_bytes:97)
    ~decode:(fun value ->
      let key =
        if String.is_prefix value ~prefix:"$" then String.drop_prefix value 1 else value
      in
      Result.map (Id.Actor.of_string key) ~f:(fun _ -> value))
    ~encode:Fn.id
    ~description:"Opaque ID or transaction $alias, resolved before preparation."
;;

let names =
  Api_codec.map
    (Api_codec.list name ~max_items:100)
    ~decode:(fun names ->
      if List.contains_dup names ~compare:String.compare
      then Error (Problem.create Invalid_argument "duplicate capability or pool name")
      else Ok names)
    ~encode:Fn.id
    ~description:"At most 100 distinct nonblank names."
;;

let references =
  Api_codec.map
    (Api_codec.list reference ~max_items:100)
    ~decode:(fun values ->
      if List.contains_dup values ~compare:String.compare
      then Error (Problem.create Invalid_argument "duplicate session reference")
      else Ok values)
    ~encode:Fn.id
    ~description:"At most 100 distinct session references."
;;

let terminal_attempt_state =
  Api_codec.enum
    [ "completed", Attempt.State.Completed; "failed", Failed; "cancelled", Cancelled ]
    ~equal:Attempt.State.equal
;;

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

module Reservation_request = struct
  type t =
    { name : string
    ; mode : Reservation.Mode.t
    ; lease_duration_ms : int64 option
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "reservation_id" reference
          ++ Fields.required "mode" Agent_run_wire.reservation_mode
          ++ Fields.optional "lease_duration_ms" (Api_codec.nullable lease_duration))
         ~decode:(fun ((name, mode), lease_duration_ms) ->
           { name; mode; lease_duration_ms = Option.join lease_duration_ms })
         ~encode:(fun { name; mode; lease_duration_ms } ->
           (name, mode), Some lease_duration_ms))
  ;;

  let resolve { name; mode; lease_duration_ms } =
    { Reservation.name = Reservation.Name.t_of_jsonaf (Json.string name)
    ; mode
    ; lease_duration_ms
    }
  ;;

  let of_request ({ name; mode; lease_duration_ms } : Reservation.request) =
    { name = Reservation.Name.to_string name; mode; lease_duration_ms }
  ;;
end

let reservation_requests =
  Api_codec.map
    (Api_codec.list Reservation_request.codec ~max_items:32)
    ~decode:(fun requests ->
      if List.is_empty requests
      then
        Error
          (Problem.create
             Invalid_argument
             "reservation acquisition requires 1..32 requests")
      else if
        List.contains_dup
          (List.map requests ~f:(fun request -> request.Reservation_request.name))
          ~compare:String.compare
      then Error (Problem.create Invalid_argument "duplicate reservation reference")
      else Ok requests)
    ~encode:Fn.id
    ~description:"1..32 ordered reservation requests."
;;

module Allocation_pool_put_request = struct
  type t =
    { name : string
    ; expected_revision : int
    ; limit : int
    }
end

module Allocation_ticket_policy_put_request = struct
  type t =
    { ticket : string
    ; expected_revision : int
    ; required_capabilities : string list
    ; pools : string list
    }
end

module Run_register_request = struct
  type t =
    { id : string
    ; parent : string option
    ; parent_stop_policy : Agent_run_event.Parent_stop_policy.t option
    ; objective : string
    ; capabilities : string list option
    ; process_ref : string option
    ; worktree_ref : string option
    }
end

module Run_transition_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; status : Agent_run_event.Status.t
    ; evidence : string
    }
end

module Run_observe_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; observed_unix_ms : int64
    }
end

module Run_link_session_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; session : string
    }
end

module Attempt_start_request = struct
  type t =
    { id : string
    ; run : string
    ; ticket : string
    ; token : int
    ; sessions : string list option
    }
end

module Attempt_checkpoint_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; checkpoint : Agent_run_checkpoint.Reference.t
    }
end

module Attempt_finish_request = struct
  type t =
    { id : string
    ; expected_revision : int
    ; state : Attempt.State.t
    ; evidence : string
    }
end

module Reservation_acquire_request = struct
  type t =
    { run : string
    ; requests : Reservation_request.t list
    }
end

module Reservation_renew_request = struct
  type t =
    { run : string
    ; name : string
    ; token : int
    ; expected_lease_revision : int
    }
end

module Reservation_release_request = struct
  type t =
    { run : string
    ; name : string
    ; token : int
    }
end

module Run_action_acknowledge_request = struct
  type t =
    { child : string
    ; evidence : string
    }
end

type entry =
  | Entry :
      { name : string
      ; request : 'request Api_codec.t
      ; command : 'request -> Agent_run_command.t
      ; project : Agent_run_command.t -> 'request option
      }
      -> entry

let entries =
  [ Entry
      { name = "allocation.pool_put"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "name" name
                ++ Fields.required "expected_revision" decimal
                ++ Fields.required "limit" pool_limit)
               ~decode:(fun ((name, expected_revision), limit) ->
                 { Allocation_pool_put_request.name; expected_revision; limit })
               ~encode:
                 (fun
                   ({ name; expected_revision; limit } : Allocation_pool_put_request.t) ->
                 (name, expected_revision), limit))
      ; command =
          (fun ({ name; expected_revision; limit } : Allocation_pool_put_request.t) ->
            Pool_put { name; expected_revision; limit })
      ; project =
          (function
            | Pool_put { name; expected_revision; limit } ->
              Some { Allocation_pool_put_request.name; expected_revision; limit }
            | _ -> None)
      }
  ; Entry
      { name = "allocation.ticket_policy_put"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "ticket_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.required "required_capabilities" names
                ++ Fields.required "pools" names)
               ~decode:
                 (fun
                   (((ticket, expected_revision), required_capabilities), pools) ->
                 { Allocation_ticket_policy_put_request.ticket
                 ; expected_revision
                 ; required_capabilities
                 ; pools
                 })
               ~encode:
                 (fun
                   ({ ticket; expected_revision; required_capabilities; pools } :
                     Allocation_ticket_policy_put_request.t) ->
                 ((ticket, expected_revision), required_capabilities), pools))
      ; command =
          (fun ({ ticket; expected_revision; required_capabilities; pools } :
                 Allocation_ticket_policy_put_request.t) ->
            Ticket_policy_put
              { ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; expected_revision
              ; required_capabilities
              ; pools
              })
      ; project =
          (function
            | Ticket_policy_put
                { ticket; expected_revision; required_capabilities; pools } ->
              Some
                { Allocation_ticket_policy_put_request.ticket = Id.Ticket.to_string ticket
                ; expected_revision
                ; required_capabilities
                ; pools
                }
            | _ -> None)
      }
  ; Entry
      { name = "run.register"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "target_run_id" reference
                ++ Fields.optional "parent_run_id" reference
                ++ Fields.optional "parent_stop_policy" Agent_run_wire.parent_stop_policy
                ++ Fields.required "objective" objective
                ++ Fields.optional "capabilities" names
                ++ Fields.optional "process_ref" (nonblank 1024)
                ++ Fields.optional "worktree_ref" (nonblank 4096))
               ~decode:
                 (fun
                   ( ( ((((id, parent), parent_stop_policy), objective), capabilities)
                     , process_ref )
                   , worktree_ref ) ->
                 { Run_register_request.id
                 ; parent
                 ; parent_stop_policy
                 ; objective
                 ; capabilities
                 ; process_ref
                 ; worktree_ref
                 })
               ~encode:
                 (fun
                   ({ id
                    ; parent
                    ; parent_stop_policy
                    ; objective
                    ; capabilities
                    ; process_ref
                    ; worktree_ref
                    } :
                     Run_register_request.t) ->
                 ( ( ((((id, parent), parent_stop_policy), objective), capabilities)
                   , process_ref )
                 , worktree_ref )))
      ; command =
          (fun ({ id
                ; parent
                ; parent_stop_policy
                ; objective
                ; capabilities
                ; process_ref
                ; worktree_ref
                } :
                 Run_register_request.t) ->
            Register
              { id = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) id
              ; parent =
                  Option.map parent ~f:(fun value ->
                    Id.Run.t_of_jsonaf (Json.string value))
              ; parent_stop_policy =
                  Option.value
                    parent_stop_policy
                    ~default:Agent_run_event.Parent_stop_policy.Continue
              ; objective
              ; capabilities = Option.value capabilities ~default:[]
              ; process_ref
              ; worktree_ref
              })
      ; project =
          (function
            | Register
                { id
                ; parent
                ; parent_stop_policy
                ; objective
                ; capabilities
                ; process_ref
                ; worktree_ref
                } ->
              Some
                { Run_register_request.id = Id.Run.to_string id
                ; parent = Option.map parent ~f:Id.Run.to_string
                ; parent_stop_policy = Some parent_stop_policy
                ; objective
                ; capabilities = Some capabilities
                ; process_ref
                ; worktree_ref
                }
            | _ -> None)
      }
  ; Entry
      { name = "run.transition"
      ; request =
          Api_codec.map
            (Api_codec.object_
               (Fields.map
                  (Fields.required "target_run_id" reference
                   ++ Fields.required "expected_revision" decimal
                   ++ Fields.required "status" Agent_run_wire.status
                   ++ Fields.required "evidence" text)
                  ~decode:(fun (((id, expected_revision), status), evidence) ->
                    { Run_transition_request.id; expected_revision; status; evidence })
                  ~encode:
                    (fun
                      ({ id; expected_revision; status; evidence } :
                        Run_transition_request.t) ->
                    ((id, expected_revision), status), evidence)))
            ~decode:(fun request ->
              if
                Agent_run_event.Status.terminal request.Run_transition_request.status
                && String.is_empty (String.strip request.evidence)
              then
                Error (Problem.create Invalid_argument "terminal runs require evidence")
              else Ok request)
            ~encode:Fn.id
            ~description:"Terminal transitions require nonblank evidence."
      ; command =
          (fun ({ id; expected_revision; status; evidence } : Run_transition_request.t) ->
            Transition
              { id = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; status
              ; evidence
              })
      ; project =
          (function
            | Transition { id; expected_revision; status; evidence } ->
              Some
                { Run_transition_request.id = Id.Run.to_string id
                ; expected_revision
                ; status
                ; evidence
                }
            | _ -> None)
      }
  ; Entry
      { name = "run.observe"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "target_run_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.required "observed_unix_ms" decimal64)
               ~decode:(fun ((id, expected_revision), observed_unix_ms) ->
                 { Run_observe_request.id; expected_revision; observed_unix_ms })
               ~encode:
                 (fun
                   ({ id; expected_revision; observed_unix_ms } : Run_observe_request.t) ->
                 (id, expected_revision), observed_unix_ms))
      ; command =
          (fun ({ id; expected_revision; observed_unix_ms } : Run_observe_request.t) ->
            Observe
              { id = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; observed_unix_ms
              })
      ; project =
          (function
            | Observe { id; expected_revision; observed_unix_ms } ->
              Some
                { Run_observe_request.id = Id.Run.to_string id
                ; expected_revision
                ; observed_unix_ms
                }
            | _ -> None)
      }
  ; Entry
      { name = "run.link_session"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "target_run_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.required "session_id" reference)
               ~decode:(fun ((id, expected_revision), session) ->
                 { Run_link_session_request.id; expected_revision; session })
               ~encode:
                 (fun
                   ({ id; expected_revision; session } : Run_link_session_request.t) ->
                 (id, expected_revision), session))
      ; command =
          (fun ({ id; expected_revision; session } : Run_link_session_request.t) ->
            Link_session
              { id = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; session =
                  (fun value -> Session_id.t_of_jsonaf (Json.string value)) session
              })
      ; project =
          (function
            | Link_session { id; expected_revision; session } ->
              Some
                { Run_link_session_request.id = Id.Run.to_string id
                ; expected_revision
                ; session = Session_id.to_string session
                }
            | _ -> None)
      }
  ; Entry
      { name = "attempt.start"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "attempt_id" reference
                ++ Fields.required "target_run_id" reference
                ++ Fields.required "ticket_id" reference
                ++ Fields.required "token" positive
                ++ Fields.optional "session_ids" references)
               ~decode:(fun ((((id, run), ticket), token), sessions) ->
                 { Attempt_start_request.id; run; ticket; token; sessions })
               ~encode:
                 (fun
                   ({ id; run; ticket; token; sessions } : Attempt_start_request.t) ->
                 (((id, run), ticket), token), sessions))
      ; command =
          (fun ({ id; run; ticket; token; sessions } : Attempt_start_request.t) ->
            Attempt_start
              { id = (fun value -> Attempt.Id.t_of_jsonaf (Json.string value)) id
              ; run = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) run
              ; ticket = (fun value -> Id.Ticket.t_of_jsonaf (Json.string value)) ticket
              ; token
              ; sessions =
                  (fun values ->
                     List.map values ~f:(fun value ->
                       Session_id.t_of_jsonaf (Json.string value)))
                    (Option.value sessions ~default:[])
              })
      ; project =
          (function
            | Attempt_start { id; run; ticket; token; sessions } ->
              Some
                { Attempt_start_request.id = Attempt.Id.to_string id
                ; run = Id.Run.to_string run
                ; ticket = Id.Ticket.to_string ticket
                ; token
                ; sessions =
                    Some
                      ((fun values -> List.map values ~f:Session_id.to_string) sessions)
                }
            | _ -> None)
      }
  ; Entry
      { name = "attempt.checkpoint"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "attempt_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.required "checkpoint" Agent_run_checkpoint.Reference.codec)
               ~decode:(fun ((id, expected_revision), checkpoint) ->
                 { Attempt_checkpoint_request.id; expected_revision; checkpoint })
               ~encode:
                 (fun
                   ({ id; expected_revision; checkpoint } : Attempt_checkpoint_request.t) ->
                 (id, expected_revision), checkpoint))
      ; command =
          (fun ({ id; expected_revision; checkpoint } : Attempt_checkpoint_request.t) ->
            Attempt_checkpoint
              { id = (fun value -> Attempt.Id.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; checkpoint = unwrap (Agent_run_checkpoint.Reference.resolve checkpoint)
              })
      ; project =
          (function
            | Attempt_checkpoint { id; expected_revision; checkpoint } ->
              Some
                { Attempt_checkpoint_request.id = Attempt.Id.to_string id
                ; expected_revision
                ; checkpoint = Agent_run_checkpoint.Reference.of_checkpoint checkpoint
                }
            | _ -> None)
      }
  ; Entry
      { name = "attempt.finish"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "attempt_id" reference
                ++ Fields.required "expected_revision" decimal
                ++ Fields.required "state" terminal_attempt_state
                ++ Fields.required "evidence" (nonblank 65_536))
               ~decode:(fun (((id, expected_revision), state), evidence) ->
                 { Attempt_finish_request.id; expected_revision; state; evidence })
               ~encode:
                 (fun
                   ({ id; expected_revision; state; evidence } : Attempt_finish_request.t) ->
                 ((id, expected_revision), state), evidence))
      ; command =
          (fun ({ id; expected_revision; state; evidence } : Attempt_finish_request.t) ->
            Attempt_finish
              { id = (fun value -> Attempt.Id.t_of_jsonaf (Json.string value)) id
              ; expected_revision
              ; state
              ; evidence
              })
      ; project =
          (function
            | Attempt_finish { id; expected_revision; state; evidence } ->
              Some
                { Attempt_finish_request.id = Attempt.Id.to_string id
                ; expected_revision
                ; state
                ; evidence
                }
            | _ -> None)
      }
  ; Entry
      { name = "reservation.acquire"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "target_run_id" reference
                ++ Fields.required "requests" reservation_requests)
               ~decode:(fun (run, requests) ->
                 { Reservation_acquire_request.run; requests })
               ~encode:(fun ({ run; requests } : Reservation_acquire_request.t) ->
                 run, requests))
      ; command =
          (fun ({ run; requests } : Reservation_acquire_request.t) ->
            Reservation_acquire
              { run = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) run
              ; requests = List.map requests ~f:Reservation_request.resolve
              })
      ; project =
          (function
            | Reservation_acquire { run; requests } ->
              Some
                { Reservation_acquire_request.run = Id.Run.to_string run
                ; requests = List.map requests ~f:Reservation_request.of_request
                }
            | _ -> None)
      }
  ; Entry
      { name = "reservation.renew"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "target_run_id" reference
                ++ Fields.required "reservation_id" reference
                ++ Fields.required "token" positive
                ++ Fields.required "expected_lease_revision" positive)
               ~decode:(fun (((run, name), token), expected_lease_revision) ->
                 { Reservation_renew_request.run; name; token; expected_lease_revision })
               ~encode:
                 (fun
                   ({ run; name; token; expected_lease_revision } :
                     Reservation_renew_request.t) ->
                 ((run, name), token), expected_lease_revision))
      ; command =
          (fun ({ run; name; token; expected_lease_revision } :
                 Reservation_renew_request.t) ->
            Reservation_renew
              { run = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) run
              ; name =
                  (fun value -> Reservation.Name.t_of_jsonaf (Json.string value)) name
              ; token
              ; expected_lease_revision
              })
      ; project =
          (function
            | Reservation_renew { run; name; token; expected_lease_revision } ->
              Some
                { Reservation_renew_request.run = Id.Run.to_string run
                ; name = Reservation.Name.to_string name
                ; token
                ; expected_lease_revision
                }
            | _ -> None)
      }
  ; Entry
      { name = "reservation.release"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "target_run_id" reference
                ++ Fields.required "reservation_id" reference
                ++ Fields.required "token" positive)
               ~decode:(fun ((run, name), token) ->
                 { Reservation_release_request.run; name; token })
               ~encode:(fun ({ run; name; token } : Reservation_release_request.t) ->
                 (run, name), token))
      ; command =
          (fun ({ run; name; token } : Reservation_release_request.t) ->
            Reservation_release
              { run = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) run
              ; name =
                  (fun value -> Reservation.Name.t_of_jsonaf (Json.string value)) name
              ; token
              })
      ; project =
          (function
            | Reservation_release { run; name; token } ->
              Some
                { Reservation_release_request.run = Id.Run.to_string run
                ; name = Reservation.Name.to_string name
                ; token
                }
            | _ -> None)
      }
  ; Entry
      { name = "run.action_acknowledge"
      ; request =
          Api_codec.object_
            (Fields.map
               (Fields.required "child_run_id" reference
                ++ Fields.required "evidence" (nonblank 65_536))
               ~decode:(fun (child, evidence) ->
                 { Run_action_acknowledge_request.child; evidence })
               ~encode:(fun ({ child; evidence } : Run_action_acknowledge_request.t) ->
                 child, evidence))
      ; command =
          (fun ({ child; evidence } : Run_action_acknowledge_request.t) ->
            Action_acknowledge
              { child = (fun value -> Id.Run.t_of_jsonaf (Json.string value)) child
              ; evidence
              })
      ; project =
          (function
            | Action_acknowledge { child; evidence } ->
              Some
                { Run_action_acknowledge_request.child = Id.Run.to_string child
                ; evidence
                }
            | _ -> None)
      }
  ]
;;

let mutation_methods =
  List.map entries ~f:(fun (Entry entry) -> entry.name)
  @ Agent_coordination_api.mutation_methods
;;

let find_mutation method_ =
  List.find entries ~f:(fun (Entry entry) -> String.equal method_ entry.name)
;;

let decode_command ~method_ ~params =
  match find_mutation method_ with
  | None ->
    Result.map (Agent_coordination_api.decode_command ~method_ ~params) ~f:(fun c ->
      Coordination c)
  | Some (Entry entry) ->
    Result.bind (Api_codec.decode entry.request params) ~f:(fun request ->
      Json.decode (fun () -> entry.command request))
;;

let encode_command command =
  match command with
  | Coordination c -> Agent_coordination_api.encode_command c
  | _ ->
    (match
       List.find_map entries ~f:(fun (Entry entry) ->
         Option.map (entry.project command) ~f:(fun request ->
           Result.map (Api_codec.encode entry.request request) ~f:(fun params ->
             entry.name, params)))
     with
     | Some result -> result
     | None -> Error (Problem.create Invalid_argument "run command has no wire codec"))
;;

module Query = struct
  module Page = struct
    type t =
      { limit : int
      ; max_bytes : int
      ; offset : int
      ; expected_revision : int option
      }

    let bounded codec min description =
      Api_codec.map
        codec
        ~decode:(fun value ->
          if value >= min
          then Ok value
          else Error (Problem.create Invalid_argument description))
        ~encode:Fn.id
        ~description
    ;;

    let limit = bounded (Api_codec.decimal ~max:100) 1 "limit must be 1..100"

    let max_bytes =
      bounded (Api_codec.decimal ~max:1_048_576) 4096 "max_bytes must be 4096..1048576"
    ;;

    let fields =
      Fields.map
        (Fields.optional "limit" limit
         ++ Fields.optional "max_bytes" max_bytes
         ++ Fields.optional "offset" decimal
         ++ Fields.optional "expected_revision" decimal)
        ~decode:(fun (((limit, max_bytes), offset), expected_revision) ->
          { limit = Option.value limit ~default:50
          ; max_bytes = Option.value max_bytes ~default:65_536
          ; offset = Option.value offset ~default:0
          ; expected_revision
          })
        ~encode:(fun { limit; max_bytes; offset; expected_revision } ->
          ((Some limit, Some max_bytes), Some offset), expected_revision)
    ;;

    let validate page =
      if page.offset > 0 && Option.is_none page.expected_revision
      then
        Error (Problem.create Invalid_argument "offset pages require expected_revision")
      else Ok page
    ;;
  end

  module Get = struct
    type 'id t =
      { id : 'id
      ; max_bytes : int
      }

    let fields name codec =
      Fields.map
        (Fields.required name codec ++ Fields.optional "max_bytes" Page.max_bytes)
        ~decode:(fun (id, max_bytes) ->
          { id; max_bytes = Option.value max_bytes ~default:65_536 })
        ~encode:(fun { id; max_bytes } -> id, Some max_bytes)
    ;;
  end

  type t =
    | Run_get of Id.Run.t Get.t
    | Attempt_get of Attempt.Id.t Get.t
    | Reservation_get of Reservation.Name.t Get.t
    | Pools of Page.t
    | Ticket_policies of Page.t
    | Runs of Page.t
    | Attempts of
        { page : Page.t
        ; ticket : Id.Ticket.t option
        ; run : Id.Run.t option
        }
    | Reservations of Page.t
    | Actions of Page.t

  let resolved of_string to_string =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:of_string
      ~encode:to_string
      ~description:"Resolved opaque identity."
  ;;

  let run_id = resolved Id.Run.of_string Id.Run.to_string
  let ticket_id = resolved Id.Ticket.of_string Id.Ticket.to_string
  let attempt_id = resolved Attempt.Id.of_string Attempt.Id.to_string
  let reservation_id = resolved Reservation.Name.of_string Reservation.Name.to_string

  let page name create project =
    ( name
    , Api_codec.map
        (Api_codec.object_ (Fields.map Page.fields ~decode:create ~encode:project))
        ~decode:(fun query ->
          Result.map (Page.validate (project query)) ~f:(fun _ -> query))
        ~encode:Fn.id
        ~description:"Bounded stable offset page guarded by coordination revision." )
  ;;

  let entries =
    [ ( "run.get"
      , Api_codec.object_
          (Fields.map
             (Get.fields "target_run_id" run_id)
             ~decode:(fun id -> Run_get id)
             ~encode:(function
               | Run_get id -> id
               | _ -> Json.fail Invalid_argument "wrong query kind")) )
    ; ( "attempt.get"
      , Api_codec.object_
          (Fields.map
             (Get.fields "attempt_id" attempt_id)
             ~decode:(fun id -> Attempt_get id)
             ~encode:(function
               | Attempt_get id -> id
               | _ -> Json.fail Invalid_argument "wrong query kind")) )
    ; ( "reservation.get"
      , Api_codec.object_
          (Fields.map
             (Get.fields "reservation_id" reservation_id)
             ~decode:(fun id -> Reservation_get id)
             ~encode:(function
               | Reservation_get id -> id
               | _ -> Json.fail Invalid_argument "wrong query kind")) )
    ; page
        "allocation.pools"
        (fun page -> Pools page)
        (function
          | Pools page -> page
          | _ -> Json.fail Invalid_argument "wrong query kind")
    ; page
        "allocation.ticket_policies"
        (fun page -> Ticket_policies page)
        (function
          | Ticket_policies page -> page
          | _ -> Json.fail Invalid_argument "wrong query kind")
    ; page
        "run.list"
        (fun page -> Runs page)
        (function
          | Runs page -> page
          | _ -> Json.fail Invalid_argument "wrong query kind")
    ; page
        "reservation.list"
        (fun page -> Reservations page)
        (function
          | Reservations page -> page
          | _ -> Json.fail Invalid_argument "wrong query kind")
    ; page
        "run.actions"
        (fun page -> Actions page)
        (function
          | Actions page -> page
          | _ -> Json.fail Invalid_argument "wrong query kind")
    ; ( "attempt.list"
      , Api_codec.map
          (Api_codec.object_
             (Fields.map
                (Page.fields
                 ++ Fields.optional "ticket_id" ticket_id
                 ++ Fields.optional "target_run_id" run_id)
                ~decode:(fun ((page, ticket), run) -> Attempts { page; ticket; run })
                ~encode:(function
                  | Attempts { page; ticket; run } -> (page, ticket), run
                  | _ -> Json.fail Invalid_argument "wrong query kind")))
          ~decode:(function
            | Attempts ({ page; _ } as params) ->
              Result.map (Page.validate page) ~f:(fun _ -> Attempts params)
            | _ -> Json.fail Invalid_argument "wrong query kind")
          ~encode:Fn.id
          ~description:"Bounded attempt page with exact optional ticket/run filters." )
    ]
  ;;

  let decode ~method_ ~params =
    match List.Assoc.find entries method_ ~equal:String.equal with
    | Some codec -> Api_codec.decode codec params
    | None -> Error (Problem.create Invalid_argument "unknown run query method")
  ;;
end

let query_methods = List.map Query.entries ~f:fst @ Agent_coordination_api.query_methods

let json_codec codec =
  Api_codec.map
    codec
    ~decode:(Api_codec.encode codec)
    ~encode:(fun json -> unwrap (Api_codec.decode codec json))
    ~description:"Canonical data validated by the executable typed codec."
;;

let request_codec ~method_ =
  match find_mutation method_ with
  | Some (Entry entry) -> Some (Api_codec.as_json entry.request)
  | None ->
    (match List.Assoc.find Query.entries method_ ~equal:String.equal with
     | Some codec -> Some (Api_codec.as_json codec)
     | None -> Agent_coordination_api.request_codec ~method_)
;;

let entity_receipt =
  json_codec
    (Api_codec.object_
       (Fields.required
          "revision"
          (Api_codec.map
             Coordination_wire.positive
             ~decode:Result.return
             ~encode:Fn.id
             ~description:"Affected entity revision; use as its next expected_revision.")))
;;

let coordination_receipt =
  json_codec (Api_codec.object_ (Fields.required "coordination_revision" decimal))
;;

let page_data codec =
  json_codec
    (Api_codec.object_
       (Fields.map
          (Fields.required "items" (Api_codec.list codec ~max_items:100)
           ++ Fields.required "next_offset" (Api_codec.nullable decimal)
           ++ Fields.required "omitted" decimal)
          ~decode:(fun ((items, next_offset), omitted) -> items, next_offset, omitted)
          ~encode:(fun (items, next_offset, omitted) -> (items, next_offset), omitted)))
;;

let response_codec ~method_ =
  match Agent_coordination_api.response_codec ~method_ with
  | Some codec -> Some codec
  | None ->
    (match method_ with
     | "run.register"
     | "run.transition"
     | "run.observe"
     | "run.link_session"
     | "allocation.pool_put"
     | "allocation.ticket_policy_put" -> Some entity_receipt
     | "attempt.start" ->
       Some
         (json_codec
            (Coordination_wire.checked Attempt_result.codec (fun result ->
               if not (Attempt.State.equal result.state Running)
               then Json.fail Invalid_argument "new attempt must be running")))
     | "attempt.checkpoint" ->
       Some
         (json_codec
            (Coordination_wire.checked Attempt_result.codec (fun result ->
               if Attempt.State.terminal result.state
               then Json.fail Invalid_argument "checkpoint attempt must be active")))
     | "attempt.finish" ->
       Some
         (json_codec
            (Coordination_wire.checked Attempt_result.codec (fun result ->
               if not (Attempt.State.terminal result.state)
               then Json.fail Invalid_argument "finished attempt must be terminal")))
     | "reservation.acquire"
     | "reservation.renew"
     | "reservation.release"
     | "run.action_acknowledge" -> Some coordination_receipt
     | _ ->
       (match method_ with
        | "run.get" -> Some (json_codec Agent_run_wire.run)
        | "attempt.get" -> Some (json_codec Agent_run_wire.attempt)
        | "reservation.get" -> Some (json_codec Agent_run_wire.reservation)
        | "allocation.pools" -> Some (page_data Agent_run_wire.pool)
        | "allocation.ticket_policies" -> Some (page_data Agent_run_wire.ticket_policy)
        | "run.list" -> Some (page_data Agent_run_wire.run)
        | "attempt.list" -> Some (page_data Agent_run_wire.attempt)
        | "reservation.list" -> Some (page_data Agent_run_wire.reservation)
        | "run.actions" -> Some (page_data Agent_run_wire.action)
        | _ -> None))
;;

let descriptor ~method_ =
  match request_codec ~method_, response_codec ~method_ with
  | Some request, Some response ->
    Some
      (Api_method.Packed.Pack
         (Api_method.create
            ~name:method_
            ~summary:("Run coordination method " ^ method_)
            ~mode:
              (if List.mem mutation_methods method_ ~equal:String.equal
               then Api_method.Mode.Mutation
               else Read)
            ~request
            ~response))
  | None, _ | _, None -> None
;;

let validate_result ~method_ result =
  match request_codec ~method_, response_codec ~method_ with
  | Some request, Some response ->
    let descriptor =
      Api_method.create
        ~name:method_
        ~summary:("Run coordination method " ^ method_)
        ~mode:
          (if List.mem mutation_methods method_ ~equal:String.equal
           then Api_method.Mode.Mutation
           else Read)
        ~request
        ~response
    in
    ignore (Api_method.encode_response descriptor result : Jsonaf.t);
    Some ()
  | None, _ | _, None -> None
;;

let project method_ codec value =
  match Api_codec.encode codec value with
  | Ok json -> json
  | Error error -> raise (Api_method.Invalid_response (method_, error))
;;

let run_json = project "run.get" Agent_run_wire.run
let attempt_json = project "attempt.get" Agent_run_wire.attempt
let reservation_json = project "reservation.get" Agent_run_wire.reservation
let action_json = project "run.actions" Agent_run_wire.action
let pool_json = project "allocation.pools" Agent_run_wire.pool
let ticket_policy_json = project "allocation.ticket_policies" Agent_run_wire.ticket_policy
