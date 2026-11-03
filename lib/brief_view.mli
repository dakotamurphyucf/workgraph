open Core

(** Explicit compact projections. Every omitted body byte/item is counted;
    identifiers, revisions, ownership and expansion selectors are never clipped. *)
module Excerpt : sig
  type t =
    { text : string
    ; total_bytes : int
    ; omitted_bytes : int
    }

  val codec : t Api_codec.t

  (** UTF-8 prefix, at most 512 bytes; negative bounds reject via Json.Decode_error. *)
  val of_text : string -> max_bytes:int -> t
end

module Ticket : sig
  (** Input is one immutable capture. Decision comments are current, live authored
      decision notes in descending activity serial; no full attempt/activity
      history is read or materialized. Full context remains [ticket.context]. *)
  type t =
    { ticket : Planning_ticket_wire.Ticket.t
    ; observed_unix_ms : int64 option
    ; ready : bool
    ; readiness_reason_count : int
    ; handoff : Planning_ticket_wire.Handoff.t option
    ; decisions : Jsonaf.t list
    ; resources : Resource.t list
    }
end

val ticket
  :  Ticket.t
  -> workspace:Id.Workspace.t
  -> workspace_revision:int
  -> max_bytes:int
  -> (Jsonaf.t, Problem.t) Result.t

val resource
  :  Resource.t
  -> workspace:Id.Workspace.t
  -> workspace_revision:int
  -> max_bytes:int
  -> (Jsonaf.t, Problem.t) Result.t

val ticket_codec : Jsonaf.t Api_codec.t
val resource_codec : Jsonaf.t Api_codec.t
