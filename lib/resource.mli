open Core

module Version : sig
  type t =
    { revision : int
    ; digest : string
    ; size_bytes : int option
    ; actor : Id.Actor.t
    ; timestamp : string
    ; filename : string
    ; mime_type : string
    }
  [@@deriving sexp, jsonaf]
end

module Metadata : sig
  type t =
    { title : string
    ; filename : string
    ; mime_type : string
    ; description : string
    ; archived : bool
    ; targets : Entity_ref.t list
    }
  [@@deriving sexp, jsonaf]
end

type t =
  { id : Id.Resource.t
  ; revision : int
  ; metadata : Metadata.t
  ; versions : Version.t list
  }
[@@deriving sexp, jsonaf]

module Change : sig
  type t =
    | Published of
        { id : Id.Resource.t
        ; revision : int
        ; metadata : Metadata.t
        ; version : Version.t
        }
    | Metadata_changed of
        { id : Id.Resource.t
        ; revision : int
        ; metadata : Metadata.t
        }
  [@@deriving sexp, jsonaf]
end

(** Logical filenames are basenames, never filesystem paths. MIME strings contain
    one slash and no whitespace or control characters. No decoded record is
    trusted until [validate]/[apply]. These pure boundaries raise Json.Decode_error. *)
val validate_metadata : Metadata.t -> unit

val validate : t -> unit
val apply : t option -> Change.t -> t
val get_version : t -> revision:int option -> Version.t
val max_blob_bytes : int
