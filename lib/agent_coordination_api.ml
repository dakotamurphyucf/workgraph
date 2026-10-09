open Core
open Agent_coordination_command
module W = Coordination_wire
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both
let wrong () = Json.fail Invalid_argument "Wrong coordination command"

let path_requests =
  W.checked (Api_codec.list Path_reservation.Request.codec ~max_items:32) (fun xs ->
    if List.is_empty xs
    then Json.fail Invalid_argument "Path acquisition requires 1..32 requests";
    if
      List.contains_dup
        (List.map xs ~f:(fun r -> r.Path_reservation.Request.target))
        ~compare:Path_scope.compare
    then Json.fail Invalid_argument "Duplicate path acquisition target")
;;

let paths_acquire_fields run =
  Fields.required "target_run_id" run ++ Fields.required "requests" path_requests
;;

let path_renew_fields run =
  Fields.required "target_run_id" run
  ++ Fields.required "target" Path_scope.codec
  ++ Fields.required "token" W.positive
  ++ Fields.required "expected_lease_revision" W.positive
;;

let path_release_fields run =
  Fields.required "target_run_id" run
  ++ Fields.required "target" Path_scope.codec
  ++ Fields.required "token" W.positive
;;

let ticket_declarations =
  Api_codec.map
    (Api_codec.list Ticket_paths.Declaration.codec ~max_items:100)
    ~decode:Ticket_paths.canonicalize
    ~encode:Fn.id
    ~description:"At most 100 distinct targets, normalized and ordered by path target."
;;

let ticket_paths_fields ticket =
  Fields.required "ticket_id" ticket
  ++ Fields.required "expected_revision" W.counter
  ++ Fields.required "declarations" ticket_declarations
  ++ Fields.optional "require_reservations" Api_codec.boolean
;;

let mutation_entries =
  [ ( "reservation.paths.acquire"
    , Api_codec.object_
        (Fields.map
           (paths_acquire_fields W.run)
           ~decode:(fun (run, requests) -> Paths_acquire { run; requests })
           ~encode:(function
             | Paths_acquire p -> p.run, p.requests
             | _ -> wrong ())) )
  ; ( "reservation.path.renew"
    , Api_codec.object_
        (Fields.map
           (path_renew_fields W.run)
           ~decode:(fun (((run, target), token), expected_lease_revision) ->
             Path_renew { run; target; token; expected_lease_revision })
           ~encode:(function
             | Path_renew p -> ((p.run, p.target), p.token), p.expected_lease_revision
             | _ -> wrong ())) )
  ; ( "reservation.path.release"
    , Api_codec.object_
        (Fields.map
           (path_release_fields W.run)
           ~decode:(fun ((run, target), token) -> Path_release { run; target; token })
           ~encode:(function
             | Path_release p -> (p.run, p.target), p.token
             | _ -> wrong ())) )
  ; ( "ticket.paths.put"
    , Api_codec.map
        (Api_codec.object_
           (Fields.map
              (ticket_paths_fields W.ticket)
              ~decode:
                (fun
                  (((ticket_id, expected_revision), declarations), require_reservations) ->
                Ticket_paths_put
                  { ticket_id
                  ; expected_revision
                  ; declarations
                  ; require_reservations =
                      Option.value require_reservations ~default:false
                  })
              ~encode:(function
                | Ticket_paths_put p ->
                  ( ((p.ticket_id, p.expected_revision), p.declarations)
                  , Some p.require_reservations )
                | _ -> wrong ())))
        ~decode:(function
          | Ticket_paths_put p ->
            Result.map (Ticket_paths.canonicalize p.declarations) ~f:(fun declarations ->
              Ticket_paths_put { p with declarations })
          | _ -> wrong ())
        ~encode:Fn.id
        ~description:
          "Up to 100 distinct targets; declarations normalized into target order." )
  ]
  @ List.filter_map [ "condition.put"; "condition.signal" ] ~f:(fun method_ ->
    Option.map (External_condition.Command.codec ~method_) ~f:(fun codec ->
      ( method_
      , Api_codec.map
          codec
          ~decode:(fun c -> Ok (Condition c))
          ~encode:(function
            | Condition c -> c
            | _ -> wrong ())
          ~description:"External condition mutation." )))
  @ List.map
      [ "reservation.recover", `Named; "reservation.path.recover", `Path ]
      ~f:(fun (name, kind) ->
        ( name
        , Api_codec.map
            Ownership_recovery.Request.codec
            ~decode:(fun request ->
              match kind, request.target with
              | `Named, Ownership_recovery.Target.Named _ | `Path, Path _ ->
                Ok (Recover request)
              | `Named, Path _ | `Path, Named _ ->
                Error
                  (Problem.create
                     Invalid_argument
                     "Recovery method and target kind differ"))
            ~encode:(function
              | Recover r -> r
              | _ -> wrong ())
            ~description:"Exact guarded audited stopped/isolated recovery." ))
