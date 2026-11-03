open Core

(** Canonical CLI spelling. [ticket.get] is the only daemon method alias. *)
val canonical_method_name : string -> string

(** Resolve the longest executable method or local transfer-helper prefix, joining
    leading dotted or space-separated words. Absolute socket paths and options
    are never consumed. Unknown names return bounded, relevant suggestions;
    resolution performs no I/O and never invents a method. The remaining words
    still undergo the ordinary strict CLI option parser. *)
val resolve_method : string list -> (string * string list, Problem.t) Result.t

(** Offline discovery from the executable method contracts. No daemon or context
    file is needed. [ticket.get] selects the canonical [ticket.context] contract;
    other unknown methods return [Not_found] with bounded suggestions. Local
    helpers and family indexes have no daemon request/result schema. *)
val schema
  :  ?core:bool
  -> method_name:string option
  -> unit
  -> (Jsonaf.t, Problem.t) Result.t

module Detail : sig
  type t =
    | Brief
    | Full
  [@@deriving sexp, equal]
end

(** Offline daemon method index, or method help. [Brief] is the default and
    presents required/optional inputs, constraints, preconditions, a small example
    and one level of nested input shape; deeper objects/arrays remain summaries.
    It distinguishes raw required inputs from available context defaults. [Full]
    includes complete self-contained schemas.
    Examples pass the real stateless request codec; live references and guards
    still require caller values. If bounded placeholder candidates cannot satisfy
    a future contract, help explicitly labels the rejected example as a skeleton.
    [core] filters the index by the descriptor tier. CLI helpers are labelled
    separately from daemon methods. Local setup, transfer, evidence and retry
    helpers return offline usage. A family prefix lists its matching methods;
    unknown prefixes reject. [ticket.get] selects [ticket.context].
    No top-level inputs or full schemas are truncated. *)
val help
  :  ?detail:Detail.t
  -> ?core:bool
  -> method_name:string option
  -> unit
  -> (string, Problem.t) Result.t
