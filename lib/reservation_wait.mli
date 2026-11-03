open Core

(** Client-only bounded acquisition. No fairness queue, renewal, ownership
    recovery or inference that an expired lease means a process has stopped.
    Lease expiry does not itself remove a holder or make acquisition succeed. *)
module Limits : sig
  type t

  (** Total monotonic deadline 1000..300000ms; 1..100 acquisition attempts;
      feed wait slice 1..25000ms. Defaults: 30000ms, 32 attempts, 1000ms. *)
  val create
    :  timeout_ms:int
    -> max_attempts:int
    -> wait_slice_ms:int
    -> (t, Problem.t) Result.t

  val default : t
end

type t

(** Only exact [reservation.acquire] and [reservation.paths.acquire] requests.
    Requires concrete validated attribution, mutation identity and a nonempty
    atomic batch. Every field is retained when constructing later attempts;
    only the mutation identity changes after definite [Already_claimed] or
    [Conflict] carrying typed [Reservation_conflict] whose
    requested target belongs to this batch. No guards are refreshed. *)
val create : Protocol.Request.t -> limits:Limits.t -> (t, Problem.t) Result.t

module Stop : sig
  type t =
    | Acquired
    | Deadline
    | Attempt_limit
    | Needs_larger_budget
    | No_progress
    | Failed
    | Uncertain
  [@@deriving equal, sexp]

  val to_string : t -> string
end

module Outcome : sig
  type t

  val completed : t -> bool
  val stop : t -> Stop.t

  (** Local workflow envelope: the actual daemon success reply [{data;meta}] is
      retained separately in [data.daemon_response], including an invalid or
      nondurable reply that caused [Uncertain]. Only [completed] validates a grant.
      [data.wait] contains stop,
      completed, attempt_count, ordered journal references, last actual conflict,
      problem and the exact saved retry request/path when available. Incomplete
      is never a successful acquisition or evidence that a waiter was queued. *)
  val to_json : t -> Jsonaf.t
end

(** Capture the planning feed before the first acquisition. Each journal must be
    synchronized before [exchange] is called for that attempt. [now] supplies
    monotonic seconds; [exchange] must honor its positive remaining timeout.
    Journal references distinguish an exchange started from a saved-but-unsent
    request if the deadline passes during synchronization. At most max_attempts
    exchanges are started. A final in-flight durable success remains a success;
    no subsequent attempt starts after the deadline.

    Feed cursors/omissions are retained. After definite contention, a feed wake or
    bounded timer permits one fresh identity. Other conflicts/errors, malformed
    or nondurable grants and uncertainty stop. Cancellation and unexpected
    exceptions propagate, leaving synchronized journals for exact manual retry.
    Read transport unavailability observed at the exhausted total deadline stops
    as [Deadline], retaining the original problem. The same failure before that
    deadline remains [Failed]; write uncertainty remains [Uncertain]. Expected
    callback failures are returned as incomplete Outcome diagnostics. *)
val collect
  :  t
  -> now:(unit -> float)
  -> max_exchange_seconds:float
  -> fresh_mutation:(unit -> Id.Mutation.t)
  -> save:(Protocol.Request.t -> (string, Problem.t) Result.t)
  -> exchange:
       (timeout_seconds:float -> Protocol.Request.t -> (Jsonaf.t, Problem.t) Result.t)
  -> (Outcome.t, Problem.t) Result.t

(** Eio adapter: exclusive synchronized files in an existing absolute private
    directory, named by exact mutation identity. Existing files never overwrite.
    [on_saved] runs before transmission (CLI diagnostics belong on stderr).
    Transport timeouts are capped by the remaining monotonic deadline. *)
val run
  :  t
  -> fs:_ Eio.Path.t
  -> net:_ Eio.Net.t
  -> clock:_ Eio.Time.Mono.t
  -> random:_ Eio.Flow.source
  -> socket:string
  -> request_directory:string
  -> max_exchange_seconds:float
  -> on_saved:(string -> unit)
  -> (Outcome.t, Problem.t) Result.t
