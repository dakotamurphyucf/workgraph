open Core
module Condition_id = Coordination_id.Condition
module Signal_id = Coordination_id.Signal
module Operation_id = Coordination_id.Operation
module Fields = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = Fields.both
let condition_id = W.id Condition_id.of_string Condition_id.to_string
let signal_id = W.id Signal_id.of_string Signal_id.to_string
let operation_id = W.id Operation_id.of_string Operation_id.to_string

let recipients =
  W.checked (Api_codec.list W.actor ~max_items:100) (fun xs ->
    if
      not
        (List.equal Id.Actor.equal xs (List.dedup_and_sort xs ~compare:Id.Actor.compare))
    then
      Json.fail
        Invalid_argument
        "Condition recipients must be distinct and in actor order")
;;

module Declaration = struct
  type t =
    { condition_id : Condition_id.t
    ; revision : int
    ; ticket_id : Id.Ticket.t
    ; operation_id : Operation_id.t
    ; artifact : Evidence_event.Pin.t
    ; required : bool
    ; label : string
    ; creator : Id.Actor.t
    ; creator_run : Id.Run.t option
    ; recipients : Id.Actor.t list
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "condition_id" condition_id
          ++ Fields.required "revision" W.positive
          ++ Fields.required "ticket_id" W.ticket
          ++ Fields.required "operation_id" operation_id
          ++ Fields.required "artifact" Evidence_wire.pin
          ++ Fields.required "required" Api_codec.boolean
          ++ Fields.required "label" (W.nonblank ~max_bytes:4096)
          ++ Fields.required "creator" W.actor
          ++ Fields.required "creator_run" (Api_codec.nullable W.run)
          ++ Fields.required "recipients" recipients)
         ~decode:
           (fun
             ( ( ( ( ( ((((condition_id, revision), ticket_id), operation_id), artifact)
                     , required )
                   , label )
                 , creator )
               , creator_run )
             , recipients ) ->
           { condition_id
           ; revision
           ; ticket_id
           ; operation_id
           ; artifact
           ; required
           ; label
           ; creator
           ; creator_run
           ; recipients
           })
         ~encode:(fun t ->
           ( ( ( ( ( ( (((t.condition_id, t.revision), t.ticket_id), t.operation_id)
                     , t.artifact )
                   , t.required )
                 , t.label )
               , t.creator )
             , t.creator_run )
           , t.recipients )))
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
end

module Signal = struct
  type t =
    { signal_id : Signal_id.t
    ; condition_id : Condition_id.t
    ; condition_revision : int
    ; operation_id : Operation_id.t
    ; artifact : Evidence_event.Pin.t
    ; evidence : Evidence_event.Pin.t list
    ; summary : string
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; sequence : int
    }
  [@@deriving sexp, equal]

  let nonempty_evidence =
    W.checked W.evidence (fun xs ->
      if List.is_empty xs
      then Json.fail Invalid_argument "Condition signal requires evidence")
  ;;

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "signal_id" signal_id
          ++ Fields.required "condition_id" condition_id
          ++ Fields.required "condition_revision" W.positive
          ++ Fields.required "operation_id" operation_id
          ++ Fields.required "artifact" Evidence_wire.pin
          ++ Fields.required "evidence" nonempty_evidence
          ++ Fields.required "summary" (W.nonblank ~max_bytes:65_536)
          ++ Fields.required "actor_id" W.actor
          ++ Fields.required "run_id" (Api_codec.nullable W.run)
          ++ Fields.required "timestamp" (W.nonblank ~max_bytes:128)
          ++ Fields.required "sequence" W.positive)
         ~decode:
           (fun
             ( ( ( ( ( ( ( (((signal_id, condition_id), condition_revision), operation_id)
                         , artifact )
                       , evidence )
                     , summary )
                   , actor_id )
                 , run_id )
               , timestamp )
             , sequence ) ->
           { signal_id
           ; condition_id
           ; condition_revision
           ; operation_id
           ; artifact
           ; evidence
           ; summary
           ; actor_id
           ; run_id
           ; timestamp
           ; sequence
           })
         ~encode:(fun t ->
           ( ( ( ( ( ( ( ( ((t.signal_id, t.condition_id), t.condition_revision)
                         , t.operation_id )
                       , t.artifact )
                     , t.evidence )
                   , t.summary )
                 , t.actor_id )
               , t.run_id )
             , t.timestamp )
           , t.sequence )))
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
end

