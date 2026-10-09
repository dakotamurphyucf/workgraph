(** Canonical tagged actor/run recipient codec shared by messaging and inbox
    requests/results. Persistence remains owned by Communication_event. *)
val codec : Communication_event.Recipient.t Api_codec.t
