open Core

(** Public transport values independent of durable Communication_event JSON.
    Full domain values are projected before bounded query fitting. View codecs
    preserve complete identity/counters/tags but allow explicitly disclosed
    prose and collection prefixes, rather than constructing invalid domain records. *)
val scope : Communication_event.Scope.t Api_codec.t

val kind : Communication_event.Notification.Kind.t Api_codec.t
val thread_state : Communication_event.Thread.State.t Api_codec.t
val request_kind : Communication_event.Request.Kind.t Api_codec.t
val filter_input : Communication_event.Subscription.Filter.t Api_codec.t
val board : Jsonaf.t Api_codec.t
val team : Jsonaf.t Api_codec.t
val subscription : Jsonaf.t Api_codec.t
val thread : Jsonaf.t Api_codec.t
val request : Jsonaf.t Api_codec.t
val page : Jsonaf.t Api_codec.t -> Jsonaf.t Api_codec.t
val board_json : Communication_event.Board.t -> Jsonaf.t
val team_json : Communication_event.Team.t -> Jsonaf.t
val subscription_json : Communication_event.Subscription.t -> Jsonaf.t
val thread_json : Communication_event.Thread.t -> Jsonaf.t
val request_json : Communication_event.Request.t -> Jsonaf.t

(** Complete historical snapshots reuse these same owning field declarations;
    related live discussion is absent and cannot enter retained audit payloads. *)
val attribution : Communication_event.Attribution.t Api_codec.t

val board_snapshot : Communication_event.Board.t Api_codec.t
val team_snapshot : Communication_event.Team.t Api_codec.t
val subscription_snapshot : Communication_event.Subscription.t Api_codec.t
val thread_snapshot : Communication_event.Thread.t Api_codec.t
val request_snapshot : Communication_event.Request.t Api_codec.t

(** Validate a complete typed publication result before preparing a durable
    acknowledgement. Invalid programmer output raises Invalid_response. *)
val validate_result : method_:string -> Jsonaf.t -> unit

(** Shared exact typed responsibility Fields used by request projections. *)
val request_responsibility : Communication_event.Request.Responsibility.t Api_codec.t
