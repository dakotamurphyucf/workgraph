open Core

(** Lazy readable projection of an immutable history capture. Each session has an
    index and pages of at most 100 events. Text previews retain at most 4096 UTF-8
    bytes per event; omitted bytes and links to complete portable blobs are explicit.
    [read_text] must verify the captured blob identity before returning up to the
    requested byte prefix. This module performs no filesystem I/O itself. *)
val files
  :  Session_store.Capture.t
  -> read_text:(Session_event.Blob_ref.t -> max_bytes:int -> string)
  -> (string * string) Sequence.t
