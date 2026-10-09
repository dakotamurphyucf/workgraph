open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Revision = struct
  type t = int [@@deriving sexp]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Entity_ref = struct
  type t =
    | Workspace
    | Project of Id.Project.t
    | Milestone of Id.Milestone.t
    | Ticket of Id.Ticket.t
    | Resource of Id.Resource.t
  [@@deriving sexp, equal, compare]

  include Comparator.Make (struct
      type nonrec t = t

      let compare = compare
      let sexp_of_t = sexp_of_t
    end)

  let jsonaf_of_t t =
    let kind, id =
      match t with
      | Workspace -> "workspace", None
      | Project id -> "project", Some (Id.Project.jsonaf_of_t id)
      | Milestone id -> "milestone", Some (Id.Milestone.jsonaf_of_t id)
      | Ticket id -> "ticket", Some (Id.Ticket.jsonaf_of_t id)
      | Resource id -> "resource", Some (Id.Resource.jsonaf_of_t id)
    in
    Json.obj
      (("kind", Json.string kind)
       :: Option.to_list (Option.map id ~f:(fun id -> "id", id)))
  ;;

  let t_of_jsonaf value =
    Json.fields value ~allowed:[ "kind"; "id" ];
    let id () = Json.field value "id" in
    match Json.text (Json.field value "kind") with
    | "workspace" ->
      if Option.is_some (Json.optional value "id")
      then Json.fail Invalid_argument "workspace target has no ID field";
      Workspace
    | "project" -> Project (Id.Project.t_of_jsonaf (id ()))
    | "milestone" -> Milestone (Id.Milestone.t_of_jsonaf (id ()))
    | "ticket" -> Ticket (Id.Ticket.t_of_jsonaf (id ()))
    | "resource" -> Resource (Id.Resource.t_of_jsonaf (id ()))
    | _ -> Json.fail Invalid_argument "unknown target kind"
  ;;
end

module Workflow = struct
  module Category = struct
    type t =
      | Backlog
      | Todo
      | In_progress
      | Done
      | Canceled
    [@@deriving sexp, equal, jsonaf]

    let of_name = function
      | "backlog" -> Backlog
      | "todo" -> Todo
      | "in_progress" -> In_progress
      | "done" -> Done
      | "canceled" -> Canceled
      | _ -> Json.fail Invalid_argument "unknown status category"
    ;;

    let jsonaf_of_t t =
      Json.string
        (match t with
         | Backlog -> "backlog"
         | Todo -> "todo"
         | In_progress -> "in_progress"
         | Done -> "done"
         | Canceled -> "canceled")
    ;;

    let t_of_jsonaf json = of_name (Json.text json)
  end

  module Actor = struct
    type kind =
      | Person
      | Agent
    [@@deriving sexp, equal]

    let jsonaf_of_kind = function
      | Person -> Json.string "person"
      | Agent -> Json.string "agent"
    ;;

    let kind_of_jsonaf value =
      match Json.text value with
      | "person" -> Person
      | "agent" -> Agent
      | _ -> Json.fail Invalid_argument "unknown actor kind"
    ;;

    type t =
      { id : Id.Actor.t
      ; name : string
      ; kind : kind
      ; revision : Revision.t
      ; archived : bool
      }
    [@@deriving sexp, jsonaf]
  end

  module Label = struct
    type t =
      { id : Id.Label.t
      ; name : string
      ; description : string
      ; revision : Revision.t
      ; archived : bool
      }
    [@@deriving sexp, jsonaf]
  end

  module Status = struct
    type t =
      { id : Id.Status.t
      ; name : string
      ; category : Category.t
      ; revision : Revision.t
      ; archived : bool
      }
    [@@deriving sexp, jsonaf]
  end

  module Change = struct
    type t =
      | Actor of Actor.t
      | Label of Label.t
      | Status of Status.t
    [@@deriving sexp, jsonaf]
  end
end

module Domain_command = struct
  module Status = Workflow.Category
end

module Discussion = struct
  module Kind = struct
    type t =
      | Comment
      | Progress
      | Decision
      | Blocker
      | Evidence
    [@@deriving sexp, equal]

    let jsonaf_of_t t =
      Json.string
        (match t with
         | Comment -> "comment"
         | Progress -> "progress"
         | Decision -> "decision"
         | Blocker -> "blocker"
         | Evidence -> "evidence")
    ;;

    let t_of_jsonaf value =
      match Json.text value with
      | "comment" -> Comment
      | "progress" -> Progress
      | "decision" -> Decision
      | "blocker" -> Blocker
      | "evidence" -> Evidence
      | _ -> Json.fail Invalid_argument "unknown discussion kind"
    ;;
  end

  module Origin = struct
    type t =
      | Authored
      | Completion
    [@@deriving sexp, equal]

    let jsonaf_of_t = function
      | Authored -> Json.string "authored"
      | Completion -> Json.string "completion"
    ;;

    let t_of_jsonaf value =
      match Json.text value with
      | "authored" -> Authored
      | "completion" -> Completion
      | _ -> Json.fail Invalid_argument "unknown comment origin"
    ;;
  end

  module Version = struct
    type t =
      { revision : Revision.t
      ; serial : Revision.t
      ; sequence : Revision.t
      ; actor : Id.Actor.t
      ; timestamp : string
      ; body : string
      ; tombstone : bool
      }
    [@@deriving sexp, jsonaf]
  end

  module Change = struct
    type t =
      | Create of
          { id : Id.Comment.t
          ; target : Entity_ref.t
          ; reply_to : Id.Comment.t option
          ; kind : Kind.t
          ; origin : Origin.t
          ; version : Version.t
          }
      | Revise of
          { id : Id.Comment.t
          ; version : Version.t
          }
    [@@deriving sexp, jsonaf]
  end
