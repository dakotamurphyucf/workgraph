open Core

type t =
  | Workspace
  | Project of string
  | Milestone of string
  | Ticket of string
  | Resource of string

let reference =
  Api_codec.map
    (Api_codec.text ~max_bytes:97)
    ~decode:(fun value ->
      let key =
        if String.is_prefix value ~prefix:"$" then String.drop_prefix value 1 else value
      in
      Result.map (Id.Actor.of_string key) ~f:(fun _ -> value))
    ~encode:Fn.id
    ~description:"Opaque entity ID or transaction $alias."
;;

let tag name =
  Api_codec.Fields.required "kind" (Api_codec.enum [ name, () ] ~equal:Unit.equal)
;;

let branch name constructor project =
  Api_codec.object_
    (Api_codec.Fields.map
       (Api_codec.Fields.both (tag name) (Api_codec.Fields.required "id" reference))
       ~decode:(fun ((), id) -> constructor id)
       ~encode:(fun value -> (), project value))
;;

let workspace =
  Api_codec.object_
    (Api_codec.Fields.map
       (tag "workspace")
       ~decode:(fun () -> Workspace)
       ~encode:(function
         | Workspace -> ()
         | _ -> Json.fail Invalid_argument "wrong target kind"))
;;

let cases =
  [ "workspace", workspace
  ; ( "project"
    , branch
        "project"
        (fun id -> Project id)
        (function
          | Project id -> id
          | _ -> Json.fail Invalid_argument "wrong target kind") )
  ; ( "milestone"
    , branch
        "milestone"
        (fun id -> Milestone id)
        (function
          | Milestone id -> id
          | _ -> Json.fail Invalid_argument "wrong target kind") )
  ; ( "ticket"
    , branch
        "ticket"
        (fun id -> Ticket id)
        (function
          | Ticket id -> id
          | _ -> Json.fail Invalid_argument "wrong target kind") )
  ; ( "resource"
    , branch
        "resource"
        (fun id -> Resource id)
        (function
          | Resource id -> id
          | _ -> Json.fail Invalid_argument "wrong target kind") )
  ]
;;

let select = function
  | Workspace -> "workspace"
  | Project _ -> "project"
  | Milestone _ -> "milestone"
  | Ticket _ -> "ticket"
  | Resource _ -> "resource"
;;

let codec = Api_codec.tagged ~discriminator:"kind" ~cases ~select

let scope_codec =
  Api_codec.tagged ~discriminator:"kind" ~cases:(List.take cases 4) ~select
;;

let to_ref = function
  | Workspace -> Ok Entity_ref.Workspace
  | Project id ->
    Result.map (Id.Project.of_string id) ~f:(fun id -> Entity_ref.Project id)
  | Milestone id ->
    Result.map (Id.Milestone.of_string id) ~f:(fun id -> Entity_ref.Milestone id)
  | Ticket id -> Result.map (Id.Ticket.of_string id) ~f:(fun id -> Entity_ref.Ticket id)
  | Resource id ->
    Result.map (Id.Resource.of_string id) ~f:(fun id -> Entity_ref.Resource id)
;;

let of_ref = function
  | Entity_ref.Workspace -> Workspace
  | Project id -> Project (Id.Project.to_string id)
  | Milestone id -> Milestone (Id.Milestone.to_string id)
  | Ticket id -> Ticket (Id.Ticket.to_string id)
  | Resource id -> Resource (Id.Resource.to_string id)
;;
