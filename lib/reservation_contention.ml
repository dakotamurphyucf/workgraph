open Core
module F = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = F.both
let wrong () = Json.fail Invalid_argument "wrong contention constructor"
let clock = Api_codec.decimal64 ~max:Int64.max_value
let note = Api_codec.text ~max_bytes:1024
let reason = W.nonblank ~max_bytes:512

let duration =
  W.checked (Api_codec.decimal ~max:300000) (fun n ->
    if n < 1 then Json.fail Invalid_argument "duration_ms must be 1..300000")
;;

let optional c = Api_codec.nullable c

module Target = struct
  type t =
    | Named of Reservation.Name.t
    | Path of Path_scope.t
  [@@deriving compare, equal, sexp]

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~select:(function
        | Named _ -> "named"
        | Path _ -> "path")
      ~cases:
        [ ( "named"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "named")
                  ++ F.required
                       "reservation_id"
                       (W.id Reservation.Name.of_string Reservation.Name.to_string))
                 ~decode:(fun ((), name) -> Named name)
                 ~encode:(function
                   | Named n -> (), n
                   | Path _ -> wrong ())) )
        ; ( "path"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "path")
                  ++ F.required "target" Path_scope.codec)
                 ~decode:(fun ((), p) -> Path p)
                 ~encode:(function
                   | Path p -> (), p
                   | Named _ -> wrong ())) )
        ]
  ;;

  let overlaps t other =
    match t, other with
    | Named a, Named b -> Reservation.Name.equal a b
    | Path a, Path b -> Path_scope.overlaps a b
    | Named _, Path _ | Path _, Named _ -> false
  ;;
end

module Waiter = struct
  type state =
    | Waiting
    | Closed of string
  [@@deriving equal, sexp]

  type t =
    { target : Target.t
    ; actor : Id.Actor.t
    ; run : Id.Run.t
    ; revision : int
    ; started_unix_ms : int64
    ; updated_unix_ms : int64
    ; expires_unix_ms : int64
    ; note : string
    ; state : state
    }
  [@@deriving equal, sexp]

  type input =
    { duration_ms : int
    ; note : string
    }
  [@@deriving sexp]

  type action =
    | Begin of input
    | Refresh of input
    | Close of string
  [@@deriving sexp]

  let state_codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~select:(function
        | Waiting -> "waiting"
        | Closed _ -> "closed")
      ~cases:
        [ ( "waiting"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "waiting"))
                 ~decode:(fun () -> Waiting)
                 ~encode:(function
                   | Waiting -> ()
                   | Closed _ -> wrong ())) )
        ; ( "closed"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "closed")
                  ++ F.required "reason" reason)
                 ~decode:(fun ((), r) -> Closed r)
                 ~encode:(function
                   | Closed r -> (), r
                   | Waiting -> wrong ())) )
        ]
  ;;

  let codec =
    Api_codec.object_
      (F.map
         (F.required "target" Target.codec
          ++ F.required "actor_id" W.actor
          ++ F.required "run_id" W.run
          ++ F.required "revision" W.positive
          ++ F.required "started_unix_ms" clock
          ++ F.required "updated_unix_ms" clock
          ++ F.required "expires_unix_ms" clock
          ++ F.required "note" note
          ++ F.required "state" state_codec)
         ~decode:
           (fun
             ( ( ( (((((target, actor), run), revision), started_unix_ms), updated_unix_ms)
                 , expires_unix_ms )
               , note )
             , state ) ->
           { target
           ; actor
           ; run
           ; revision
           ; started_unix_ms
           ; updated_unix_ms
           ; expires_unix_ms
           ; note
           ; state
           })
         ~encode:(fun (t : t) ->
           ( ( ( ( ((((t.target, t.actor), t.run), t.revision), t.started_unix_ms)
                 , t.updated_unix_ms )
               , t.expires_unix_ms )
             , t.note )
           , t.state )))
    |> fun c ->
    W.checked c (fun t ->
      if
        Int64.(
          t.started_unix_ms > t.updated_unix_ms || t.expires_unix_ms <= t.started_unix_ms)
      then Json.fail Invalid_argument "invalid waiter clocks";
      match t.state with
      | Waiting ->
        if
          Int64.(
            t.expires_unix_ms <= t.updated_unix_ms
            || t.expires_unix_ms - t.updated_unix_ms > 300000L)
        then Json.fail Invalid_argument "invalid waiter duration"
      | Closed _ -> ())
  ;;

  let action_codec =
    Api_codec.tagged
      ~discriminator:"action"
      ~select:(function
        | Begin _ -> "begin"
        | Refresh _ -> "refresh"
        | Close _ -> "close")
      ~cases:
        (List.map
           [ "begin", true; "refresh", false ]
           ~f:(fun (tag, begin_) ->
             ( tag
             , Api_codec.object_
                 (F.map
                    (F.required "action" (Api_codec.literal tag)
                     ++ F.required "duration_ms" duration
                     ++ F.required "note" note)
                    ~decode:(fun (((), duration_ms), note) ->
                      if begin_
                      then Begin { duration_ms; note }
                      else Refresh { duration_ms; note })
                    ~encode:(function
                      | Begin x when begin_ -> ((), x.duration_ms), x.note
                      | Refresh x when not begin_ -> ((), x.duration_ms), x.note
                      | Begin _ | Refresh _ | Close _ -> wrong ())) ))
         @ [ ( "close"
             , Api_codec.object_
                 (F.map
                    (F.required "action" (Api_codec.literal "close")
                     ++ F.required "reason" reason)
                    ~decode:(fun ((), r) -> Close r)
                    ~encode:(function
                      | Close r -> (), r
                      | Begin _ | Refresh _ -> wrong ())) )
           ])
  ;;
