open Core

(** Lightweight observations, never inferred client-call counts or causal
    productivity. All durations are wall-clock observations, not CPU time. *)
module Status : sig
  type t =
    { status : Workflow.Category.t
    ; tickets : int
    ; elapsed_ms : int64
    ; closed_intervals : int
    ; open_intervals : int
    ; unknown_intervals : int
    ; overflow : bool
    }

  val codec : t Api_codec.t
end

module Usage : sig
  type t =
    { observations : int
    ; tokens : int64
    ; elapsed_ms : int64
    ; overflow : bool
    }

  val codec : t Api_codec.t

  (** Add validated disjoint reports. Overflow saturates and is disclosed.
      Invalid records raise [Json.Decode_error]; callers retain report identities. *)
  val of_records : Usage_record.t list -> t
end

module Planning : sig
  type t =
    { revision : int
    ; statuses : Status.t list
    ; completion_transitions : int
    ; reopenings : int
    ; completed_tickets_with_evidence : int
    ; tickets_with_recorded_manifest : int
    ; stored_assertions : int
    ; stored_accepted_submissions : int
    ; reported_usage : Usage.t
    ; admission : Admission.t list
    }
end

type t

val create
  :  Planning.t
  -> observed_unix_ms:int64
  -> history_head:string option
  -> storage_admission:Admission.t list
  -> (t, Problem.t) Result.t

val codec : t Api_codec.t

module Request : sig
  type t =
    { at_revision : int option
    ; max_bytes : int
    }

  val codec : t Api_codec.t
end

val method_ : (Request.t, t) Api_method.t

(** Final Planning_read envelope budget, including workspace metadata. *)
val response : t -> max_bytes:int -> (Jsonaf.t, Problem.t) Result.t
