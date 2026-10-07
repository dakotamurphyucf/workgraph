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

module Holder = struct
  type t =
    { run : Id.Run.t
    ; actor : Id.Actor.t
    ; token : int
    ; mode : Mode.t
    ; lease : Allocation_lease.t
    }
  [@@deriving sexp, equal, jsonaf]
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
    if
      h.Holder.token < 1 || h.token > t.epoch || Allocation_lease.epoch h.lease <> h.token
    then Json.fail Invalid_argument "Invalid reservation fence");
  if
    List.length t.holders > 1
    && List.exists t.holders ~f:(fun h -> Mode.equal h.Holder.mode Exclusive)
  then Json.fail Conflict "Exclusive reservation cannot share holders"
;;

let acquire t ~run ~actor ~mode ~now_unix_ms ~lease_duration_ms =
  validate t;
  if t.epoch = Int.max_value then Json.fail Conflict "Reservation fencing epoch exhausted";
  if List.exists t.holders ~f:(fun h -> Id.Run.equal h.Holder.run run)
  then Json.fail Already_claimed "Run already reserves this resource";
  if
    (not (List.is_empty t.holders))
    && (Mode.equal mode Exclusive
        || List.exists t.holders ~f:(fun h -> Mode.equal h.Holder.mode Exclusive))
  then Json.fail Already_claimed "Reservation is unavailable";
  let epoch = t.epoch + 1 in
  let next =
    { t with
      epoch
    ; holders =
        t.holders
        @ [ { Holder.run
            ; actor
            ; token = epoch
            ; mode
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
  validate_token t ~run ~token;
  { t with
    holders = List.filter t.holders ~f:(fun h -> not (Id.Run.equal h.Holder.run run))
  }
;;

let mode_of_jsonaf json =
  match Json.list json with
  | [ `String "Exclusive" ] -> Mode.Exclusive
  | [ `String "Shared" ] -> Shared
  | [] | _ :: _ -> Json.fail Invalid_argument "Invalid reservation mode"
;;

let t_of_jsonaf json =
  Json.fields json ~allowed:[ "name"; "epoch"; "holders" ];
  let t =
    { name = Name.t_of_jsonaf (Json.field json "name")
    ; epoch = Json.integer (Json.field json "epoch")
    ; holders =
        List.map
          (Json.list (Json.field json "holders"))
          ~f:(fun holder ->
            Json.fields holder ~allowed:[ "run"; "actor"; "token"; "mode"; "lease" ];
            { Holder.run = Id.Run.t_of_jsonaf (Json.field holder "run")
            ; actor = Id.Actor.t_of_jsonaf (Json.field holder "actor")
            ; token = Json.integer (Json.field holder "token")
            ; mode = mode_of_jsonaf (Json.field holder "mode")
            ; lease = Allocation_lease.t_of_jsonaf (Json.field holder "lease")
            })
    }
  in
  validate t;
  t
;;

let validate_owner t ~now_unix_ms ~run ~token =
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
