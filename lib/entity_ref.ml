open Core

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
    (("kind", Json.string kind) :: Option.to_list (Option.map id ~f:(fun id -> "id", id)))
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
