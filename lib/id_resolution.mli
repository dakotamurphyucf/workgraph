open Core

module Kind : sig
  type t =
    | Project
    | Milestone
    | Ticket
    | Comment
    | Resource
end

(** Fill omitted creation IDs, including batch aliases, before pure command
    decoding. Explicit IDs/nulls remain untouched. Resource IDs are generated only
    for expected_revision zero. The service supplies secure randomness AFTER
    checking the original request's durable receipt; generated IDs are persisted
    in resolved events/results, never included in the original request hash. *)
val resolve
  :  method_:string
  -> params:Jsonaf.t
  -> fresh:(Kind.t -> string)
  -> (Jsonaf.t, Problem.t) Result.t
