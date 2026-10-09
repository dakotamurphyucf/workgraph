open Core

(** Configured allocation bounds. Reported spending limits create attention;
    inference and process stopping remain the harness’s responsibility. *)
type t =
  { run : Id.Run.t
  ; revision : int
  ; max_attempts : int option
  ; max_active_attempts : int option
  ; reported_token_limit : int64 option
  ; reported_elapsed_ms_limit : int64 option
  }
[@@deriving sexp, equal]

(** Raises [Json.Decode_error] for a nonpositive revision/attempt limit or a
    negative reported spending limit. *)
val validate_exn : t -> unit

(** Independent current durable representation, not the public API. *)
val to_json : t -> Jsonaf.t

(** Raises [Json.Decode_error] for malformed durable data or invalid limits. *)
val of_json_exn : Jsonaf.t -> t

module Attention : sig
  module Kind : sig
    type t =
      | Reported_tokens
      | Reported_elapsed_ms
    [@@deriving sexp_of, equal]

    val codec : t Api_codec.t
    val to_string : t -> string
  end

  type t =
    { run_id : Id.Run.t
    ; kind : Kind.t
    ; reported : int64
    ; reported_total_is_lower_bound : bool
    ; limit : int64
    }

  (** Reported values reach/exceed a configured limit. Saturated max-int64 totals
      are explicitly lower bounds, preserving the actual usage accumulator.
      Public provenance is literal externally_reported, not enforcement. *)
  val codec : t Api_codec.t

  val create
    :  run:Id.Run.t
    -> kind:Kind.t
    -> reported:int64
    -> limit:int64
    -> (t, Problem.t) Result.t
end
