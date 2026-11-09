open Core

module Lane : sig
  type t =
    | Visible
    | History
    | Search
    | Wait
  [@@deriving equal, sexp]

  val of_string : string -> (t, Workgraph.Problem.t) Result.t
  val to_string : t -> string
end

(** Single-domain bounded fibers. Active defaults: visible=4, history=2,
    search=1, wait=2; each has at most 32 queued admissions. No empty-success
    fallback. Cancellation removes queued/active ownership in all paths. *)
type t

val create : unit -> t

val run
  :  t
  -> lane:Lane.t
  -> f:(unit -> ('a, Workgraph.Problem.t) Result.t)
  -> ('a, Workgraph.Problem.t) Result.t

val to_json : t -> Jsonaf.t
