open Core

(** Current executable public projections. Durable Registry, Export_job and
    Restore_plan codecs remain independent. These codecs validate on both decode
    and encode; receipt bodies and export captures remain complete. *)
val capture : Export_job.Capture.t Api_codec.t

val export_job : Export_job.t Api_codec.t
val path : string Api_codec.t
val digest : string Api_codec.t

(** Fixed Boolean response flags; validates their exact value. *)
val flag : bool -> unit Api_codec.t

module Health : sig
  module Workspace : sig
    type t =
      { workspace : Id.Workspace.t
      ; root : string
      ; archived : bool option
      ; is_open : bool
      ; open_intent : bool
      ; error : Problem.t option
      ; capacity : Admission.Summary.t option
      }

    val create
      :  workspace:Id.Workspace.t
      -> registration:Registry.Registration.t
      -> archived:bool option
      -> is_open:bool
      -> error:Problem.t option
      -> capacity:Admission.Summary.t option
      -> t
  end

  type t =
    { registry_requires_restart : bool
    ; pending_creates : int
    ; pending_restores : int
    ; active_exports : int
    ; workspaces : Workspace.t list
    }

  (** Immutable registry capture with caller-supplied current loaded/error status.
      The callback must describe the same serialized dispatcher capture. *)
  val capture
    :  Registry.t
    -> registry_requires_restart:bool
    -> active_exports:int
    -> workspace_status:
         (Id.Workspace.t
          -> bool option * bool * Problem.t option * Admission.Summary.t option)
    -> t

  val codec : t Api_codec.t
end

module Receipt : sig
  type t =
    | Absent
    | Pending
    | Committed of
        { request_hash : string
        ; response : Api_response.t
        }

  val registry : Registry.t -> key:string -> t
  val planning : request_hash:string -> response:Jsonaf.t -> t

  (** Saved committed responses must confirm durability. No response field is
      clipped or substituted; registry pending intents remain distinguishable. *)
  val codec : t Api_codec.t

  val planning_codec : t Api_codec.t
end

module Restore : sig
  module Target : sig
    type t =
      { root : string
      ; capture : Export_job.Capture.t
      }
  end

  type t =
    | Installed of Target.t list
    | Canceled

  val of_plan : Restore_plan.t -> t
  val codec : t Api_codec.t
end

module Verification : sig
  type t =
    { workspace : Id.Workspace.t
    ; revision : int
    ; head : string option
    }

  val of_verified : Snapshot.Verified.t -> t
  val codec : t Api_codec.t
end

module Export_page : sig
  type t =
    { items : Export_job.t list
    ; offset : int
    ; remaining : int
    ; next_offset : int option
    }

  val codec : t Api_codec.t

  (** Return the Snapshot_read internal envelope, including exact budget metadata.
      Offset counts complete jobs; nonzero offset requires the current listing
      hash. Budgets cover the public data/meta envelope (4096..1048576 bytes).
      An oversized first job fails Invalid_argument; increase max_bytes. *)
  val response
    :  Registry.t
    -> offset:int
    -> limit:int
    -> max_bytes:int
    -> at_snapshot:string option
    -> (Jsonaf.t, Problem.t) Result.t
end
