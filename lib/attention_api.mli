open Core

module Kind : sig
  type t =
    | Communication
    | Fact
    | Ticket
    | Readiness
  [@@deriving sexp, compare, equal]

  val codec : t Api_codec.t
end

module Filter : sig
  type t =
    { project : Id.Project.t option
    ; recipient : Communication.Recipient.t option
    ; consumer : Communication_id.Consumer.t option
    ; exclude_self : bool
    ; kinds : Kind.t list
    ; fact_scope : Facts.Scope.t option
    ; fact_prefix : string option
    ; tickets : Id.Ticket.t list
    ; run : Id.Run.t option
    }

  (** Fields AND, kinds OR. Communication requires both explicit recipient and
      consumer; neither read nor wait acknowledges. Source-specific selectors
      apply only to that source. Empty kinds selects fact/ticket/readiness and
      communication when its explicit consumer/recipient pair is supplied. Run
      selects source attribution for facts/tickets, attribution or the explicitly
      addressed run for communication, and allocation eligibility for readiness.
      Cross-project prerequisite/pool/path effects can invalidate selected work. *)
  val codec : t Api_codec.t
end

module Request : sig
  (** Pure read or bounded 1..25000ms wait. Cursor and after are exclusive;
      limit1..100, max_bytes4096..1048576. Durable continuation fixes the audit
      upper bound and exact row/fragment position; fully consumed ranges may
      advance. Unmatched prefixes advance without acknowledging delivery.
      initial_readiness requests a current eligibility snapshot even with no
      invalidation; its readiness_cursor binds an independent current capture.
      Clock-only expiry is observed on an explicit snapshot/relevant recheck;
      this API does not promise a timer for every expiry boundary. *)
  type t

  val codec : method_:string -> t Api_codec.t option
  val filter : t -> Filter.t
  val after : t -> int option
  val cursor : t -> string option
  val limit : t -> int
  val max_bytes : t -> int
  val timeout_ms : t -> int
  val initial_readiness : t -> bool
  val readiness_cursor : t -> string option
  val read_params : t -> Jsonaf.t
  val with_cursor : t -> string -> t
end

(** Exact source references and whole rows. Communication fragments expose every
    underlying raw notification ID for explicit inbox.ack; grouping never alters
    the raw audit. Current eligibility is a separate labelled capture with its
    own continuation, and is never bound by the durable attention cursor. *)
val row_codec : Jsonaf.t Api_codec.t

val response_codec : Jsonaf.t Api_codec.t
val methods : Api_method.Packed.t list
val overview_method : Api_method.Packed.t
val overview_request : Jsonaf.t Api_codec.t
val overview_response : Jsonaf.t Api_codec.t
val notification_json : Communication.Notification.t -> Jsonaf.t
