open Core

(** Curated offline discovery text. These records describe choices, not executable
    request schemas or permission policy. IDs and links are checked against the
    executable catalog by discovery validation. Reference paths are relative to
    the installed Workgraph skill folder. No I/O or daemon dependency. *)
module Capability : sig
  type t =
    { id : string
    ; title : string
    ; summary : string
    ; groups : string list
    ; reference : string
    }
end

module Group : sig
  type t =
    { id : string
    ; summary : string
    ; use_when : string
    ; distinction : string
    ; start_with : string list
    ; reference : string
    }
end

module Method : sig
  type t =
    { name : string
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; related : string list
    }
end

module Helper : sig
  type t =
    { name : string
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; capability : string
    ; effect_summary : string
    ; reference : string
    }
end

module Workflow : sig
  type t =
    { id : string
    ; title : string
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; capability : string
    ; steps : string list
    ; methods : string list
    ; reference : string
    }
end

val capabilities : Capability.t list
val groups : Group.t list
val methods : Method.t list
val helpers : Helper.t list
val workflows : Workflow.t list
val find_method : string -> Method.t option
