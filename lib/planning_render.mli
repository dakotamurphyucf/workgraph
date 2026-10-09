open Core

(** Private lazy export renderer. The sequence retains its immutable snapshot and
    yields one file at a time; it never writes files or observes later changes. *)
val readable_files : Planning_state.t -> (string * string) Sequence.t
