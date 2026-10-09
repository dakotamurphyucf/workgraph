open Core
open Workgraph

let json = Jsonaf.of_string

let print_result = function
  | Ok _ -> print_endline "ok"
  | Error error -> print_endline error.Problem.message
;;

let validate method_ params =
  match Planning_api.validate_request ~method_ ~params:(json params) with
  | None -> print_endline "unknown method"
  | Some result -> print_result result
;;

let%expect_test "public generated IDs and resolved commands have distinct stages" =
  validate "project.create" {|{"title":"Project"}|};
  print_result
    (Domain_command.decode
       ~method_:"project.create"
       ~params:(json {|{"title":"Project"}|}));
  let resolved =
    Id_resolution.resolve
      ~method_:"project.create"
      ~params:(json {|{"title":"Project"}|})
      ~fresh:(fun _ -> "generated")
  in
  (match resolved with
   | Error error -> print_endline error.message
   | Ok params -> print_result (Domain_command.decode ~method_:"project.create" ~params));
  [%expect
    {| 
    ok
    unresolved generated ID: project_id
    ok
  |}]
;;

let%expect_test "the declared request codec validates omission null and enums" =
  validate
    "ticket.metadata"
    {|{"ticket_id":"t","expected_revision":"1","assignee_id":null}|};
  validate "ticket.update" {|{"ticket_id":"t","expected_revision":"1","title":null}|};
  validate "ticket.update" {|{"ticket_id":"t","expected_revision":"1","status":"Todo"}|};
  validate "ticket.update" {|{"ticket_id":"t","expected_revision":"1","ticket":"t"}|};
  [%expect
    {|
    ok
    /title: expected string
    /status: expected one of: backlog, todo, in_progress, done, canceled
    /ticket: unknown field
  |}]
;;

let%expect_test "aliases resolve in typed scalar and tagged target positions" =
  validate "ticket.create" {|{"title":"Ticket","project_id":"$project"}|};
  let params =
    json
      {|{"operations":[{"method":"project.create","params":{"title":"Project"},"as":"project"},{"method":"ticket.create","params":{"title":"Ticket","project_id":"$project"},"as":"ticket"},{"method":"comment.add","params":{"target":{"kind":"ticket","id":"$ticket"},"body":"hello"}}]}|}
  in
  let next = ref 0 in
  let resolved =
    Id_resolution.resolve ~method_:"transaction.apply" ~params ~fresh:(fun _ ->
      incr next;
      "generated_" ^ Int.to_string !next)
  in
  (match resolved with
   | Error error -> print_endline error.message
   | Ok params ->
     (match Domain_command.decode ~method_:"transaction.apply" ~params with
      | Ok (Batch [ Project_create p; Ticket_create t; Comment_add c ]) ->
        print_endline (Id.Project.to_string p.id);
        print_endline
          (Option.value_map t.project ~default:"missing" ~f:Id.Project.to_string);
        print_endline (Jsonaf.to_string (Entity_ref.jsonaf_of_t c.target))
      | Ok _ -> print_endline "unexpected commands"
      | Error error -> print_endline error.message));
  [%expect
    {|
    ok
    generated_1
    generated_1
    {"kind":"ticket","id":"generated_2"}
  |}]
;;

let%expect_test "tagged codecs enforce the selected branch" =
  print_result
    (Api_codec.decode
       Planning_target.scope_codec
       (json {|{"kind":"workspace","id":"x"}|}));
  print_result
    (Api_codec.decode Planning_target.scope_codec (json {|{"kind":"resource","id":"r"}|}));
  print_result
    (Api_codec.decode Planning_target.codec (json {|{"kind":"ticket","id":"$new"}|}));
  [%expect
    {|
    /id: unknown field
    /kind: unknown tagged object kind
    ok
  |}]
;;

let%expect_test "schemas derive optional generated IDs and exact fields" =
  let schema = Option.value_exn (Planning_api.request_schema ~method_:"project.create") in
  print_endline (Jsonaf.to_string (Json.field schema "required"));
  let properties = Json.field schema "properties" in
  print_endline (Jsonaf.to_string (Json.field properties "project_id"));
  [%expect
    {|
    ["title"]
    {"allOf":[{"type":"string","x-maxUtf8Bytes":97}],"description":"Opaque ID, or $alias within transaction.apply; aliases resolve before command preparation."}
  |}]
;;

