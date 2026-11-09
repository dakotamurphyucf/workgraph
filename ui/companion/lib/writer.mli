open Core

type t

val create : actor:Workgraph.Id.Actor.t -> run:Workgraph.Id.Run.t option -> t
val actor : t -> Workgraph.Id.Actor.t
val run : t -> Workgraph.Id.Run.t option
val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
