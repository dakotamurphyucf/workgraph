open Core

(** Complete retained family records. Named public object variants are independent
    of private Event arrays; immutable versions, frozen recipients, selected ack
    IDs, lease fences, digests and exact provenance are never budget-clipped. *)
val facts : Facts.Change.t Api_codec.t

val communication : Communication_event.t Api_codec.t
val agent_run : Agent_run_event.t Api_codec.t
val evidence : Evidence_event.t Api_codec.t
val policy : Agent_run_policy.Change.t Api_codec.t
val workflow : Workflow.Change.t Api_codec.t
val discussion : Discussion.Change.t Api_codec.t
val resource : Resource.Change.t Api_codec.t
