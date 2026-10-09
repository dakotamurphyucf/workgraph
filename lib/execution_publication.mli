open Core

(** A single durable publication intent for a finished local execution stage.
    It never launches commands or infers validation/approval from their outcome. *)
type t

(** Validate a finished stage and publish its exact upload request atomically to
    [publication.json] inside that stage, before any network access. Parameters
    specify workspace/actor/optional run, explicit mutation/resource IDs, expected
    resource revision and title. Filename/MIME/source are fixed by the capture.
    Existing publication intents reject; use [load] for exact retries. *)
val prepare
  :  Execution_stage.t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> params:Jsonaf.t
  -> (t, Problem.t) Result.t

(** Reads only the saved request; does not require the original capture bytes.
    Transfer checks the committed receipt first, allowing recovery after source
    removal. Missing/unfinalized intents never synthesize a replacement request. *)
val load : fs:_ Eio.Path.t -> directory:string -> (t, Problem.t) Result.t

val saved_request : t -> string
val request : t -> Protocol.Request.t

(** Returns a durable resource publication envelope or an explicit failure.
    Failure/retry never reruns execution. Network timeouts follow Client semantics;
    external cancellation and unexpected exceptions propagate. *)
val publish : t -> client:Client.t -> fs:_ Eio.Path.t -> (Jsonaf.t, Problem.t) Result.t
