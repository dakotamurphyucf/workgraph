open Core

(** Advisory attributed records, never grants or fairness/queue positions. The
    combined 1000 natural-key lifetime cap includes inactive keys: revisions are
    retained, never evicted/reset. Explicit updates alone change this state. *)
module Target : sig
  type t =
    | Named of Reservation.Name.t
    | Path of Path_scope.t
  [@@deriving compare, equal, sexp]

  val codec : t Api_codec.t
  val overlaps : t -> t -> bool
end

module Waiter : sig
  type state =
    | Waiting
    | Closed of string
  [@@deriving equal, sexp]

  type t =
    { target : Target.t
    ; actor : Id.Actor.t
    ; run : Id.Run.t
    ; revision : int
    ; started_unix_ms : int64
    ; updated_unix_ms : int64
    ; expires_unix_ms : int64
    ; note : string
    ; state : state
    }
  [@@deriving equal, sexp]

  type input =
    { duration_ms : int
    ; note : string
    }
  [@@deriving sexp]

  type action =
    | Begin of input
    | Refresh of input
    | Close of string
  [@@deriving sexp]

  val codec : t Api_codec.t
end

module Holder_note : sig
  type contents =
    { note : string
    ; expected_release_unix_ms : int64 option
    ; expires_unix_ms : int64
    }
  [@@deriving equal, sexp]

  type t =
    { target : Target.t
    ; actor : Id.Actor.t
    ; run : Id.Run.t
    ; token : int
    ; revision : int
    ; updated_unix_ms : int64
    ; contents : contents option
    }
  [@@deriving equal, sexp]

  type input =
    { duration_ms : int
    ; note : string
    ; expected_release_unix_ms : int64 option
    }
  [@@deriving sexp]

  type action =
    | Set of input
    | Clear
  [@@deriving sexp]

  val codec : t Api_codec.t
end

module Command : sig
  (** Duration 1..300000ms; note <=1024 UTF8 bytes; close reason nonblank <=512
      bytes. Expected revision zero creates a key; all later actions use its exact
      current revision. Begin/reopen resets start; Refresh preserves it and requires
      unexpired Waiting. Close withdraws a record without changing ownership.
      Holder note Set/Clear additionally needs the current stored holder fence. *)
  type t =
    | Waiter of
        { target : Target.t
        ; run : Id.Run.t
        ; expected_revision : int
        ; action : Waiter.action
        }
    | Holder_note of
        { target : Target.t
        ; run : Id.Run.t
        ; token : int
        ; expected_revision : int
        ; action : Holder_note.action
        }
  [@@deriving sexp]

  val codec : method_:string -> t Api_codec.t option
  val raw_codec : method_:string -> Jsonaf.t Api_codec.t option
  val run : t -> Id.Run.t
  val target : t -> Target.t
  val holder_token : t -> int option
end

module Change : sig
  (** Resolved action tags remain explicit for independent replay validation. *)
  type t =
    | Waiter_begin of Waiter.t
    | Waiter_refresh of Waiter.t
    | Waiter_close of Waiter.t
    | Holder_note_put of Holder_note.t
  [@@deriving equal, sexp]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
  val actor : t -> Id.Actor.t
  val run : t -> Id.Run.t
  val target : t -> Target.t
  val holder_token : t -> int option
end

type t

val empty : t

(** Pure transitions reject clock overflow/regression, invalid lifecycle/revision
    and distinct-key capacity with a separate Blocked error. Caller must validate
    registered nonterminal run ownership and actual holder fence independently in
    preparation AND replay; these records cannot validate acquisition themselves.
    Inputs remain immutable; only expected failures become Problem results. *)
val prepare
  :  t
  -> Command.t
  -> actor:Id.Actor.t
  -> now_unix_ms:int64
  -> (Change.t, Problem.t) Result.t

val apply : t -> Change.t -> (t, Problem.t) Result.t
val waiters : t -> Waiter.t list
val holder_notes : t -> Holder_note.t list
val holder_note : t -> target:Target.t -> run:Id.Run.t -> Holder_note.t option
val to_json : t -> Jsonaf.t
