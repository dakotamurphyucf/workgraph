open Core

(** Finish handoff patch. Summary and next steps are required; omitted rich
    fields preserve the current handoff, while empty text/resource lists clear
    them. Without a previous handoff, rich fields default to empty values and
    coverage to zero. Coverage is an observed workspace revision, never save
    time; omission preserves the previous cursor. Text fields are bounded to
    64KiB and resource references to 100. Finish evidence becomes this version's
    evidence; historical handoffs remain immutable. *)
module Handoff : sig
  type t =
    { summary : string
    ; next_steps : string
    ; objective : string option
    ; completed : string option
    ; decisions : string option
    ; blockers : string option
    ; resource_ids : Id.Resource.t list option
    ; covers_through : int option
    }
  [@@deriving sexp]

  val codec : t Api_codec.t
end

(** Explicit external-process confirmation followed by exact guarded recovery.
    Expiry alone is insufficient. [old_run_id=None] identifies ownership without
    run attribution; a mismatched replacement owner always rejects. *)
module Recovery : sig
  module Recovery_id = Ownership_recovery.Recovery_id
  module Confirmation = Ownership_recovery.Confirmation

  type t =
    { recovery_id : Recovery_id.t
    ; ticket_id : Id.Ticket.t
    ; expected_revision : int
    ; old_actor_id : Id.Actor.t
    ; old_run_id : Id.Run.t option
    ; token : int
    ; expected_lease_revision : int
    ; confirmation : Confirmation.t
    ; reason : string
    ; evidence : Evidence_event.Pin.t list
    }
  [@@deriving sexp]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  (** Conflict for revision/lease changes, Stale_claim for owner changes. The
      caller supplies the immutable immediately preceding claim and lease. *)
  val validate_owner
    :  t
    -> revision:int
    -> actor:Id.Actor.t
    -> run:Id.Run.t option
    -> token:int
    -> lease_revision:int
    -> (unit, Problem.t) Result.t
end

(** Pure public lifecycle commands. Claim/Start guards are optional: supplied
    revisions reject intervening changes; omission atomically selects current
    eligible unclaimed work. Revision conflicts precede ownership conflicts.
    Start atomically claims, writes the optional nonblank initial note and starts
    the optional fresh attempt (which requires attributed run ownership).
    Finish requires a positive current ownership token and nonblank evidence;
    its optional handoff, active attempt completion and ticket completion publish
    together. Holds, dependencies, unfinished children and enabled acceptance
    policy are rechecked at commit. Reopen requires a current revision and nonblank
    reason, preserves prior evidence/attempts/waivers and creates unclaimed Todo
    work with a fresh ownership fence. It retains dependent claims/statuses and
    records structured reassessment; running dependents get durable messages.
    All commands use one durable mutation identity/receipt; failed preparation
    publishes nothing, exact retries return the original result. Stateless wire
    codecs reject invalid identities, blank reasons/evidence/notes, zero tokens
    and lease durations outside 1ms..24h. State-dependent errors include Conflict,
    Already_claimed, Blocked and Stale_claim. No I/O occurs in these codecs. *)
module Command : sig
  type t =
    | Claim of
        { ticket_id : Id.Ticket.t
        ; expected_revision : int option
        ; lease_duration_ms : int64 option
        }
    | Start of
        { ticket_id : Id.Ticket.t
        ; expected_revision : int option
        ; lease_duration_ms : int64 option
        ; initial_note : string option
        ; attempt_id : Attempt.Id.t option
        }
    | Finish of
        { ticket_id : Id.Ticket.t
        ; token : int
        ; evidence : string
        ; handoff : Handoff.t option
        }
    | Recover of Recovery.t
    | Reopen of
        { ticket_id : Id.Ticket.t
        ; expected_revision : int
        ; reason : string
        }
  [@@deriving sexp]

  val codec : string -> (t Api_codec.t, Problem.t) Result.t
  val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
  val encode : t -> (string * Jsonaf.t, Problem.t) Result.t
end

val mutation_methods : string list

(** Unknown methods return Invalid_argument. Responses validate exact fields and
    typed ticket identities. Start/finish include an optional [attempt] containing
    its identity, entity revision and state when an attempt is created/completed;
    ordinary work omits it. Finish also returns the committed [ticket_revision],
    a positive entity revision rather than the workspace revision. *)
val response_codec : string -> (Jsonaf.t Api_codec.t, Problem.t) Result.t

(** Shares the same raw Fields declarations as Command.codec and preserves caller
    JSON omissions. Accepts transaction aliases before resolution; typed Command
    decoding requires resolved identities. *)
val request_codec : string -> (Jsonaf.t Api_codec.t, Problem.t) Result.t
