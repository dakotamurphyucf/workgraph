open Core

(** Render untrusted text literally, choosing a fence longer than any backtick
    run in the content. Preserve the input bytes; add a separating newline when
    needed so the closing fence remains syntactically distinct. No I/O. *)
val literal : string -> string

(** A fixed application-owned section heading and a literal text body. Empty
    bodies remain visible as an explicit absence of recorded content. *)
val section : heading:string -> string -> string
