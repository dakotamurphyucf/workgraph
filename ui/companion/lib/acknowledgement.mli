open Core

type t =
  | Committed of Workgraph.Api_response.t
  | Observed of Workgraph.Api_response.t

val receipt_lookup_supported : Workgraph.Protocol.Request.t -> bool

(** Full original method codec plus namespace-specific acknowledgement. A valid
    outer envelope is insufficient. Reads are rejected here. Invalid attempted
    write acknowledgements retain Outcome_unknown. History mutations require
    durable:true; their native replies do not require history_capture. A capture,
    when present, and any returned session must match the original workspace.
    Returned session IDs, including append event references, bind the original
    requested session. *)
val validate
  :  Workgraph.Protocol.Request.t
  -> response:Workgraph.Api_response.t
  -> (t, Workgraph.Problem.t) Result.t

(** Prepare exact namespace receipt lookup from a saved mutation. Ephemeral
    writes have no receipt. Never confuse envelope hash with request_hash. *)
val receipt_request
  :  Workgraph.Request_journal.Entry.t
  -> (Workgraph.Protocol.Request.t, Workgraph.Problem.t) Result.t

(** Validate outer lookup, exact saved server request_hash, nested original
    method codec and durability. Pending/absent yield None, never proof of unsent.
    Mismatched identity is Idempotency_conflict, not permission for a new send. *)
val receipt
  :  Workgraph.Protocol.Request.t
  -> entry:Workgraph.Request_journal.Entry.t
  -> response:Workgraph.Api_response.t
  -> (t option, Workgraph.Problem.t) Result.t
