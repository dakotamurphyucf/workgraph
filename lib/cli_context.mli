open Core

(** Explicit agent-local defaults. No current ticket or process-global actor.
    Paths must be absolute; identities are validated on decoding. *)
type t

val of_json : Jsonaf.t -> (t, Problem.t) Result.t
val to_json : t -> Jsonaf.t
val socket : t -> string
val request_directory : t -> string option

(** Inserts missing scope/attribution defaults admitted by executable schemas.
    Read methods receive only the workspace default: actor/run query filters and
    target identities remain explicit. Write methods receive applicable actor/run
    defaults, including actor-owned upload staging. Local upload/download helpers
    have explicit scope rules; unknown methods receive no defaults. Explicit fields
    always win. *)
val apply
  :  t
  -> method_:string
  -> fields:(string * Jsonaf.t) list
  -> (string * Jsonaf.t) list

(** Explicit CLI [--self] expansion only. For inbox.read/wait/ack and
    request.list/acknowledge/accept, supply a missing actor [recipient]. For
    run.get/transition/observe/link_session, supply missing [target_run_id].
    Explicit selectors win, even without context. Missing required actor/run
    context and unsupported methods return actionable Invalid_argument. This
    operation never defaults general reads, reassign destinations or API params
    named [self]; raw JSON fields remain subject to normal schema validation. *)
val apply_self
  :  t option
  -> method_:string
  -> fields:(string * Jsonaf.t) list
  -> ((string * Jsonaf.t) list, Problem.t) Result.t

(** Reading uses Eio and a bounded regular-file contract. Invalid input paths are
    Invalid_argument; other expected local I/O failures are Local_io. *)
val load : fs:_ Eio.Path.t -> string -> (t, Problem.t) Result.t

(** Publish complete synchronized bytes atomically without replacing an existing
    context. Readers never observe a partly written published file. A random
    private sibling stages the bytes; invalid input paths are Invalid_argument and
    other expected local I/O failures are Local_io. Cancellation and unexpected
    errors propagate. *)
val save
  :  t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> string
  -> (unit, Problem.t) Result.t
