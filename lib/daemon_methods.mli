open Core

module Initialization : sig
  type t =
    { workgraph_api : string
    ; max_frame_bytes : int
    ; name : string
    ; version : string
    ; administrative_receipts : bool
    ; workspace_receipts : bool
    ; registry_format_version : int
    ; background_exports : bool
    }

  val current : unit -> t
end

val initialize : (unit, Initialization.t) Api_method.t
val shutdown : (unit, bool) Api_method.t

(** The same definitions used for routing, effect classification and discovery. *)
val methods : Api_method.Packed.t list

val find : string -> Api_method.Packed.t option
