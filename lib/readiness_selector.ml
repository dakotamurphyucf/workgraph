open Core
module Fields = Api_codec.Fields

module Candidate = struct
  type t =
    { actor : Id.Actor.t
    ; capabilities : string list
    }

  let create ~actor ~capabilities =
    Json.decode (fun () ->
      if List.length capabilities > 100
      then Json.fail Invalid_argument "candidate supports at most 100 capabilities";
      List.iter capabilities ~f:(fun name ->
        ignore
          (Coordination_wire.encode_exn (Coordination_wire.nonblank ~max_bytes:512) name
           : Jsonaf.t));
      if List.contains_dup capabilities ~compare:String.compare
      then Json.fail Invalid_argument "candidate capabilities contain duplicates";
      { actor; capabilities = List.sort capabilities ~compare:String.compare })
  ;;

  let actor t = t.actor
  let capabilities t = t.capabilities

  let codec =
    Api_codec.map
      (Api_codec.object_
         (Fields.both
            (Fields.required "actor_id" Coordination_wire.actor)
            (Fields.required
               "capabilities"
               (Api_codec.list (Coordination_wire.nonblank ~max_bytes:512) ~max_items:100))))
      ~decode:(fun (actor, capabilities) -> create ~actor ~capabilities)
      ~encode:(fun t -> t.actor, t.capabilities)
      ~description:
        "Prospective actor and distinct capabilities; read-only, without run \
         registration."
  ;;
end

type t =
  | Graph
  | Run of Id.Run.t
  | Candidate of Candidate.t

let fields =
  Fields.map
    (Fields.both
       (Fields.optional "target_run_id" Coordination_wire.run)
       (Fields.optional "candidate" Candidate.codec))
    ~decode:(function
      | None, None -> Graph
      | Some run, None -> Run run
      | None, Some candidate -> Candidate candidate
      | Some _, Some _ ->
        Json.fail Invalid_argument "candidate and target_run_id are mutually exclusive")
    ~encode:(function
      | Graph -> None, None
      | Run run -> Some run, None
      | Candidate candidate -> None, Some candidate)
;;

module Assessment = struct
  module Scope = struct
    type t =
      | Graph
      | Run
      | Candidate
    [@@deriving equal]

    let codec =
      Api_codec.enum [ "graph", Graph; "run", Run; "candidate", Candidate ] ~equal
    ;;
  end

  module Unknown_check = struct
    type t =
      | Run_lifecycle
      | Run_budget
      | Required_path_ownership
    [@@deriving equal]

    let codec =
      Api_codec.enum
        [ "run_lifecycle", Run_lifecycle
        ; "run_budget", Run_budget
        ; "required_path_ownership", Required_path_ownership
        ]
        ~equal
    ;;
  end

  type t =
    { scope : Scope.t
    ; unknown_checks : Unknown_check.t list
    }

  let graph = { scope = Graph; unknown_checks = [] }
  let run = { scope = Run; unknown_checks = [] }

  let candidate ~required_paths =
    { scope = Candidate
    ; unknown_checks =
        ([ Unknown_check.Run_lifecycle; Run_budget ]
         @ if required_paths then [ Required_path_ownership ] else [])
    }
  ;;

  let codec =
    Api_codec.map
      (Api_codec.object_
         (Fields.map
            (Fields.both
               (Fields.required "scope" Scope.codec)
               (Fields.required
                  "unknown_checks"
                  (Api_codec.list Unknown_check.codec ~max_items:3)))
            ~decode:(fun (scope, unknown_checks) -> { scope; unknown_checks })
            ~encode:(fun { scope; unknown_checks } -> scope, unknown_checks)))
      ~decode:(fun t ->
        let expected =
          match t.scope with
          | Graph | Run -> []
          | Candidate ->
            (candidate
               ~required_paths:
                 (List.mem
                    t.unknown_checks
                    Required_path_ownership
                    ~equal:Unknown_check.equal))
              .unknown_checks
        in
        if List.equal Unknown_check.equal t.unknown_checks expected
        then Ok t
        else
          Error (Problem.create Invalid_argument "assessment scope/unknown checks differ"))
      ~encode:Fn.id
      ~description:
        "Scope of known checks; candidate run lifecycle/budget and required path \
         ownership remain unknown. Readiness never authorizes acquisition."
  ;;
end
