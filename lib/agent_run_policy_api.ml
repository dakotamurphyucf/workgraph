open Core
module Command = Agent_run_policy_command

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required
let opt = Api_codec.Fields.optional

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let unwrap = function
  | Ok v -> v
  | Error p -> raise (Json.Decode_error p)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated entity ID."
;;

let literal = function
  | Api_codec.Literal x -> x
  | Alias _ -> Json.fail Invalid_argument "unresolved transaction alias"
;;

let decimal = Api_codec.decimal ~max:Int.max_value
let decimal64 = Api_codec.decimal64 ~max:Int64.max_value

let positive =
  Api_codec.map
    decimal
    ~decode:(fun n ->
      if n > 0
      then Ok n
      else Error (Problem.create Invalid_argument "value must be positive"))
    ~encode:Fn.id
    ~description:"Positive version or attempt limit."
;;

let nonblank max_bytes =
  Api_codec.map
    (Api_codec.text ~max_bytes)
    ~decode:(fun s ->
      if String.is_empty (String.strip s)
      then Error (Problem.create Invalid_argument "text must be nonblank")
      else Ok s)
    ~encode:Fn.id
    ~description:"Nonblank bounded attributed text."
;;

let run = id Id.Run.of_string Id.Run.to_string
let actor = id Id.Actor.of_string Id.Actor.to_string
let resource = id Id.Resource.of_string Id.Resource.to_string
let nullable = Api_codec.nullable

let budget_fields run revision =
  req "target_run_id" run
  <*> req revision positive
  <*> req "max_attempts" (nullable positive)
  <*> req "max_active_attempts" (nullable positive)
  <*> req "reported_token_limit" (nullable decimal64)
  <*> req "reported_elapsed_ms_limit" (nullable decimal64)
;;

let budget =
  Api_codec.map
    (obj
       (budget_fields run "revision")
       ~decode:
         (fun
           ( ((((run, revision), max_attempts), max_active_attempts), reported_token_limit)
           , reported_elapsed_ms_limit ) ->
         { Run_budget.run
         ; revision
         ; max_attempts
         ; max_active_attempts
         ; reported_token_limit
         ; reported_elapsed_ms_limit
         })
       ~encode:(fun b ->
         ( ( (((b.Run_budget.run, b.revision), b.max_attempts), b.max_active_attempts)
           , b.reported_token_limit )
         , b.reported_elapsed_ms_limit )))
    ~decode:(fun b ->
      Json.decode (fun () ->
        Run_budget.validate_exn b;
        b))
    ~encode:Fn.id
    ~description:
      "Allocation bounds and externally reported attention limits; null means unlimited."
;;

type entry =
  { name : string
  ; raw : Jsonaf.t Api_codec.t
  ; resolved : Command.t Api_codec.t
  }

let declaration name fields ~decode ~encode =
  { name
  ; raw = Api_codec.as_json (Api_codec.object_ fields)
  ; resolved = obj fields ~decode ~encode
  }
;;

let typed name raw ~decode ~encode =
  { name
  ; raw = Api_codec.as_json raw
  ; resolved =
      Api_codec.map raw ~decode ~encode ~description:"Validated resolved domain command."
  }
;;

let parse codec j = unwrap (Api_codec.decode codec j)
let json codec value = unwrap (Api_codec.encode codec value)

