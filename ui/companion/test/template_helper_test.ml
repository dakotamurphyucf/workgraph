open Core
open Workgraph
open Workgraph_ui

let json text = Json.parse text |> Disk.unwrap
let resource = Id.Resource.of_string "template" |> Disk.unwrap
let actor = Id.Actor.of_string "author" |> Disk.unwrap

let node alias title parent depends_on =
  { Workflow_template.Node.alias
  ; title
  ; description = "Literal {{name}}"
  ; parent
  ; depends_on
  ; capabilities = [ "implementation" ]
  ; allowed_actor_ids = Actor_eligibility.allowed [ actor ] |> Disk.unwrap
  ; reviewers = []
  ; separate_actor = false
  }
;;

let spec =
  { Workflow_template.Spec.parameters = [ "name" ]
  ; nodes =
      [ node "z-child" "Child {{name}}" (Some "a-parent") [ "a-parent" ]
      ; node "a-parent" "Parent {{name}}" None []
      ]
  }
;;

let template =
  Workflow_template.create ~resource ~resource_revision:4 ~spec |> Disk.unwrap
;;

let public_template template =
  Api_response.project
    (Domain_query Policy)
    (Json.obj
       [ "revision", Json.int 20
       ; ( "record"
         , Api_codec.encode Workflow_template_wire.template template |> Disk.unwrap )
       ])
  |> Api_response.to_json
;;

let params () =
  Json.obj
    [ "workspace_id", Json.string "workspace"
    ; "actor_id", Id.Actor.jsonaf_of_t actor
    ; "run_id", Json.string "run"
    ; "template_id", Id.Resource.jsonaf_of_t resource
    ; "template_revision", Json.int 4
    ; "expected_digest", Json.string template.digest
    ; "instance_id", Json.string "instance"
    ; "parameters", json {|{"name":"{{not-recursive}}<tag>"}|}
    ; "project_id", Json.string "project"
    ]
;;

let replace value key replacement =
  match value with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key replacement)
  | _ -> assert false
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error (problem : Problem.t) -> print_endline (Problem.wire_name problem.kind)
;;

let publication_params () =
  Json.obj
    [ "workspace_id", Json.string "workspace"
    ; "actor_id", Id.Actor.jsonaf_of_t actor
    ; "template_id", Id.Resource.jsonaf_of_t resource
    ; "expected_revision", Json.int 7
    ; "title", Json.string "Template"
    ; "spec", Api_codec.encode Workflow_template_wire.spec spec |> Disk.unwrap
    ]
;;

let captured_resource () =
  let version revision =
    { Resource.Version.revision
    ; digest = String.make 64 'a'
    ; size_bytes = Some 2
    ; actor
    ; timestamp = "2026-11-07"
    ; filename = "template.json"
    ; mime_type = "application/json"
    }
  in
  Resource_wire.summary_json
    { Resource.id = resource
    ; revision = 7
    ; metadata =
        { title = "Old template"
        ; description = ""
        ; archived = false
        ; targets = []
        ; filename = "template.json"
        ; mime_type = "application/json"
        }
    ; versions = [ version 3; version 2; version 1 ]
    }
;;

