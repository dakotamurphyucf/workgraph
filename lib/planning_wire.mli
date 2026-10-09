open Core

(** Typed current public views, independent of private snapshot/event encodings.
    Codecs validate every entry point, including direct record construction during
    encoding. Descriptive fields may be explicit budgeted prefixes; identities,
    revisions, status/category, dates and other non-descriptive values stay exact. *)
module Project : sig
  type t =
    { project_id : Id.Project.t
    ; title : string
    ; description : string
    ; revision : int
    ; status : Workflow.Category.t
    ; priority : int
    ; summary : string
    ; acceptance_criteria : string
    ; archived : bool
    }

  val codec : t Api_codec.t
end

module Milestone : sig
  type t =
    { milestone_id : Id.Milestone.t
    ; project_id : Id.Project.t
    ; title : string
    ; description : string
    ; target_date : string option
    ; status : Workflow.Category.t
    ; revision : int
    ; archived : bool
    }

  val codec : t Api_codec.t
end

module Workspace_settings : sig
  type t =
    { description : string
    ; instructions : string
    ; summary : string
    ; revision : int
    ; name : string option
    ; archived : bool
    }

  val codec : t Api_codec.t
end

module Workspace : sig
  type t =
    { name : string
    ; settings : Workspace_settings.t
    }

  val codec : t Api_codec.t
end

module Actor : sig
  type t =
    { actor_id : Id.Actor.t
    ; name : string
    ; kind : Workflow.Actor.kind
    ; revision : int
    ; archived : bool
    }

  val codec : t Api_codec.t
  val of_domain : Workflow.Actor.t -> t
end

module Label : sig
  type t =
    { label_id : Id.Label.t
    ; name : string
    ; description : string
    ; revision : int
    ; archived : bool
    }

  val codec : t Api_codec.t
  val of_domain : Workflow.Label.t -> t
end

module Status : sig
  type t =
    { status_id : Id.Status.t
    ; name : string
    ; category : Workflow.Category.t
    ; revision : int
    ; archived : bool
    }

  val codec : t Api_codec.t
  val of_domain : Workflow.Status.t -> t
end

module Progress : sig
  (** Nonnegative counts; done and blocked each never exceed total. *)
  type t =
    { total : int
    ; done_ : int
    ; blocked : int
    }

  val codec : t Api_codec.t
end

module Page : sig
  (** Ordered selected records with retained total tail count. A nonempty tail
      requires next_offset=offset+returned count. Budget fitting may drop a page
      suffix; it never returns an empty first oversized item as success. *)
  type 'a t =
    { items : 'a list
    ; offset : int
    ; remaining : int
    ; next_offset : int option
    }

  val codec : 'a Api_codec.t -> 'a t Api_codec.t
end

module Milestone_read : sig
  type t =
    { milestone : Milestone.t
    ; progress : Progress.t
    }

  val codec : t Api_codec.t
end

module Response : sig
  type t =
    | Workspace of Workspace.t
    | Project of Project.t
    | Projects of Project.t Page.t
    | Milestone of Milestone_read.t
    | Milestones of Milestone.t Page.t
    | Actors of Actor.t Page.t
    | Labels of Label.t Page.t
    | Statuses of Status.t Page.t

  (** Exact data projection. Invalid constructed programmer values raise
      Api_method.Invalid_response rather than become ordinary domain failures. *)
  val data : t -> Jsonaf.t

  (** Produce the private planning-read envelope with final public byte accounting.
      Only declared description/instructions/summary/acceptance_criteria fields
      and page-item suffixes may shorten. Identity, title/name, counters, dates,
      status/category and progress stay exact. Returns actionable Invalid_argument
      if essential metadata or the first item cannot fit. No recursive generic
      trim runs over canonical records. *)
  val fit : t -> workspace_revision:int -> max_bytes:int -> (Jsonaf.t, Problem.t) Result.t
end
