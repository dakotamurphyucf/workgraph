open Core

(** Read-only discovery of registered catalog identities and actors attributed to
    retained planning commits. Naming a recipient, assignee or resolver alone is
    not an observation. Registration and past participation imply no liveness.
    Specialized families describe authored changes, not referenced identities.
    Run includes the agent-run/coordination event family. Every retained commit
    contributes Activity, including writes outside the specialized families. *)
module Source : sig
  type t =
    | Catalog
    | Activity
    | Fact
    | Comment
    | Request
    | Run
  [@@deriving compare, equal, sexp]

  val codec : t Api_codec.t
end

module Observation : sig
  (** Inclusive workspace commit revisions within retained history, not lifetime
      bounds, timestamps or heartbeats. *)
  type t =
    { first_revision : int
    ; last_revision : int
    }

  val codec : t Api_codec.t
end

module Participant : sig
  (** Sources are distinct and in [Source.compare] order. Catalog is present iff
      registration is present (including archived actors); Activity and observed
      are present together. Specialized sources imply Activity. Empty identities
      and contradictory source/observation combinations are rejected by codecs. *)
  type t =
    { actor_id : Id.Actor.t
    ; registration : Planning_wire.Actor.t option
    ; observed : Observation.t option
    ; sources : Source.t list
    }

  val codec : t Api_codec.t
end

module Request : sig
  (** Defaults: limit 50, offset 0, max_bytes 65536. Bounds: limit 1..100,
      max_bytes 4096..1048576. Positive offsets require the exact [at_revision];
      any mutation invalidates the capture. Explicit null and unknown fields fail.
      All catalog identities, including archived ones, remain discoverable. *)
  type t

  val codec : t Api_codec.t
  val limit : t -> int
  val offset : t -> int
  val at_revision : t -> int option
  val max_bytes : t -> int
end

(** Actor-ID ordered pages retain complete records. Byte fitting removes a suffix
    and advances next_offset only by the returned count. If the first item cannot
    fit, returns Invalid_argument. This query never registers actors or runs or mutates state. *)
val response_codec : Participant.t Planning_wire.Page.t Api_codec.t

val descriptor : Api_method.Packed.t