end

module Holder_note = struct
  type contents =
    { note : string
    ; expected_release_unix_ms : int64 option
    ; expires_unix_ms : int64
    }
  [@@deriving equal, sexp]

  type t =
    { target : Target.t
    ; actor : Id.Actor.t
    ; run : Id.Run.t
    ; token : int
    ; revision : int
    ; updated_unix_ms : int64
    ; contents : contents option
    }
  [@@deriving equal, sexp]

  type input =
    { duration_ms : int
    ; note : string
    ; expected_release_unix_ms : int64 option
    }
  [@@deriving sexp]

  type action =
    | Set of input
    | Clear
  [@@deriving sexp]

  let contents_codec =
    Api_codec.object_
      (F.map
         (F.required "note" note
          ++ F.required "expected_release_unix_ms" (optional clock)
          ++ F.required "expires_unix_ms" clock)
         ~decode:(fun ((note, expected_release_unix_ms), expires_unix_ms) ->
           { note; expected_release_unix_ms; expires_unix_ms })
         ~encode:(fun (t : contents) ->
           (t.note, t.expected_release_unix_ms), t.expires_unix_ms))
  ;;

  let codec =
    Api_codec.object_
      (F.map
         (F.required "target" Target.codec
          ++ F.required "actor_id" W.actor
          ++ F.required "run_id" W.run
          ++ F.required "token" W.positive
          ++ F.required "revision" W.positive
          ++ F.required "updated_unix_ms" clock
          ++ F.required "contents" (optional contents_codec))
         ~decode:
           (fun
             ((((((target, actor), run), token), revision), updated_unix_ms), contents) ->
           { target; actor; run; token; revision; updated_unix_ms; contents })
         ~encode:(fun (t : t) ->
           ( (((((t.target, t.actor), t.run), t.token), t.revision), t.updated_unix_ms)
           , t.contents )))
    |> fun c ->
    W.checked c (fun t ->
      Option.iter t.contents ~f:(fun x ->
        if
          Int64.(
            x.expires_unix_ms <= t.updated_unix_ms
            || x.expires_unix_ms - t.updated_unix_ms > 300000L)
        then Json.fail Invalid_argument "invalid holder note duration"))
  ;;

  let action_codec =
    Api_codec.tagged
      ~discriminator:"action"
      ~select:(function
        | Set _ -> "set"
        | Clear -> "clear")
      ~cases:
        [ ( "set"
          , Api_codec.object_
              (F.map
                 (F.required "action" (Api_codec.literal "set")
                  ++ F.required "duration_ms" duration
                  ++ F.required "note" note
                  ++ F.optional "expected_release_unix_ms" (optional clock))
                 ~decode:(fun ((((), duration_ms), note), expected_release_unix_ms) ->
                   Set
                     { duration_ms
                     ; note
                     ; expected_release_unix_ms = Option.join expected_release_unix_ms
                     })
                 ~encode:(function
                   | Set x ->
                     (((), x.duration_ms), x.note), Some x.expected_release_unix_ms
                   | Clear -> wrong ())) )
        ; ( "clear"
          , Api_codec.object_
              (F.map
                 (F.required "action" (Api_codec.literal "clear"))
                 ~decode:(fun () -> Clear)
                 ~encode:(function
                   | Clear -> ()
                   | Set _ -> wrong ())) )
        ]
  ;;