end

module Resource = struct
  module Version = struct
    type t =
      { revision : Revision.t
      ; digest : string
      ; size_bytes : Revision.t option
      ; actor : Id.Actor.t
      ; timestamp : string
      ; filename : string
      ; mime_type : string
      }
    [@@deriving sexp, jsonaf]
  end

  module Metadata = struct
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
    ; revision : Revision.t
    ; metadata : Metadata.t
    ; versions : Version.t list
    }
  [@@deriving sexp, jsonaf]

  module Change = struct
    type t =
      | Published of
          { id : Id.Resource.t
          ; revision : Revision.t
          ; metadata : Metadata.t
          ; version : Version.t
          }
      | Metadata_changed of
          { id : Id.Resource.t
          ; revision : Revision.t
          ; metadata : Metadata.t
          }
    [@@deriving sexp, jsonaf]
  end
end

module Workspace_settings = struct
  type t =
    { description : string
    ; instructions : string
    ; summary : string
    ; revision : Revision.t
    ; name : string option
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Project = struct
  type t =
    { id : Id.Project.t
    ; title : string
    ; description : string
    ; revision : Revision.t
    ; status : Domain_command.Status.t
    ; priority : Revision.t
    ; summary : string
    ; acceptance_criteria : string
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Milestone = struct
  type t =
    { id : Id.Milestone.t
    ; project : Id.Project.t
    ; title : string
    ; description : string
    ; target_date : string option
    ; status : Domain_command.Status.t
    ; revision : Revision.t
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Claim = struct
  type t =
    { actor : Id.Actor.t
    ; run_id : Id.Run.t option
    ; token : Revision.t
    ; lease : Allocation_lease.t
    }
  [@@deriving sexp, jsonaf]
end

module Hold = struct
  type t =
    { actor : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Waiver = struct
  type t =
    { prerequisite : Id.Ticket.t
    ; actor : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Reassessment = struct
  type t =
    { prerequisite : Id.Ticket.t
    ; reopened_revision : Revision.t
    ; reason : string
    ; actor : Id.Actor.t
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Ticket = struct
  type t =
    { id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; description : string
    ; project : Id.Project.t option
    ; membership_revision : Revision.t
    ; parent : Id.Ticket.t option
    ; milestone : Id.Milestone.t option
    ; archived : bool
    ; status_id : Id.Status.t option
    ; priority : Revision.t
    ; assignee : Id.Actor.t option
    ; labels : Id.Label.t list
    ; acceptance_criteria : string
    ; status : Domain_command.Status.t
    ; revision : Revision.t
    ; hold : Hold.t option
    ; waivers : Waiver.t list
    ; prerequisites : Id.Ticket.t list
    ; related : Id.Ticket.t list
    ; claim : Claim.t option
    ; created_order : Revision.t
    ; reopened_token : Revision.t option
    ; reassessments : Reassessment.t list
    ; created_sequence : Revision.t
    ; created_at : string
    ; updated_at : string
    ; next_token : Revision.t
    }
  [@@deriving sexp, jsonaf]

  let decoded_t_of_jsonaf = t_of_jsonaf

  let t_of_jsonaf json =
    let ticket = decoded_t_of_jsonaf json in
    if ticket.membership_revision <= 0
    then Json.fail Invalid_argument "Ticket membership revision must be positive";
    ticket
  ;;

  let decoded_t_of_sexp = t_of_sexp

  let t_of_sexp sexp =
    let ticket = decoded_t_of_sexp sexp in
    if ticket.membership_revision <= 0
    then Sexplib.Conv.of_sexp_error "Ticket membership revision must be positive" sexp;
    ticket
  ;;
end

module Handoff = struct
  type t =
    { ticket : Id.Ticket.t
    ; actor : Id.Actor.t
    ; summary : string
    ; next_steps : string
    ; evidence : string
    ; revision : Revision.t
    ; objective : string
    ; completed : string
    ; decisions : string
    ; blockers : string
    ; resources : Id.Resource.t list
    ; timestamp : string
    ; covers_through : Revision.t
    }
  [@@deriving sexp, jsonaf]
end

module Event = struct
  type t =
    | Allocation_empty of
        { run : Id.Run.t
        ; attempt : Attempt.Id.t
        }
    | Settings_changed of Workflow.Change.t
    | Workspace_updated of Workspace_settings.t
    | Project_put of Project.t
    | Milestone_put of Milestone.t
    | Ticket_put of Ticket.t
    | Ticket_recovered of Ticket_recovery.t
    | Signal_receipt of External_condition.Repeat.t
    | Comment_changed of Discussion.Change.t
    | Handoff_put of Handoff.t
    | Resource_changed of Resource.Change.t
  [@@deriving sexp, jsonaf]
end

type t =
  { json : Jsonaf.t
  ; revision : int
  ; actor : string
  }

let to_json t = t.json
let revision t = t.revision
let actor t = t.actor

let of_json json =
  Json.decode (fun () ->
    (match Current_format.validate Planning_events json with
     | Ok () -> ()
     | Error p -> raise (Json.Decode_error p));
    Json.fields
      json
      ~allowed:[ "version"; "revision"; "actor"; "run_id"; "timestamp"; "changes" ];
    let revision = Json.integer (Json.field json "revision") in
    if revision < 1 || revision > 100_000
    then Json.fail Corrupt_store "event revision outside bounds";
    let actor = Id.Actor.t_of_jsonaf (Json.field json "actor") in
    let run = Option.map (Json.optional json "run_id") ~f:Id.Run.t_of_jsonaf in
    let timestamp = Json.bounded_text (Json.field json "timestamp") ~max_bytes:128 in
    let changes = Json.list (Json.field json "changes") in
    if List.is_empty changes || List.length changes > 10_064
    then Json.fail Corrupt_store "invalid event count";
    let attribution ~sequence ~event_actor ~event_run ~event_timestamp =
      if
        sequence <> revision
        || (not (Id.Actor.equal actor event_actor))
        || (not (Option.equal Id.Run.equal run event_run))
        || not (String.equal timestamp event_timestamp)
      then Json.fail Corrupt_store "extension event attribution differs from transaction"
    in
    (try
       List.iter changes ~f:(function
         | `Array [ `String "Facts_changed"; payload ] ->
           let change = Facts.Change.t_of_jsonaf payload in
           attribution
             ~sequence:(Facts.Change.sequence change)
             ~event_actor:(Facts.Change.actor change)
             ~event_run:(Facts.Change.run change)
             ~event_timestamp:(Facts.Change.timestamp change)
         | `Array [ `String "Comment_changed"; payload ] ->
           let version =
             match Discussion.Change.t_of_jsonaf payload with
             | Create { version; _ } | Revise { version; _ } -> version
           in
           attribution
             ~sequence:version.sequence
             ~event_actor:version.actor
             ~event_run:run
             ~event_timestamp:version.timestamp
         | `Array [ `String "Communication_changed"; payload ] ->
           let event = Communication_event.t_of_jsonaf payload in
           if event.version <> 1
           then Json.fail Unsupported_version "unsupported communication schema";
           attribution
             ~sequence:event.sequence
             ~event_actor:event.attribution.actor
             ~event_run:event.attribution.run
             ~event_timestamp:event.attribution.timestamp
         | `Array [ `String "Agent_run_changed"; payload ] ->
           let event = Agent_run_event.t_of_jsonaf payload in
           Agent_run_event.validate event;
           attribution
             ~sequence:event.sequence
             ~event_actor:event.actor
             ~event_run:event.actor_run
             ~event_timestamp:event.timestamp
         | `Array [ `String "Ticket_recovered"; payload ] ->
           let recovery = Ticket_recovery.t_of_jsonaf payload in
           attribution
             ~sequence:recovery.sequence
             ~event_actor:recovery.actor_id
             ~event_run:recovery.run_id
             ~event_timestamp:recovery.timestamp
         | `Array [ `String "Evidence_changed"; payload ] ->
           let event = Evidence_event.t_of_jsonaf payload in
           attribution
             ~sequence:event.sequence
             ~event_actor:event.attribution.actor
             ~event_run:event.attribution.run
             ~event_timestamp:event.attribution.timestamp
         | `Array [ `String ("Policy_changed" | "Policy_unchanged"); payload ] ->
           let event =
             match Agent_run_policy.Change.of_json payload with
             | Ok event -> event
             | Error error -> raise (Json.Decode_error error)
           in
           (match event.command with
            | Usage_report usage ->
              if not (Id.Actor.equal usage.actor actor)
              then Json.fail Corrupt_store "usage attribution differs from transaction"
            | Template_register _ | Instance_register _ | Budget_put _ -> ())
         | change -> ignore (Event.t_of_jsonaf change : Event.t))
     with
     | Jsonaf_kernel.Conv.Of_jsonaf_error (exn, _) ->
       Json.fail Corrupt_store (Exn.to_string exn));
    { json; revision; actor = Id.Actor.to_string actor })
;;
