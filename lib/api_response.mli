open Core
module Query_scope = Api_metadata.Query_scope

module Layout : sig
  (** Internal result layouts, not alternate public wire formats. Planning and
      history storage retain domain receipts; the transport publishes one shape.
      [Domain_record] leaves its entity revision on the record, while
      [Domain_query] moves the query capture revision to metadata. *)
  type t =
    | Value
    | Planning_read
    | Planning_write
    | Registry_write
    | Snapshot_read
    | Domain_query of Query_scope.t
    | Domain_record of Query_scope.t
    | Workspace_view
    | Feed
    | History
  [@@deriving sexp, equal]
end

(** Public successes are always [{data; meta}]. Only applicable metadata is
    present. Workspace, domain-query and history captures are never conflated.
    Record/entity revisions stay with their records. *)
type t

exception Invalid_result of Problem.t

val of_json : Jsonaf.t -> (t, Problem.t) Result.t
val to_json : t -> Jsonaf.t
val data : t -> Jsonaf.t
val meta : t -> Jsonaf.t

(** Require explicit durable publication for a receipt-bearing write. Missing or
    false durability is [Outcome_unknown], never a rejected/not-committed result. *)
val require_durable : t -> (unit, Problem.t) Result.t

(** Compose a method data codec with the common metadata codec. Generated result
    schemas describe this public envelope, not the handler's internal layout. *)
val codec : 'a Api_codec.t -> ('a * Api_metadata.t) Api_codec.t

(** Project a trusted internal result to the public contract. This is not an
    old-wire compatibility reader. Invalid internal layouts raise
    [Invalid_result]; callers must not report them as rejected mutations. *)
val project : Layout.t -> Jsonaf.t -> t

(** Size of the public result, excluding the JSON-RPC transport envelope. Query
    fitters must measure this shape to keep byte budgets and omission counts true. *)
val encoded_size : Layout.t -> Jsonaf.t -> int