let%expect_test "publication freezes native canonical spec and independent revisions" =
  let input =
    Template_helper.Publication.of_params (publication_params ()) |> Disk.unwrap
  in
  let captures = ref 0 in
  let request =
    Template_helper.Publication.prepare input ~fetch:(fun request ->
      incr captures;
      assert (String.equal (Protocol.Request.method_ request) "resource.get");
      Ok (Json.obj [ "data", captured_resource (); "meta", Json.obj [] ]))
    |> Disk.unwrap
  in
  let operations =
    Json.field (Protocol.Request.params request) "operations" |> Json.list
  in
  let publication = Json.field (List.nth_exn operations 0) "params" in
  let registration = Json.field (List.nth_exn operations 1) "params" in
  printf
    "captures=%d metadata_guard=%d content_version=%d method=%s\n"
    !captures
    (Json.field publication "expected_revision" |> Json.integer)
    (Json.field registration "template_revision" |> Json.integer)
    (Protocol.Request.method_ request);
  let text = Json.field publication "text" |> Json.text in
  assert (String.equal text (Json.canonical (Json.field registration "spec")));
  assert (String.equal (Json.hash text) (Json.field registration "digest" |> Json.text));
  State_tests.with_root (fun env root ->
    let random = Eio.Stdenv.secure_random env in
    let store = Operation_store.create ~root ~random |> Disk.unwrap in
    let input =
      Operation.Preparation.create
        ~intention_id:"publication"
        ~connection:(State_tests.profile ())
        ~context:(State_tests.context ~workspace:"workspace" ())
        ~method_:(Protocol.Request.method_ request)
        ~params:(Protocol.Request.params request)
      |> Disk.unwrap
    in
    let first = State_tests.prepared store input in
    let sending =
      Operation_store.admit store ~id:(Operation.id first) ~retry:false |> Disk.unwrap
    in
    let loaded = Operation_store.create ~root ~random |> Disk.unwrap in
    let retried =
      Operation_store.admit loaded ~id:(Operation.id first) ~retry:true |> Disk.unwrap
    in
    assert (
      String.equal
        (Json.canonical (Protocol.Request.to_json (Operation.request sending)))
        (Json.canonical (Protocol.Request.to_json (Operation.request retried))));
    ignore (State_tests.prepared loaded input : Operation.t);
    printf "after journal/reload/exact retry captures=%d\n" !captures);
  [%expect
    {|
    captures=1 metadata_guard=7 content_version=4 method=transaction.apply
    after journal/reload/exact retry captures=1
    |}]
;;

