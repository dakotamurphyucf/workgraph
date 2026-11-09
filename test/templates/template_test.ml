open Core
open Workgraph

let unwrap = Disk.unwrap
let json text = Json.parse text |> unwrap
let actor = Id.Actor.of_string "lead" |> unwrap
let resource = Id.Resource.of_string "plan" |> unwrap

let node =
  { Workflow_template.Node.alias = "work"
  ; title = "Work"
  ; description = ""
  ; depends_on = []
  ; parent = None
  ; capabilities = []
  ; allowed_actor_ids = Actor_eligibility.allowed [ actor ] |> unwrap
  ; reviewers = []
  ; separate_actor = false
  }
;;

let spec = { Workflow_template.Spec.parameters = []; nodes = [ node ] }

let params ~revision =
  Json.obj
    [ "workspace_id", Json.string "w"
    ; "actor_id", Id.Actor.jsonaf_of_t actor
    ; "template_id", Id.Resource.jsonaf_of_t resource
    ; "expected_revision", Json.int revision
    ; "title", Json.string "Plan"
    ; "spec", Workflow_template.Spec.to_json spec
    ]
;;

let prepared state command =
  State.prepare state command ~actor ~timestamp:"2026-11-05" |> unwrap
;;

let apply state command = prepared state command |> State.candidate
let command method_ params = Domain_command.decode ~method_ ~params |> unwrap
let query state method_ params = State.query state ~method_ ~params |> unwrap

let report = function
  | Ok _ -> print_endline "ok"
  | Error (problem : Problem.t) ->
    print_s [%sexp (problem.kind : Problem.kind)];
    Option.iter problem.details ~f:(fun details ->
      print_endline (Json.canonical (Problem.Details.to_json details)))
;;

let replace value key replacement =
  match value with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key replacement)
  | _ -> failwith "object expected"
;;

let initial () =
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Work" |> unwrap
  in
  let template =
    Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
  in
  let state =
    apply
      state
      (Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = Some "Plan"
         ; text = Json.canonical (Workflow_template.Spec.to_json spec)
         ; filename = None
         ; mime_type = None
         })
  in
  apply state (Policy (Template_register template)), template
;;

let instance id : Domain_command.t =
  Template_instantiate
    { template = resource
    ; template_revision = 1
    ; id = Workflow_template.Instance_id.of_string id |> unwrap
    ; parameters = []
    ; bindings = Workflow_template.Bindings.empty
    }
;;

let%expect_test
    "helper captures metadata independently from content version and freezes exact \
     transaction"
  =
  let publication = Template_publication.of_params (params ~revision:7) |> unwrap in
  let version revision =
    { Resource.Version.revision
    ; digest = String.make 64 'a'
    ; size_bytes = Some 2
    ; actor
    ; timestamp = "2026-11-05"
    ; filename = "template.json"
    ; mime_type = "application/json"
    }
  in
  let asset =
    { Resource.id = resource
    ; revision = 7
    ; metadata =
        { title = "Old"
        ; description = ""
        ; archived = false
        ; targets = []
        ; filename = "template.json"
        ; mime_type = "application/json"
        }
    ; versions = [ version 3; version 2; version 1 ]
    }
  in
  let calls = ref 0 in
  let exact =
    Template_publication.prepare publication ~fetch:(fun request ->
      incr calls;
      assert (String.equal (Protocol.Request.method_ request) "resource.get");
      Ok (Json.obj [ "data", Resource_wire.summary_json asset; "meta", Json.obj [] ]))
    |> unwrap
  in
  let operations = Json.field (Protocol.Request.params exact) "operations" |> Json.list in
  let publication = Json.field (List.nth_exn operations 0) "params" in
  let registration = Json.field (List.nth_exn operations 1) "params" in
  printf
    "captures=%d content_version=%d metadata_guard=%d\n"
    !calls
    (Json.integer (Json.field registration "template_revision"))
    (Json.integer (Json.field publication "expected_revision"));
  assert (
    String.equal
      (Json.text (Json.field publication "text"))
      (Json.canonical (Json.field registration "spec")));
  assert (
    String.equal
      (Json.hash (Json.text (Json.field publication "text")))
      (Json.text (Json.field registration "digest")));
  print_endline (Protocol.Request.method_ exact);
  let stale = Template_publication.of_params (params ~revision:6) |> unwrap in
  report
    (Template_publication.prepare stale ~fetch:(fun _ ->
       Ok (Json.obj [ "data", Resource_wire.summary_json asset; "meta", Json.obj [] ])));
  let error = Problem.create Storage_unavailable "original read failure" in
  assert (
    match Template_publication.prepare stale ~fetch:(fun _ -> Error error) with
    | Error actual -> phys_equal actual error
    | Ok _ -> false);
  (try
     ignore
       (Template_publication.prepare stale ~fetch:(fun _ ->
          raise (Eio.Cancel.Cancelled (Failure "cancel")))
        : (_, _) Result.t)
   with
   | Eio.Cancel.Cancelled _ -> print_endline "cancellation propagated");
  [%expect
    {|
    captures=1 content_version=4 metadata_guard=7
    transaction.apply
    Conflict
    {"actual":"7","expected":"6","type":"revision"}
    cancellation propagated
    |}]
