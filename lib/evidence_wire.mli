open Core

(** Public exact provenance pins. Wire objects use a [kind] discriminator;
    durable evidence retains its own tagged representation. *)
val pin : Evidence_event.Pin.t Api_codec.t

val validate_pin : Evidence_event.Pin.t -> (unit, Problem.t) Result.t
val manifest_ref : Evidence_event.Manifest_ref.t Api_codec.t
val artifact : Evidence_event.Artifact.t Api_codec.t
val contract_ref : Evidence_event.Contract_ref.t Api_codec.t
val resource_pin : Evidence_event.Resource_pin.t Api_codec.t
val attribution : Evidence_event.Attribution.t Api_codec.t
val entity_ref : Entity_ref.t Api_codec.t
val verdict : Evidence_event.Review.Verdict.t Api_codec.t
val contract : Evidence_event.Contract.t Api_codec.t
val manifest : Evidence_event.Manifest.t Api_codec.t
val policy : Evidence_event.Policy.t Api_codec.t
val submission : Evidence_event.Submission.t Api_codec.t
val review : Evidence_event.Review.t Api_codec.t
val validation : Evidence_event.Validation.t Api_codec.t
val decision : Evidence_event.Decision.t Api_codec.t
val reconciliation : Evidence_event.Reconciliation.t Api_codec.t
