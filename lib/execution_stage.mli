open Core

(** Local durable execution staging. This module runs commands only on the client;
    it has no daemon/client transport capability and cannot publish or validate
    evidence. Explicit publication consumes a finished stage without executing. *)
type t

module State : sig
  type t =
    | Unfinished of Execution_capture.Command.t
    | Finished of Execution_capture.t
end

(** Create a fresh private directory at the absolute path and sync the command
    record before launching. Existing directories reject, even if unfinished;
    running this operation again must never rerun a saved command. Existing stages
    report their path and explain that a fresh stage is needed for a new execution. The parent
    directory must exist. Bad paths/existing destinations are Invalid_argument;
    other expected local I/O failures are Local_io. Cancellation kills the directly owned child, stages an
    interrupted outcome with observed output, then propagates. Descendant process
    isolation remains the caller's responsibility. Unexpected exceptions propagate.
    The child inherits the client's environment; standard input is immediate EOF.
    A hard process kill may leave an [Unfinished] stage, never implicit success. *)
val run
  :  Execution_capture.Command.t
  -> env:Eio_unix.Stdenv.base
  -> directory:string
  -> (t, Problem.t) Result.t

(** Read a stage without launching any command. Reject malformed records, output
    digests or a final command differing from the synced launch intent. Input path
    errors are Invalid_argument; durable record integrity errors remain Corrupt_store. *)
val load : fs:_ Eio.Path.t -> directory:string -> (t, Problem.t) Result.t

val directory : t -> string
val state : t -> State.t
val owner_token : t -> string option

(** Hold the stage's stable command-file lock while preparing publication or
    cleanup. Refuses live/concurrent owners and nonregular launch records. The
    callback receives an opened directory capability. This is cooperative local
    coordination, not authentication or process-isolation enforcement. *)
val with_lock
  :  fs:_ Eio.Path.t
  -> directory:string
  -> f:(Eio.Fs.dir_ty Eio.Path.t -> 'a)
  -> ('a, Problem.t) Result.t

(** Explicit cleanup of one finished stage created with an ownership marker.
    Requires its exact token and validated command/capture bytes, acquires the
    live-operation lock, and refuses every publication intent or unknown entry.
    Removes only the three known regular files and the empty stage directory;
    never recursively prunes, follows symlinks or deletes published evidence.
    Partial cleanup after I/O failure is reported and never claimed successful. *)
val cleanup
  :  fs:_ Eio.Path.t
  -> directory:string
  -> owner_token:string
  -> (unit, Problem.t) Result.t

(** Absolute path of the final bounded JSON capture resource. [None] for an
    unfinished stage. Bytes include exact base64 stdout/stderr and provenance
    describing command/outcome/timing; callers must not treat it as approval. *)
val capture_file : t -> string option
