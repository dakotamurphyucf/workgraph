(** Immutable static assets embedded at build time. No filesystem reads or mutable
    state are involved; values may be shared between domains. All paths are exact
    absolute HTTP paths from the validated build manifest. *)

type t =
  { path : string
  ; content_type : string
  ; sha256 : string
  ; body : string
  }

(** Exact path lookup. No normalization, decoding or SPA fallback is performed.
    The HTTP router owns route policy and bootstrap capability substitution. *)
val find : string -> t option

(** Assets in bytewise path order. The list and its strings are immutable. *)
val all : t list

(** SHA256 of the exact canonical manifest bytes embedded below. *)
val manifest_sha256 : string

val manifest_json : string

(** Literal marker appearing exactly once in /index.html, in a meta content
    attribute. The router must substitute its validated per-launch capability
    before serving no-store bootstrap HTML; never serve the unsubstituted body. *)
val capability_marker : string
