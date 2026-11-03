open Core

module Put : sig
  type t =
    { ticket : Id.Ticket.t
    ; expected_revision : int
    ; policy : Hierarchy_policy.t
    ; reason : string
    }

  (** Explicit ID, nonnegative policy revision, both policy enums, and nonblank
      bounded audit reason. Omitted policy fields are not implicit patches. *)
  val codec : t Api_codec.t
end

module Get : sig
  type t = { ticket : Id.Ticket.t }

  val codec : t Api_codec.t
end

module Snapshot : sig
  (** [None] means no stored policy, distinct from an explicit default policy.
      Effective defaults are included and validated against the stored policy. *)
  type t

  val create
    :  ticket:Id.Ticket.t
    -> policy:Hierarchy_policy.Definition.t option
    -> (t, Problem.t) Result.t

  val ticket : t -> Id.Ticket.t
  val stored : t -> Hierarchy_policy.Definition.t option
  val effective : t -> Hierarchy_policy.t
  val codec : t Api_codec.t
end

val put : (Put.t, Hierarchy_policy.Definition.t) Api_method.t
val get : (Get.t, Snapshot.t) Api_method.t
val methods : Api_method.Packed.t list
