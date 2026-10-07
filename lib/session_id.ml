open Core

let of_string value =
  if
    String.is_empty value
    || String.length value > 96
    || not
         (String.for_all value ~f:(fun c ->
            Char.is_alphanum c || Char.equal c '_' || Char.equal c '-'))
  then
    Error
      (Problem.create
         Invalid_argument
         "session IDs require 1..96 ASCII letters, digits, underscores or hyphens")
  else Ok value
;;

module T = struct
  type t = string [@@deriving sexp_of, compare, equal]

  let t_of_sexp sexp =
    match of_string (String.t_of_sexp sexp) with
    | Ok t -> t
    | Error error -> Sexplib.Conv.of_sexp_error error.message sexp
  ;;
end

include T
include Comparable.Make (T)

let to_string t = t
let jsonaf_of_t = Json.string
let t_of_jsonaf json = Disk.unwrap (of_string (Json.text json))
