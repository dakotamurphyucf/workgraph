open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

let jsonaf_of_int = Json.int
let int_of_jsonaf = Json.integer
let jsonaf_of_int64 = Json.int64
let int64_of_jsonaf = Json.integer64

module Name = struct
  module T = struct
    type t = string [@@deriving sexp_of, compare, equal]

    let of_string s = Result.map (Id.Run.of_string s) ~f:Id.Run.to_string

    let t_of_sexp sexp =
      match of_string (String.t_of_sexp sexp) with
      | Ok s -> s
      | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
    ;;
  end

  include T
  include Comparable.Make (T)

  let to_string t = t
  let jsonaf_of_t = Json.string

  let t_of_jsonaf j =
    match of_string (Json.text j) with
    | Ok t -> t
    | Error e -> raise (Json.Decode_error e)
  ;;
end

module Mode = struct
  type t =
    | Exclusive
    | Shared
  [@@deriving sexp, equal, jsonaf]
end

module Claim = struct
  type t =
    { ticket : Id.Ticket.t
    ; token : int
    ; run : Id.Run.t
    ; actor : Id.Actor.t
    }
  [@@deriving sexp, compare, equal, jsonaf]

  let validate t =
    if t.token < 1 then Json.fail Invalid_argument "Claim borrower token must be positive"
  ;;

  let t_of_jsonaf json =
    Json.fields json ~allowed:[ "ticket"; "token"; "run"; "actor" ];
    let t =
      { ticket = Id.Ticket.t_of_jsonaf (Json.field json "ticket")
      ; token = Json.integer (Json.field json "token")
      ; run = Id.Run.t_of_jsonaf (Json.field json "run")
      ; actor = Id.Actor.t_of_jsonaf (Json.field json "actor")
      }
    in
    validate t;
    t
  ;;

  let codec =
    let module F = Api_codec.Fields in
    let ( ++ ) = F.both in
    let id of_string to_string =
      Api_codec.map
        (Api_codec.text ~max_bytes:96)
        ~decode:of_string
        ~encode:to_string
        ~description:"Exact claim identity."
    in
    let codec =
      Api_codec.object_
        (F.map
           (F.required "ticket_id" (id Id.Ticket.of_string Id.Ticket.to_string)
            ++ F.required "token" (Api_codec.decimal ~max:Int.max_value)
            ++ F.required "run_id" (id Id.Run.of_string Id.Run.to_string)
            ++ F.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string))
           ~decode:(fun (((ticket, token), run), actor) -> { ticket; token; run; actor })
           ~encode:(fun t -> ((t.ticket, t.token), t.run), t.actor))
    in
    Api_codec.map
      codec
      ~decode:(fun t ->
        Json.decode (fun () ->
          validate t;
          t))
      ~encode:(fun t ->
        validate t;
        t)
      ~description:"Positive exact claim borrower fence."
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
    | Error error -> Sexplib.Conv.of_sexp_error error.Problem.message sexp
  ;;
end