end

module Command = struct
  type t =
    | Waiter of
        { target : Target.t
        ; run : Id.Run.t
        ; expected_revision : int
        ; action : Waiter.action
        }
    | Holder_note of
        { target : Target.t
        ; run : Id.Run.t
        ; token : int
        ; expected_revision : int
        ; action : Holder_note.action
        }
  [@@deriving sexp]

  let run = function
    | Waiter x -> x.run
    | Holder_note x -> x.run
  ;;

  let target = function
    | Waiter x -> x.target
    | Holder_note x -> x.target
  ;;

  let holder_token = function
    | Waiter _ -> None
    | Holder_note x -> Some x.token
  ;;

  let waiter_fields run =
    Api_codec.merge_objects
      (Api_codec.object_
         (F.required "target" Target.codec
          ++ F.required "target_run_id" run
          ++ F.required "expected_revision" W.counter))
      Waiter.action_codec
  ;;

  let note_fields run =
    Api_codec.merge_objects
      (Api_codec.object_
         (F.required "target" Target.codec
          ++ F.required "target_run_id" run
          ++ F.required "token" W.positive
          ++ F.required "expected_revision" W.counter))
      Holder_note.action_codec
  ;;

  let codec ~method_ =
    match method_ with
    | "reservation.waiter.put" ->
      Some
        (Api_codec.map
           (waiter_fields W.run)
           ~decode:(fun (((target, run), expected_revision), action) ->
             Ok (Waiter { target; run; expected_revision; action }))
           ~encode:(function
             | Waiter x -> ((x.target, x.run), x.expected_revision), x.action
             | Holder_note _ -> wrong ())
           ~description:"Explicit advisory waiter lifecycle.")
    | "reservation.holder_note.put" ->
      Some
        (Api_codec.map
           (note_fields W.run)
           ~decode:(fun ((((target, run), token), expected_revision), action) ->
             Ok (Holder_note { target; run; token; expected_revision; action }))
           ~encode:(function
             | Holder_note x ->
               (((x.target, x.run), x.token), x.expected_revision), x.action
             | Waiter _ -> wrong ())
           ~description:"Advisory current-fence holder note.")
    | _ -> None
  ;;

  let raw_codec ~method_ =
    match method_ with
    | "reservation.waiter.put" ->
      Some (Api_codec.as_json (waiter_fields (Api_codec.reference W.run)))
    | "reservation.holder_note.put" ->
      Some (Api_codec.as_json (note_fields (Api_codec.reference W.run)))
    | _ -> None
  ;;
end

