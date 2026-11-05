open Core

(** Exact audit traversal, independent of semantic [activity.digest]. Numeric
    [after] begins a capture; [cursor] resumes its immutable retained prefix and
    binds the target/actor selectors. They are mutually exclusive. Limit counts
    changes or chunks (1..100); budget counts the public result envelope bytes. *)
module Request : sig
  type t

  val codec : t Api_codec.t
  val after : t -> int option
  val cursor : t -> string option
  val target : t -> Entity_ref.t option
  val actor : t -> Id.Actor.t option
  val limit : t -> int
  val max_bytes : t -> int
end

(** A whole row contains exactly one original public audit change and all frozen
    source headers. An oversized row instead carries UTF8-safe byte slices of
    that same record's canonical JSON, never a lossy excerpt. SHA256, total bytes,
    zero-based change ordinal and byte offsets bind exact reassembly. Ranges are
    nonempty, contiguous and half open. Cursor never advances beyond unread bytes.
    Complete rows have offset zero and matching canonical byte count/digest. *)
module Row : sig
  type payload =
    | Change of Planning_activity_wire.Activity.t
    | Chunk of string

  type t =
    { revision : int
    ; change_index : int
    ; change_count : int
    ; byte_offset : int
    ; total_bytes : int
    ; digest : string
    ; payload : payload
    }

  val codec : t Api_codec.t
end

(** The first row may resume in the middle of a commit or chunk. Later rows
    must account for every intervening ordinal and byte; entering a later commit
    requires completing the earlier commit and starting at ordinal zero. A null
    cursor requires the final change of the final returned commit to be complete. *)
module Page : sig
  type t =
    { through : int
    ; lineage : string
    ; items : Row.t list
    ; cursor : string option
    ; remaining_changes : int
    }

  val codec : t Api_codec.t
end

val descriptor : Api_method.Packed.t
