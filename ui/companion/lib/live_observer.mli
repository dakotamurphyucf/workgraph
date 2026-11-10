open Core

(** Foreground, read-only workspace observation. One HTTP request observes planning
    and optionally history together, outside the generic two-slot wait lane.
    The service and admission counter belong to the companion Eio domain; they
    must never be shared with worker domains. *)
module Cancellation : sig
  type t

  (** Closed workspace_id and observation_id (32 lowercase hex characters).
      The immutable connection generation is supplied separately by the router. *)
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Plan : sig
  type t

  (** Closed wire object: observation_id, workspace_id, planning_cursor (nullable), history
      (boolean), history_cursor (nullable), wait (boolean), runtime (boolean), and
      runtime_signature (nullable SHA-256). Runtime observation compares advisory
      staleness/lease warnings at the end of each wait, without browser polling. Native cursor bounds
      apply. Project filters deliberately do not restrict invalidation. *)
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

type t

val create : net:_ Eio.Net.t -> clock:_ Eio.Time.Mono.t -> t

(** Up to 16 concurrent observations, with immediate capacity rejection rather
    than queued long polls. Each uses at most two daemon connections. Initial
    calls establish both cursors before returning. Subsequent calls return on
    either feed or after 25 seconds; cancellation closes both native waits.
    An unreturned feed cursor is retained exactly, including on errors. Each
    invocation qualifies its immutable endpoint before contacting native feeds.
    Cancellation and unexpected exceptions propagate. *)
val observe
  :  t
  -> connection:Connection_profile.t
  -> Plan.t
  -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Finish only the named observation normally, without closing its HTTP socket.
    A cancellation arriving before admission is remembered for 90 seconds, bounded
    to 256 identities. All mutable registries belong to the serving Eio domain.
    Cancellation is idempotent, scoped to connection generation and workspace;
    it never cancels a write. Observe returns {cancelled:true} when interrupted. *)
val cancel
  :  t
  -> connection:Connection_profile.t
  -> Cancellation.t
  -> (Jsonaf.t, Workgraph.Problem.t) Result.t