;;

let mutation_methods = List.map mutation_entries ~f:fst

let command_method = function
  | Paths_acquire _ -> "reservation.paths.acquire"
  | Path_renew _ -> "reservation.path.renew"
  | Path_release _ -> "reservation.path.release"
  | Ticket_paths_put _ -> "ticket.paths.put"
  | Condition (External_condition.Command.Put _) -> "condition.put"
  | Condition (Signal _) -> "condition.signal"
  | Recover r ->
    (match r.Ownership_recovery.Request.target with
     | Named _ -> "reservation.recover"
     | Path _ -> "reservation.path.recover")
;;

let decode_command ~method_ ~params =
  match List.Assoc.find mutation_entries method_ ~equal:String.equal with
  | None -> Error (Problem.create Invalid_argument "Unknown coordination mutation")
  | Some codec -> Api_codec.decode codec params
;;

let encode_command command =
  let method_ = command_method command in
  let codec = List.Assoc.find_exn mutation_entries method_ ~equal:String.equal in
  Result.map (Api_codec.encode codec command) ~f:(fun json -> method_, json)
;;

let holder =
  (* The named and path views share the actual public holder contract. *)
  Agent_run_wire.holder
;;

let path_reservation =
  W.checked
    (Api_codec.object_
       (Fields.map
          (Fields.required "target" Path_scope.codec
           ++ Fields.required "epoch" W.counter
           ++ Fields.required "holders" (Api_codec.list holder ~max_items:100))
          ~decode:(fun ((target, epoch), holders) ->
            { Path_reservation.target; epoch; holders })
          ~encode:(fun t -> (t.Path_reservation.target, t.epoch), t.holders)))
    Path_reservation.validate
;;

let condition_record =
  Api_codec.object_
    (Fields.map
       (Fields.required "declaration" External_condition.Declaration.codec
        ++ Fields.required "satisfied" Api_codec.boolean
        ++ Fields.required
             "latest_signal"
             (Api_codec.nullable External_condition.Signal.codec))
       ~decode:(fun ((declaration, satisfied), latest_signal) ->
         declaration, satisfied, latest_signal)
       ~encode:(fun (d, s, sig_) -> (d, s), sig_))
;;

let condition_record =
  W.checked condition_record (fun (d, satisfied, latest) ->
    let matches =
      Option.value_map latest ~default:false ~f:(fun s ->
        if
          not
            (Coordination_id.Condition.equal
               d.External_condition.Declaration.condition_id
               s.External_condition.Signal.condition_id)
        then
          Json.fail
            Invalid_argument
            "Condition result signal belongs to another declaration";
        Int.equal d.revision s.condition_revision
        && Coordination_id.Operation.equal d.operation_id s.operation_id
        && Evidence_event.Pin.equal d.artifact s.artifact)
    in
    if not (Bool.equal matches satisfied)
    then Json.fail Invalid_argument "Condition result satisfaction contradicts its signal")
;;

let path_reservation_codec = path_reservation
let path_reservation_json = W.encode_exn path_reservation

let condition_json conditions declaration =
  let latest_signal =
    List.last
      (External_condition.signals
         conditions
         ~condition:declaration.External_condition.Declaration.condition_id)
  in
  W.encode_exn
    condition_record
    (declaration, External_condition.satisfied conditions declaration, latest_signal)
;;

