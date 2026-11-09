open Core
open Workgraph

type t =
  { actor : Id.Actor.t
  ; run : Id.Run.t option
  }

let create ~actor ~run = { actor; run }
let actor t = t.actor
let run t = t.run

let to_json t =
  Json.obj
    [ "actor_id", Id.Actor.jsonaf_of_t t.actor
    ; "run_id", Option.value_map t.run ~default:`Null ~f:Id.Run.jsonaf_of_t
    ]
;;

let of_json value =
  Json.decode (fun () ->
    Json.fields value ~allowed:[ "actor_id"; "run_id" ];
    let actor = Id.Actor.t_of_jsonaf (Json.field value "actor_id") in
    let run =
      match Json.field value "run_id" with
      | `Null -> None
      | value -> Some (Id.Run.t_of_jsonaf value)
    in
    create ~actor ~run)
;;
