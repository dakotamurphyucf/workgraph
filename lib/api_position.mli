open Core

(** Distinct positions exposed by the API. Conversion from an integer validates
    the nonnegative operational range. There is deliberately no conversion from
    one position type to another: equal numbers do not imply equal captures. *)
module type S = sig
  type t [@@deriving sexp_of, compare, equal]

  val of_int : int -> (t, Problem.t) Result.t
  val to_int : t -> int
  val codec : t Api_codec.t
end

(** Commits to the workspace planning graph. *)
module Workspace_revision : S

(** A domain projection's pagination revision; always paired with query_scope. *)
module Query_revision : S

(** Commits to the independent history journal, not events within a session. *)
module History_sequence : S

(** Events within one history session, including zero for an empty session. *)
module Session_sequence : S
