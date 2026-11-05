open Core

(** Client-added single-page continuation metadata. This module has no dependency
    on the client, protocol dispatcher or method catalog, so common success codecs
    can validate its closed representation without a dependency cycle. *)
module Stop : sig
  type t =
    | Complete
    | Page_limit
    | Byte_limit
    | No_progress
    | Needs_larger_budget
    | Indexing_incomplete
    | Server_field_omissions
    | Server_item_omissions
    | Error
    | Metadata_limit
  [@@deriving equal, sexp]

  val to_string : t -> string
end

type t

module Section : sig
  type t =
    { path : string
    ; response_path : string option
    ; complete : bool
    ; stop : Stop.t
    ; next_request : Jsonaf.t option
    ; retry_request : Jsonaf.t option
    }

  (** [path] identifies the original section. [response_path], when present,
      identifies its collection in the next/retry response after switching to a
      dedicated listing method. Otherwise consume the same [path]. Requests
      retain the enclosing response's capture. *)
  val codec : t Api_codec.t
end

(** Independently paged nested collections. Top-level next/retry requests remain
    null. The entire metadata object shares the same 64KiB bound; overflow
    removes all sections and reports [Metadata_limit] without invented requests. *)
val create_sections
  :  consistency:string
  -> capture:Jsonaf.t
  -> sections:Section.t list
  -> (t, Problem.t) Result.t

(** Validate original exact request envelopes and family-specific captures. Wrong
    protocol versions and unknown envelope fields reject before encoding or size
    limiting. Canonical metadata bytes alone are capped at 65536, independently
    of daemon byte budgets.
    An oversized continuation becomes an explicit incomplete [Metadata_limit]
    marker with exact required byte count, preserving the original page rather
    than clipping a request or inventing a new capture. *)
val create
  :  complete:bool
  -> stop:Stop.t
  -> consistency:string
  -> capture:Jsonaf.t
  -> next_request:Jsonaf.t option
  -> retry_request:Jsonaf.t option
  -> (t, Problem.t) Result.t

val codec : t Api_codec.t
val complete : t -> bool
val stop : t -> Stop.t
val next_request : t -> Jsonaf.t option
val retry_request : t -> Jsonaf.t option
val to_json : t -> Jsonaf.t
