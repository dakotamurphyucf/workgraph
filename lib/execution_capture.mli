open Core

(** Client-side execution evidence. No command is executed by this module or by
    the daemon. JSON decoders enforce the same invariants as constructors. *)
module Command : sig
  type t

  (** Absolute working directory, nonempty argv, at most 256 UTF-8 arguments and
      64KiB aggregate argv bytes. NUL bytes reject. Each stream retains at most
      [output_limit] bytes (1..1MiB); draining continues past that bound. *)
  val create
    :  argv:string list
    -> cwd:string
    -> output_limit:int
    -> (t, Problem.t) Result.t

  val argv : t -> string list
  val cwd : t -> string
  val output_limit : t -> int
  val source_root : t -> string option
  val with_source_root : t -> string -> (t, Problem.t) Result.t
  val codec : t Api_codec.t
end

module Outcome : sig
  type t =
    | Exited of int
    | Signaled of int
    | Interrupted
    | Launch_failed of string
  [@@deriving sexp, equal]

  (** Exit status is 0..255. Signal numbers use OCaml's [Sys] convention (which
      may be negative), not a platform-independent POSIX signal numbering. *)
  val codec : t Api_codec.t
end

module Output : sig
  type t

  (** [bytes] are an exact prefix, including arbitrary binary content.
      [observed_bytes] counts drained bytes, not necessarily everything the child
      wrote. [eof] says whether the pipe reached EOF; it is independent of prefix
      truncation. The digest identifies all observed bytes, including discarded
      suffixes. A partial capture never claims complete output. *)
  val create
    :  bytes:string
    -> observed_bytes:int64
    -> observed_sha256:string
    -> eof:bool
    -> (t, Problem.t) Result.t

  val bytes : t -> string
  val observed_bytes : t -> int64
  val eof : t -> bool
  val truncated : t -> bool
  val codec : t Api_codec.t
end

type t

(** Times are wall-clock Unix milliseconds, nonnegative; a backwards clock step
    is allowed. [elapsed_ms] is independently measured by a monotonic clock.
    Normal exits/signals require both pipes to have reached EOF. Interrupted and
    failed launches cannot claim successful completion. No acceptance assertion
    is inferred from an exit status. *)
val create
  :  command:Command.t
  -> outcome:Outcome.t
  -> started_unix_ms:int64
  -> finished_unix_ms:int64
  -> elapsed_ms:int64
  -> stdout:Output.t
  -> stderr:Output.t
  -> source_before:Source_provenance.t
  -> source_after:Source_provenance.t
  -> (t, Problem.t) Result.t

val command : t -> Command.t
val outcome : t -> Outcome.t
val stdout : t -> Output.t
val stderr : t -> Output.t
val source_before : t -> Source_provenance.t
val source_after : t -> Source_provenance.t
val codec : t Api_codec.t
