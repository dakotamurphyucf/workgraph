open Core

(** Offline discovery from the executable method contracts. No daemon or context
    file is needed. Unknown methods return [Not_found]. *)
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
    and a shallow result summary. [Full] includes complete self-contained schemas.
    Examples pass the real stateless request codec; live references and guards
    still require caller values. If bounded placeholder candidates cannot satisfy
    a future contract, help explicitly labels the rejected example as a skeleton.
    [core] filters the index by the descriptor tier. CLI helpers are labelled
    separately from daemon methods. No inputs or schemas are truncated. *)
val help
  :  ?detail:Detail.t
  -> ?core:bool
  -> method_name:string option
  -> unit
  -> (string, Problem.t) Result.t
