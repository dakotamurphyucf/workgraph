open Core
module Recovery_id = Coordination_id.Recovery
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

module W = Coordination_wire

module Confirmation = struct
  type t =
    | Stopped
    | Isolated
  [@@deriving sexp, equal]

  let codec = Api_codec.enum [ "stopped", Stopped; "isolated", Isolated ] ~equal
end

module Target = struct
  type t =
    | Named of Reservation.Name.t
    | Path of Path_scope.t
  [@@deriving sexp, equal]

  let named_fields name =
    Fields.required "kind" (Api_codec.literal "named")
    ++ Fields.required "reservation_id" name
  ;;

  let path_fields =
    Fields.required "kind" (Api_codec.literal "path")
    ++ Fields.required "target" Path_scope.codec
  ;;

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "named"
          , Api_codec.object_
              (Fields.map
                 (named_fields
                    (W.id Reservation.Name.of_string Reservation.Name.to_string))
                 ~decode:(fun ((), id) -> Named id)
                 ~encode:(function
                   | Named id -> (), id
                   | Path _ -> Json.fail Invalid_argument "Wrong recovery target")) )
        ; ( "path"
          , Api_codec.object_
              (Fields.map
                 path_fields
                 ~decode:(fun ((), target) -> Path target)
                 ~encode:(function
                   | Path target -> (), target
                   | Named _ -> Json.fail Invalid_argument "Wrong recovery target")) )
        ]
      ~select:(function
        | Named _ -> "named"
        | Path _ -> "path")
  ;;

  let raw_codec =
    let obj fields = Api_codec.as_json (Api_codec.object_ fields) in
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "named"
          , obj
              (named_fields (W.id Reservation.Name.of_string Reservation.Name.to_string))
          )
        ; "path", obj path_fields
        ]
      ~select:(fun json -> Json.field json "kind" |> Json.text)
  ;;
end

module Request = struct
  type t =
    { recovery_id : Recovery_id.t
    ; target : Target.t
    ; expected_epoch : int
    ; old_run_id : Id.Run.t
    ; old_actor_id : Id.Actor.t
    ; token : int
    ; expected_lease_revision : int
    ; confirmation : Confirmation.t
    ; reason : string
    ; evidence : Evidence_event.Pin.t list
    }
  [@@deriving sexp, equal]

  let fields ~target ~run ~actor ~evidence =
    Fields.required "recovery_id" (W.id Recovery_id.of_string Recovery_id.to_string)
    ++ Fields.required "target" target
    ++ Fields.required "expected_epoch" W.positive
    ++ Fields.required "old_run_id" run
    ++ Fields.required "old_actor_id" actor
    ++ Fields.required "token" W.positive
    ++ Fields.required "expected_lease_revision" W.positive
    ++ Fields.required "confirmation" Confirmation.codec
    ++ Fields.required "reason" (W.nonblank ~max_bytes:65_536)
    ++ Fields.optional "evidence" evidence
  ;;

  let codec =
    Api_codec.object_
      (Fields.map
         (fields ~target:Target.codec ~run:W.run ~actor:W.actor ~evidence:W.evidence)
         ~decode:
           (fun
             ( ( ( ( ( ( (((recovery_id, target), expected_epoch), old_run_id)
                       , old_actor_id )
                     , token )
                   , expected_lease_revision )
                 , confirmation )
               , reason )
             , evidence ) ->
           { recovery_id
           ; target
           ; expected_epoch
           ; old_run_id
           ; old_actor_id
           ; token
           ; expected_lease_revision
           ; confirmation
           ; reason
           ; evidence = Option.value evidence ~default:[]
           })
         ~encode:(fun t ->
           ( ( ( ( ( ( (((t.recovery_id, t.target), t.expected_epoch), t.old_run_id)
                     , t.old_actor_id )
                   , t.token )
                 , t.expected_lease_revision )
               , t.confirmation )
             , t.reason )
           , Some t.evidence )))
  ;;

  let codec =
    W.checked codec (fun t ->
      if t.token > t.expected_epoch
      then Json.fail Invalid_argument "Recovery token exceeds reservation epoch")
  ;;

  let raw_codec =
    W.checked
      (Api_codec.as_json
         (Api_codec.object_
            (fields
               ~target:Target.raw_codec
               ~run:(Api_codec.reference W.run)
               ~actor:W.actor
               ~evidence:(Api_codec.list Evidence_request.pin ~max_items:100))))
      (fun request ->
         if
           Json.integer (Json.field request "token")
           > Json.integer (Json.field request "expected_epoch")
         then Json.fail Invalid_argument "Recovery token exceeds reservation epoch")
  ;;

  let validate t = ignore (W.encode_exn codec t : Jsonaf.t)
  let unchecked_t_of_sexp = t_of_sexp

  let t_of_sexp sexp =
    let t = unchecked_t_of_sexp sexp in
    match Api_codec.encode codec t with
    | Ok _ -> t
    | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
  ;;

  let validate_holder t ~epoch ~holders =
    validate t;
    if epoch <> t.expected_epoch
    then Json.fail Stale_claim "Recovery reservation epoch changed";
    match
      List.find holders ~f:(fun h -> Id.Run.equal h.Reservation.Holder.run t.old_run_id)
    with
    | None -> Json.fail Stale_claim "Recovery owner is absent"
    | Some h ->
      if
        not
          (Id.Actor.equal h.actor t.old_actor_id
           && Int.equal h.token t.token
           && Int.equal (Allocation_lease.revision h.lease) t.expected_lease_revision)
      then Json.fail Stale_claim "Recovery owner, fence or lease revision changed"
  ;;
end

type t =
  { request : Request.t
  ; actor_id : Id.Actor.t
  ; run_id : Id.Run.t option
  ; timestamp : string
  ; sequence : int
  }
[@@deriving sexp, equal]

let codec =
  Api_codec.object_
    (Fields.map
       (Fields.required "request" Request.codec
        ++ Fields.required "actor_id" W.actor
        ++ Fields.required "run_id" (Api_codec.nullable W.run)
        ++ Fields.required "timestamp" (W.nonblank ~max_bytes:128)
        ++ Fields.required "sequence" W.positive)
       ~decode:(fun ((((request, actor_id), run_id), timestamp), sequence) ->
         { request; actor_id; run_id; timestamp; sequence })
       ~encode:(fun t -> (((t.request, t.actor_id), t.run_id), t.timestamp), t.sequence))
;;

let jsonaf_of_t = W.encode_exn codec

let t_of_jsonaf json =
  let t = W.decode_exn codec json in
  (match t.request.target with
   | Target.Named _ -> ()
   | Path _ ->
     ignore
       (Path_scope.t_of_jsonaf
          (Json.field (Json.field (Json.field json "request") "target") "target")
        : Path_scope.t));
  t
;;

let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match Api_codec.encode codec t with
  | Ok _ -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
;;
