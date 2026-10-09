open Core

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated identity."
;;

let workspace = id Id.Workspace.of_string Id.Workspace.to_string
let run = id Id.Run.of_string Id.Run.to_string
let actor = id Id.Actor.of_string Id.Actor.to_string

module Read = struct
  type t =
    { workspace_id : Id.Workspace.t
    ; target_run_id : Id.Run.t
    }

  let codec =
    let open Api_codec in
    object_
      (Fields.both
         (Fields.required "workspace_id" workspace)
         (Fields.required "target_run_id" run)
       |> Fields.map
            ~decode:(fun (workspace_id, target_run_id) -> { workspace_id; target_run_id })
            ~encode:(fun t -> t.workspace_id, t.target_run_id))
  ;;
end

module Observe = struct
  type t =
    { workspace_id : Id.Workspace.t
    ; target_run_id : Id.Run.t
    ; actor_id : Id.Actor.t
    }

  let codec =
    Api_codec.merge_objects
      Read.codec
      (Api_codec.object_ (Api_codec.Fields.required "actor_id" actor))
    |> Api_codec.map
         ~decode:(fun ((read : Read.t), actor_id) ->
           Ok
             { workspace_id = read.workspace_id
             ; target_run_id = read.target_run_id
             ; actor_id
             })
         ~encode:(fun t ->
           ( { Read.workspace_id = t.workspace_id; target_run_id = t.target_run_id }
           , t.actor_id ))
         ~description:"Advisory observation attributed to the run's registered actor."
  ;;
end

module Observation = struct
  type t =
    { actor : Id.Actor.t
    ; observed_unix_ms : int64
    }

  let equal a b =
    Id.Actor.equal a.actor b.actor && Int64.equal a.observed_unix_ms b.observed_unix_ms
  ;;

  let codec =
    let open Api_codec in
    object_
      (Fields.both
         (Fields.required "actor_id" actor)
         (Fields.required "observed_unix_ms" (decimal64 ~max:Int64.max_value))
       |> Fields.map
            ~decode:(fun (actor, observed_unix_ms) -> { actor; observed_unix_ms })
            ~encode:(fun t -> t.actor, t.observed_unix_ms))
  ;;
end

let response =
  let open Api_codec in
  object_
    (Fields.both
       (Fields.required "target_run_id" run)
       (Fields.both
          (Fields.both
             (Fields.required "observation" Observation.codec)
             (Fields.required "persisted" (nullable Observation.codec)))
          (Fields.both
             (Fields.required "durable" boolean)
             (Fields.required "advisory" boolean))))
  |> map
       ~decode:(fun ((_, ((observation, persisted), (durable, advisory))) as value) ->
         if
           (not advisory)
           || (not
                 (Bool.equal
                    durable
                    (Option.exists persisted ~f:(Observation.equal observation))))
           || Option.exists persisted ~f:(fun old ->
             (not (Id.Actor.equal old.actor observation.actor))
             || Int64.(old.observed_unix_ms > observation.observed_unix_ms))
         then Error (Problem.create Invalid_argument "inconsistent heartbeat observation")
         else Ok value)
       ~encode:Fn.id
       ~description:
         "Advisory is true. Persisted is absent (null) or from the same actor at an \
          earlier/equal time; durable iff it equals the current observation."
  |> as_json
;;

let observe =
  Api_method.create
    ~name:"run.heartbeat"
    ~summary:
      "Record advisory liveness; does not renew ownership or require a mutation ID."
    ~mode:Write
    ~request:Observe.codec
    ~response
;;

let read =
  Api_method.create
    ~name:"run.heartbeat_get"
    ~summary:"Read the current and last persisted advisory liveness observation."
    ~mode:Read
    ~request:Read.codec
    ~response
;;

let methods = [ Api_method.Packed.Pack observe; Pack read ]