let%expect_test "fact values preserve literal aliases while scopes resolve" =
  let params =
    json
      {|{"operations":[{"method":"ticket.create","as":"task","params":{"ticket_id":"t","title":"Ticket"}},{"method":"fact.put","params":{"scope":{"kind":"ticket","id":"$task"},"key":"literal","expected_revision":"0","value":{"ticket_id":"$task","target":{"kind":"project","id":"$unknown"},"array":[{"run_id":"$task"}]}}}]}|}
  in
  match Domain_command.decode ~method_:"transaction.apply" ~params with
  | Ok (Batch [ Ticket_create _; Facts (Facts.Command.Put { scope; value; _ }) ]) ->
    print_endline (Jsonaf.to_string (Entity_ref.jsonaf_of_t (Facts.Scope.target scope)));
    print_endline (Jsonaf.to_string (Facts.Value.to_json value));
    [%expect
      {|
      {"kind":"ticket","id":"t"}
      {"ticket_id":"$task","target":{"kind":"project","id":"$unknown"},"array":[{"run_id":"$task"}]}
    |}]
  | Ok _ -> failwith "unexpected commands"
  | Error error -> failwith error.message
;;

let%expect_test "resource generation and Gregorian date invariants validate publicly" =
  validate "resource.put_text" {|{"expected_revision":"0","title":"Resource","text":""}|};
  validate "resource.put_text" {|{"expected_revision":"1","title":"Resource","text":""}|};
  validate
    "milestone.create"
    {|{"project_id":"p","title":"M","target_date":"2024-02-29"}|};
  validate
    "milestone.create"
    {|{"project_id":"p","title":"M","target_date":"2025-02-29"}|};
  validate
    "milestone.create"
    {|{"project_id":"p","title":"M","target_date":"--24-02-29"}|};
  [%expect
    {|
    ok
    resource_id is required when expected_revision is nonzero
    ok
    /target_date: target_date must be a valid YYYY-MM-DD date
    /target_date: target_date must be a valid YYYY-MM-DD date
  |}]
;;

let%expect_test "method descriptors execute their real request and receipt codecs" =
  let call params =
    match
      Planning_api.invoke_resolved
        ~method_:"ticket.release"
        ~params:(json params)
        ~f:(fun _ -> Ok (json {|{"released":true}|}))
    with
    | None -> failwith "missing descriptor"
    | Some result -> print_result result
  in
  call {|{"ticket_id":"t","token":"1"}|};
  call {|{"ticket_id":"t","token":1}|};
  let called = ref false in
  (try
     ignore
       (Planning_api.invoke_resolved
          ~method_:"ticket.release"
          ~params:(json {|{"ticket_id":"t","token":"1"}|})
          ~f:(fun _ ->
            called := true;
            Ok (json {|{"wrong":true}|}))
        : _)
   with
   | Api_method.Invalid_response (method_, _) -> print_endline method_);
  printf "handler ran: %b\n" !called;
  [%expect
    {|
    ok
    /token: expected canonical decimal string in 0..4611686018427387903
    ticket.release
    handler ran: true
  |}]
;;

let%expect_test "template receipts use canonical typed projections and closed operations" =
  let get = function
    | Ok value -> value
    | Error error -> failwith error.Problem.message
  in
  let plan : Workflow_template.Instance.t =
    { id = get (Workflow_template.Instance_id.of_string "instance")
    ; template = get (Id.Resource.of_string "template")
    ; template_revision = 1
    ; parameters = [ "title", "Literal $value" ]
    ; tickets =
        [ { alias = "build"
          ; ticket = get (Id.Ticket.of_string "instance-build")
          ; title = "Build"
          ; description = ""
          ; dependencies = []
          ; parent = None
          ; capabilities = []
          ; reviewers = []
          ; separate_actor = false
          }
        ]
    }
  in
  let operation =
    get
      (Planning_result.Template.operation
         Instance_register
         ~data:(json {|{"revision":"4","duplicate":true}|}))
  in
  let receipt =
    get (Planning_result.Template.create plan ~results:[ operation ] ~duplicate:true)
  in
  print_endline (Json.canonical receipt);
  print_result (Api_codec.decode Planning_result.Template.codec receipt);
  print_result
    (Planning_result.Template.operation
       Ticket_policy_put
       ~data:(json {|{"revision":"4","extra":true}|}));
  let policy : Evidence.Policy.t =
    { ticket = get (Id.Ticket.of_string "instance-build")
    ; revision = 1
    ; enabled = true
    ; reviewers =
        [ Role { name = "reviewer"; members = [ get (Id.Actor.of_string "actor") ] } ]
    ; separate_actor = true
    ; validators = []
    }
  in
  let review = get (Planning_result.Template.review_policy policy) in
  print_endline (Json.canonical review);
  print_result (Planning_result.Template.operation Review_policy_put ~data:review);
  [%expect
    {|
    {"duplicate":true,"instance":{"instance_id":"instance","parameters":{"title":"Literal $value"},"template_id":"template","template_revision":"1","tickets":[{"alias":"build","capabilities":[],"description":"","parent_ticket_id":null,"prerequisite_ticket_ids":[],"reviewer_ids":[],"separate_actor":false,"ticket_id":"instance-build","title":"Build"}]},"results":[{"data":{"duplicate":true,"revision":"4"},"kind":"instance_register"}]}
    ok
    /extra: unknown field
    {"enabled":true,"reviewers":[{"kind":"role","member_ids":["actor"],"name":"reviewer"}],"revision":"1","separate_actor":true,"ticket_id":"instance-build","validators":[]}
    ok
    |}]
