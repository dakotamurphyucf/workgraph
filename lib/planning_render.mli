open Core

(** Private lazy export renderer. The sequence retains its immutable snapshot and
    yields one file at a time; it never writes files or observes later changes.
    Ticket handoffs include all recorded fields and exact resource references.
    Project/ticket discussion versions retain attribution, order and raw audit
    metadata alongside literal readable text; tombstones are explicit. *)
val readable_files : Planning_state.t -> (string * string) Sequence.t
