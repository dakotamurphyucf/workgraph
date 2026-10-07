open Core

module Target : sig
  type t =
    { source : string
    ; root : string
    ; capture : Export_job.Capture.t
    ; manifest_hash : string
    }
end

(** Durable admission before copying. Targets reserve workspace identities and
    fresh roots. Retries retain the original manifests and publication token. *)
type t =
  { request_hash : string
  ; token : string
  ; targets : Target.t list
  }

val validate : t -> unit
val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> t