let%expect_test "publication validation and exception propagation" =
  report
    (Template_helper.Publication.of_params
       (replace (publication_params ()) "unknown" `True));
  let duplicate =
    match publication_params () with
    | `Object fields -> `Object (("title", Json.string "Duplicate") :: fields)
    | _ -> assert false
  in
  report (Template_helper.Publication.of_params duplicate);
  let input =
    Template_helper.Publication.of_params (publication_params ()) |> Disk.unwrap
  in
  (try
     ignore
       (Template_helper.Publication.prepare input ~fetch:(fun _ ->
          raise (Eio.Cancel.Cancelled (Failure "cancel")))
        : (_, _) Result.t)
   with
   | Eio.Cancel.Cancelled _ -> print_endline "publication cancellation propagated");
  (try
     ignore
       (Template_helper.Publication.prepare input ~fetch:(fun _ -> failwith "unexpected")
        : (_, _) Result.t)
   with
   | Failure message when String.equal message "unexpected" ->
     print_endline "publication unexpected exception propagated");
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    publication cancellation propagated
    publication unexpected exception propagated
    |}]
;;

let%expect_test "public template capture, native substitution/order and original mutation"
  =
  let input = Template_helper.Instance_preview.of_params (params ()) |> Disk.unwrap in
  let calls = ref 0 in
  let prepared =
    Template_helper.Instance_preview.prepare input ~fetch:(fun request ->
      incr calls;
      assert (String.equal (Protocol.Request.method_ request) "template.get");
      let params = Protocol.Request.params request in
      assert (Json.integer (Json.field params "max_bytes") = 1_048_576);
      assert (Json.integer (Json.field params "template_revision") = 4);
      Ok (public_template template))
    |> Disk.unwrap
  in
  printf "captures=%d mutation=%s\n" !calls (Protocol.Request.method_ prepared.request);
  List.iter prepared.instance.tickets ~f:(fun ticket ->
    printf "%s: %s\n" ticket.alias ticket.title);
  let output = Template_helper.Instance_preview.to_json prepared in
  ignore
    (Api_codec.decode Workflow_template_wire.instance (Json.field output "instance")
     |> Disk.unwrap
     : Workflow_template.Instance.t);
  ignore
    (Api_codec.decode Workflow_template_wire.template (Json.field output "template")
     |> Disk.unwrap
     : Workflow_template.t);
  assert (
    Option.is_none
      (Json.optional (Protocol.Request.params prepared.request) "expected_digest"));
  assert (
    Option.is_none
      (Json.optional (Protocol.Request.params prepared.request) "mutation_id"));
  print_endline "public output; missing mutation identity remains missing";
  [%expect
    {|
    captures=1 mutation=template.instantiate
    a-parent: Parent {{not-recursive}}<tag>
    z-child: Child {{not-recursive}}<tag>
    public output; missing mutation identity remains missing
    |}]
;;

let%expect_test "closed input rejects invalid, duplicate and aliases before any fetch" =
  List.iter
    [ replace (params ()) "expected_digest" (Json.string "bad")
    ; replace (params ()) "template_revision" (Json.int 0)
    ; replace (params ()) "project_id" (Json.string "$project")
    ; replace (params ()) "unknown" `True
    ; (match params () with
       | `Object fields -> `Object (("instance_id", Json.string "duplicate") :: fields)
       | _ -> assert false)
    ]
    ~f:(fun params -> report (Template_helper.Instance_preview.of_params params));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "exact identity/version/digest and public-only shape" =
  let input = Template_helper.Instance_preview.of_params (params ()) |> Disk.unwrap in
  List.iter
    [ Workflow_template.create
        ~resource:(Id.Resource.of_string "other" |> Disk.unwrap)
        ~resource_revision:4
        ~spec
      |> Disk.unwrap
    ; Workflow_template.create ~resource ~resource_revision:5 ~spec |> Disk.unwrap
    ; Workflow_template.create
        ~resource
        ~resource_revision:4
        ~spec:{ spec with nodes = [ node "different" "Different" None [] ] }
      |> Disk.unwrap
    ]
    ~f:(fun template ->
      report
        (Template_helper.Instance_preview.prepare input ~fetch:(fun _ ->
           Ok (public_template template))));
  let internal =
    Json.obj
      [ "data", Json.obj [ "record", Workflow_template.to_json template ]
      ; "meta", Json.obj []
      ]
  in
  report (Template_helper.Instance_preview.prepare input ~fetch:(fun _ -> Ok internal));
  [%expect
    {|
    Conflict
    Conflict
    Conflict
    Invalid_argument
    |}]
;;

let%expect_test "complete bound error and unexpected exceptions are not disguised" =
  let input = Template_helper.Instance_preview.of_params (params ()) |> Disk.unwrap in
  let problem = Problem.create Invalid_argument "complete policy record cannot fit" in
  assert (
    match
      Template_helper.Instance_preview.prepare input ~fetch:(fun _ -> Error problem)
    with
    | Error actual -> phys_equal actual problem
    | Ok _ -> false);
  print_endline "original complete-record bound error";
  (try
     ignore
       (Template_helper.Instance_preview.prepare input ~fetch:(fun _ ->
          raise (Eio.Cancel.Cancelled (Failure "cancel")))
        : (_, _) Result.t)
   with
   | Eio.Cancel.Cancelled _ -> print_endline "cancellation propagated");
  (try
     ignore
       (Template_helper.Instance_preview.prepare input ~fetch:(fun _ ->
          failwith "unexpected")
        : (_, _) Result.t)
   with
   | Failure message when String.equal message "unexpected" ->
     print_endline "unexpected exception propagated");
  [%expect
    {|
    original complete-record bound error
    cancellation propagated
    unexpected exception propagated
    |}]
;;

let%expect_test "helper HTTP boundary uses a captured generation and a read-only socket" =
  let reads = ref 0 in
  Rpc_socket_test.with_bridge
    (fun request ->
       incr reads;
       assert (String.equal (Protocol.Request.method_ request) "template.get");
       Some (Protocol.Success (public_template template)))
    (fun env root operations rpc connection ->
       let profiles = Connection_profile.Store.create root |> Disk.unwrap in
       Connection_profile.Store.put profiles connection ~expected_generation:None
       |> Disk.unwrap;
       let router =
         Http_router.create
           ~host:Http_tests.host
           ~origin:Http_tests.origin
           ~capability:Http_tests.capability
           ~profiles
           ~operations
           ~rpc
           ~random:(Eio.Stdenv.secure_random env)
       in
       let body params generation =
         Json.obj
           [ "connection_id", Json.string "local"
           ; "generation", Json.string generation
           ; "params", params
           ; "lane", Json.string "visible"
           ]
         |> Json.canonical
       in
       let call params generation =
         Http_tests.call
           router
           ~method_:"POST"
           ~body:(body params generation)
           "/ui-api/v1/template-instances/preview"
       in
       let response = call (params ()) "1" in
       assert (response.status = 200);
       let data = Http_tests.data response in
       assert (
         String.equal
           (Json.field (Json.field data "request") "method" |> Json.text)
           "template.instantiate");
       printf "status=%d reads=%d\n" response.status !reads;
       let invalid = call (replace (params ()) "unknown" `True) "1" in
       let missing = call (params ()) "2" in
       printf
         "invalid=%d missing-generation=%d reads=%d\n"
         invalid.status
         missing.status
         !reads;
       let inventory =
         Operation_store.list operations ~offset:0 ~limit:100 |> Disk.unwrap
       in
       assert (List.is_empty (Json.field inventory "items" |> Json.list));
       print_endline "preview created no operation journal");
  [%expect
    {|
    status=200 reads=1
    invalid=400 missing-generation=404 reads=1
    preview created no operation journal
    |}]
;;

let%expect_test "retained profile generation lookup performs no daemon probe or fallback" =
  let reads = ref 0 in
  Rpc_socket_test.with_bridge
    (fun _ ->
       incr reads;
       failwith "profile lookup must not contact a daemon")
    (fun env root operations rpc connection ->
       let profiles = Connection_profile.Store.create root |> Disk.unwrap in
       Connection_profile.Store.put profiles connection ~expected_generation:None
       |> Disk.unwrap;
       let next =
         Connection_profile.create
           ~id:(Connection_profile.id connection)
           ~generation:
             (Connection_profile.Generation.next
                (Connection_profile.generation connection)
              |> Disk.unwrap)
           ~label:"Retargeted"
           ~socket:"/tmp/synthetic-unconnected-profile.sock"
         |> Disk.unwrap
       in
       Connection_profile.Store.put
         profiles
         next
         ~expected_generation:(Some (Connection_profile.generation connection))
       |> Disk.unwrap;
       let router =
         Http_router.create
           ~host:Http_tests.host
           ~origin:Http_tests.origin
           ~capability:Http_tests.capability
           ~profiles
           ~operations
           ~rpc
           ~random:(Eio.Stdenv.secure_random env)
       in
       let first = Http_tests.call router "/ui-api/v1/connections/local/generations/1" in
       let actual = Connection_profile.of_json (Http_tests.data first) |> Disk.unwrap in
       assert (
         String.equal
           (Connection_profile.socket actual)
           (Connection_profile.socket connection));
       printf
         "retained=%d generation=%s\n"
         first.status
         (Connection_profile.Generation.to_string (Connection_profile.generation actual));
       List.iter [ "3"; "0"; "01"; "not-a-generation" ] ~f:(fun generation ->
         printf
           "%s=%d\n"
           generation
           (Http_tests.call
              router
              ("/ui-api/v1/connections/local/generations/" ^ generation))
             .status);
       printf "daemon probes=%d\n" !reads);
  [%expect
    {| 
    retained=200 generation=1
    3=404
    0=400
    01=400
    not-a-generation=400
    daemon probes=0
    |}]
;;
