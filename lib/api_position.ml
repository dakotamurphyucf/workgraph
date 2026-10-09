open Core

module type S = sig
  type t [@@deriving sexp_of, compare, equal]

  val of_int : int -> (t, Problem.t) Result.t
  val to_int : t -> int
  val codec : t Api_codec.t
end

module Make (Bounds : sig
    val max : int
    val description : string
  end) : S = struct
  type t = int [@@deriving sexp_of, compare, equal]

  let of_int value =
    if value < 0 || value > Bounds.max
    then Error (Problem.create Invalid_argument "position outside supported range")
    else Ok value
  ;;

  let to_int t = t

  let codec =
    Api_codec.map
      (Api_codec.decimal ~max:Bounds.max)
      ~decode:of_int
      ~encode:to_int
      ~description:Bounds.description
  ;;
end

module Workspace_revision = Make (struct
    let max = Int.max_value
    let description = "Workspace planning transaction revision."
  end)

module Query_revision = Make (struct
    let max = Int.max_value
    let description = "Pagination capture revision within the accompanying query_scope."
  end)

module History_sequence = Make (struct
    let max = 1_000_000
    let description = "History journal commit sequence, independent of planning."
  end)

module Session_sequence = Make (struct
    let max = 1_000_000
    let description = "Event sequence within one history session."
  end)
