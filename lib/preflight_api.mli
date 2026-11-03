open Core

module Request : sig
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; at_revision : int option
    ; operations : Planning_api.Operation.t list
    }

  (** The exact transaction.apply operation union and alias limits. Actor/run
      are explicit simulation inputs, not read filters or authentication.
      [at_revision] pins the observed planning state; it reserves nothing. *)
  val codec : t Api_codec.t
end

module Generated_id : sig
  type t =
    { kind : Id_resolution.Kind.t
    ; id : string
    }

  (** Provisional, unreserved identities used only to validate this preview. *)
  val codec : t Api_codec.t
end

module Response : sig
  type t =
    { workspace_revision : int
    ; proposed_revision : int
    ; operation_count : int
    ; generated_ids : Generated_id.t list
    ; staged_blob_count : int
    ; staged_blob_bytes : int64
    }

  (** A successful domain preparation, never a durable receipt. Blob totals
      describe staged entries, not incremental disk usage. This does not check
      filesystem health, Store commit admission or future eligibility. *)
  val codec : t Api_codec.t
end

val method_ : (Request.t, Response.t) Api_method.t
