open Core

module type S = sig
  type t [@@deriving sexp, compare, equal]

  include Comparable.S with type t := t

  val of_string : string -> (t, Problem.t) Result.t
  val to_string : t -> string
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Make () : S = struct
  let of_string value =
    if
      Int.(String.length value = 0 || String.length value > 96)
      || not
           (String.for_all value ~f:(fun c ->
              Char.is_alphanum c || Char.equal c '_' || Char.equal c '-'))
    then
      Error
        (Problem.create
           Invalid_argument
           "IDs require 1..96 ASCII letters, digits, underscores or hyphens")
    else Ok value
  ;;

  module T = struct
    type t = string [@@deriving sexp_of, compare, equal]

    let t_of_sexp sexp =
      let value = String.t_of_sexp sexp in
      match of_string value with
      | Ok value -> value
      | Error error -> Sexplib.Conv.of_sexp_error error.message sexp
    ;;
  end

  include T
  include Comparable.Make (T)

  let to_string t = t
  let jsonaf_of_t t = Json.string t

  let t_of_jsonaf json =
    match of_string (Json.text json) with
    | Ok t -> t
    | Error error -> raise (Json.Decode_error error)
  ;;
end

module Board = Make ()
module Thread = Make ()
module Request = Make ()
module Team = Make ()
module Subscription = Make ()
