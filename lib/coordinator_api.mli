open Core
module Kind = Coordinator_wire.Kind

module Request : sig
  (** Literal exact selectors: project_id/run_id/actor_id, no inferred aliases.
      Positive stale_after_ms; cursor<=2048 bytes; kinds<=14 distinct allowed
      values. Immutable cursor binds capture head/revision, heartbeat snapshot,
      filters and first-page clock. Unknown run fails Not_found in pure view. *)
  type t

  val codec : t Api_codec.t
  val project : t -> Id.Project.t option
  val run : t -> Id.Run.t option
  val actor : t -> Id.Actor.t option
  val kinds : t -> Kind.t list
  val cursor : t -> string option
  val limit : t -> int
  val max_bytes : t -> int
  val stale_after_ms : t -> int64
  val dependency_path_to : t -> Id.Ticket.t option
end

val method_ : (Request.t, Coordinator_wire.Response.t) Api_method.t
val methods : Api_method.Packed.t list
