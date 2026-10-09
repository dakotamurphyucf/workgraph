open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json = Jsonaf.of_string

let report = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let run = ok (Id.Run.of_string "run")
let actor = ok (Id.Actor.of_string "worker")
let command method_ text = ok (Agent_run_policy.decode ~method_ ~params:(json text))

let put state command =
  ok (Agent_run_policy.prepare state command) |> Agent_run_policy.candidate
;;

let spec description =
  { Workflow_template.Spec.parameters = [ "ticket_id" ]
  ; nodes =
      [ { Workflow_template.Node.alias = "node"
        ; title = "Build {{ticket_id}}"
        ; description
        ; depends_on = []
        ; parent = None
        ; capabilities = []
        ; reviewers = [ actor ]
        ; separate_actor = true
        }
      ]
  }
;;

let template description =
  ok
    (Workflow_template.create
       ~resource:(ok (Id.Resource.of_string "plan"))
       ~resource_revision:1
       ~spec:(spec description))
;;

let response state method_ params =
  let raw =
    ok (Agent_run_policy.query state ~runs:Agent_run.empty ~method_ ~params:(json params))
  in
  let wire = Api_response.project (Domain_query Policy) raw in
  ignore
    (ok
       (Api_codec.decode
          (Option.value_exn (Agent_run_policy_api.response_codec ~method_))
          (Api_response.data wire))
     : Jsonaf.t);
  wire
;;

let%expect_test "all eleven descriptors expose executable request and result shapes" =
  print_s
    [%sexp
      (List.map Agent_run_policy_api.methods ~f:(fun (Api_method.Packed.Pack m) ->
         Api_method.name m)
       |> List.sort ~compare:String.compare
       : string list)];
  List.iter Agent_run_policy_api.methods ~f:(fun (Api_method.Packed.Pack m) ->
    let declaration = Json.canonical (Api_method.describe m) in
    assert (String.is_substring declaration ~substring:"additionalProperties"));
  [%expect
    {|
    (run.budget_attention run.budget_get run.budget_put template.get
     template.instance_get template.instance_list template.instance_register
     template.list template.register usage.list usage.report)
    |}]
;;