;;

let%expect_test
    "new registration final-state and replay gates do not freeze later ordinary edits"
  =
  let state, template = initial () in
  let id = Workflow_template.Instance_id.of_string "instance" |> unwrap in
  let plan =
    Workflow_template.instantiate
      template
      ~id
      ~bindings:Workflow_template.Bindings.empty
      ~parameters:[]
    |> unwrap
  in
  let ticket = (List.hd_exn plan.tickets).ticket in
  let strip : Domain_command.t =
    Agent_run
      (Ticket_policy_put
         { ticket
         ; expected_revision = 1
         ; required_capabilities = []
         ; pools = []
         ; allowed_actor_ids = Some Actor_eligibility.unrestricted
         })
  in
  report
    (State.prepare
       state
       (Batch [ instance "instance"; strip ])
       ~actor
       ~timestamp:"2026-11-05");
  let created = prepared state (instance "instance") in
  let after = State.candidate created in
  report (State.prepare after strip ~actor ~timestamp:"2026-11-05");
  let events = State.events created in
  let rec loosen = function
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "allowed_actor_ids" then `Null else loosen value))
    | `Array values -> `Array (List.map values ~f:loosen)
    | value -> value
  in
  let changed = ref false in
  let changes =
    Json.field events "changes"
    |> Json.list
    |> List.map ~f:(function
      | `Array [ `String "Agent_run_changed"; payload ] ->
        changed := true;
        `Array [ Json.string "Agent_run_changed"; loosen payload ]
      | value -> value)
  in
  assert !changed;
  report (State.replay state (replace events "changes" (`Array changes)));
  let replayed = State.replay state events |> unwrap in
  assert (
    String.equal
      (Json.canonical (State.to_json replayed))
      (Json.canonical (State.to_json after)));
  print_endline "deterministic replay";
  [%expect
    {|
    Conflict
    ok
    Conflict
    deterministic replay
    |}]
;;

let%expect_test
    "typed registration errors preserve missing resource, content version and digest \
     identity"
  =
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Work" |> unwrap
  in
  let template =
    Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
  in
  report
    (State.prepare
       state
       (Policy (Template_register template))
       ~actor
       ~timestamp:"2026-11-05");
  let state =
    apply
      state
      (Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = Some "Wrong bytes"
         ; text = "{}"
         ; filename = None
         ; mime_type = None
         })
  in
  let missing = { template with resource_revision = 2 } in
  report
    (State.prepare
       state
       (Policy (Template_register missing))
       ~actor
       ~timestamp:"2026-11-05");
  report
    (State.prepare
       state
       (Policy (Template_register template))
       ~actor
       ~timestamp:"2026-11-05");
  [%expect
    {|
    Not_found
    {"expected":"published template resource","path":["template_id"],"suggestion":"Use template.publish to publish the canonical specification before registration.","type":"field"}
    Not_found
    {"expected":"retained immutable template content version","path":["template_revision"],"suggestion":"Use template.publish to publish the canonical specification before registration.","type":"field"}
    Conflict
    {"expected":"SHA256 of canonical published specification","path":["digest"],"suggestion":"Use template.publish to canonicalize, publish and register atomically.","type":"field"}
    |}]
;;

let%expect_test "parent topological ordering and bound actor-only gates are deterministic"
  =
  let parent = { node with alias = "z-parent" } in
  let child = { node with alias = "a-child"; parent = Some "z-parent" } in
  let template =
    Workflow_template.create
      ~resource
      ~resource_revision:1
      ~spec:{ spec with nodes = [ child; parent ] }
    |> unwrap
  in
  let id = Workflow_template.Instance_id.of_string "tree" |> unwrap in
  let plan =
    Workflow_template.instantiate
      template
      ~id
      ~bindings:Workflow_template.Bindings.empty
      ~parameters:[]
    |> unwrap
  in
  print_s
    [%sexp
      (List.map plan.tickets ~f:(fun node -> node.Workflow_template.Planned_ticket.alias)
       : string list)];
  let generated = (List.hd_exn plan.tickets).ticket in
  report
    (Workflow_template.instantiate
       template
       ~id
       ~bindings:{ Workflow_template.Bindings.empty with parent = Some generated }
       ~parameters:[]);
  let nodes =
    List.init (Transaction_limit.max_operations / 2) ~f:(fun i ->
      { node with alias = "n" ^ Int.to_string i })
  in
  report (Workflow_template.Spec.validate { spec with nodes });
  report
    (Workflow_template.Spec.validate
       { spec with nodes = [ { parent with parent = Some "a-child" }; child ] });
  [%expect
    {|
    (z-parent a-child)
    Dependency_cycle
    Invalid_argument
    Dependency_cycle
    |}]
;;

let%expect_test
    "role gates survive registration final state and durable replay, then allow later \
     edits"
  =
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Work" |> unwrap
  in
  let state =
    apply
      state
      (command
         "actor.put"
         (json
            {|{"target_actor_id":"lead","expected_revision":"0","name":"Lead","kind":"agent"}|}))
  in
  let reviewers =
    [ Acceptance_policy.Requirement.Role { name = "review"; members = [ actor ] } ]
  in
  let spec = { spec with nodes = [ { node with reviewers } ] } in
  let template =
    Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
  in
  let state =
    apply
      state
      (Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = Some "Plan"
         ; text = Json.canonical (Workflow_template.Spec.to_json spec)
         ; filename = None
         ; mime_type = None
         })
  in
  let state = apply state (Policy (Template_register template)) in
  let id = Workflow_template.Instance_id.of_string "roles" |> unwrap in
  let plan =
    Workflow_template.instantiate
      template
      ~id
      ~bindings:Workflow_template.Bindings.empty
      ~parameters:[]
    |> unwrap
  in
  let ticket = (List.hd_exn plan.tickets).ticket in
  let instantiate : Domain_command.t =
    Template_instantiate
      { template = resource
      ; template_revision = 1
      ; id
      ; parameters = []
      ; bindings = Workflow_template.Bindings.empty
      }
  in
  let strip : Domain_command.t =
    Evidence
      (Policy_put
         { ticket
         ; expected_revision = 1
         ; enabled = false
         ; reviewers = []
         ; separate_actor = false
         ; validators = []
         ; weakening_reason = Some "Approved ordinary later policy edit"
         })
  in
  report
    (State.prepare state (Batch [ instantiate; strip ]) ~actor ~timestamp:"2026-11-05");
  let created = prepared state instantiate in
  report (State.prepare (State.candidate created) strip ~actor ~timestamp:"2026-11-05");
  let events = State.events created in
  let rec strip_reviewers = function
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "reviewers" then `Array [] else strip_reviewers value))
    | `Array values -> `Array (List.map values ~f:strip_reviewers)
    | value -> value
  in
  let changed = ref false in
  let changes =
    Json.field events "changes"
    |> Json.list
    |> List.map ~f:(function
      | `Array [ `String "Evidence_changed"; payload ] ->
        changed := true;
        `Array [ Json.string "Evidence_changed"; strip_reviewers payload ]
      | value -> value)
  in
  assert !changed;
  report (State.replay state (replace events "changes" (`Array changes)));
  let missing_project =
    { Workflow_template.Bindings.empty with
      project = Some (Id.Project.of_string "absent" |> unwrap)
    }
  in
  let missing : Domain_command.t =
    Template_instantiate
      { template = resource
      ; template_revision = 1
      ; id
      ; parameters = []
      ; bindings = missing_project
      }
  in
  report (State.prepare state missing ~actor ~timestamp:"2026-11-05");
  assert (
    Result.is_error
      (State.query
         state
         ~method_:"template.instance_get"
         ~params:
           (Json.obj [ "instance_id", Workflow_template.Instance_id.jsonaf_of_t id ])));
  [%expect
    {|
    Conflict
    ok
    Conflict
    Not_found
    |}]
