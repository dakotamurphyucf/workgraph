open Core

module Request = struct
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; at_revision : int option
    ; operations : Planning_api.Operation.t list
    }

  let codec =
    let open Api_codec in
    map
      (merge_objects
         (object_
            Fields.(
              both
                (required "actor_id" Coordination_wire.actor)
                (both
                   (optional "run_id" Coordination_wire.run)
                   (optional "at_revision" (decimal ~max:Int.max_value)))))
         Transaction_api.request)
      ~decode:(fun ((actor, (run, at_revision)), operations) ->
        Ok { actor; run; at_revision; operations })
      ~encode:(fun t -> (t.actor, (t.run, t.at_revision)), t.operations)
      ~description:
        "Read-only domain preparation of the actual atomic transaction operations."
  ;;
end

module Generated_id = struct
  type t =
    { kind : Id_resolution.Kind.t
    ; id : string
    }

  let kind_name = function
    | Id_resolution.Kind.Project -> "project"
    | Milestone -> "milestone"
    | Ticket -> "ticket"
    | Comment -> "comment"
    | Resource -> "resource"
  ;;

  let codec =
    let open Api_codec in
    let kinds =
      List.map
        [ Id_resolution.Kind.Project; Milestone; Ticket; Comment; Resource ]
        ~f:(fun kind -> kind_name kind, kind)
    in
    map
      (object_
         Fields.(
           both
             (required
                "kind"
                (enum kinds ~equal:(fun a b -> String.equal (kind_name a) (kind_name b))))
             (required "id" (text ~max_bytes:96))))
      ~decode:(fun (kind, id) ->
        let valid =
          match kind with
          | Id_resolution.Kind.Project -> Result.map (Id.Project.of_string id) ~f:ignore
          | Milestone -> Result.map (Id.Milestone.of_string id) ~f:ignore
          | Ticket -> Result.map (Id.Ticket.of_string id) ~f:ignore
          | Comment -> Result.map (Id.Comment.of_string id) ~f:ignore
          | Resource -> Result.map (Id.Resource.of_string id) ~f:ignore
        in
        Result.map valid ~f:(fun () -> { kind; id }))
      ~encode:(fun t -> t.kind, t.id)
      ~description:"Provisional identity used by this preview only; it is not reserved."
  ;;
end

module Response = struct
  type t =
    { workspace_revision : int
    ; proposed_revision : int
    ; operation_count : int
    ; generated_ids : Generated_id.t list
    ; staged_blob_count : int
    ; staged_blob_bytes : int64
    }

  let codec =
    let open Api_codec in
    let module F = Fields in
    let ( ++ ) = F.both in
    map
      (object_
         (F.map
            (F.required "validation" (literal "domain_preparation")
             ++ F.required "workspace_revision" (decimal ~max:Int.max_value)
             ++ F.required "proposed_revision" (decimal ~max:Int.max_value)
             ++ F.required
                  "operation_count"
                  (decimal ~max:Transaction_limit.max_operations)
             ++ F.required
                  "generated_ids"
                  (list Generated_id.codec ~max_items:Transaction_limit.max_operations)
             ++ F.required "staged_blob_count" (decimal ~max:Int.max_value)
             ++ F.required "staged_blob_bytes" (decimal64 ~max:Int64.max_value))
            ~decode:
              (fun
                ( ( ( ((((), workspace_revision), proposed_revision), operation_count)
                    , generated_ids )
                  , staged_blob_count )
                , staged_blob_bytes ) ->
              { workspace_revision
              ; proposed_revision
              ; operation_count
              ; generated_ids
              ; staged_blob_count
              ; staged_blob_bytes
              })
            ~encode:(fun t ->
              ( ( ( ((((), t.workspace_revision), t.proposed_revision), t.operation_count)
                  , t.generated_ids )
                , t.staged_blob_count )
              , t.staged_blob_bytes ))))
      ~decode:(fun t ->
        let identities =
          List.map t.generated_ids ~f:(fun id -> Generated_id.kind_name id.kind, id.id)
        in
        if
          t.operation_count < 1
          || t.workspace_revision = Int.max_value
          || t.proposed_revision <> t.workspace_revision + 1
          || List.length t.generated_ids > t.operation_count
          || List.contains_dup identities ~compare:[%compare: string * string]
          || (t.staged_blob_count = 0 && not (Int64.equal t.staged_blob_bytes 0L))
        then
          Error (Problem.create Invalid_argument "invalid transaction preflight summary")
        else Ok t)
      ~encode:Fn.id
      ~description:
        "Successful non-durable preparation only. Storage commit and future state remain \
         unchecked; IDs and revision are unreserved. Staged blob totals are not \
         incremental disk usage."
  ;;
end

let method_ =
  Api_method.create
    ~name:"transaction.preflight"
    ~summary:
      "Validate an atomic plan with actual domain preparation, without committing it."
    ~mode:Read
    ~request:Request.codec
    ~response:Response.codec
;;