let%expect_test "budget put guards the old version and rejects missing nullable limits" =
  let c =
    command
      "run.budget_put"
      {|{"target_run_id":"run","expected_revision":"0","max_attempts":"3","max_active_attempts":"1","reported_token_limit":null,"reported_elapsed_ms_limit":"9"}|}
  in
  let state = put Agent_run_policy.empty c in
  let view = response state "run.budget_get" {|{"target_run_id":"run"}|} in
  print_endline (Json.canonical (Api_response.data view));
  report (Agent_run_policy.prepare state c);
  report
    (Agent_run_policy.decode
       ~method_:"run.budget_put"
       ~params:
         (json
            {|{"target_run_id":"run","expected_revision":"1","max_attempts":"3","max_active_attempts":"1","reported_token_limit":null}|}));
  report
    (Agent_run_policy.decode
       ~method_:"run.budget_put"
       ~params:
         (json
            {|{"target_run_id":"run","expected_revision":"1","max_attempts":"0","max_active_attempts":null,"reported_token_limit":null,"reported_elapsed_ms_limit":null}|}));
  [%expect
    {|
    {"max_active_attempts":"1","max_attempts":"3","reported_elapsed_ms_limit":"9","reported_token_limit":null,"revision":"1","target_run_id":"run"}
    Conflict
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "usage identity is immutable and durable schema is distinct and validated"
  =
  let c =
    command
      "usage.report"
      {|{"usage_id":"usage","scope":{"kind":"run","run_id":"run"},"reported_actor_id":"worker","tokens":"4","elapsed_ms":"7","provenance":"$literal external report","timestamp":"now"}|}
  in
  let prepared = ok (Agent_run_policy.prepare Agent_run_policy.empty c) in
  let state = Agent_run_policy.candidate prepared in
  let duplicate = ok (Agent_run_policy.prepare state c) in
  print_s [%sexp (List.length (Agent_run_policy.changes duplicate) : int)];
  print_endline (Json.canonical (Agent_run_policy.result duplicate));
  let changed =
    match c with
    | Usage_report r -> Agent_run_policy.Command.Usage_report { r with tokens = 5L }
    | _ -> assert false
  in
  report (Agent_run_policy.prepare state changed);
  let malformed =
    json
      {|{"revision":"1","kind":"usage.report","record":{"id":"usage","scope":{"run":"run"},"actor":"worker","tokens":"-1","elapsed_ms":"7","provenance":"source","timestamp":"now"}}|}
  in
  report (Agent_run_policy.Change.of_json malformed);
  let change = List.hd_exn (Agent_run_policy.changes prepared) in
  let encoded = Agent_run_policy.Change.to_json change in
  print_s
    [%sexp (Option.is_some (Json.optional (Json.field encoded "record") "id") : bool)];
  let replay =
    ok
      (Agent_run_policy.apply
         Agent_run_policy.empty
         (ok (Agent_run_policy.Change.of_json encoded)))
  in
  let wire = response replay "usage.list" "{}" in
  print_endline (Json.canonical (Api_response.data wire));
  [%expect
    {|
    0
    {"duplicate":true,"revision":"1"}
    Idempotency_conflict
    Invalid_argument
    true
    {"items":[{"actor_id":"worker","elapsed_ms":"7","provenance":"$literal external report","scope":{"kind":"run","run_id":"run"},"timestamp":"now","tokens":"4","usage_id":"usage"}],"next_offset":null,"omitted":"0"}
    |}]
;;

let%expect_test "raw aliases are explicit and opaque template parameters remain literal" =
  let budget =
    {|{"target_run_id":"$runner","expected_revision":"0","max_attempts":null,"max_active_attempts":null,"reported_token_limit":null,"reported_elapsed_ms_limit":null}|}
  in
  let usage =
    {|{"usage_id":"usage","scope":{"kind":"run","run_id":"$runner"},"reported_actor_id":"$reporter","tokens":"1","elapsed_ms":"2","provenance":"$runner","timestamp":"now"}|}
  in
  List.iter
    [ "run.budget_put", budget; "usage.report", usage ]
    ~f:(fun (method_, params) ->
      let codec = Option.value_exn (Agent_run_policy_api.request_codec ~method_) in
      report (Api_codec.decode codec (json params));
      report (Agent_run_policy.decode ~method_ ~params:(json params));
      assert (
        String.is_substring (Json.canonical (Api_codec.schema codec)) ~substring:"anyOf"));
  let t = template "Literal $runner" in
  let _, raw = Agent_run_policy.encode (Template_register t) in
  let raw =
    match raw with
    | `Object fs ->
      Json.obj
        (List.Assoc.add fs ~equal:String.equal "template_id" (Json.string "$asset"))
    | _ -> assert false
  in
  report
    (Api_codec.decode
       (Option.value_exn
          (Agent_run_policy_api.request_codec ~method_:"template.register"))
       raw);
  let instance =
    ok
      (Workflow_template.instantiate
         t
         ~id:(ok (Workflow_template.Instance_id.of_string "instance"))
         ~parameters:[ "ticket_id", "$runner" ])
  in
  let _, raw_instance = Agent_run_policy.encode (Instance_register instance) in
  report
    (Api_codec.decode
       (Option.value_exn
          (Agent_run_policy_api.request_codec ~method_:"template.instance_register"))
       raw_instance);
  let operations =
    Json.obj
      [ ( "operations"
        , `Array
            [ Json.obj
                [ "method", Json.string "run.register"
                ; "as", Json.string "runner"
                ; "params", json {|{"target_run_id":"run","objective":"Run"}|}
                ]
            ; Json.obj
                [ "method", Json.string "usage.report"
                ; ( "params"
                  , json
                      (String.substr_replace_all
                         usage
                         ~pattern:"$reporter"
                         ~with_:"worker") )
                ]
            ; Json.obj
                [ "method", Json.string "template.instantiate"
                ; ( "params"
                  , json
                      {|{"template_id":"plan","template_revision":"1","instance_id":"instance","parameters":{"ticket_id":"$runner"}}|}
                  )
                ]
            ] )
      ]
  in
  (match Domain_command.decode ~method_:"transaction.apply" ~params:operations with
   | Ok (Batch [ _; Policy (Usage_report r); Template_instantiate { parameters; _ } ]) ->
     print_s
       [%sexp
         (Id.Actor.to_string r.actor : string)
       , (r.provenance : string)
       , (parameters : (string * string) list)]
   | Ok _ -> failwith "unexpected batch"
   | Error p -> failwith p.message);
  [%expect
    {|
    ok
    Invalid_argument
    ok
    Invalid_argument
    ok
    ok
    (worker $runner ((ticket_id $runner)))
    |}]
