open Core

(** Read-only UI helpers. Neither module writes, generates mutation identities,
    reserves IDs, nor publishes an Operation_store journal. The caller supplies a
    read capability bound to one captured immutable connection generation.
    Cancellation and unexpected exceptions propagate from both helpers. *)
module Publication : sig
  type t

  (** Exact native Template_publication input, validated before the one capture. *)
  val of_params : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t

  (** Frozen native transaction.apply request. Ordinary operation preparation must
      journal it before explicit execution; retry/recovery never reruns this. *)
  val prepare
    :  t
    -> fetch:(Workgraph.Protocol.Request.t -> (Jsonaf.t, Workgraph.Problem.t) Result.t)
    -> (Workgraph.Protocol.Request.t, Workgraph.Problem.t) Result.t
end

module Instance_preview : sig
  type t

  type prepared =
    { template : Workgraph.Workflow_template.t
    ; instance : Workgraph.Workflow_template.Instance.t
    ; request : Workgraph.Protocol.Request.t
    }

  (** Native template.instantiate params with required [expected_digest] in
      addition to explicit workspace/actor and optional run/mutation attribution.
      Bindings are literal IDs: transaction aliases belong to native preflight,
      not this literal preview. Duplicate/unknown fields reject before I/O. *)
  val of_params : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t

  (** One template.get at the exact template ID/version with the maximum public
      query budget. Decode a complete native record; verify ID/version/digest;
      delegate substitution, deterministic IDs, gates, ordering and instance
      expansion limits to Workflow_template.instantiate. Oversized complete
      records remain explicit errors. Current domain guards and expanded count
      require native transaction.preflight, which reserves nothing. The frozen
      request remains template.instantiate: manually generated ticket.create
      records must not replace native instance registration. Cancellation and
      unexpected exceptions propagate. *)
  val prepare
    :  t
    -> fetch:(Workgraph.Protocol.Request.t -> (Jsonaf.t, Workgraph.Problem.t) Result.t)
    -> (prepared, Workgraph.Problem.t) Result.t

  val to_json : prepared -> Jsonaf.t
end
