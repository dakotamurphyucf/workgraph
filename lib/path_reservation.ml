open Core

module Request = struct
  type t =
    { target : Path_scope.t
    ; mode : Reservation.Mode.t
    ; lease_duration_ms : int64 option
    }
  [@@deriving sexp]

  let duration =
    Api_codec.map
      (Api_codec.decimal64 ~max:86_400_000L)
      ~decode:(fun value ->
        if Int64.(value > 0L)
        then Ok value
        else Error (Problem.create Invalid_argument "lease duration must be 1ms..24h"))
      ~encode:Fn.id
      ~description:"Positive milliseconds, at most 24 hours."
  ;;

  let codec =
    Api_codec.object_
      (Api_codec.Fields.map
         (Api_codec.Fields.both
            (Api_codec.Fields.required "target" Path_scope.codec)
            (Api_codec.Fields.both
               (Api_codec.Fields.required
                  "mode"
                  (Api_codec.enum
                     [ "exclusive", Reservation.Mode.Exclusive; "shared", Shared ]
                     ~equal:Reservation.Mode.equal))
               (Api_codec.Fields.optional "lease_duration_ms" duration)))
         ~decode:(fun (target, (mode, lease_duration_ms)) ->
           { target; mode; lease_duration_ms })
         ~encode:(fun t -> t.target, (t.mode, t.lease_duration_ms)))
  ;;

  let unchecked_t_of_sexp = t_of_sexp

  let t_of_sexp sexp =
    let t = unchecked_t_of_sexp sexp in
    match Api_codec.encode codec t with
    | Ok _ -> t
    | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
  ;;
end

type t =
  { target : Path_scope.t
  ; epoch : int
  ; holders : Reservation.Holder.t list
  }
[@@deriving sexp, equal]

let ownership t = { Reservation.Ownership.epoch = t.epoch; holders = t.holders }

let with_ownership t (ownership : Reservation.Ownership.t) =
  { t with epoch = ownership.epoch; holders = ownership.holders }
;;

let validate t = Reservation.Ownership.validate (ownership t)

let acquire t ~run ~actor ~mode ~now_unix_ms ~lease_duration_ms =
  with_ownership
    t
    (Reservation.Ownership.acquire
       (ownership t)
       ~run
       ~actor
       ~mode
       ~now_unix_ms
       ~lease_duration_ms)
;;

let release t ~run ~token =
  with_ownership t (Reservation.Ownership.release (ownership t) ~run ~token)
;;

let renew t ~run ~token ~expected_lease_revision ~now_unix_ms =
  with_ownership
    t
    (Reservation.Ownership.renew
       (ownership t)
       ~run
       ~token
       ~expected_lease_revision
       ~now_unix_ms)
;;

let validate_owner t ~now_unix_ms ~run ~token =
  Reservation.Ownership.validate_owner (ownership t) ~now_unix_ms ~run ~token
;;

let conflicts t ~target ~mode ~excluding_run =
  if not (Path_scope.overlaps t.target target)
  then []
  else
    List.filter t.holders ~f:(fun h ->
      (not
         (Option.value_map
            excluding_run
            ~default:false
            ~f:(Id.Run.equal h.Reservation.Holder.run)))
      && (Reservation.Mode.equal mode Exclusive || Reservation.Mode.equal h.mode Exclusive))
;;

let jsonaf_of_t t =
  validate t;
  Json.obj
    [ "target", Path_scope.jsonaf_of_t t.target
    ; "epoch", Json.int t.epoch
    ; "holders", `Array (List.map t.holders ~f:Reservation.Holder.jsonaf_of_t)
    ]
;;

let t_of_jsonaf json =
  Json.fields json ~allowed:[ "target"; "epoch"; "holders" ];
  let target = Path_scope.t_of_jsonaf (Json.field json "target") in
  let t =
    { target
    ; epoch = Json.integer (Json.field json "epoch")
    ; holders =
        List.map (Json.list (Json.field json "holders")) ~f:Reservation.Holder.t_of_jsonaf
    }
  in
  validate t;
  t
;;

let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match
    Json.decode (fun () ->
      validate t;
      t)
  with
  | Ok t -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
;;
