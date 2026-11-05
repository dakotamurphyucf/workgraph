open Core

(** Offline capability discovery. Searches curated descriptions, not workspace
    content. No schemas, filesystem reads, network calls or side effects. *)
module Kind : sig
  type t =
    | Method
    | Helper
    | Workflow
  [@@deriving sexp, equal]

  val to_string : t -> string
  val of_string : string -> (t, Problem.t) Result.t
end

(** Complete metadata for documentation generation. This deliberately explicit
    operation is not the bounded search response; executable schemas remain in
    [Api_catalog]. *)
val catalog : unit -> Jsonaf.t

(** Reject duplicate/missing descriptions, uncovered groups, and dangling method,
    capability or workflow references. Documentation checks validate file paths.
    Expected to run in tests, not on each user query. *)
val validate : unit -> (unit, string list) Result.t

(** Deterministic keyword ranking, with curated synonyms and exact-name priority.
    Query must be nonblank UTF-8 of at most 1024 bytes; limit is 1..20 (default 5).
    Unknown filters reject. Zero lexical matches returns an empty successful
    response. Truncation is disclosed through counts and [has_more]; search never
    claims semantic completeness or chooses an operation for the caller. *)
val search
  :  ?capability:string
  -> ?kind:Kind.t
  -> ?limit:int
  -> query:string
  -> unit
  -> (Jsonaf.t, Problem.t) Result.t

val render_search : Jsonaf.t -> string
val capabilities : string option -> (Jsonaf.t, Problem.t) Result.t
val render_capabilities : Jsonaf.t -> string

(** Group card for the top-level prefix, or an exact workflow recipe. [None]
    leaves unknown names to the CLI's ordinary not-found handling. *)
val group_help : string -> string option

val workflow_help : string -> string option
