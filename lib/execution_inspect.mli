open Core

module Stream : sig
  type t =
    | Stdout
    | Stderr
  [@@deriving equal, sexp]
end

module Selection : sig
  type t

  (** Byte offsets count retained prefix bytes, not characters. Length is
      1..65536 bytes; an offset beyond retained output rejects. *)
  val range : offset:int -> length:int -> (t, Problem.t) Result.t

  (** The suffix of retained bytes only. A truncated capture cannot reveal the
      final process tail; inspection explicitly labels that unavailable suffix. *)
  val tail : length:int -> (t, Problem.t) Result.t
end

type t

(** Pure bounded view. No execution, publication or acceptance inference.
    Text rendering replaces malformed UTF8 visibly and labels loss; raw bytes
    and JSON base64 retain the exact selected bytes. Metadata discloses retained
    versus observed bytes, EOF, omissions and before/after provenance coverage. *)
val create
  :  Execution_capture.t
  -> stream:Stream.t
  -> selection:Selection.t
  -> (t, Problem.t) Result.t

val bytes : t -> string
val to_json : t -> Jsonaf.t
val to_text : t -> string
