open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

let jsonaf_of_int = Json.int
let int_of_jsonaf = Json.integer

module Pool = struct
  type t =
    { name : string
    ; limit : int
    ; active : int
    }
  [@@deriving sexp]
end

module Candidate = struct
  type t =
    { ticket : Id.Ticket.t
    ; priority : int
    ; creation_sequence : int
    ; ready : bool
    ; available : bool
    ; required_capabilities : string list
    ; pools : Pool.t list
    }
  [@@deriving sexp]
end

module Reason = struct
  type t =
    | Not_ready
    | Claimed
    | Missing_capability of string
    | Pool_full of string
  [@@deriving sexp, equal]
end

type t =
  | Selected of Candidate.t
  | Empty
[@@deriving sexp]

let eligibility c ~capabilities =
  (if c.Candidate.ready then [] else [ Reason.Not_ready ])
  @ (if c.available then [] else [ Reason.Claimed ])
  @ List.filter_map c.required_capabilities ~f:(fun required ->
    if List.mem capabilities required ~equal:String.equal
    then None
    else Some (Reason.Missing_capability required))
  @ List.filter_map c.pools ~f:(fun p ->
    if p.Pool.active >= p.limit then Some (Reason.Pool_full p.name) else None)
;;

let choose candidates ~capabilities =
  Json.decode (fun () ->
    if
      List.contains_dup
        (List.map candidates ~f:(fun c -> c.Candidate.ticket))
        ~compare:Id.Ticket.compare
    then Json.fail Invalid_argument "Duplicate allocation candidate";
    List.iter candidates ~f:(fun c ->
      if c.Candidate.priority < 0 || c.priority > 4 || c.creation_sequence < 0
      then Json.fail Invalid_argument "Invalid allocation ordering";
      List.iter c.pools ~f:(fun p ->
        if p.Pool.limit < 1 || p.active < 0 || String.is_empty p.name
        then Json.fail Invalid_argument "Invalid concurrency pool"));
    let rank p = if p = 0 then 5 else p in
    let compare a b =
      let first = Int.compare (rank a.Candidate.priority) (rank b.Candidate.priority) in
      if first <> 0
      then first
      else (
        let second = Int.compare a.creation_sequence b.creation_sequence in
        if second <> 0 then second else Id.Ticket.compare a.ticket b.ticket)
    in
    match
      List.find (List.sort candidates ~compare) ~f:(fun c ->
        List.is_empty (eligibility c ~capabilities))
    with
    | None -> Empty
    | Some c -> Selected c)
;;

module Definition = struct
  type t =
    { name : string
    ; revision : int
    ; limit : int
    }
  [@@deriving sexp, equal, jsonaf]
end

module Ticket_policy = struct
  type t =
    { ticket : Id.Ticket.t
    ; revision : int
    ; required_capabilities : string list
    ; pools : string list
    }
  [@@deriving sexp, equal, jsonaf]
end
