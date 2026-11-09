open Core
module Id : Workgraph.Id.S

module Generation : sig
  type t [@@deriving sexp, equal]

  val of_string : string -> (t, Workgraph.Problem.t) Result.t
  val to_string : t -> string
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  (** Positive canonical decimal string, not an opaque identifier. *)
  val initial : t

  val next : t -> (t, Workgraph.Problem.t) Result.t
end

(** Immutable endpoint generation. A socket path is trusted-local addressing,
    not an authenticated daemon identity; same-path replacement may be invisible. *)
type t

val create
  :  id:Id.t
  -> generation:Generation.t
  -> label:string
  -> socket:string
  -> (t, Workgraph.Problem.t) Result.t

val id : t -> Id.t
val generation : t -> Generation.t
val label : t -> string
val socket : t -> string
val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t

module Store : sig
  type profile := t
  type t

  (** Load bounded current profiles while retaining old immutable generations for
      operation recovery. A corrupt file rejects startup rather than reset state. *)
  val create : State_root.t -> (t, Workgraph.Problem.t) Result.t

  val list : t -> profile list
  val find : t -> id:Id.t -> generation:Generation.t -> profile option

  (** None creates; Some guards the current generation. A new generation is
      supplied by the owning companion, never inferred from browser selection. *)
  val put
    :  t
    -> profile
    -> expected_generation:Generation.t option
    -> (unit, Workgraph.Problem.t) Result.t
end
