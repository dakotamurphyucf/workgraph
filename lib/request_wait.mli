open Core

(** Client-only bounded observation of one accountable request. No write,
    acknowledgement, acceptance, resolution or process management occurs. *)
type t

(** Total monotonic deadline 1000..300000ms; delay between completed reads
    250..25000ms. Always reads the explicitly selected workspace/request with a
    1MiB response budget, without related-message expansion. *)
val create
  :  workspace:Id.Workspace.t
  -> request:Communication_id.Request.t
  -> timeout_ms:int
  -> poll_interval_ms:int
  -> (t, Problem.t) Result.t

module Outcome : sig
  type t

  (** True only for a complete resolved observation. A request may resolve with
      no answer, in which case its exact [answer] remains null. Cancellation,
      deadline and clipped observations are distinct unsuccessful stops. *)
  val resolved : t -> bool

  (** Local helper result: original request.get [{data;meta}] plus [meta.wait]
      with [stop], [resolved], [poll_count]. Original data paths and all metadata
      are preserved; [data.answer] is the pinned answer version supplied by the
      daemon, never a later current comment. This extension is not a daemon
      request.get response and does not alter the raw API metadata schema. *)
  val to_json : t -> Jsonaf.t
end

(** Read immediately, then delay between open observations. [now] is monotonic
    seconds; [sleep] takes positive seconds. [exchange] must enforce its positive
    remaining timeout. Validate the entire response and requested identity before
    inspecting status. A clipped result stops instead of asserting a full answer.
    No exchange begins after the deadline; its last complete observation remains
    available on deadline. A final in-flight resolved observation succeeds.

    Expected transport/domain errors return unchanged. No automatic retry after
    an error. Cancellation and unexpected exceptions propagate. Callbacks must
    honor the clock and timeout contracts; no wall-clock liveness is inferred. *)
val collect
  :  t
  -> now:(unit -> float)
  -> sleep:(float -> unit)
  -> exchange:
       (timeout_seconds:float -> Protocol.Request.t -> (Jsonaf.t, Problem.t) Result.t)
  -> (Outcome.t, Problem.t) Result.t

(** Thin Eio adapter. Each transport timeout is capped by the remaining total
    deadline; external cancellation interrupts both reads and sleeps. *)
val run
  :  t
  -> net:_ Eio.Net.t
  -> clock:_ Eio.Time.Mono.t
  -> socket:string
  -> max_exchange_seconds:float
  -> (Outcome.t, Problem.t) Result.t
