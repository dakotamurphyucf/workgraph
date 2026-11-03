open Core

module T = struct
  type t = string [@@deriving sexp_of, compare, equal]

  let of_string s = Result.map (Id.Ticket.of_string s) ~f:Id.Ticket.to_string

  let t_of_sexp sexp =
    match of_string (String.t_of_sexp sexp) with
    | Ok s -> s
    | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
  ;;
end

include T
include Comparable.Make (T)

let to_string t = t
let jsonaf_of_t = Json.string

let t_of_jsonaf json =
  match of_string (Json.text json) with
  | Ok s -> s
  | Error e -> raise (Json.Decode_error e)
;;