module Command = struct
  type t =
    | Put of
        { condition_id : Condition_id.t
        ; expected_revision : int
        ; ticket_id : Id.Ticket.t
        ; operation_id : Operation_id.t
        ; artifact : Evidence_event.Pin.t
        ; required : bool
        ; label : string
        ; recipients : Id.Actor.t list
        }
    | Signal of
        { signal_id : Signal_id.t
        ; condition_id : Condition_id.t
        ; expected_revision : int
        ; operation_id : Operation_id.t
        ; artifact : Evidence_event.Pin.t
        ; evidence : Evidence_event.Pin.t list
        ; summary : string
        }
  [@@deriving sexp]

  let put_fields ~ticket ~actor ~pin =
    Fields.required "condition_id" condition_id
    ++ Fields.required "expected_revision" W.counter
    ++ Fields.required "ticket_id" ticket
    ++ Fields.required "operation_id" operation_id
    ++ Fields.required "artifact" pin
    ++ Fields.optional "required" Api_codec.boolean
    ++ Fields.required "label" (W.nonblank ~max_bytes:4096)
    ++ Fields.optional "recipients" (Api_codec.list actor ~max_items:100)
  ;;

  let signal_fields ~pin ~evidence =
    Fields.required "signal_id" signal_id
    ++ Fields.required "condition_id" condition_id
    ++ Fields.required "expected_revision" W.positive
    ++ Fields.required "operation_id" operation_id
    ++ Fields.required "artifact" pin
    ++ Fields.required "evidence" evidence
    ++ Fields.required "summary" (W.nonblank ~max_bytes:65_536)
  ;;

  let put_codec =
    Api_codec.object_
      (Fields.map
         (put_fields ~ticket:W.ticket ~actor:W.actor ~pin:Evidence_wire.pin)
         ~decode:
           (fun
             ( ( ( ( (((condition_id, expected_revision), ticket_id), operation_id)
                   , artifact )
                 , required )
               , label )
             , recipients ) ->
           Put
             { condition_id
             ; expected_revision
             ; ticket_id
             ; operation_id
             ; artifact
             ; required = Option.value required ~default:true
             ; label
             ; recipients =
                 List.dedup_and_sort
                   (Option.value recipients ~default:[])
                   ~compare:Id.Actor.compare
             })
         ~encode:(function
           | Put p ->
             ( ( ( ( (((p.condition_id, p.expected_revision), p.ticket_id), p.operation_id)
                   , p.artifact )
                 , Some p.required )
               , p.label )
             , Some p.recipients )
           | Signal _ -> Json.fail Invalid_argument "Wrong condition command"))
  ;;

  let signal_codec =
    Api_codec.object_
      (Fields.map
         (signal_fields ~pin:Evidence_wire.pin ~evidence:Signal.nonempty_evidence)
         ~decode:
           (fun
             ( ( ((((signal_id, condition_id), expected_revision), operation_id), artifact)
               , evidence )
             , summary ) ->
           Signal
             { signal_id
             ; condition_id
             ; expected_revision
             ; operation_id
             ; artifact
             ; evidence
             ; summary
             })
         ~encode:(function
           | Signal p ->
             ( ( ( (((p.signal_id, p.condition_id), p.expected_revision), p.operation_id)
                 , p.artifact )
               , p.evidence )
             , p.summary )
           | Put _ -> Json.fail Invalid_argument "Wrong condition command"))
  ;;

  let codec ~method_ =
    match method_ with
    | "condition.put" -> Some put_codec
    | "condition.signal" -> Some signal_codec
    | _ -> None
  ;;

  let raw_request_codec ~method_ =
    let obj fields = Api_codec.as_json (Api_codec.object_ fields) in
    match method_ with
    | "condition.put" ->
      Some
        (obj
           (put_fields
              ~ticket:(Api_codec.reference W.ticket)
              ~actor:W.actor
              ~pin:Evidence_request.pin))
    | "condition.signal" ->
      let evidence =
        W.checked (Api_codec.list Evidence_request.pin ~max_items:100) (fun xs ->
          if List.is_empty xs
          then Json.fail Invalid_argument "Condition signal requires evidence")
      in
      Some (obj (signal_fields ~pin:Evidence_request.pin ~evidence))
    | _ -> None
  ;;
end

