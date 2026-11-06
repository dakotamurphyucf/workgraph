open Core

(** Offline conversion of the released 0.6.2 workspace representations only.
    The old root's committed files are never changed. Stop its daemon and resolve
    uncertain old writes with the old executable before conversion. Registry
    jobs, local caches/uploads, exports and saved API envelopes are not migrated.
    Register a successful destination separately in a fresh registry. *)
type t

val to_json : t -> Jsonaf.t

(** Validate the source under its exclusive writer lock, build and replay a fresh
    target root, then publish with a no-replacement rename and parent sync.
    Expected failures return [Problem.t]; cancellation and unexpected exceptions
    propagate. Failures after staging identify the owned stage and cleanup token.
    A failed final parent sync is [Outcome_unknown]; never overwrite a destination
    to resolve it. Timestamp fields absent from the old schema become null.
    History digests change; [to_json] includes every old-to-new history head. *)
val run
  :  sw:Eio.Switch.t
  -> fs:Eio.Fs.dir_ty Eio.Path.t
  -> random:_ Eio.Flow.source
  -> source:string
  -> destination:string
  -> (t, Problem.t) Result.t

(** Remove only an unpublished stage created by [run], after checking its exact
    owner token and allowlisted tree. Unexpected entries cause refusal before any
    deletion. Neither the original source nor a published destination is removed. *)
val cleanup
  :  fs:Eio.Fs.dir_ty Eio.Path.t
  -> stage:string
  -> owner_token:string
  -> (unit, Problem.t) Result.t
