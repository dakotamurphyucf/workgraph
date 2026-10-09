open Core

(** Current public wire encoder for typed domain commands. Patch omission
    and nullable clears remain distinct. Aliases are already resolved in typed
    batches. Resource_publish is worker-internal and cannot be sent by a client;
    clients publish binary resources through the upload protocol instead.
    Encoding revalidates the public wire contract before returning parameters.
    Tombstone commands require an empty body; encoding never silently discards
    supplied comment text. *)
val encode : Domain_command.t -> (string * Jsonaf.t, Problem.t) Result.t