;;

let%expect_test
    "helper and public spec decoders reject malformed actor and role gates before capture"
  =
  let wire = Workflow_template.Spec.to_json spec in
  let raw_node = List.hd_exn (Json.list (Json.field wire "nodes")) in
  let malformed_nodes =
    [ replace raw_node "allowed_actor_ids" (`Array [])
    ; replace
        raw_node
        "reviewers"
        (json {|[{"kind":"role","name":"review","member_ids":[]}]|})
    ; replace
        raw_node
        "reviewers"
        (json {|[{"kind":"role","name":"review","member_ids":["lead","lead"]}]|})
    ; replace
        raw_node
        "reviewers"
        (json {|[{"kind":"actor","actor_id":"lead"},{"kind":"actor","actor_id":"lead"}]|})
    ]
  in
  let kind = function
    | Ok _ -> print_endline "ok"
    | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
  in
  List.iter malformed_nodes ~f:(fun node ->
    let malformed = replace wire "nodes" (`Array [ node ]) in
    kind (Workflow_template.Spec.of_json malformed);
    kind (Api_codec.decode Workflow_template_wire.spec malformed);
    kind (Template_publication.of_params (replace (params ~revision:0) "spec" malformed)));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "transaction alias resolution preserves actor restriction kinds" =
  let template =
    Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
  in
  let _, registration = Agent_run_policy.encode (Template_register template) in
  let wire = Json.field registration "spec" in
  let raw_node = List.hd_exn (Json.list (Json.field wire "nodes")) in
  let registration =
    replace
      registration
      "spec"
      (replace
         wire
         "nodes"
         (`Array [ replace raw_node "allowed_actor_ids" (json {|["$asset"]|}) ]))
  in
  let operations =
    `Array
      [ json
          {|{"method":"resource.put_text","as":"asset","params":{"resource_id":"asset","expected_revision":"0","title":"Asset","text":"{}"}}|}
      ; Json.obj [ "method", Json.string "template.register"; "params", registration ]
      ]
  in
  (match
     Domain_command.decode
       ~method_:"transaction.apply"
       ~params:(Json.obj [ "operations", operations ])
   with
   | Ok _ -> failwith "resource alias admitted as actor restriction"
   | Error problem -> print_endline problem.message);
  [%expect {| alias entity kind mismatch: asset |}]
;;

let%expect_test "publication capture race fails exact resource guard without registering" =
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Work" |> unwrap
  in
  let publication = Template_publication.of_params (params ~revision:0) |> unwrap in
  let exact =
    Template_publication.prepare publication ~fetch:(fun _ ->
      Error (Problem.create Not_found "resource missing"))
    |> unwrap
  in
  let changed =
    apply
      state
      (Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = Some "Racing writer"
         ; text = "{}"
         ; filename = None
         ; mime_type = None
         })
  in
  let fields =
    match Protocol.Request.params exact with
    | `Object fields -> fields
    | _ -> assert false
  in
  let command_params =
    Json.obj (List.filter fields ~f:(fun (key, _) -> String.equal key "operations"))
  in
  let exact =
    Domain_command.decode ~method_:(Protocol.Request.method_ exact) ~params:command_params
    |> unwrap
  in
  report (State.prepare changed exact ~actor ~timestamp:"2026-11-05");
  report
    (State.query
       changed
       ~method_:"template.get"
       ~params:(json {|{"template_id":"plan","template_revision":"1"}|}));
  [%expect
    {|
    Conflict
    {"actual":"1","expected":"0","type":"revision"}
    Not_found
    |}]
;;

let%expect_test
    "instance placement raw references resolve with their declared entity kinds"
  =
  let _, template = initial () in
  let project = Id.Project.of_string "project" |> unwrap in
  let bindings = { Workflow_template.Bindings.empty with project = Some project } in
  let plan =
    Workflow_template.instantiate
      template
      ~id:(Workflow_template.Instance_id.of_string "placed" |> unwrap)
      ~bindings
      ~parameters:[]
    |> unwrap
  in
  let _, raw = Agent_run_policy.encode (Instance_register plan) in
  let raw_bindings =
    replace (Json.field raw "bindings") "project_id" (Json.string "$placement")
  in
  let registration = replace raw "bindings" raw_bindings in
  let operations =
    `Array
      [ json
          {|{"method":"project.create","as":"placement","params":{"project_id":"project","title":"Project"}}|}
      ; Json.obj
          [ "method", Json.string "template.instance_register"; "params", registration ]
      ]
  in
  (match
     Domain_command.decode
       ~method_:"transaction.apply"
       ~params:(Json.obj [ "operations", operations ])
     |> unwrap
   with
   | Batch [ _; Policy (Instance_register actual) ] ->
     assert (Workflow_template.Bindings.equal actual.bindings bindings);
     print_endline "resolved project placement"
   | _ -> failwith "unexpected transaction projection");
  report (Api_codec.decode Workflow_template.Bindings.codec raw_bindings);
  report (Api_codec.decode Workflow_template.Bindings.raw_codec raw_bindings);
  [%expect
    {|
    resolved project placement
    Invalid_argument
    {"expected":"IDs require 1..96 ASCII letters, digits, underscores or hyphens","path":["project_id"],"suggestion":null,"type":"field"}
    ok
    |}]
;;

let%expect_test "template node and expanded policy bounds share the transaction cap" =
  let nodes =
    List.init (Transaction_limit.max_operations - 1) ~f:(fun index ->
      { node with
        alias = "work-" ^ Int.to_string index
      ; allowed_actor_ids = Actor_eligibility.unrestricted
      })
  in
  let spec = { spec with nodes } in
  report (Workflow_template.Spec.validate spec);
  report (Workflow_template.Spec.of_json (Workflow_template.Spec.to_json spec));
  report
    (Api_codec.decode Workflow_template_wire.spec (Workflow_template.Spec.to_json spec));
  let extra_policy =
    { spec with
      nodes =
        List.mapi nodes ~f:(fun index node ->
          if index = 0 then { node with capabilities = [ "ocaml" ] } else node)
    }
  in
  report (Workflow_template.Spec.validate extra_policy);
  report (Workflow_template.Spec.of_json (Workflow_template.Spec.to_json extra_policy));
  report
    (Api_codec.decode
       Workflow_template_wire.spec
       (Workflow_template.Spec.to_json extra_policy));
  let too_many_nodes = { spec with nodes = { node with alias = "extra" } :: nodes } in
  report (Workflow_template.Spec.validate too_many_nodes);
  report
    (Api_codec.decode
       Workflow_template_wire.spec
       (Workflow_template.Spec.to_json too_many_nodes));
  [%expect
    {|
    ok
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    {"expected":"expected at most 127 items","path":["nodes"],"suggestion":null,"type":"field"}
    |}]
;;

let%expect_test
    "preflight reports the exact staged expansion accumulator, not source or event count"
  =
  let empty () =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Work" |> unwrap
  in
  let publication spec =
    let template =
      Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
    in
    [ Domain_command.Resource_put
        { id = resource
        ; expected_revision = 0
        ; title = Some "Plan"
        ; text = Json.canonical (Workflow_template.Spec.to_json spec)
        ; filename = None
        ; mime_type = None
        }
    ; Policy (Template_register template)
    ]
  in
  let ticket = command "ticket.create" (json {|{"ticket_id":"extra","title":"Extra"}|}) in
  let request commands =
    let _, params = Wire_command.encode (Domain_command.Batch commands) |> unwrap in
    Api_codec.decode
      Preflight_api.Request.codec
      (replace params "actor_id" (Id.Actor.jsonaf_of_t actor))
    |> unwrap
  in
  let preview state commands =
    Transaction_preflight.run
      state
      (request commands)
      ~now_unix_ms:1L
      ~timestamp:"2026-11-05"
      ~fresh:(fun _ -> failwith "All fixture IDs are explicit")
  in
  let check label state commands =
    let before = Json.canonical (State.to_json state) in
    let summary = preview state commands |> unwrap in
    let actual = prepared state (Batch commands) in
    printf
      "%s source=%d preflight=%d prepared=%d unchanged=%b\n"
      label
      (List.length commands)
      summary.operation_count
      (State.expanded_operation_count actual)
      (String.equal before (Json.canonical (State.to_json state)));
    State.candidate actual
  in
  let state, _ = initial () in
  let after = check "fresh" state [ instance "fresh" ] in
  ignore (check "existing" after [ instance "fresh" ] : State.t);
  ignore (check "mixed" state [ ticket; instance "mixed" ] : State.t);
  ignore (check "staged-existing" state [ instance "same"; instance "same" ] : State.t);
  ignore
    (check "same-batch-publication" (empty ()) (publication spec @ [ instance "inline" ])
     : State.t);
  let bulk =
    { spec with
      nodes =
        List.init 127 ~f:(fun index ->
          { node with
            alias = "bulk-" ^ Int.to_string index
          ; allowed_actor_ids = Actor_eligibility.unrestricted
          })
    }
  in
  let full = apply (empty ()) (Batch (publication bulk)) in
  let bulk_after = check "limit" full [ instance "bulk" ] in
  ignore (check "existing-at-limit" bulk_after [ instance "bulk"; ticket ] : State.t);
  let before = Json.canonical (State.to_json full) in
  report (preview full [ instance "over"; ticket ]);
  report
    (State.prepare full (Batch [ instance "over"; ticket ]) ~actor ~timestamp:"fixture");
  printf
    "limit-rejection-unchanged=%b\n"
    (String.equal before (Json.canonical (State.to_json full)));
  [%expect
    {|
    fresh source=1 preflight=3 prepared=3 unchanged=true
    existing source=1 preflight=1 prepared=1 unchanged=true
    mixed source=2 preflight=4 prepared=4 unchanged=true
    staged-existing source=2 preflight=4 prepared=4 unchanged=true
    same-batch-publication source=3 preflight=5 prepared=5 unchanged=true
    limit source=1 preflight=128 prepared=128 unchanged=true
    existing-at-limit source=2 preflight=2 prepared=2 unchanged=true
    Invalid_argument
    Invalid_argument
    limit-rejection-unchanged=true
    |}]
;;
