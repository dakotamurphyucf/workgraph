open Core

(** Offline discovery from the executable method contracts. No daemon or context
    file is needed. [ticket.get] selects the canonical [ticket.context] contract;
    other unknown methods return [Not_found]. *)
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
    separately from daemon methods. [init] and [bootstrap] return offline local
    helper usage. [ticket.get] resolves to the canonical [ticket.context] contract.
    No top-level inputs or full schemas are truncated. *)
val help
  :  ?detail:Detail.t
  -> ?core:bool
  -> method_name:string option
  -> unit
  -> (string, Problem.t) Result.t