module Change = struct
  type t =
    | Put of Declaration.t
    | Signal of Signal.t
  [@@deriving sexp, equal, jsonaf]

  let t_of_jsonaf json =
    match Json.list json with
    | [ `String "Put"; d ] -> Put (Declaration.t_of_jsonaf d)
    | [ `String "Signal"; s ] -> Signal (Signal.t_of_jsonaf s)
    | [] | _ :: _ -> Json.fail Invalid_argument "Invalid condition change"
  ;;
end

module Blocker = struct
  type t =
    { condition_id : Condition_id.t
    ; revision : int
    ; operation_id : Operation_id.t
    ; artifact : Evidence_event.Pin.t
    ; label : string
    }
  [@@deriving sexp, equal]
end

type t =
  { declarations : Declaration.t Condition_id.Map.t
  ; history : Declaration.t list
  ; signals : Signal.t Signal_id.Map.t
  }

type prepared =
  { candidate : t
  ; changes : Change.t list
  ; result : Jsonaf.t
  }

let empty =
  { declarations = Condition_id.Map.empty; history = []; signals = Signal_id.Map.empty }
;;

let candidate t = t.candidate
let changes t = t.changes
let result t = t.result
let get t id = Map.find t.declarations id
let signal t id = Map.find t.signals id
let declarations t = Map.data t.declarations
let history t = List.rev t.history

let signals t ~condition =
  Map.data t.signals
  |> List.filter ~f:(fun s -> Condition_id.equal s.Signal.condition_id condition)
  |> List.sort ~compare:(fun a b ->
    match Int.compare a.Signal.sequence b.sequence with
    | 0 -> Signal_id.compare a.signal_id b.signal_id
    | c -> c)
;;

let require p kind message = if not p then Json.fail kind message

let find t id =
  match get t id with
  | Some d -> d
  | None -> Json.fail Not_found "External condition does not exist"
;;

let matches (d : Declaration.t) (s : Signal.t) =
  Condition_id.equal d.condition_id s.condition_id
  && Int.equal d.revision s.condition_revision
  && Operation_id.equal d.operation_id s.operation_id
  && Evidence_event.Pin.equal d.artifact s.artifact
;;

let satisfied t d =
  List.exists (signals t ~condition:d.Declaration.condition_id) ~f:(matches d)
;;

let blockers t ~ticket =
  declarations t
  |> List.filter_map ~f:(fun d ->
    if Id.Ticket.equal d.Declaration.ticket_id ticket && d.required && not (satisfied t d)
    then
      Some
        { Blocker.condition_id = d.condition_id
        ; revision = d.revision
        ; operation_id = d.operation_id
        ; artifact = d.artifact
        ; label = d.label
        }
    else None)
;;

let apply_exn t change ~actor ~run ~timestamp ~sequence =
  require (sequence > 0) Invalid_argument "Condition sequence must be positive";
  ignore (W.encode_exn (W.nonblank ~max_bytes:128) timestamp : Jsonaf.t);
  match change with
  | Change.Put d ->
    ignore (Declaration.jsonaf_of_t d : Jsonaf.t);
    (match get t d.condition_id with
     | None ->
       require
         (d.revision = 1
          && Id.Actor.equal d.creator actor
          && Option.equal Id.Run.equal d.creator_run run)
         Conflict
         "Condition creator or initial revision differs"
     | Some old ->
       require
         (old.revision < Int.max_value && d.revision = old.revision + 1)
         Conflict
         "Condition revision conflict";
       require
         (Id.Ticket.equal old.ticket_id d.ticket_id
          && Id.Actor.equal old.creator d.creator
          && Option.equal Id.Run.equal old.creator_run d.creator_run)
         Conflict
         "Condition ticket and creator are immutable");
    { t with
      declarations = Map.set t.declarations ~key:d.condition_id ~data:d
    ; history = d :: t.history
    }
  | Signal s ->
    ignore (Signal.jsonaf_of_t s : Jsonaf.t);
    require (not (Map.mem t.signals s.signal_id)) Conflict "Signal ID already exists";
    require
      (Id.Actor.equal s.actor_id actor
       && Option.equal Id.Run.equal s.run_id run
       && String.equal s.timestamp timestamp
       && Int.equal s.sequence sequence)
      Conflict
      "Signal attribution differs";
    require
      (matches (find t s.condition_id) s)
      Conflict
      "Signal declaration binding differs";
    { t with signals = Map.set t.signals ~key:s.signal_id ~data:s }
