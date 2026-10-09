open Core

(** Public transport values are independent of journal encodings. Opaque inline
    content is base64 encoded and never parsed or normalized; searchable inline
    text remains validated UTF-8 by [Session_event.Input.create]. *)
val event_ref : Session.Event_ref.t Api_codec.t

val blob_ref : Session_event.Blob_ref.t Api_codec.t
val resource_ref : Session_event.Resource_ref.t Api_codec.t
val scope : Entity_ref.t Api_codec.t
val content : Session_event.Content.t Api_codec.t
val input : Session_event.Input.t Api_codec.t
val session : Session.t Api_codec.t
val event : Session_event.t Api_codec.t
val session_json : Session.t -> Jsonaf.t
val event_json : Session_event.t -> Jsonaf.t
