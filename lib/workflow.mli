open Core

(** Fixed scheduling semantics, independent of user-defined display names. *)
module Category : sig
  type t =
    | Backlog
    | Todo
    | In_progress
    | Done
    | Canceled
  [@@deriving sexp, equal]

  val of_name : string -> t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Actor : sig
  type kind =
    | Person
    | Agent
  [@@deriving sexp, equal, jsonaf]

  type t =
    { id : Id.Actor.t
    ; name : string
    ; kind : kind
    ; revision : int
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Label : sig
  type t =
    { id : Id.Label.t
    ; name : string
    ; description : string
    ; revision : int
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Status : sig
  type t =
    { id : Id.Status.t
    ; name : string
    ; category : Category.t
    ; revision : int
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

(** Full replacement commands contain the observed revision (zero to create).
    Changes contain the resulting revision. A status's category is immutable.
    Archive preserves existing references but prevents new assignments. *)
module Change : sig
  type t =
    | Actor of Actor.t
    | Label of Label.t
    | Status of Status.t
  [@@deriving sexp, jsonaf]
end

type t

val empty : t
val decode : method_:string -> params:Jsonaf.t -> Change.t
val prepare : t -> Change.t -> Change.t
val apply : t -> Change.t -> t
val actor : t -> Id.Actor.t -> Actor.t
val label : t -> Id.Label.t -> Label.t
val status : t -> Id.Status.t -> Status.t

val items
  :  t
  -> kind:[ `Actors | `Labels | `Statuses ]
  -> include_archived:bool
  -> Jsonaf.t list

(** Pure operations raise [Json.Decode_error] for invalid input and references;
    the enclosing domain boundary converts these to typed Results. *)
val to_json : t -> Jsonaf.t
