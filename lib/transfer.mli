open Core

module Upload_plan : sig
  type t

  (** Parameters include workspace/actor/mutation/resource IDs, observed revision,
      title, filename, MIME type, and an absolute source [file]. New plans hash the
      bounded regular source file before returning. Saved plans validate without
      reading the source, so a completed retry can succeed after its removal. *)
  val prepare : fs:_ Eio.Path.t -> params:Jsonaf.t -> (t, Problem.t) Result.t

  val params : t -> Jsonaf.t
end

(** Checks the durable finish receipt first, then verifies source bytes and resumes
    the ephemeral upload. A restart starts the same upload again using the original
    mutation ID. Each network operation uses the client's timeout; no operation is
    retried implicitly. Scratch chunks are at most 256KiB. *)
val upload
  :  Upload_plan.t
  -> client:Client.t
  -> fs:_ Eio.Path.t
  -> (Jsonaf.t, Problem.t) Result.t

module Download : sig
  type t =
    { workspace : Id.Workspace.t
    ; resource : Id.Resource.t
    ; version : int option
    ; destination : string
    }

  val of_params : Jsonaf.t -> (t, Problem.t) Result.t
end

(** Pins the first returned immutable version and verifies chunk offsets, lengths,
    hashes and the complete content digest. Syncs a private file, atomically links
    it to a fresh destination without replacement, then syncs the directory.
    Failures before publication leave no destination. Private partial-file cleanup
    is best-effort; process kills may leave an unreferenced .downloading-* file. *)
val download
  :  Download.t
  -> client:Client.t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> (Jsonaf.t, Problem.t) Result.t
