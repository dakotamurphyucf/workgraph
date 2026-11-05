open Core

(** Three advisory methods, explicit lifecycle and exact revision/fence guards.
    Mutation receipts do not acquire/release/renew ownership. *)
val mutation_methods : string list

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option
val descriptor : method_:string -> Api_method.Packed.t option
val result : Reservation_contention.Change.t -> Jsonaf.t

module Request : sig
  (** Target required; optional include_inactive, cursor, limit1..100 and
      max_bytes4096..1048576. Current capture binds filters, revision and clock.
      Inactive includes closed/expired/explicitly terminal-run waiter records.
      Clock-regressed Waiting remains visible with unknown elapsed. *)
  type t

  val codec : t Api_codec.t
  val target : t -> Reservation_contention.Target.t
  val include_inactive : t -> bool
  val cursor : t -> string option
  val limit : t -> int
  val max_bytes : t -> int
end

module Row : sig
  type phase =
    | Waiting
    | Closed
    | Expired
    | Run_terminal
  [@@deriving equal, sexp]

  type t =
    | Waiter of
        { record : Reservation_contention.Waiter.t
        ; run_status : Agent_run_event.Status.t
        ; phase : phase
        ; elapsed_ms : int64 option
        ; clock_regressed : bool
        }
    | Holder of
        { target : Reservation_contention.Target.t
        ; holder : Reservation.Holder.t
        ; note : Reservation_contention.Holder_note.t option
        ; note_clock_regressed : bool
        }

  val codec : t Api_codec.t
  val order_key : t -> string

  val waiter
    :  Reservation_contention.Waiter.t
    -> run_status:Agent_run_event.Status.t
    -> now_unix_ms:int64
    -> t
end

(** Validates exact elapsed/phase/clock against observed_unix_ms, holder-note
    actor/run/target/fence and visible note expiry. Enforced advisory=true.
    Whole rows and exact cursor position, never a queue position or FIFO promise. *)
val read_response_codec : Jsonaf.t Api_codec.t

val read_descriptor : Api_method.Packed.t
