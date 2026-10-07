open Core

let require condition kind message = if not condition then Json.fail kind message

let checked = function
  | Ok t -> t
  | Error e -> raise (Json.Decode_error e)
;;

let optional json f =
  match json with
  | `Null -> None
  | j -> Some (f j)
;;

module Budget = struct
  type t =
    { run : Id.Run.t
    ; revision : int
    ; max_attempts : int option
    ; max_active_attempts : int option
    ; reported_token_limit : int64 option
    ; reported_elapsed_ms_limit : int64 option
    }
  [@@deriving sexp, equal]

  let validate t =
    require (t.revision > 0) Invalid_argument "Budget revision must be positive";
    List.iter [ t.max_attempts; t.max_active_attempts ] ~f:(fun n ->
      Option.iter n ~f:(fun n ->
        require (n > 0) Invalid_argument "Attempt limit must be positive"));
    List.iter [ t.reported_token_limit; t.reported_elapsed_ms_limit ] ~f:(fun n ->
      Option.iter n ~f:(fun n ->
        require
          Int64.(n >= zero)
          Invalid_argument
          "Reported usage limit cannot be negative"))
  ;;

  let to_json t =
    Json.obj
      [ "run", Id.Run.jsonaf_of_t t.run
      ; "revision", Json.int t.revision
      ; "max_attempts", Option.value_map t.max_attempts ~default:`Null ~f:Json.int
      ; ( "max_active_attempts"
        , Option.value_map t.max_active_attempts ~default:`Null ~f:Json.int )
      ; ( "reported_token_limit"
        , Option.value_map t.reported_token_limit ~default:`Null ~f:Json.int64 )
      ; ( "reported_elapsed_ms_limit"
        , Option.value_map t.reported_elapsed_ms_limit ~default:`Null ~f:Json.int64 )
      ]
  ;;

  let of_json json =
    Json.fields
      json
      ~allowed:
        [ "run"
        ; "revision"
        ; "max_attempts"
        ; "max_active_attempts"
        ; "reported_token_limit"
        ; "reported_elapsed_ms_limit"
        ];
    let get = Json.field json in
    let t =
      { run = Id.Run.t_of_jsonaf (get "run")
      ; revision = Json.integer (get "revision")
      ; max_attempts = optional (get "max_attempts") Json.integer
      ; max_active_attempts = optional (get "max_active_attempts") Json.integer
      ; reported_token_limit = optional (get "reported_token_limit") Json.integer64
      ; reported_elapsed_ms_limit =
          optional (get "reported_elapsed_ms_limit") Json.integer64
      }
    in
    validate t;
    t
  ;;
end

module Command = struct
  type t =
    | Template_register of Workflow_template.t
    | Instance_register of Workflow_template.Instance.t
    | Budget_put of Budget.t
    | Usage_report of Usage_record.t
  [@@deriving sexp]
end

let mutation_methods =
  [ "template.register"; "template.instance_register"; "run.budget_put"; "usage.report" ]
;;

let query_methods =
  [ "template.get"
  ; "template.list"
  ; "template.instance_get"
  ; "template.instance_list"
  ; "run.budget_get"
  ; "usage.list"
  ; "run.budget_attention"
  ]
;;

let encode = function
  | Command.Template_register t -> "template.register", Workflow_template.to_json t
  | Instance_register t ->
    "template.instance_register", Workflow_template.Instance.to_json t
  | Budget_put t -> "run.budget_put", Budget.to_json t
  | Usage_report t -> "usage.report", Usage_record.to_json t
;;

let decode ~method_ ~params =
  Json.decode (fun () ->
    match method_ with
    | "template.register" ->
      Command.Template_register (checked (Workflow_template.of_json params))
    | "template.instance_register" ->
      Instance_register (checked (Workflow_template.Instance.of_json params))
    | "run.budget_put" -> Budget_put (Budget.of_json params)
    | "usage.report" -> Usage_report (checked (Usage_record.of_json params))
    | _ -> Json.fail Invalid_argument "Unknown policy mutation")
;;

module Change = struct
  type t =
    { revision : int
    ; command : Command.t
    }
  [@@deriving sexp]

  let to_json t =
    let method_, params = encode t.command in
    Json.obj
      [ "revision", Json.int t.revision; "kind", Json.string method_; "record", params ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "revision"; "kind"; "record" ];
      { revision = Json.integer (Json.field json "revision")
      ; command =
          checked
            (decode
               ~method_:(Json.text (Json.field json "kind"))
               ~params:(Json.field json "record"))
      })
  ;;
end

type t =
  { revision : int
  ; templates : Workflow_template.t list Id.Resource.Map.t
  ; instances : Workflow_template.Instance.t Workflow_template.Instance_id.Map.t
  ; budgets : Budget.t Id.Run.Map.t
  ; usage : Usage_record.t Usage_record.Id.Map.t
  }

type prepared =
  { candidate : t
  ; changes : Change.t list
  ; result : Jsonaf.t
  }

let empty =
  { revision = 0
  ; templates = Id.Resource.Map.empty
  ; instances = Workflow_template.Instance_id.Map.empty
  ; budgets = Id.Run.Map.empty
  ; usage = Usage_record.Id.Map.empty
  }
;;

let candidate p = p.candidate
let changes p = p.changes
let result p = p.result

let get_template t id ~revision =
  Option.bind
    (Map.find t.templates id)
    ~f:(List.find ~f:(fun x -> Int.equal x.Workflow_template.resource_revision revision))
;;

let get_instance t id = Map.find t.instances id
let budget t id = Map.find t.budgets id

let apply_exn t change =
  require
    (Int.equal change.Change.revision (t.revision + 1))
    Conflict
    "Policy revision conflict";
  let next =
    match change.command with
    | Command.Template_register template ->
      let validated =
        checked
          (Workflow_template.create
             ~resource:template.resource
             ~resource_revision:template.resource_revision
             ~spec:template.spec)
      in
      require
        (Workflow_template.equal validated template)
        Invalid_argument
        "Template is not canonical";
      require
        (Option.is_none
           (get_template t template.resource ~revision:template.resource_revision))
        Conflict
        "Template version already registered";
      let versions = Option.value (Map.find t.templates template.resource) ~default:[] in
      { t with
        templates =
          Map.set t.templates ~key:template.resource ~data:(versions @ [ template ])
      }
    | Instance_register instance ->
      require
        (not (Map.mem t.instances instance.id))
        Conflict
        "Workflow instance already exists";
      let template =
        match get_template t instance.template ~revision:instance.template_revision with
        | Some t -> t
        | None -> Json.fail Not_found "Template version does not exist"
      in
      let expected =
        checked
          (Workflow_template.instantiate
             template
             ~id:instance.id
             ~parameters:instance.parameters)
      in
      require
        (Workflow_template.Instance.equal expected instance)
        Conflict
        "Workflow plan differs from template";
      { t with instances = Map.set t.instances ~key:instance.id ~data:instance }
    | Budget_put next ->
      Budget.validate next;
      let revision =
        Option.value_map (budget t next.run) ~default:1 ~f:(fun b ->
          b.Budget.revision + 1)
      in
      require (Int.equal revision next.revision) Conflict "Budget revision conflict";
      { t with budgets = Map.set t.budgets ~key:next.run ~data:next }
    | Usage_report usage ->
      ignore (checked (Usage_record.validate usage) : unit);
      require
        (not (Map.mem t.usage usage.id))
        Idempotency_conflict
        "Usage record already exists";
      { t with usage = Map.set t.usage ~key:usage.id ~data:usage }
  in
  { next with revision = change.revision }
;;

let apply t change = Json.decode (fun () -> apply_exn t change)

let prepare t command =
  Json.decode (fun () ->
    let same =
      match command with
      | Command.Template_register x ->
        Option.value_map
          (get_template t x.resource ~revision:x.resource_revision)
          ~default:false
          ~f:(Workflow_template.equal x)
      | Instance_register x ->
        Option.value_map
          (get_instance t x.id)
          ~default:false
          ~f:(Workflow_template.Instance.equal x)
      | Usage_report x ->
        (match Map.find t.usage x.id with
         | None -> false
         | Some old ->
           require
             (Usage_record.equal x old)
             Idempotency_conflict
             "Usage retry content differs";
           true)
      | Budget_put _ -> false
    in
    if same
    then
      { candidate = t
      ; changes = []
      ; result = Json.obj [ "revision", Json.int t.revision; "duplicate", `True ]
      }
    else (
      let change = { Change.revision = t.revision + 1; command } in
      let candidate = apply_exn t change in
      { candidate
      ; changes = [ change ]
      ; result = Json.obj [ "revision", Json.int candidate.revision; "duplicate", `False ]
      }))
;;

let validate_allocation t run ~runs =
  Json.decode (fun () ->
    match budget t run with
    | None -> ()
    | Some budget ->
      let attempts = Agent_run.attempts_for_run runs run in
      Option.iter budget.max_attempts ~f:(fun limit ->
        require (List.length attempts < limit) Blocked "Run attempt budget is exhausted");
      let active =
        List.count attempts ~f:(fun a -> not (Attempt.State.terminal a.Attempt.state))
      in
      Option.iter budget.max_active_attempts ~f:(fun limit ->
        require (active < limit) Blocked "Run concurrency budget is exhausted"))
;;

let usage_run usage ~runs =
  match usage.Usage_record.scope with
  | Usage_record.Scope.Run id -> Some id
  | Attempt id -> Option.map (Agent_run.get_attempt runs id) ~f:(fun a -> a.Attempt.run)
;;

let total t run ~runs field =
  List.fold (Map.data t.usage) ~init:0L ~f:(fun acc usage ->
    if Option.value_map (usage_run usage ~runs) ~default:false ~f:(Id.Run.equal run)
    then (
      let value = field usage in
      if Int64.(value > max_value - acc) then Int64.max_value else Int64.(acc + value))
    else acc)
;;

let attention t ~runs =
  List.concat_map (Map.data t.budgets) ~f:(fun budget ->
    let entry kind reported limit =
      Json.obj
        [ "run", Id.Run.jsonaf_of_t budget.Budget.run
        ; "kind", Json.string kind
        ; "reported", Json.int64 reported
        ; ( "reported_total_is_lower_bound"
          , if Int64.equal reported Int64.max_value then `True else `False )
        ; "limit", Json.int64 limit
        ; "provenance", Json.string "externally_reported"
        ]
    in
    let check kind reported limit =
      Option.to_list
        (Option.bind limit ~f:(fun limit ->
           if Int64.(reported >= limit) then Some (entry kind reported limit) else None))
    in
    check
      "reported_tokens"
      (total t budget.run ~runs (fun u -> u.Usage_record.tokens))
      budget.reported_token_limit
    @ check
        "reported_elapsed_ms"
        (total t budget.run ~runs (fun u -> u.Usage_record.elapsed_ms))
        budget.reported_elapsed_ms_limit)
;;

let validate_references t ~resource_version ~run_exists ~attempt_exists ~ticket_exists =
  Json.decode (fun () ->
    Map.iter
      t.templates
      ~f:
        (List.iter ~f:(fun template ->
           require
             (Option.value_map
                (resource_version
                   template.Workflow_template.resource
                   ~revision:template.resource_revision)
                ~default:false
                ~f:(String.equal template.digest))
             Not_found
             "Template resource digest/version differs"));
    Map.iter t.instances ~f:(fun instance ->
      List.iter instance.Workflow_template.Instance.tickets ~f:(fun p ->
        require
          (ticket_exists p.Workflow_template.Planned_ticket.ticket)
          Not_found
          "Workflow ticket does not exist"));
    Map.iter t.budgets ~f:(fun b ->
      require (run_exists b.Budget.run) Not_found "Budget run does not exist");
    Map.iter t.usage ~f:(fun u ->
      match u.Usage_record.scope with
      | Run id -> require (run_exists id) Not_found "Usage run does not exist"
      | Attempt id -> require (attempt_exists id) Not_found "Usage attempt does not exist"))
;;

let to_json t =
  Json.obj
    [ "revision", Json.int t.revision
    ; ( "templates"
      , `Array
          (List.concat_map
             (Map.data t.templates)
             ~f:(List.map ~f:Workflow_template.to_json)) )
    ; ( "instances"
      , `Array (List.map (Map.data t.instances) ~f:Workflow_template.Instance.to_json) )
    ; "budgets", `Array (List.map (Map.data t.budgets) ~f:Budget.to_json)
    ; "usage", `Array (List.map (Map.data t.usage) ~f:Usage_record.to_json)
    ]
;;

let query t ~runs ~method_ ~params =
  Json.decode (fun () ->
    let get = Json.field params in
    let page values =
      let limit =
        Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
      in
      let max_bytes =
        Option.value_map (Json.optional params "max_bytes") ~default:65536 ~f:Json.integer
      in
      require
        (limit > 0 && limit <= 100 && max_bytes >= 4096 && max_bytes <= 1048576)
        Invalid_argument
        "Policy query bounds are invalid";
      let offset =
        Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
      in
      if offset > 0
      then
        require
          (Int.equal t.revision (Json.integer (get "expected_revision")))
          Conflict
          "Policy pagination revision changed";
      let selected = List.take (List.drop values offset) limit in
      let rec fit reversed = function
        | [] -> List.rev reversed
        | item :: rest ->
          if
            String.length (Json.canonical (`Array (List.rev (item :: reversed)))) + 512
            > max_bytes
          then List.rev reversed
          else fit (item :: reversed) rest
      in
      let items = fit [] selected in
      let next = offset + List.length items in
      Json.obj
        [ "revision", Json.int t.revision
        ; "items", `Array items
        ; ("next_offset", if next < List.length values then Json.int next else `Null)
        ; "omitted", Json.int (Int.max 0 (List.length values - next))
        ]
    in
    let find = function
      | Some x -> x
      | None -> Json.fail Not_found "Policy record not found"
    in
    match method_ with
    | "template.get" ->
      Json.fields params ~allowed:[ "resource"; "resource_revision" ];
      Workflow_template.to_json
        (find
           (get_template
              t
              (Id.Resource.t_of_jsonaf (get "resource"))
              ~revision:(Json.integer (get "resource_revision"))))
    | "template.instance_get" ->
      Json.fields params ~allowed:[ "id" ];
      Workflow_template.Instance.to_json
        (find (get_instance t (Workflow_template.Instance_id.t_of_jsonaf (get "id"))))
    | "run.budget_get" ->
      Json.fields params ~allowed:[ "run" ];
      Budget.to_json (find (budget t (Id.Run.t_of_jsonaf (get "run"))))
    | "template.list" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page
        (List.concat_map
           (Map.data t.templates)
           ~f:(List.map ~f:Workflow_template.to_json))
    | "template.instance_list" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map (Map.data t.instances) ~f:Workflow_template.Instance.to_json)
    | "usage.list" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map (Map.data t.usage) ~f:Usage_record.to_json)
    | "run.budget_attention" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (attention t ~runs)
    | _ -> Json.fail Invalid_argument "Unknown policy query")
;;

let usage_records t = Map.data t.usage
let budgets t = Map.data t.budgets
