open Core

(** Local canonical template publication. The only I/O capability is one read-only
    capture. The returned transaction is frozen before journal publication and
    submission; exact saved retries do not run this helper or reread latest state. *)
type t

(** Typed literal Spec, required template_id/title/expected_revision (resource
    metadata guard), workspace/actor attribution and optional run/mutation identity.
    Reject aliases, unknown/duplicate fields and invalid graphs before any fetch. *)
val of_params : Jsonaf.t -> (t, Problem.t) Result.t

(** Fetch resource.get once. A missing resource plus guard zero selects content
    version one; an existing resource must match its metadata guard. Content version
    advances independently from metadata revision. Prepare one transaction.apply
    containing canonical resource.put_text then template.register with exact digest
    and content version. No write, fallback, identity generation or retry occurs.
    Caller saves and executes the returned request through ordinary CLI machinery.
    Expected Problems propagate; cancellation and unexpected exceptions propagate. *)
val prepare
  :  t
  -> fetch:(Protocol.Request.t -> (Jsonaf.t, Problem.t) Result.t)
  -> (Protocol.Request.t, Problem.t) Result.t