;;

let%expect_test "operation discriminators accept dotted methods and reject unknown names" =
  let request = Option.value_exn (Planning_api.request_codec ~method_:"project.create") in
  let codec =
    Planning_api.Operation.codec
      ~requests:[ "project.create", request ]
      ~creation_methods:[ "project.create" ]
  in
  print_result
    (Api_codec.decode
       codec
       (json {|{"method":"project.create","params":{"title":"Project"},"as":"project"}|}));
  print_result
    (Api_codec.decode
       codec
       (json {|{"method":"project.update","params":{"title":"Project"}}|}));
  [%expect
    {|
    ok
    /method: unknown tagged object kind
    |}]
;;

let%expect_test "template staging validates exact initial and duplicate receipts" =
  let get = function
    | Ok value -> value
    | Error error -> failwith error.Problem.message
  in
  let actor = get (Id.Actor.of_string "agent") in
  let prepare state command =
    get (State.prepare state command ~actor ~timestamp:"template-test")
  in
  let apply state command = State.candidate (prepare state command) in
  let state =
    get
      (State.empty
         ~workspace:(get (Id.Workspace.of_string "workspace"))
         ~name:"Workspace")
  in
  let reviewer = get (Id.Actor.of_string "reviewer") in
  let state =
    apply
      state
      (get
         (Domain_command.decode
            ~method_:"actor.put"
            ~params:
              (json
                 {|{"target_actor_id":"reviewer","expected_revision":"0","name":"Reviewer","kind":"agent"}|})))
  in
  let first : Workflow_template.Node.t =
    { alias = "first"
    ; title = "First"
    ; description = ""
    ; depends_on = []
    ; parent = None
    ; capabilities = []
    ; reviewers = []
    ; separate_actor = false
    }
  in
  let second =
    { first with
      alias = "second"
    ; title = "Second"
    ; depends_on = [ "first" ]
    ; capabilities = [ "ocaml" ]
    ; reviewers = [ reviewer ]
    ; separate_actor = true
    }
  in
  let spec : Workflow_template.Spec.t = { parameters = []; nodes = [ first; second ] } in
  let resource = get (Id.Resource.of_string "template") in
  let state =
    apply
      state
      (Domain_command.Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = "Template"
         ; text = Json.canonical (Workflow_template.Spec.to_json spec)
         ; filename = None
         ; mime_type = None
         })
  in
  let template = get (Workflow_template.create ~resource ~resource_revision:1 ~spec) in
  let state = apply state (Domain_command.Policy (Template_register template)) in
  let command =
    Domain_command.Template_instantiate
      { template = resource
      ; template_revision = 1
      ; id = get (Workflow_template.Instance_id.of_string "instance")
      ; parameters = []
      }
  in
  let prepared = prepare state command in
  let receipt = State.result prepared in
  print_result (Api_codec.decode Planning_result.Template.codec receipt);
  List.iter
    (Json.list (Json.field receipt "results"))
    ~f:(fun result -> print_endline (Json.text (Json.field result "kind")));
  let replayed = get (State.replay state (State.events prepared)) in
  let duplicate = prepare replayed command |> State.result in
  print_result (Api_codec.decode Planning_result.Template.codec duplicate);
  print_endline (Json.canonical (Json.field duplicate "duplicate"));
  printf
    "retry operations=%d\n"
    (List.length (Json.list (Json.field duplicate "results")));
  [%expect
    {|
    ok
    ticket_create
    ticket_create
    dependency_add
    ticket_policy_put
    review_policy_put
    instance_register
    ok
    true
    retry operations=1
    |}]
;;
