open Core

type t =
  | Unrestricted
  | Allowed of Id.Actor.t list
[@@deriving sexp, equal]

let unrestricted = Unrestricted

let allowed actors =
  Json.decode (fun () ->
    if List.is_empty actors || List.length actors > 100
    then Json.fail Invalid_argument "actor allowlist requires 1..100 actors";
    if List.contains_dup actors ~compare:Id.Actor.compare
    then Json.fail Invalid_argument "actor allowlist contains duplicate identities";
    Allowed (List.sort actors ~compare:Id.Actor.compare))
;;

let t_of_sexp_unchecked = t_of_sexp

let t_of_sexp sexp =
  match t_of_sexp_unchecked sexp with
  | Unrestricted -> Unrestricted
  | Allowed actors ->
    (match allowed actors with
     | Ok value -> value
     | Error problem -> Sexplib.Conv.of_sexp_error problem.Problem.message sexp)
;;

let allowed_actors = function
  | Unrestricted -> None
  | Allowed actors -> Some actors
;;

let permits t ~actor =
  match t with
  | Unrestricted -> true
  | Allowed actors -> List.mem actors actor ~equal:Id.Actor.equal
;;

let assess t ~actor =
  if permits t ~actor
  then None
  else
    Some
      (Allocation_admission_reason.Actor_not_allowed
         { actor_id = Id.Actor.to_string actor })
;;

let codec =
  Api_codec.map
    (Api_codec.nullable
       (Api_codec.list
          (Coordination_wire.id Id.Actor.of_string Id.Actor.to_string)
          ~max_items:100))
    ~decode:(function
      | None -> Ok Unrestricted
      | Some actors -> allowed actors)
    ~encode:allowed_actors
    ~description:
      "Null is unrestricted; a nonempty distinct actor allowlist is canonicalized by ID."
;;

let jsonaf_of_t t =
  match Api_codec.encode codec t with
  | Ok json -> json
  | Error problem -> raise (Json.Decode_error problem)
;;

let t_of_jsonaf json =
  match Api_codec.decode codec json with
  | Ok t -> t
  | Error problem -> raise (Json.Decode_error problem)
;;