module Query = struct
  module Page = struct
    type t =
      { limit : int
      ; max_bytes : int
      ; offset : int
      ; expected_revision : int option
      }

    let bounded max min =
      W.checked (Api_codec.decimal ~max) (fun n ->
        if n < min then Json.fail Invalid_argument "Page bound is too small")
    ;;

    let max_bytes = bounded 1_048_576 4096

    let fields =
      Fields.map
        (Fields.optional "limit" (bounded 100 1)
         ++ Fields.optional "max_bytes" max_bytes
         ++ Fields.optional "offset" W.counter
         ++ Fields.optional "expected_revision" W.counter)
        ~decode:(fun (((limit, max_bytes), offset), expected_revision) ->
          { limit = Option.value limit ~default:50
          ; max_bytes = Option.value max_bytes ~default:65_536
          ; offset = Option.value offset ~default:0
          ; expected_revision
          })
        ~encode:(fun p ->
          ((Some p.limit, Some p.max_bytes), Some p.offset), p.expected_revision)
    ;;

    let validate p =
      if p.offset > 0 && Option.is_none p.expected_revision
      then Json.fail Invalid_argument "Offset pages require expected_revision"
    ;;
  end

  type t =
    | Path_get of
        { target : Path_scope.t
        ; max_bytes : int
        }
    | Ticket_paths_get of
        { ticket : Id.Ticket.t
        ; max_bytes : int
        }
    | Condition_get of
        { condition : Coordination_id.Condition.t
        ; max_bytes : int
        }
    | Recovery_get of
        { recovery : Coordination_id.Recovery.t
        ; max_bytes : int
        }
    | Paths of Page.t
    | Ticket_paths of Page.t
    | Conditions of
        { page : Page.t
        ; ticket : Id.Ticket.t option
        }
    | Signals of
        { page : Page.t
        ; condition : Coordination_id.Condition.t
        }
    | Recoveries of Page.t

  let get name codec create project =
    Api_codec.object_
      (Fields.map
         (Fields.required name codec ++ Fields.optional "max_bytes" Page.max_bytes)
         ~decode:(fun (id, max_bytes) ->
           create id (Option.value max_bytes ~default:65_536))
         ~encode:(fun q ->
           let id, max_bytes = project q in
           id, Some max_bytes))
  ;;

  let page create project =
    W.checked
      (Api_codec.object_ (Fields.map Page.fields ~decode:create ~encode:project))
      (fun q -> Page.validate (project q))
  ;;

  let condition_id =
    W.id Coordination_id.Condition.of_string Coordination_id.Condition.to_string
  ;;

  let recovery_id =
    W.id Coordination_id.Recovery.of_string Coordination_id.Recovery.to_string
  ;;

  let entries =
    [ ( "reservation.path.get"
      , get
          "target"
          Path_scope.codec
          (fun target max_bytes -> Path_get { target; max_bytes })
          (function
            | Path_get p -> p.target, p.max_bytes
            | _ -> wrong ()) )
    ; ( "ticket.paths.get"
      , get
          "ticket_id"
          W.ticket
          (fun ticket max_bytes -> Ticket_paths_get { ticket; max_bytes })
          (function
            | Ticket_paths_get p -> p.ticket, p.max_bytes
            | _ -> wrong ()) )
    ; ( "condition.get"
      , get
          "condition_id"
          condition_id
          (fun condition max_bytes -> Condition_get { condition; max_bytes })
          (function
            | Condition_get p -> p.condition, p.max_bytes
            | _ -> wrong ()) )
    ; ( "recovery.get"
      , get
          "recovery_id"
          recovery_id
          (fun recovery max_bytes -> Recovery_get { recovery; max_bytes })
          (function
            | Recovery_get p -> p.recovery, p.max_bytes
            | _ -> wrong ()) )
    ; ( "reservation.path.list"
      , page
          (fun p -> Paths p)
          (function
            | Paths p -> p
            | _ -> wrong ()) )
    ; ( "ticket.paths.list"
      , page
          (fun p -> Ticket_paths p)
          (function
            | Ticket_paths p -> p
            | _ -> wrong ()) )
    ; ( "recovery.list"
      , page
          (fun p -> Recoveries p)
          (function
            | Recoveries p -> p
            | _ -> wrong ()) )
    ; ( "condition.list"
      , W.checked
          (Api_codec.object_
             (Fields.map
                (Page.fields ++ Fields.optional "ticket_id" W.ticket)
                ~decode:(fun (page, ticket) -> Conditions { page; ticket })
                ~encode:(function
                  | Conditions p -> p.page, p.ticket
                  | _ -> wrong ())))
          (function
            | Conditions p -> Page.validate p.page
            | _ -> wrong ()) )
    ; ( "condition.signals"
      , W.checked
          (Api_codec.object_
             (Fields.map
                (Page.fields ++ Fields.required "condition_id" condition_id)
                ~decode:(fun (page, condition) -> Signals { page; condition })
                ~encode:(function
                  | Signals p -> p.page, p.condition
                  | _ -> wrong ())))
          (function
            | Signals p -> Page.validate p.page
            | _ -> wrong ()) )
    ]
  ;;

  let decode ~method_ ~params =
    match List.Assoc.find entries method_ ~equal:String.equal with
    | Some codec -> Api_codec.decode codec params
    | None -> Error (Problem.create Invalid_argument "Unknown coordination query")
  ;;
