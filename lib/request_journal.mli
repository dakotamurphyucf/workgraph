open Core

module Namespace : sig
  type t =
    | Registry
    | Planning of Id.Workspace.t
    | History of Id.Workspace.t
  [@@deriving equal, compare, sexp]
end

module Mutation : sig
  type t =
    { namespace : Namespace.t
    ; actor : Id.Actor.t
    ; mutation : Id.Mutation.t
    ; run : Id.Run.t option
    ; method_ : string
    ; request_hash : string
    }
end

module Entry : sig
  type t

  (** Validate a current-profile saved request without sending it or resolving
      aliases/generated IDs. A complete upload plan is validated without reading
      source bytes and exposes its distinct finish operation identity/hash. *)
  val create : Protocol.Request.t -> fs:_ Eio.Path.t -> (t, Problem.t) Result.t

  val mutation : t -> Mutation.t option

  (** Bounded metadata only, never payload bytes or commit evidence. Offline
      commit status is always unchecked; envelope hash differs from receipt hash. *)
  val to_json : t -> Jsonaf.t
end

(** Deterministic filename from canonical complete envelope bytes. A generated
    fresh mutation remains a fresh operation. No implicit identity adoption. *)
val path : Protocol.Request.t -> directory:string -> (string, Problem.t) Result.t

module Saved : sig
  type t =
    | Created
    | Reused
  [@@deriving equal, sexp]
end

(** Sync a fresh private stage, atomically publish without replacement, sync the
    parent before success. An existing regular winner is accepted only for exact
    full-envelope bytes, then re-synced. Regular hardlinks are permitted under the
    private immutable journal assumption. Different/partial/nonregular/symlink
    winners reject unchanged. No network; failures/cancellation retain installed/staged
    bytes, and cancellation/unexpected exceptions propagate. Never changes Disk's
    storage publication semantics. *)
val save
  :  Protocol.Request.t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> destination:string
  -> (Saved.t, Problem.t) Result.t

(** Re-verify and sync an existing exact request plus parent. Never creates a
    file or generates an identity; useful for recovery from an interrupted local
    save before transmission. Matching bytes and regular-file rules equal save. *)
val sync_existing
  :  Protocol.Request.t
  -> fs:_ Eio.Path.t
  -> destination:string
  -> (unit, Problem.t) Result.t

val inspect : string -> fs:_ Eio.Path.t -> (Entry.t, Problem.t) Result.t

module Page : sig
  type t

  (** Local scan observation, not a committed receipt or immutable directory
      snapshot. Duplicate/conflict groups cover only returned validated entries.
      Explicit incomplete/next_after fields preserve unreturned filenames. *)
  val to_json : t -> Jsonaf.t
end

(** Sorted nonrecursive .json files; a private directory may contain at most
    10000 names. limit is 1..1000 entries; max_bytes is aggregate input bytes,
    4..64MiB, each file at most 4MiB. Output is capped at 1MiB. Invalid files have
    per-file diagnostics; symlinks/special files reject. If a read fails under a
    reduced remaining input budget, the page stops before that filename; resuming
    after next_after retries it with the full budget. after is an explicit
    basename cursor. Concurrent changes can require restarting the observation. *)
val list
  :  string
  -> fs:_ Eio.Path.t
  -> after:string option
  -> limit:int
  -> max_bytes:int
  -> (Page.t, Problem.t) Result.t