module Change = struct
  type t =
    | Waiter_begin of Waiter.t
    | Waiter_refresh of Waiter.t
    | Waiter_close of Waiter.t
    | Holder_note_put of Holder_note.t
  [@@deriving equal, sexp]

  let actor = function
    | Waiter_begin x | Waiter_refresh x | Waiter_close x -> x.actor
    | Holder_note_put x -> x.actor
  ;;

  let run = function
    | Waiter_begin x | Waiter_refresh x | Waiter_close x -> x.run
    | Holder_note_put x -> x.run
  ;;

  let target = function
    | Waiter_begin x | Waiter_refresh x | Waiter_close x -> x.target
    | Holder_note_put x -> x.target
  ;;

  let holder_token = function
    | Holder_note_put x -> Some x.token
    | Waiter_begin _ | Waiter_refresh _ | Waiter_close _ -> None
  ;;

  let select = function
    | Waiter_begin _ -> "waiter_begin"
    | Waiter_refresh _ -> "waiter_refresh"
    | Waiter_close _ -> "waiter_close"
    | Holder_note_put _ -> "holder_note_put"
  ;;

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~select
      ~cases:
        (List.map [ "waiter_begin"; "waiter_refresh"; "waiter_close" ] ~f:(fun tag ->
           ( tag
           , Api_codec.object_
               (F.map
                  (F.required "kind" (Api_codec.literal tag)
                   ++ F.required "record" Waiter.codec)
                  ~decode:(fun ((), x) ->
                    match tag with
                    | "waiter_begin" -> Waiter_begin x
                    | "waiter_refresh" -> Waiter_refresh x
                    | _ -> Waiter_close x)
                  ~encode:(fun t ->
                    if not (String.equal tag (select t)) then wrong ();
                    match t with
                    | Waiter_begin x | Waiter_refresh x | Waiter_close x -> (), x
                    | Holder_note_put _ -> wrong ())) ))
         @ [ ( "holder_note_put"
             , Api_codec.object_
                 (F.map
                    (F.required "kind" (Api_codec.literal "holder_note_put")
                     ++ F.required "record" Holder_note.codec)
                    ~decode:(fun ((), x) -> Holder_note_put x)
                    ~encode:(function
                      | Holder_note_put x -> (), x
                      | Waiter_begin _ | Waiter_refresh _ | Waiter_close _ -> wrong ())) )
           ])
    |> fun c ->
    W.checked c (function
      | Waiter_begin { state = Waiting; _ }
      | Waiter_refresh { state = Waiting; _ }
      | Waiter_close { state = Closed _; _ }
      | Holder_note_put _ -> ()
      | Waiter_begin _ | Waiter_refresh _ | Waiter_close _ ->
        Json.fail Invalid_argument "waiter action/state differ")
  ;;

  let jsonaf_of_t t = W.encode_exn codec t

  let t_of_jsonaf json =
    let t = W.decode_exn codec json in
    if not (String.equal (Json.canonical json) (Json.canonical (jsonaf_of_t t)))
    then Json.fail Invalid_argument "noncanonical durable contention change";
    t
  ;;
end

module Key = struct
  module T = struct
    type t = Target.t * Id.Run.t [@@deriving compare, sexp]
  end

  include T
  include Comparator.Make (T)
end

type t =
  { waiters : Waiter.t Map.M(Key).t
  ; notes : Holder_note.t Map.M(Key).t
  }

let empty = { waiters = Map.empty (module Key); notes = Map.empty (module Key) }
let waiters t = Map.data t.waiters
let holder_notes t = Map.data t.notes
let holder_note t ~target ~run = Map.find t.notes (target, run)
let fail message = Json.fail Conflict message

let expected current supplied =
  if current <> supplied
  then
    raise
      (Json.Decode_error
         (Problem.with_details
            (Problem.create Conflict "advisory record revision conflict")
            (Revision { expected = supplied; actual = current })))
;;

let next n = if n = Int.max_value then fail "advisory revision exhausted" else n + 1

let capacity t exists =
  if (not exists) && Map.length t.waiters + Map.length t.notes >= 1000
  then
    Json.fail
      Blocked
      "advisory contention capacity reached: 1000 retained natural keys including \
       inactive records"
;;

let advance_clock old now =
  if Int64.(now < 0L)
  then Json.fail Invalid_argument "negative contention clock"
  else if Option.exists old ~f:(fun old -> Int64.(now < old))
  then fail "contention clock regressed"
;;

let deadline now duration =
  let duration = Int64.of_int duration in
  if Int64.(duration < 1L || duration > 300000L)
  then Json.fail Invalid_argument "duration_ms must be 1..300000";
  if Int64.(now > max_value - duration) then fail "contention clock overflow";
  Int64.(now + duration)
;;

