open Core

(** Private pure projection. Fold retained committed changes in transaction/order
    order; no I/O, new events, model inference or global clock. Unknown/malformed
    or regressed timestamps disclose unavailable intervals instead of zero time.
    Linear in retained audit changes; transient indexing is proportional to tickets.
    This diagnostic does not cache another authoritative history or scan disk. *)
val capture : Planning_state.t -> observed_unix_ms:int64 -> Workspace_metrics.Planning.t