;;

let%expect_test "template digest and byte limits protect complete canonical records" =
  let t = template (String.make 6000 'x') in
  let state = put Agent_run_policy.empty (Template_register t) in
  report
    (Agent_run_policy.query
       state
       ~runs:Agent_run.empty
       ~method_:"template.get"
       ~params:
         (json {|{"template_id":"plan","template_revision":"1","max_bytes":"4096"}|}));
  report
    (Agent_run_policy.query
       state
       ~runs:Agent_run.empty
       ~method_:"template.list"
       ~params:(json {|{"max_bytes":"4096"}|}));
  let wire =
    response
      state
      "template.get"
      {|{"template_id":"plan","template_revision":"1","max_bytes":"16384"}|}
  in
  let actual =
    ok (Api_codec.decode Workflow_template_wire.template (Api_response.data wire))
  in
  print_s [%sexp (Workflow_template.equal t actual : bool)];
  let _, raw = Agent_run_policy.encode (Template_register t) in
  let tampered =
    match raw with
    | `Object fs ->
      Json.obj
        (List.Assoc.add
           fs
           ~equal:String.equal
           "digest"
           (Json.string (String.make 64 '0')))
    | _ -> assert false
  in
  report (Agent_run_policy.decode ~method_:"template.register" ~params:tampered);
  let short = put Agent_run_policy.empty (Template_register (template "Small")) in
  let wire = response short "template.list" {|{"max_bytes":"4096"}|} in
  print_s
    [%sexp
      (Api_response.encoded_size
         (Domain_query Policy)
         (ok
            (Agent_run_policy.query
               short
               ~runs:Agent_run.empty
               ~method_:"template.list"
               ~params:(json {|{"max_bytes":"4096"}|})))
       <= 4096
       : bool)];
  print_s
    [%sexp (List.length (Json.list (Json.field (Api_response.data wire) "items")) : int)];
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    true
    Invalid_argument
    true
    1
    |}]
;;

let%expect_test
    "independent canonical asset digest uses reviewer_ids and rejects prototype keys"
  =
  let current =
    json
      {|{"template_id":"plan","template_revision":"1","digest":"5c4ace10a576c42c8dad419f66a1795a59505d6ddaae50937691cf1c532b1c37","spec":{"parameters":["topic"],"nodes":[{"alias":"build","title":"Build {{topic}}","description":"Save evidence","depends_on":[],"parent":null,"capabilities":["ocaml"],"reviewer_ids":["reviewer"],"separate_actor":true}]}}|}
  in
  report (Agent_run_policy.decode ~method_:"template.register" ~params:current);
  let legacy =
    Json.canonical current
    |> String.substr_replace_all ~pattern:"reviewer_ids" ~with_:"reviewers"
    |> json
  in
  report (Agent_run_policy.decode ~method_:"template.register" ~params:legacy);
  report
    (Api_codec.decode
       Usage_record_wire.scope
       (json {|{"kind":"run","run_id":"run","attempt_id":"attempt"}|}));
  report (Api_codec.decode Usage_record_wire.scope (json {|{"run":"run"}|}));
  let invalid = template "Valid" in
  let bad = { invalid with spec = spec (String.of_char (Char.of_int_exn 255)) } in
  report (Agent_run_policy.prepare Agent_run_policy.empty (Template_register bad));
  report
    (Agent_run_policy.apply
       Agent_run_policy.empty
       { Agent_run_policy.Change.revision = 1; command = Template_register bad });
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "template nested alias declarations validate without replacing graph names"
  =
  let alias value = Json.string ("$" ^ value) in
  let replace value key data =
    match value with
    | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key data)
    | _ -> assert false
  in
  let t = template "Literal $asset" in
  let _, registered = Agent_run_policy.encode (Template_register t) in
  let raw_spec = Json.field registered "spec" in
  let raw_node =
    List.hd_exn (Json.list (Json.field raw_spec "nodes"))
    |> fun node -> replace node "reviewer_ids" (`Array [ alias "reviewer" ])
  in
  let registered =
    replace registered "template_id" (alias "asset")
    |> fun r -> replace r "spec" (replace raw_spec "nodes" (`Array [ raw_node ]))
  in
  report
    (Api_codec.decode
       (Option.value_exn
          (Agent_run_policy_api.request_codec ~method_:"template.register"))
       registered);
  let instance =
    ok
      (Workflow_template.instantiate
         t
         ~id:(ok (Workflow_template.Instance_id.of_string "instance"))
         ~parameters:[ "ticket_id", "$asset" ])
  in
  let _, raw = Agent_run_policy.encode (Instance_register instance) in
  let node =
    List.hd_exn (Json.list (Json.field raw "tickets"))
    |> fun n ->
    replace n "ticket_id" (alias "work")
    |> fun n -> replace n "reviewer_ids" (`Array [ alias "reviewer" ])
  in
  let raw =
    replace raw "template_id" (alias "asset")
    |> fun r -> replace r "tickets" (`Array [ node ])
  in
  report
    (Api_codec.decode
       (Option.value_exn
          (Agent_run_policy_api.request_codec ~method_:"template.instance_register"))
       raw);
  report (Agent_run_policy.decode ~method_:"template.instance_register" ~params:raw);
  let malformed = replace registered "template_id" (Json.string "$bad alias") in
  report
    (Api_codec.decode
       (Option.value_exn
          (Agent_run_policy_api.request_codec ~method_:"template.register"))
       malformed);
  report
    (Domain_command.decode
       ~method_:"transaction.apply"
       ~params:
         (json
            {|{"operations":[{"method":"ticket.create","as":"ticket","params":{"ticket_id":"work","title":"Work"}},{"method":"run.budget_put","params":{"target_run_id":"$ticket","expected_revision":"0","max_attempts":null,"max_active_attempts":null,"reported_token_limit":null,"reported_elapsed_ms_limit":null}}]}|}));
  [%expect
    {|
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "budget sexp reader applies the same validated bounds" =
  let read revision attempts =
    Sexp.of_string
      (Printf.sprintf
         "((run run)(revision %d)(max_attempts (%d))(max_active_attempts \
          ())(reported_token_limit ())(reported_elapsed_ms_limit ()))"
         revision
         attempts)
    |> Run_budget.t_of_sexp
  in
  print_s [%sexp (Or_error.is_ok (Or_error.try_with (fun () -> read 1 2)) : bool)];
  print_s [%sexp (Or_error.is_error (Or_error.try_with (fun () -> read 0 2)) : bool)];
  print_s [%sexp (Or_error.is_error (Or_error.try_with (fun () -> read 1 0)) : bool)];
  [%expect
    {|
    true
    true
    true
    |}]
;;