let digest =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun s ->
      Json.decode (fun () ->
        if
          String.length s <> 64
          || not
               (String.for_all s ~f:(fun c ->
                  Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
        then Json.fail Invalid_argument "invalid SHA256 digest";
        s))
    ~encode:Fn.id
    ~description:"Lowercase SHA256 canonical Spec digest."
;;

let entries =
  let register =
    declaration
      "template.register"
      (req "template_id" (Api_codec.reference resource)
       <*> req "template_revision" positive
       <*> req "digest" digest
       <*> req "spec" Workflow_template_wire.Raw.spec)
      ~decode:(fun (((resource, resource_revision), digest), spec) ->
        let template =
          unwrap
            (Workflow_template.create
               ~resource:(literal resource)
               ~resource_revision
               ~spec:(parse Workflow_template_wire.spec spec))
        in
        if not (String.equal template.digest digest)
        then
          Json.fail Invalid_argument "template digest differs from canonical Spec asset";
        Command.Template_register template)
      ~encode:(function
        | Template_register t ->
          ( ((Api_codec.Literal t.resource, t.resource_revision), t.digest)
          , json Workflow_template_wire.spec t.spec )
        | _ -> Json.fail Invalid_argument "template register expected")
  in
  let instance =
    typed
      "template.instance_register"
      Workflow_template_wire.Raw.instance
      ~decode:(fun raw ->
        Result.map (Api_codec.decode Workflow_template_wire.instance raw) ~f:(fun i ->
          Command.Instance_register i))
      ~encode:(function
        | Instance_register i -> json Workflow_template_wire.instance i
        | _ -> Json.fail Invalid_argument "instance register expected")
  in
  let budget =
    declaration
      "run.budget_put"
      (req "target_run_id" (Api_codec.reference run)
       <*> req "expected_revision" decimal
       <*> req "max_attempts" (nullable positive)
       <*> req "max_active_attempts" (nullable positive)
       <*> req "reported_token_limit" (nullable decimal64)
       <*> req "reported_elapsed_ms_limit" (nullable decimal64))
      ~decode:
        (fun
          ( ( (((run, expected_revision), max_attempts), max_active_attempts)
            , reported_token_limit )
          , reported_elapsed_ms_limit ) ->
        if expected_revision = Int.max_value
        then Json.fail Invalid_argument "budget revision exhausted";
        let b =
          { Run_budget.run = literal run
          ; revision = expected_revision + 1
          ; max_attempts
          ; max_active_attempts
          ; reported_token_limit
          ; reported_elapsed_ms_limit
          }
        in
        Run_budget.validate_exn b;
        Command.Budget_put b)
      ~encode:(function
        | Budget_put b ->
          ( ( ( ((Api_codec.Literal b.run, b.revision - 1), b.max_attempts)
              , b.max_active_attempts )
            , b.reported_token_limit )
          , b.reported_elapsed_ms_limit )
        | _ -> Json.fail Invalid_argument "budget put expected")
  in
  let usage =
    declaration
      "usage.report"
      (req "usage_id" (id Usage_record.Id.of_string Usage_record.Id.to_string)
       <*> req "scope" Usage_record_wire.raw_scope
       <*> req "reported_actor_id" (Api_codec.reference actor)
       <*> req "tokens" decimal64
       <*> req "elapsed_ms" decimal64
       <*> req "provenance" (nonblank 4096)
       <*> req "timestamp" (nonblank 128))
      ~decode:
        (fun
          ((((((id, scope), actor), tokens), elapsed_ms), provenance), timestamp) ->
        let r =
          { Usage_record.id
          ; scope = parse Usage_record_wire.scope scope
          ; actor = literal actor
          ; tokens
          ; elapsed_ms
          ; provenance
          ; timestamp
          }
        in
        ignore (unwrap (Usage_record.validate r) : unit);
        Command.Usage_report r)
      ~encode:(function
        | Usage_report r ->
          ( ( ( ( ((r.id, json Usage_record_wire.scope r.scope), Api_codec.Literal r.actor)
                , r.tokens )
              , r.elapsed_ms )
            , r.provenance )
          , r.timestamp )
        | _ -> Json.fail Invalid_argument "usage report expected")
  in
  [ register; instance; budget; usage ]
;;

let queries =
  let max_bytes =
    opt
      "max_bytes"
      (Api_codec.map
         (Api_codec.decimal ~max:1_048_576)
         ~decode:(fun n ->
           if n >= 4096
           then Ok n
           else Error (Problem.create Invalid_argument "max_bytes must be 4096..1048576"))
         ~encode:Fn.id
         ~description:"Whole public envelope byte bound.")
  in
  let limit =
    Api_codec.map
      (Api_codec.decimal ~max:100)
      ~decode:(fun n ->
        if n > 0
        then Ok n
        else Error (Problem.create Invalid_argument "limit must be positive"))
      ~encode:Fn.id
      ~description:"1..100 complete page items."
  in
  let page =
    opt "limit" limit
    <*> max_bytes
    <*> opt "offset" decimal
    <*> opt "expected_revision" decimal
  in
  let raw fields = Api_codec.as_json (Api_codec.object_ fields) in
  [ ( "template.get"
    , raw (req "template_id" resource <*> req "template_revision" positive <*> max_bytes)
    )
  ; ( "template.instance_get"
    , raw
        (req
           "instance_id"
           (id
              Workflow_template.Instance_id.of_string
              Workflow_template.Instance_id.to_string)
         <*> max_bytes) )
  ; "run.budget_get", raw (req "target_run_id" run <*> max_bytes)
  ; "template.list", raw page
  ; "template.instance_list", raw page
  ; "usage.list", raw page
  ; "run.budget_attention", raw page
  ]
;;

let request_codec ~method_ =
  match List.find entries ~f:(fun e -> String.equal e.name method_) with
  | Some e -> Some e.raw
  | None -> List.Assoc.find queries method_ ~equal:String.equal
;;

let receipt =
  Api_codec.as_json
    (Api_codec.object_ (req "revision" decimal <*> req "duplicate" Api_codec.boolean))
;;

let attention = Api_codec.as_json Run_budget.Attention.codec

let response_codec ~method_ =
  let page item =
    Api_codec.as_json
      (Api_codec.object_
         (req "items" (Api_codec.list item ~max_items:100)
          <*> req "next_offset" (nullable decimal)
          <*> req "omitted" decimal))
  in
  if List.exists entries ~f:(fun e -> String.equal e.name method_)
  then Some receipt
  else (
    match method_ with
    | "template.get" -> Some (Api_codec.as_json Workflow_template_wire.template)
    | "template.instance_get" -> Some (Api_codec.as_json Workflow_template_wire.instance)
    | "run.budget_get" -> Some (Api_codec.as_json budget)
    | "template.list" -> Some (page Workflow_template_wire.template)
    | "template.instance_list" -> Some (page Workflow_template_wire.instance)
    | "usage.list" -> Some (page Usage_record_wire.record)
    | "run.budget_attention" -> Some (page attention)
    | _ -> None)
;;

let decode ~method_ ~params =
  match List.find entries ~f:(fun e -> String.equal e.name method_) with
  | Some e -> Api_codec.decode e.resolved params
  | None -> Error (Problem.create Invalid_argument "unknown policy mutation")
;;

let encode command =
  let name =
    match command with
    | Command.Template_register _ -> "template.register"
    | Instance_register _ -> "template.instance_register"
    | Budget_put _ -> "run.budget_put"
    | Usage_report _ -> "usage.report"
  in
  let e = List.find_exn entries ~f:(fun e -> String.equal e.name name) in
  Result.map (Api_codec.encode e.resolved command) ~f:(fun json -> name, json)
;;

let methods =
  List.map
    (List.map entries ~f:(fun e -> e.name) @ List.map queries ~f:fst)
    ~f:(fun name ->
      Api_method.Packed.Pack
        (Api_method.create
           ~name
           ~summary:("Templates, allocation bounds and reported usage: " ^ name)
           ~mode:
             (if List.exists entries ~f:(fun e -> String.equal e.name name)
              then Mutation
              else Read)
           ~request:(Option.value_exn (request_codec ~method_:name))
           ~response:(Option.value_exn (response_codec ~method_:name))))
;;
