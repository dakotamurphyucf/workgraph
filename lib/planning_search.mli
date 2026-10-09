open Core

(** Private in-memory search source selection. Filesystem adapters supply bounded
    immutable resource prefixes; this module does not read files or mutate state.
    Internal document construction raises Json.Decode_error for invalid filters. *)
val search_resources
  :  Planning_state.t
  -> params:Jsonaf.t
  -> (Resource.t list, Problem.t) Result.t

val search_documents
  :  Planning_state.t
  -> params:Jsonaf.t
  -> resource_texts:Search.Text.t list
  -> Search.Document.t list

(** Shared filters used by the query's coverage diagnostics. *)
val search_scope : Planning_state.t -> Jsonaf.t -> Entity_ref.t -> bool

val search_kinds : Jsonaf.t -> string list option
val searchable_text : string -> bool
