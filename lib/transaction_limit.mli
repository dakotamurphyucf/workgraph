(** Shared planning transaction admission bound (128 operations), counting submitted
    operations and all mutations expanded by workflow templates. Request, receipt
    and template codecs use this same count. Independent byte, event and retained
    state limits still apply. *)
val max_operations : int