module Origin = struct
  type t =
    | Manual
    | Automatic of Claim.t list
  [@@deriving sexp, equal, jsonaf]

  let validate = function
    | Manual -> ()
    | Automatic claims ->
      if List.is_empty claims || List.length claims > 100
      then Json.fail Invalid_argument "Automatic holder needs 1..100 claim borrowers";
      List.iter claims ~f:Claim.validate;
      if not (List.is_sorted_strictly claims ~compare:Claim.compare)
      then Json.fail Invalid_argument "Automatic borrowers must be sorted and unique"
  ;;

  let t_of_jsonaf json =
    let t =
      match Json.list json with
      | [ `String "Manual" ] -> Manual
      | [ `String "Automatic"; `Array claims ] ->
        Automatic (List.map claims ~f:Claim.t_of_jsonaf)
      | [] | _ :: _ -> Json.fail Invalid_argument "Invalid reservation origin"
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
    | Error error -> Sexplib.Conv.of_sexp_error error.Problem.message sexp
  ;;
end

module Holder = struct
  type t =
    { run : Id.Run.t
    ; actor : Id.Actor.t
    ; token : int
    ; mode : Mode.t
    ; lease : Allocation_lease.t
    ; origin : Origin.t
    }
  [@@deriving sexp, equal, jsonaf]

  let validate t =
    Origin.validate t.origin;
    if t.token < 1 || Allocation_lease.epoch t.lease <> t.token
    then Json.fail Invalid_argument "Invalid reservation holder fence";
    match t.origin with
    | Manual -> ()
    | Automatic claims ->
      (match Allocation_lease.policy t.lease with
       | Indefinite -> ()
       | Duration_ms _ ->
         Json.fail Invalid_argument "Automatic path ownership must be indefinite");
      List.iter claims ~f:(fun claim ->
        if not (Id.Run.equal claim.Claim.run t.run && Id.Actor.equal claim.actor t.actor)
        then Json.fail Conflict "Claim borrower differs from reservation owner")
  ;;

  let t_of_jsonaf json =
    Json.fields json ~allowed:[ "run"; "actor"; "token"; "mode"; "lease"; "origin" ];
    let mode =
      match Json.list (Json.field json "mode") with
      | [ `String "Exclusive" ] -> Mode.Exclusive
      | [ `String "Shared" ] -> Mode.Shared
      | [] | _ :: _ -> Json.fail Invalid_argument "Invalid reservation mode"
    in
    let t =
      { run = Id.Run.t_of_jsonaf (Json.field json "run")
      ; actor = Id.Actor.t_of_jsonaf (Json.field json "actor")
      ; token = Json.integer (Json.field json "token")
      ; mode
      ; lease = Allocation_lease.t_of_jsonaf (Json.field json "lease")
      ; origin = Origin.t_of_jsonaf (Json.field json "origin")
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
    | Error error -> Sexplib.Conv.of_sexp_error error.Problem.message sexp
  ;;
end

module Ownership = struct
  type t =
    { epoch : int
    ; holders : Holder.t list
    }
  [@@deriving sexp, equal]

  let validate t =
    if t.epoch < 0 then Json.fail Invalid_argument "Reservation epoch cannot be negative";
    if List.length t.holders > 100
    then Json.fail Invalid_argument "Reservation holder limit is 100";
    if
      List.contains_dup
        (List.map t.holders ~f:(fun h -> h.Holder.run))
        ~compare:Id.Run.compare
    then Json.fail Conflict "Duplicate reservation owner";
    List.iter t.holders ~f:(fun h ->
      Holder.validate h;
      if
        h.Holder.token < 1
        || h.token > t.epoch
        || Allocation_lease.epoch h.lease <> h.token
      then Json.fail Invalid_argument "Invalid reservation fence");
    if
      List.length t.holders > 1
      && List.exists t.holders ~f:(fun h -> Mode.equal h.Holder.mode Exclusive)
    then Json.fail Conflict "Exclusive reservation cannot share holders"
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

  let acquire t ~run ~actor ~mode ~now_unix_ms ~lease_duration_ms =
    validate t;
    if t.epoch = Int.max_value
    then Json.fail Conflict "Reservation fencing epoch exhausted";
    if List.exists t.holders ~f:(fun h -> Id.Run.equal h.Holder.run run)
    then Json.fail Already_claimed "Run already reserves this resource";
    if
      (not (List.is_empty t.holders))
      && (Mode.equal mode Exclusive
          || List.exists t.holders ~f:(fun h -> Mode.equal h.Holder.mode Exclusive))
    then Json.fail Already_claimed "Reservation is unavailable";
    let epoch = t.epoch + 1 in
    let next =
      { epoch
      ; holders =
          t.holders
          @ [ { Holder.run
              ; actor
              ; token = epoch
              ; mode
              ; origin = Origin.Manual
              ; lease =
                  (match
                     Allocation_lease.create
                       ~epoch
                       ~now_unix_ms
                       ?policy:
                         (Option.map lease_duration_ms ~f:(fun n ->
                            Allocation_lease.Policy.Duration_ms n))
                       ()
                   with
                   | Ok lease -> lease
                   | Error e -> raise (Json.Decode_error e))
              }
            ]
      }
    in
    validate next;
    next
  ;;

  let validate_token t ~run ~token =
    if
      not
        (List.exists t.holders ~f:(fun h ->
           Id.Run.equal h.Holder.run run && Int.equal h.token token))
    then Json.fail Stale_claim "Reservation fencing token is stale"
  ;;

  let release t ~run ~token =
    validate t;
    validate_token t ~run ~token;
    { t with
      holders = List.filter t.holders ~f:(fun h -> not (Id.Run.equal h.Holder.run run))
    }
  ;;

  let validate_owner t ~now_unix_ms ~run ~token =
    validate t;
    validate_token t ~run ~token;
    let holder = List.find_exn t.holders ~f:(fun h -> Id.Run.equal h.Holder.run run) in
    let now =
      match now_unix_ms, Allocation_lease.policy holder.lease with
      | Some n, _ -> n
      | None, Allocation_lease.Policy.Indefinite -> 0L
      | None, Duration_ms _ ->
        Json.fail Invalid_argument "Lease ownership requires the current server clock"
    in
    match Allocation_lease.validate_owner holder.lease ~epoch:token ~now_unix_ms:now with
    | Ok () -> ()
    | Error e -> raise (Json.Decode_error e)
  ;;

  let renew t ~run ~token ~expected_lease_revision ~now_unix_ms =
    validate t;
    validate_token t ~run ~token;
    { t with
      holders =
        List.map t.holders ~f:(fun h ->
          if Id.Run.equal h.Holder.run run
          then (
            let lease =
              match
                Allocation_lease.renew
                  h.lease
                  ~expected_revision:expected_lease_revision
                  ~epoch:token
                  ~now_unix_ms
              with
              | Ok lease -> lease
              | Error e -> raise (Json.Decode_error e)
            in
            { h with lease })
          else h)
    }
  ;;
end

type t =
  { name : Name.t
  ; epoch : int
  ; holders : Holder.t list
  }
[@@deriving sexp, equal, jsonaf]

type request =
  { name : Name.t
  ; mode : Mode.t
  ; lease_duration_ms : int64 option
  }
[@@deriving sexp]

let ownership (t : t) = { Ownership.epoch = t.epoch; holders = t.holders }

let with_ownership (t : t) (owned : Ownership.t) =
  { t with epoch = owned.epoch; holders = owned.holders }
;;

let validate t =
  Ownership.validate (ownership t);
  List.iter t.holders ~f:(fun h ->
    match h.Holder.origin with
    | Manual -> ()
    | Automatic _ -> Json.fail Invalid_argument "Named holds must be manual")
;;

let acquire t ~run ~actor ~mode ~now_unix_ms ~lease_duration_ms =
  with_ownership
    t
    (Ownership.acquire (ownership t) ~run ~actor ~mode ~now_unix_ms ~lease_duration_ms)
;;

let release t ~run ~token = with_ownership t (Ownership.release (ownership t) ~run ~token)

let validate_owner t ~now_unix_ms ~run ~token =
  Ownership.validate_owner (ownership t) ~now_unix_ms ~run ~token
;;

let renew t ~run ~token ~expected_lease_revision ~now_unix_ms =
  with_ownership
    t
    (Ownership.renew (ownership t) ~run ~token ~expected_lease_revision ~now_unix_ms)
;;

let t_of_jsonaf json =
  Json.fields json ~allowed:[ "name"; "epoch"; "holders" ];
  let t =
    { name = Name.t_of_jsonaf (Json.field json "name")
    ; epoch = Json.integer (Json.field json "epoch")
    ; holders = List.map (Json.list (Json.field json "holders")) ~f:Holder.t_of_jsonaf
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
