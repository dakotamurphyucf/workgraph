open Core

(** Current application and affected durable-root identities. Only these current
    representations are supported; this is not a migration or compatibility layer.
    Unchanged independent formats (for example history batches) keep their own IDs. *)
type t =
  | Application_api
  | Registry
  | Workspace
  | Planning_transaction
  | Planning_events
  | Workspace_export
  | Registry_export
  | Planning_head
  | History_head
  | History_batch
  | Upload_plan
  | Heartbeat_cache
[@@deriving sexp, equal]

val identifier : t -> string
val field : t -> string
val value : t -> Jsonaf.t

(** Inspect only the format field before interpreting version-dependent contents.
    Missing or unsupported string identifiers return Unsupported_version with
    representation/observed/supported details. Duplicate markers, non-object roots
    and non-string markers are Invalid_argument. No I/O or mutation occurs. *)
val validate : t -> Jsonaf.t -> (unit, Problem.t) Result.t
