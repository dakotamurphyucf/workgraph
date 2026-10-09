open Core

module Source : sig
  type t =
    | Workspace of Id.Workspace.t
    | Project of Id.Project.t
    | Milestone of Id.Milestone.t
    | Ticket of Id.Ticket.t
    | Comment of Id.Comment.t
    | Handoff of Id.Ticket.t
    | Resource of Id.Resource.t
    | Resource_text of Id.Resource.t
    | Fact of
        { scope : Entity_ref.t
        ; key : string
        }
  [@@deriving sexp, compare]

  val kind : t -> string
  val json : t -> revision:int -> Jsonaf.t
end

module Document : sig
  type t =
    { source : Source.t
    ; target : Entity_ref.t
    ; revision : int
    ; fields : (string * string) list
    }
end

module Text : sig
  type outcome =
    | Content of
        { text : string
        ; total_bytes : int
        }
    | Invalid_utf8

  type t =
    { id : Id.Resource.t
    ; version : int
    ; digest : string
    ; outcome : outcome
    }
end

val kinds : string list

type results =
  { items : Jsonaf.t list
  ; total : int
  }

(** ASCII case-insensitive substring matching. Stable source-kind/ID ordering;
    offsets count UTF-8 bytes in the source field, snippets are <=512 bytes. *)
val matches
  :  Document.t list
  -> text:string
  -> kinds:string list option
  -> offset:int
  -> limit:int
  -> results

(** Typed pure match results let public families construct their own exact views
    without parsing an intermediate JSON serializer. Matching order, byte offsets
    and snippet bounds are the same as [matches]. *)
module Match : sig
  type t =
    { field : string
    ; match_offset : int
    ; match_bytes : int
    ; snippet_offset : int
    ; snippet : string
    }
end

module Item : sig
  type t =
    { source : Source.t
    ; target : Entity_ref.t
    ; revision : int
    ; matches : Match.t list
    }
end

module Results : sig
  type t =
    { items : Item.t list
    ; total : int
    }
end

val typed_matches
  :  Document.t list
  -> text:string
  -> kinds:string list option
  -> offset:int
  -> limit:int
  -> Results.t
