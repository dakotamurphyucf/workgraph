open Core

(** Public tagged JSON payload carried in the initial body of an ordinary durable
    message. Exact submission generation, manifest/contract and immutable review
    references are captured together with submitter/reviewer attribution.
    [gate_status="not_evaluated"] states that one approval does not determine the
    aggregate review/validation gate. Bodies exclude potentially large evidence
    text; retrieve it through the exact recorded review reference when needed. *)
type t

val codec : t Api_codec.t

(** Only an Approve review matching this pending submission's exact references
    and policy binding is accepted. Invalid pairs return Invalid_argument. Pure;
    the input review and submission remain unchanged. *)
val create
  :  review:Evidence.Review.t
  -> submission:Evidence.Submission.t
  -> (t, Problem.t) Result.t

(** Deterministic bounded identity includes workspace-local review ID and serial.
    The message's canonical public JSON body is pinned to its initial authored
    comment; recipients are this captured submitter actor and optional run.
    Existing message collision checks apply atomically. The enclosing planning
    transaction publishes approval and message together before acknowledgement. *)
val message : t -> Communication.Message_send.t
