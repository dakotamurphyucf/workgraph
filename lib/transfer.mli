open Core

module Upload_plan : sig
  type t

  (** Parameters include workspace/actor/mutation/resource IDs, observed revision,
      title, filename, MIME type, and an absolute source [file]. New plans hash the
      bounded regular source file before returning. Saved plans validate without
      reading the source, so a completed retry can succeed after its removal.
      Bad source inputs use Invalid_argument; expected local I/O uses Local_io. *)
  val prepare : fs:_ Eio.Path.t -> params:Jsonaf.t -> (t, Problem.t) Result.t

  (** Stable staging identity, frozen and checked against the plan contents. *)
  val upload_id : t -> Id.Upload.t

  val params : t -> Jsonaf.t

  (** Exact durable planning operation represented by this frozen local plan.
      Pure: reads no source and generates no identity. The plan itself and its
      optional later ticket link are not finish-upload commit evidence. *)
  val finish_request : t -> Protocol.Request.t

  (** Pure optional ticket-link request, preserving native exact identity/guard.
      Validate a complete durable finish publication against this plan's resource,
      content digest/size, publisher, filename and MIME before deriving the guard.
      The caller must separately verify the exact saved receipt request hash;
      this function does not authenticate a response's mutation identity. No
      source read, network operation or identity generation. *)
  val link_request
    :  t
    -> publication:Api_response.t
    -> (Protocol.Request.t option, Problem.t) Result.t
end

(** Abort only the saved plan's actor-owned staging. Guard supplied context scope
    before calling this function. Never reads source bytes, publishes content or
    deletes immutable blobs; exact receipt recovery through [upload] remains valid. *)
val abort_upload : Upload_plan.t -> client:Client.t -> (Jsonaf.t, Problem.t) Result.t

module Upload_result : sig
  type t =
    | Complete of Jsonaf.t
    | Link_failed of
        { publication : Jsonaf.t
        ; error : Problem.t
        }

  (** Complete retains exact receipt fields. A partial local workflow explicitly
      exposes the committed publication, unchanged link error and exact saved-plan
      retry identity. Publication and ticket linking are separate transactions. *)
  val envelope
    :  t
    -> request:Protocol.Request.t
    -> saved_request:string option
    -> Jsonaf.t
end

(** Publish only the resource using the exact saved upload/finish identities.
    Checks the durable finish receipt before touching source bytes, so an exact
    retry can finish after source removal. Does not execute the optional ticket
    link. The caller owns that separate explicit mutation and must retain known
    publication before invoking it. Same source verification, cancellation and
    expected I/O/uncertain error contracts as [upload]; no implicit retry. *)
val upload_publication
  :  Upload_plan.t
  -> client:Client.t
  -> fs:_ Eio.Path.t
  -> (Jsonaf.t, Problem.t) Result.t

(** Optional ticket_id is frozen in the saved upload plan. After durable finish,
    link using a deterministic separate mutation and the finish entity guard.
    Lost replies/retries reuse both original receipts; conflicts never refresh
    their guard. A link error preserves the exact committed publication. *)
val upload_with_link
  :  Upload_plan.t
  -> client:Client.t
  -> fs:_ Eio.Path.t
  -> (Upload_result.t, Problem.t) Result.t

(** Checks the durable finish receipt first, then verifies source bytes and resumes
    the ephemeral upload. A restart starts the same upload again using the original
    mutation ID. Each network operation uses the client's timeout; no operation is
    retried implicitly. Scratch chunks are at most 256KiB. Only local source-file
    failures use Invalid_argument/Local_io; daemon and uncertain errors retain their
    kind. *)
val upload
  :  Upload_plan.t
  -> client:Client.t
  -> fs:_ Eio.Path.t
  -> (Jsonaf.t, Problem.t) Result.t

module Download : sig
  (** [destination] is an absolute fresh-file path or [-] for CLI stdout.
      [spool] is an absolute fresh-file path, admitted only with destination [-].
      The CLI materializes that file through [download] before copying its bytes.
      Omitted [version] selects and pins the first returned immutable version. *)
  type t =
    { workspace : Id.Workspace.t
    ; resource : Id.Resource.t
    ; version : int option
    ; destination : string
    ; spool : string option
    }

  val of_params : Jsonaf.t -> (t, Problem.t) Result.t
end

(** Stream a download with the same version/range/chunk/full digest checks as
    [download], returning the exact resource identity receipt. Output may contain
    a verified chunk prefix before a final integrity failure. No local file is
    created; [destination] must be [-] and [spool] absent. *)
val stream
  :  Download.t
  -> client:Client.t
  -> output:_ Eio.Flow.sink
  -> (Jsonaf.t, Problem.t) Result.t

(** Pins the first returned immutable version and verifies chunk offsets, lengths,
    hashes and the complete content digest. Syncs a private file, atomically links
    it to a fresh destination without replacement, then syncs the directory.
    Failures before publication leave no destination. Private partial-file cleanup
    is best-effort; process kills may leave an unreferenced .downloading-* file.
    Bad destination paths/collisions are Invalid_argument; other expected local
    I/O is Local_io. Failure to sync an installed destination is Outcome_unknown.
    Requires an absolute file destination with [spool] absent. *)
val download
  :  Download.t
  -> client:Client.t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> (Jsonaf.t, Problem.t) Result.t