;;

let apply t change ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () -> apply_exn t change ~actor ~run ~timestamp ~sequence)
;;

let prepare t command ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let change, result =
      match command with
      | Command.Put p ->
        ignore (W.encode_exn Command.put_codec command : Jsonaf.t);
        let old = get t p.condition_id in
        require
          (Int.equal
             p.expected_revision
             (Option.value_map old ~default:0 ~f:(fun d -> d.Declaration.revision)))
          Conflict
          "Condition revision conflict";
        require
          (p.expected_revision < Int.max_value)
          Conflict
          "Condition revision exhausted";
        let creator, creator_run =
          match old with
          | None -> actor, run
          | Some d -> d.creator, d.creator_run
        in
        let d =
          { Declaration.condition_id = p.condition_id
          ; revision = p.expected_revision + 1
          ; ticket_id = p.ticket_id
          ; operation_id = p.operation_id
          ; artifact = p.artifact
          ; required = p.required
          ; label = p.label
          ; creator
          ; creator_run
          ; recipients = List.dedup_and_sort p.recipients ~compare:Id.Actor.compare
          }
        in
        Some (Change.Put d), Declaration.jsonaf_of_t d
      | Command.Signal p ->
        ignore (W.encode_exn Command.signal_codec command : Jsonaf.t);
        let requested =
          { Signal.signal_id = p.signal_id
          ; condition_id = p.condition_id
          ; condition_revision = p.expected_revision
          ; operation_id = p.operation_id
          ; artifact = p.artifact
          ; evidence = p.evidence
          ; summary = p.summary
          ; actor_id = actor
          ; run_id = run
          ; timestamp
          ; sequence
          }
        in
        (match signal t p.signal_id with
         | None -> Some (Change.Signal requested), Signal.jsonaf_of_t requested
         | Some original ->
           require
             (Signal.equal
                original
                { requested with
                  timestamp = original.timestamp
                ; sequence = original.sequence
                })
             Conflict
             "Signal ID reused with different content or attribution";
           None, Signal.jsonaf_of_t original)
    in
    let changes = Option.to_list change in
    let candidate =
      List.fold changes ~init:t ~f:(fun t c ->
        apply_exn t c ~actor ~run ~timestamp ~sequence)
    in
    { candidate; changes; result })
;;

let pins t =
  List.concat_map t.history ~f:(fun d -> [ d.Declaration.artifact ])
  @ List.concat_map (Map.data t.signals) ~f:(fun s -> s.Signal.artifact :: s.evidence)
;;

let validate_references t ~ticket_exists ~pin_exists =
  Json.decode (fun () ->
    List.iter t.history ~f:(fun d ->
      require (ticket_exists d.Declaration.ticket_id) Not_found "Condition ticket missing");
    List.iter (pins t) ~f:(fun p ->
      require (pin_exists p) Not_found "Condition evidence pin missing"))
;;

let notification_id change ~sequence =
  let condition_id, key =
    match change with
    | Change.Put d -> d.condition_id, "put:" ^ Int.to_string d.revision
    | Signal s -> s.condition_id, "signal:" ^ Signal_id.to_string s.signal_id
  in
  let identity =
    String.concat
      ~sep:":"
      [ Int.to_string sequence; Condition_id.to_string condition_id; key ]
  in
  match Communication_id.Message.of_string ("condition-" ^ Json.hash identity) with
  | Ok id -> id
  | Error e -> raise (Json.Decode_error e)
;;

type state = t

module Repeat = struct
  type t =
    { command : Command.t
    ; original : Signal.t
    }
  [@@deriving sexp]

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "command" Command.signal_codec
          ++ Fields.required "original" Signal.codec)
         ~decode:(fun (command, original) -> { command; original })
         ~encode:(fun t -> t.command, t.original))
  ;;

  let jsonaf_of_t = W.encode_exn codec
  let t_of_jsonaf = W.decode_exn codec

  let validate t ~state ~actor ~run ~timestamp ~sequence =
    Result.bind
      (prepare state t.command ~actor ~run ~timestamp ~sequence)
      ~f:(fun prepared ->
        Json.decode (fun () ->
          require
            (List.is_empty prepared.changes
             && Signal.equal t.original (Signal.t_of_jsonaf prepared.result))
            Conflict
            "Signal repeat differs from its original accepted record"))
  ;;
end
