open Core

module Identity : sig
  (** Registry-scoped attribution. No run identity or planning workspace scope. *)
  type t =
    { actor : Id.Actor.t
    ; mutation : Id.Mutation.t
    }

  val key : t -> string
end

module Request : sig
  type t =
    | Health
    | Workspace_list
    | Workspace_create of
        { identity : Identity.t
        ; workspace : Id.Workspace.t option
        ; name : string
        ; root : string
        }
    | Workspace_register of
        { identity : Identity.t
        ; root : string
        }
    | Workspace_open of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        }
    | Workspace_close of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        }
    | Workspace_unregister of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        }
    | Workspace_receipt of Mutation_request.t
    | Registry_receipt of Identity.t
    | Workspace_export of
        { identity : Identity.t
        ; workspace : Id.Workspace.t
        ; destination : string
        }
    | Export_all of
        { identity : Identity.t
        ; destination : string
        ; allow_partial : bool
        }
    | Export_get of string
    | Export_list of
        { offset : int
        ; limit : int
        ; max_bytes : int
        ; at_snapshot : string option
        }
    | Export_cancel of
        { identity : Identity.t
        ; job : string
        }
    | Export_retry of
        { identity : Identity.t
        ; job : string
        }
    | Export_verify of string
    | Workspace_restore of
        { identity : Identity.t
        ; directory : string
        ; root : string
        }
    | Restore_all of
        { identity : Identity.t
        ; directory : string
        ; roots : (Id.Workspace.t * string) list
        }
    | Restore_cancel of
        { identity : Identity.t
        ; target : Identity.t
        }

  (** Exact full request objects. Optional omitted values select defaults; null
      rejects. Decode validates identities, paths, bounds and snapshot guards.
      Runtime hashes original raw parameters, retaining omission/default identity. *)
  val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t

  val encode : t -> (string * Jsonaf.t, Problem.t) Result.t
end

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Validate public result data before any registry receipt publication. Raises
    Api_method.Invalid_response for invalid programmer output; cancellation and
    unexpected exceptions propagate. Saved historical receipt bodies are complete. *)
val validate_result : method_:string -> Jsonaf.t -> unit

val methods : Api_method.Packed.t list
