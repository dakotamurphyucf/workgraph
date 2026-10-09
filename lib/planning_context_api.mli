open Core

module Query : sig
  module Filter : sig
    type t =
      { text : string option
      ; project_id : Id.Project.t option
      ; milestone_id : Id.Milestone.t option
      ; status : Workflow.Category.t option
      ; assignee_id : Id.Actor.t option
      ; label_id : Id.Label.t option
      ; priority : int option
      }
  end

  module Search_kind : sig
    type t =
      | Workspace
      | Project
      | Milestone
      | Ticket
      | Comment
      | Handoff
      | Resource
      | Resource_text
      | Fact
  end

  type t =
    | Activity_since of
        { after : int
        ; target : Entity_ref.t option
        ; actor_id : Id.Actor.t option
        }
    | Search of
        { text : string
        ; project_id : Id.Project.t option
        ; target : Entity_ref.t option
        ; kinds : Search_kind.t list option
        }
    | Workspace_overview of
        { actor_id : Id.Actor.t option
        ; run_id : Id.Run.t option
        }
    | Project_brief of Id.Project.t
    | Ticket_context of Id.Ticket.t
    | Ticket_list of Filter.t
    | Ticket_ready of Filter.t
    | Ticket_readiness of Id.Ticket.t
    | Ticket_blockers of Id.Ticket.t
    | Ticket_resolve of string
    | Handoff_get of Id.Ticket.t
    | Handoff_history of Id.Ticket.t

  type request

  val query : request -> t
  val offset : request -> int
  val limit : request -> int
  val at_revision : request -> int option
  val include_archived : request -> bool
  val max_bytes : request -> int
  val decode : method_:string -> params:Jsonaf.t -> (request, Problem.t) Result.t
end

(** Actual declarations generate public schema and execute runtime decoding/result
    validation. Optional null rejects. Public selectors resolve literal IDs only. *)
val methods : Api_method.Packed.t list

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option
val validate_result : method_:string -> Jsonaf.t -> unit
