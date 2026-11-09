open Core

(** Private personal view sources/preferences only; never daemon authority.
    One Eio-domain owner serializes metadata publication under its mutex. State_root
    performs bounded native I/O through existing Eio/Platform adapters. Fixed safe
    metadata name; no configuration-supplied filesystem paths. *)
type t

module Target : sig
  type t

  val create : connection:Connection_profile.t -> workspace:Workgraph.Id.Workspace.t -> t
  val to_json : t -> Jsonaf.t
end

module Document : sig
  type t

  (** Source is opaque valid UTF-8 text <=64 KiB. Unknown configuration versions
      remain preservable. The browser's typed validator owns activation; storing
      source never executes or publishes it. IDs are unique within a target. *)
  val create
    :  id:Workgraph.Id.Resource.t
    -> source:string
    -> (t, Workgraph.Problem.t) Result.t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Snapshot : sig
  type t

  (** Global private CAS revision, distinct from resource/content/planning guards.
      Result retains the exact target and only that target's personal documents. *)
  val revision : t -> int

  val documents : t -> Document.t list
  val selected_id : t -> Workgraph.Id.Resource.t option
  val to_json : t -> Jsonaf.t
end

(** Load current format only; corrupt/unsupported state is never empty/reset.
    At most 25 stored documents globally, each 64 KiB source; actual canonical
    metadata envelope <=2 MiB, including target/projection escaping overhead. *)
val create : State_root.t -> (t, Workgraph.Problem.t) Result.t

(** Explicit bounded inventory of all nonempty saved targets (at most 25), their
    document IDs and global CAS revision. Retains original endpoint association;
    does not retarget, delete or activate. Lets an operator inspect/remove old
    generation preferences using the ordinary exact-target CAS. *)
val list : t -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Explicit current private read/reconciliation. Publication errors fence writes
    until a successful read revalidates durable bytes. Does not rewrite or save. *)
val read : t -> Target.t -> (Snapshot.t, Workgraph.Problem.t) Result.t

(** Explicit CAS replacement of this exact retained endpoint/workspace bucket.
    Other target buckets remain unchanged. expected_revision comes from the
    captured Snapshot; 0 is admitted only at initial global store revision 0.
    selected_id must name a supplied document or be None. Capacity/conflicts are
    expected errors. On post-install sync failure, retain original request/draft;
    inspect explicitly before a deliberate new CAS. No guard refresh or retry.
    Unexpected exceptions/cancellation propagate with write uncertainty fenced. *)
val replace
  :  t
  -> Target.t
  -> expected_revision:int
  -> documents:Document.t list
  -> selected_id:Workgraph.Id.Resource.t option
  -> (Snapshot.t, Workgraph.Problem.t) Result.t
