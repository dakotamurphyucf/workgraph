open Core

(** Public metadata feed contracts. Planning revisions and history journal
    sequences remain independent positions. This interface does not turn a feed
    metadata item into a historical planning body or session event. *)
module Source : sig
  type t =
    | Planning
    | History
  [@@deriving sexp_of, equal]

  val codec : t Api_codec.t
end

module Request : sig
  (** One shared Fields declaration serves read and wait. Unknown/duplicate
      fields reject; cursor/after are exclusive; exact target and typed IDs;
      kinds <=32 unique strings<=128 bytes, canonical ordering for cursor hash;
      limit1..100, budget4096..1048576; wait timeout1..25000ms. Defaults are
      planning, after0, limit50, max_bytes65536, wait timeout20000ms. No aliases. *)
  type t

  val codec : method_:string -> t Api_codec.t option
  val workspace : t -> Id.Workspace.t
  val source : t -> Source.t
  val after : t -> int option
  val cursor : t -> string option
  val target : t -> Entity_ref.t option
  val project : t -> Id.Project.t option
  val actor : t -> Id.Actor.t option
  val kinds : t -> string list
  val limit : t -> int
  val max_bytes : t -> int
  val timeout_ms : t -> int

  (** Advance the nonmatching prefix without changing filters or timeout. This
      only constructs the next pure read; runtime waiting remains in Service. *)
  val with_cursor : t -> cursor:string -> t

  val read_params : t -> (Jsonaf.t, Problem.t) Result.t
end

module Item : sig
  type t =
    { revision : int
    ; actor_id : Id.Actor.t
    ; timestamp : string
    ; targets : Entity_ref.t list
    ; kinds : string list
    ; run_id : Id.Run.t option
    }

  (** Complete captured metadata. Timestamp may be empty for history journals;
      no provider/event timestamp is inferred. No payload clipping. Exact typed
      actor/run/targets, ordered targets and canonical captured kinds. *)
  val codec : t Api_codec.t
end

module Response : sig
  type t =
    { source : Source.t
    ; through : int
    ; items : Item.t list
    ; cursor : string
    ; has_more : bool
    ; needs_larger_budget : bool
    }

  (** Ascending positive item positions <=through; at most100 items. Oversized
      first metadata item preserves cursor position and needs_larger_budget.
      Common Feed projection supplies source-appropriate capture metadata. *)
  val codec : t Api_codec.t
end

val methods : Api_method.Packed.t list
val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option