end

let query_methods = List.map Query.entries ~f:fst

let raw_mutation_entries =
  let run = Api_codec.reference W.run in
  let obj fields = Api_codec.as_json (Api_codec.object_ fields) in
  [ "reservation.paths.acquire", obj (paths_acquire_fields run)
  ; "reservation.path.renew", obj (path_renew_fields run)
  ; "reservation.path.release", obj (path_release_fields run)
  ; "ticket.paths.put", obj (ticket_paths_fields (Api_codec.reference W.ticket))
  ]
  @ List.filter_map [ "condition.put"; "condition.signal" ] ~f:(fun method_ ->
    Option.map (External_condition.Command.raw_request_codec ~method_) ~f:(fun codec ->
      method_, codec))
  @ List.map
      [ "reservation.recover", "named"; "reservation.path.recover", "path" ]
      ~f:(fun (name, kind) ->
        ( name
        , W.checked Ownership_recovery.Request.raw_codec (fun request ->
            if
              not
                (String.equal
                   (Json.text (Json.field (Json.field request "target") "kind"))
                   kind)
            then Json.fail Invalid_argument "Recovery method and target kind differ") ))
;;

let request_codec ~method_ =
  match List.Assoc.find raw_mutation_entries method_ ~equal:String.equal with
  | Some codec -> Some codec
  | None ->
    Option.map
      (List.Assoc.find Query.entries method_ ~equal:String.equal)
      ~f:Api_codec.as_json
;;

let json codec =
  Api_codec.map
    codec
    ~decode:(Api_codec.encode codec)
    ~encode:(W.decode_exn codec)
    ~description:"Canonical cooperative coordination data."
;;

let page codec =
  json
    (Api_codec.object_
       (Fields.map
          (Fields.required "items" (Api_codec.list codec ~max_items:100)
           ++ Fields.required "next_offset" (Api_codec.nullable W.counter)
           ++ Fields.required "omitted" W.counter)
          ~decode:(fun ((items, next_offset), omitted) -> items, next_offset, omitted)
          ~encode:(fun (items, next_offset, omitted) -> (items, next_offset), omitted)))
;;

let revision = Fields.required "revision" W.counter
let entity_receipt = json (Api_codec.object_ revision)
let coordination_revision = Fields.required "coordination_revision" W.counter
let coordination_receipt = json (Api_codec.object_ coordination_revision)

let mutation_record name codec =
  json (Api_codec.object_ (coordination_revision ++ Fields.required name codec))
;;

let response_codec ~method_ =
  match method_ with
  | "condition.put" ->
    Some (mutation_record "condition" External_condition.Declaration.codec)
  | "condition.signal" -> Some (mutation_record "signal" External_condition.Signal.codec)
  | "reservation.recover" | "reservation.path.recover" ->
    Some (mutation_record "recovery" Ownership_recovery.codec)
  | "reservation.paths.acquire" | "reservation.path.renew" | "reservation.path.release" ->
    Some coordination_receipt
  | "ticket.paths.put" -> Some entity_receipt
  | "reservation.path.get" -> Some (json path_reservation)
  | "ticket.paths.get" -> Some (json Ticket_paths.codec)
  | "condition.get" -> Some (json condition_record)
  | "recovery.get" -> Some (json Ownership_recovery.codec)
  | "reservation.path.list" -> Some (page path_reservation)
  | "ticket.paths.list" -> Some (page Ticket_paths.codec)
  | "condition.list" -> Some (page condition_record)
  | "condition.signals" -> Some (page External_condition.Signal.codec)
  | "recovery.list" -> Some (page Ownership_recovery.codec)
  | _ -> None
;;
