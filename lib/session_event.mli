open Core

module Blob_ref : sig
  type t = private
    { digest : string
    ; size_bytes : int
    }
  [@@deriving sexp, equal]

  val create : digest:string -> size_bytes:int -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

module Resource_ref : sig
  type t = private
    { id : Id.Resource.t
    ; revision : int
    }
  [@@deriving sexp, equal]

  val create : id:Id.Resource.t -> revision:int -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

module Content : sig
  type t =
    | Inline of string
    | Blob of Blob_ref.t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

module Input : sig
  type t

  (** Opaque payload bytes are preserved verbatim, including invalid UTF-8.
      [searchable_text] is complete adapter-provided UTF-8 text, not a prefix.
      Absence is explicitly reported as unsearchable. Inputs <=16MiB total;
      text/payload existing blobs may each be <=64MiB. Metadata <=4KiB. *)
  val create
    :  client_id:string
    -> role:string
    -> kind:string
    -> phase:string
    -> ?correlation:string
    -> ?provenance:Jsonaf.t
    -> payload:Content.t
    -> ?searchable_text:Content.t
    -> ?resource_versions:Resource_ref.t list
    -> attachments:Blob_ref.t list
    -> unit
    -> (t, Problem.t) Result.t

  val role : t -> string
  val kind : t -> string
  val phase : t -> string
  val correlation : t -> string option
  val provenance : t -> Jsonaf.t
  val payload : t -> Content.t
  val searchable_text : t -> Content.t option
  val attachments : t -> Blob_ref.t list
  val client_id : t -> string
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val identity_hash : t -> string
  val contents : t -> Content.t list
  val resource_versions : t -> Resource_ref.t list
end

type t

val commit
  :  Input.t
  -> ref_:Session.Event_ref.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> install:(Content.t -> Blob_ref.t)
  -> t

val input : t -> Input.t
val ref_ : t -> Session.Event_ref.t
val actor : t -> Id.Actor.t
val run : t -> Id.Run.t option
val client_id : t -> string
val identity_hash : t -> string
val payload : t -> Blob_ref.t
val searchable_text : t -> Blob_ref.t option
val attachments : t -> Blob_ref.t list
val resource_versions : t -> Resource_ref.t list
val kind : t -> string
val role : t -> string
val blob_references : t -> Blob_ref.t list
val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t
