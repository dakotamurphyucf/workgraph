open Core

(** Exact executable codecs for the base planning receipt data represented by
    current staging results. Transport metadata is composed by [Api_response].
    [None] identifies methods whose family receipt codec is not implemented yet;
    callers must not advertise a fabricated result schema for those methods. *)
val codec : method_:string -> Jsonaf.t Api_codec.t option

(** Actual planning views reused by bounded resume/digest records. Canonical
    projections and these codecs change together; callers do not copy schemas. *)
val ticket : Jsonaf.t Api_codec.t

val handoff : Jsonaf.t Api_codec.t
val ownership : Jsonaf.t Api_codec.t

(** Publish catalog changes as plain public records with canonical ID fields and
    lowercase actor kinds. Persisted [Workflow.Change] encoding is independent. *)
val settings : Workflow.Change.t -> (Jsonaf.t, Problem.t) Result.t

(** Canonical public template receipts. Each operation has a closed discriminator
    and validates the actual family receipt; instance storage encodings remain
    independent. Helpers reject malformed receipt data. *)
module Template : sig
  module Kind : sig
    type t =
      | Ticket_create
      | Dependency_add
      | Ticket_policy_put
      | Review_policy_put
      | Instance_register
  end

  val codec : Jsonaf.t Api_codec.t
  val operation : Kind.t -> data:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t

  val create
    :  Workflow_template.Instance.t
    -> results:Jsonaf.t list
    -> duplicate:bool
    -> (Jsonaf.t, Problem.t) Result.t

  val review_policy : Evidence.Policy.t -> (Jsonaf.t, Problem.t) Result.t
end
