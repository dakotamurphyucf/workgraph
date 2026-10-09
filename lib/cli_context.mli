open Core

(** Explicit agent-local defaults. No current ticket or process-global actor.
    Paths must be absolute; identities are validated on decoding. *)
type t

val of_json : Jsonaf.t -> (t, Problem.t) Result.t
val to_json : t -> Jsonaf.t
val socket : t -> string
val request_directory : t -> string option

(** Inserts missing scope/attribution defaults admitted by executable schemas.
    Read methods receive only the workspace default: actor/run query filters and
    target identities remain explicit. Write methods receive applicable actor/run
    defaults, including actor-owned upload staging. Local upload/download helpers
    have explicit scope rules; unknown methods receive no defaults. Explicit fields
    always win. *)
val apply
  :  t
  -> method_:string
  -> fields:(string * Jsonaf.t) list
  -> (string * Jsonaf.t) list

(** Reading uses Eio. *)
val load : fs:_ Eio.Path.t -> string -> (t, Problem.t) Result.t

(** Publish complete synchronized bytes atomically without replacing an existing
    context. Readers never observe a partly written published file. A random
    private sibling stages the bytes; cancellation and unexpected errors propagate. *)
val save
  :  t
  -> fs:_ Eio.Path.t
  -> random:_ Eio.Flow.source
  -> string
  -> (unit, Problem.t) Result.t
