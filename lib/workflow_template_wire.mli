open Core

(** Current public template and expansion values. [spec] also describes the
    canonical resource asset; its graph aliases and parameters are literal names.
    Decoding validates graph/limits; templates recompute and validate their digest. *)
val spec : Workflow_template.Spec.t Api_codec.t

val template : Workflow_template.t Api_codec.t
val planned_ticket : Workflow_template.Planned_ticket.t Api_codec.t
val instance : Workflow_template.Instance.t Api_codec.t

module Raw : sig
  (** Same structural declarations with explicit entity ID/$alias references;
      only actor/ticket/template/instance entity references admit aliases. *)
  val spec : Jsonaf.t Api_codec.t

  val instance : Jsonaf.t Api_codec.t
end