let apply t change =
  Json.decode (fun () ->
    ignore (Change.jsonaf_of_t change : Jsonaf.t);
    match change with
    | Waiter_begin after | Waiter_refresh after | Waiter_close after ->
      let key = after.Waiter.target, after.run in
      let old = Map.find t.waiters key in
      capacity t (Option.is_some old);
      expected
        after.revision
        (next (Option.value_map old ~default:0 ~f:(fun x -> x.revision)));
      advance_clock (Option.map old ~f:(fun x -> x.updated_unix_ms)) after.updated_unix_ms;
      Option.iter old ~f:(fun old ->
        if not (Id.Actor.equal old.actor after.actor) then fail "waiter actor changed");
      (match change with
       | Waiter_begin _ ->
         if not (Int64.equal after.started_unix_ms after.updated_unix_ms)
         then fail "waiter begin must reset start"
       | Waiter_refresh _ ->
         let old =
           match old with
           | Some old -> old
           | None -> Json.fail Not_found "waiter not found"
         in
         (match old.state with
          | Waiting -> ()
          | Closed _ -> fail "waiter is closed");
         if Int64.(after.updated_unix_ms >= old.expires_unix_ms)
         then fail "waiter expired; explicitly begin again";
         if not (Int64.equal old.started_unix_ms after.started_unix_ms)
         then fail "waiter refresh changed start"
       | Waiter_close _ ->
         let old =
           match old with
           | Some old -> old
           | None -> Json.fail Not_found "waiter not found"
         in
         (match old.state with
          | Waiting -> ()
          | Closed _ -> fail "waiter already closed");
         if
           not
             (Int64.equal old.started_unix_ms after.started_unix_ms
              && Int64.equal old.expires_unix_ms after.expires_unix_ms
              && String.equal old.note after.note)
         then fail "waiter close changed payload"
       | Holder_note_put _ -> wrong ());
      { t with waiters = Map.set t.waiters ~key ~data:after }
    | Holder_note_put after ->
      let key = after.Holder_note.target, after.run in
      let old = Map.find t.notes key in
      capacity t (Option.is_some old);
      expected
        after.revision
        (next (Option.value_map old ~default:0 ~f:(fun x -> x.revision)));
      advance_clock (Option.map old ~f:(fun x -> x.updated_unix_ms)) after.updated_unix_ms;
      Option.iter old ~f:(fun old ->
        if not (Id.Actor.equal old.actor after.actor)
        then fail "holder note actor changed");
      if Option.is_none old && Option.is_none after.contents
      then Json.fail Not_found "holder note not found";
      { t with notes = Map.set t.notes ~key ~data:after })
;;

let prepare t command ~actor ~now_unix_ms =
  Json.decode (fun () ->
    let method_ =
      match command with
      | Command.Waiter _ -> "reservation.waiter.put"
      | Holder_note _ -> "reservation.holder_note.put"
    in
    ignore (W.encode_exn (Option.value_exn (Command.codec ~method_)) command : Jsonaf.t);
    advance_clock None now_unix_ms;
    let change =
      match command with
      | Command.Waiter { target; run; expected_revision; action } ->
        let old = Map.find t.waiters (target, run) in
        expected
          (Option.value_map old ~default:0 ~f:(fun x -> x.revision))
          expected_revision;
        Option.iter old ~f:(fun old ->
          if not (Id.Actor.equal old.actor actor) then fail "waiter actor changed");
        let revision = next expected_revision in
        (match action with
         | Begin x ->
           Change.Waiter_begin
             { target
             ; actor
             ; run
             ; revision
             ; started_unix_ms = now_unix_ms
             ; updated_unix_ms = now_unix_ms
             ; expires_unix_ms = deadline now_unix_ms x.duration_ms
             ; note = x.note
             ; state = Waiting
             }
         | Refresh x ->
           let old =
             match old with
             | Some old -> old
             | None -> Json.fail Not_found "waiter not found"
           in
           (match old.state with
            | Waiting -> ()
            | Closed _ -> fail "waiter is closed");
           Waiter_refresh
             { old with
               revision
             ; updated_unix_ms = now_unix_ms
             ; expires_unix_ms = deadline now_unix_ms x.duration_ms
             ; note = x.note
             }
         | Close reason ->
           let old =
             match old with
             | Some old -> old
             | None -> Json.fail Not_found "waiter not found"
           in
           Waiter_close
             { old with revision; updated_unix_ms = now_unix_ms; state = Closed reason })
      | Holder_note { target; run; token; expected_revision; action } ->
        let old = Map.find t.notes (target, run) in
        expected
          (Option.value_map old ~default:0 ~f:(fun x -> x.revision))
          expected_revision;
        let contents =
          match action with
          | Holder_note.Clear -> None
          | Set x ->
            Some
              { Holder_note.note = x.note
              ; expected_release_unix_ms = x.expected_release_unix_ms
              ; expires_unix_ms = deadline now_unix_ms x.duration_ms
              }
        in
        Holder_note_put
          { target
          ; actor
          ; run
          ; token
          ; revision = next expected_revision
          ; updated_unix_ms = now_unix_ms
          ; contents
          }
    in
    ignore (apply t change |> Disk.unwrap : t);
    change)
;;

let to_json t =
  Json.obj
    [ "waiters", `Array (List.map (waiters t) ~f:(W.encode_exn Waiter.codec))
    ; ( "holder_notes"
      , `Array (List.map (holder_notes t) ~f:(W.encode_exn Holder_note.codec)) )
    ]
;;
