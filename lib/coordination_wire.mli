open Core

(** Common executable scalar contracts for cooperative coordination records. *)
val id : (string -> ('a, Problem.t) Result.t) -> ('a -> string) -> 'a Api_codec.t

val counter : int Api_codec.t
val positive : int Api_codec.t
val nonblank : max_bytes:int -> string Api_codec.t
val checked : 'a Api_codec.t -> ('a -> unit) -> 'a Api_codec.t
val encode_exn : 'a Api_codec.t -> 'a -> Jsonaf.t
val decode_exn : 'a Api_codec.t -> Jsonaf.t -> 'a
val actor : Id.Actor.t Api_codec.t
val run : Id.Run.t Api_codec.t
val ticket : Id.Ticket.t Api_codec.t
val evidence : Evidence_event.Pin.t list Api_codec.t
