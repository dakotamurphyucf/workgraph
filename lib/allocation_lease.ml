open Core

module Policy = struct
  type t =
    | Indefinite
    | Duration_ms of int64
  [@@deriving sexp, equal]
end

module Status = struct
  type t =
    | Valid
    | Expired
    | Clock_regressed
  [@@deriving sexp, equal]
end

type t =
  { epoch : int
  ; revision : int
  ; policy : Policy.t
  ; last_unix_ms : int64
  ; deadline_unix_ms : int64 option
  }
[@@deriving sexp, equal]

let require condition kind message = if not condition then Json.fail kind message

let deadline now duration =
  require
    Int64.(duration > zero && duration <= 86_400_000L)
    Invalid_argument
    "Lease duration must be 1ms..24h";
  require
    Int64.(now >= zero && now <= max_value - duration)
    Invalid_argument
    "Lease clock overflows deadline";
  Int64.(now + duration)
;;

let create ~epoch ~now_unix_ms ?(policy = Policy.Indefinite) () =
  Json.decode (fun () ->
    require (epoch > 0) Invalid_argument "Lease epoch must be positive";
    require Int64.(now_unix_ms >= zero) Invalid_argument "Lease clock is negative";
    let deadline_unix_ms =
      match policy with
      | Indefinite -> None
      | Duration_ms duration -> Some (deadline now_unix_ms duration)
    in
    { epoch; revision = 1; policy; last_unix_ms = now_unix_ms; deadline_unix_ms })
;;

let epoch t = t.epoch
let revision t = t.revision
let policy t = t.policy

let status t ~now_unix_ms =
  match t.policy, t.deadline_unix_ms with
  | Policy.Indefinite, None -> Status.Valid
  | Duration_ms _, Some expires ->
    if Int64.(now_unix_ms < t.last_unix_ms)
    then Clock_regressed
    else if Int64.(now_unix_ms >= expires)
    then Expired
    else Valid
  | Indefinite, Some _ | Duration_ms _, None -> Status.Clock_regressed
;;

let validate_owner_exn t ~epoch ~now_unix_ms =
  require (Int.equal t.epoch epoch) Stale_claim "Lease epoch is stale";
  match status t ~now_unix_ms with
  | Valid -> ()
  | Expired -> Json.fail Stale_claim "Lease expired"
  | Clock_regressed ->
    Json.fail Stale_claim "Lease clock moved backwards; recovery is required"
;;

let validate_owner t ~epoch ~now_unix_ms =
  Json.decode (fun () -> validate_owner_exn t ~epoch ~now_unix_ms)
;;

let renew t ~expected_revision ~epoch ~now_unix_ms =
  Json.decode (fun () ->
    require (Int.equal t.revision expected_revision) Conflict "Lease revision conflict";
    require (t.revision < Int.max_value) Conflict "Lease revision exhausted";
    validate_owner_exn t ~epoch ~now_unix_ms;
    match t.policy with
    | Indefinite ->
      Json.fail Invalid_argument "Indefinite ownership does not need renewal"
    | Duration_ms duration ->
      { t with
        revision = t.revision + 1
      ; last_unix_ms = now_unix_ms
      ; deadline_unix_ms = Some (deadline now_unix_ms duration)
      })
;;

let heartbeat_due ~last_unix_ms ~now_unix_ms ~interval_ms =
  match last_unix_ms with
  | None -> true
  | Some last ->
    Int64.(interval_ms <= zero || now_unix_ms < last || now_unix_ms - last >= interval_ms)
;;

let to_json t =
  Json.obj
    [ "epoch", Json.int t.epoch
    ; "revision", Json.int t.revision
    ; ( "duration_ms"
      , match t.policy with
        | Indefinite -> `Null
        | Duration_ms n -> Json.int64 n )
    ; "last_unix_ms", Json.int64 t.last_unix_ms
    ; "deadline_unix_ms", Option.value_map t.deadline_unix_ms ~default:`Null ~f:Json.int64
    ]
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields
      json
      ~allowed:[ "epoch"; "revision"; "duration_ms"; "last_unix_ms"; "deadline_unix_ms" ];
    let get = Json.field json in
    let epoch = Json.integer (get "epoch") in
    let revision = Json.integer (get "revision") in
    let last_unix_ms = Json.integer64 (get "last_unix_ms") in
    let policy =
      match get "duration_ms" with
      | `Null -> Policy.Indefinite
      | j -> Duration_ms (Json.integer64 j)
    in
    let deadline_unix_ms =
      match get "deadline_unix_ms" with
      | `Null -> None
      | j -> Some (Json.integer64 j)
    in
    require (epoch > 0 && revision > 0) Invalid_argument "Lease counters must be positive";
    (match policy, deadline_unix_ms with
     | Indefinite, None -> ()
     | Duration_ms duration, Some expires ->
       require
         (Int64.equal expires (deadline last_unix_ms duration))
         Invalid_argument
         "Persisted lease deadline differs"
     | Indefinite, Some _ | Duration_ms _, None ->
       Json.fail Invalid_argument "Lease policy and deadline differ");
    { epoch; revision; policy; last_unix_ms; deadline_unix_ms })
;;

let last_unix_ms t = t.last_unix_ms
let jsonaf_of_t = to_json

let t_of_jsonaf json =
  match of_json json with
  | Ok t -> t
  | Error e -> raise (Json.Decode_error e)
;;

let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match of_json (to_json t) with
  | Ok t -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
;;
