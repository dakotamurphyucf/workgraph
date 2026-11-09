open Core

(** One bounded read-only request observation, owned by the foreground HTTP call.
    No durable state, write journal, acknowledgment, resolver action or process
    supervisor. Cancellation and unexpected exceptions propagate. *)
module Plan : sig
  type t

  (** Retains the immutable profile including socket and generation. Uses native
      Request_wait validation: total1000..300000ms, poll250..25000ms. *)
  val create
    :  profile:Connection_profile.t
    -> workspace:Workgraph.Id.Workspace.t
    -> request:Workgraph.Communication_id.Request.t
    -> timeout_ms:int
    -> poll_interval_ms:int
    -> (t, Workgraph.Problem.t) Result.t

  (** Closed capture object: profile, workspace_id, request_id, timeout_ms and
      poll_interval_ms. All companion integer fields are canonical decimal strings. *)
  val to_json : t -> Jsonaf.t
end

type t

val create : net:_ Eio.Net.t -> clock:_ Eio.Time.Mono.t -> scheduler:Read_scheduler.t -> t

type observed

(** Delegates immediate poll/delay/deadline/request identity/answer semantics to
    Request_wait.collect. Its monotonic total starts before qualification and
    admission. Every actual exchange enters the bounded Wait read lane, releasing
    admission during sleeps. Queue, first-invocation package qualification and
    native transport share the remaining deadline; no exchange starts afterward.
    Qualification occurs once per explicit invocation, never cached across calls.

    Expected qualification/transport/domain errors stop unchanged, without retry.
    Cancellation interrupts queued reads, active reads and sleep; caller HTTP
    disconnect/AbortSignal must cancel this foreground call. Native resolved,
    request-cancelled, deadline and incomplete stops remain distinct. The native
    last complete observation on deadline and its pinned answer are retained;
    no current-comment lookup replaces an answer version. A complete resolved
    observation may have answer=null and is successful. *)
val observe : t -> Plan.t -> (observed, Workgraph.Problem.t) Result.t

(** Closed {capture; observation}. Observation is the native local-helper
    {data;meta.wait} projection. meta.wait is not ordinary daemon metadata and
    this result must never be decoded as an unextended request.get envelope. *)
val to_json : observed -> Jsonaf.t
