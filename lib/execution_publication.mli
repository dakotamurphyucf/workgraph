open Core

(** A single durable publication intent for a finished local execution stage.
    It never launches commands or infers validation/approval from their outcome. *)
type t

(** Validate a finished stage and publish its exact upload request atomically to
    [publication.json] inside that stage, before any network access. Parameters
    specify workspace/actor/optional run, resource ID, expected resource revision
    and title. A missing mutation ID uses the shared CLI identity generator;
    the complete request is synced before return. Filename/MIME/source are fixed
    by the capture. Existing publication intents reject before generation; use
    [load] for exact retries. Local input/I/O errors use Invalid_argument/Local_io. *)
val prepare
  :  Execution_stage.t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> params:Jsonaf.t
  -> (t, Problem.t) Result.t

(** Reads and re-syncs only the saved request and its parent; does not require the
    original capture bytes. This fences sending after an interrupted local save.
    Transfer checks the committed receipt first, allowing recovery after source
    removal. Missing/unfinalized intents never synthesize a replacement request. *)
val load : fs:_ Eio.Path.t -> directory:string -> (t, Problem.t) Result.t

val saved_request : t -> string
val request : t -> Protocol.Request.t

(** Deterministic discovery-copy pathname for this complete exact request. Does
    not generate an identity or touch the filesystem. Directory must be absolute. *)
val journal_path : t -> directory:string -> (string, Problem.t) Result.t

(** Sync an optional local discovery copy of the same complete request before
    sending. Creates an exclusive file; an existing regular file is accepted only
    for identical bytes, then the file and parent are synced. Never overwrites.
    A failure must prevent sending in that invocation. The stage remains the
    authoritative retry intent: a later deliberate stage-only retry can omit the
    journal, retaining exact identity. Invalid paths/collisions use Invalid_argument;
    other expected local I/O uses Local_io. Cancellation propagates. *)
val journal : t -> fs:_ Eio.Path.t -> destination:string -> (unit, Problem.t) Result.t

(** Returns a durable resource publication envelope or an explicit failure.
    Failure/retry never reruns execution. Network timeouts follow Client semantics;
    external cancellation and unexpected exceptions propagate. *)
val publish : t -> client:Client.t -> fs:_ Eio.Path.t -> (Jsonaf.t, Problem.t) Result.t
