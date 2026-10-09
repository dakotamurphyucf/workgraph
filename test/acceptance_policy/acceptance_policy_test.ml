open Core
open Workgraph
module P = Acceptance_policy

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let ticket = ok (Id.Ticket.of_string "work")
let project = ok (Id.Project.of_string "project")
let actor = ok (Id.Actor.of_string "owner")
let reviewer = ok (Id.Actor.of_string "reviewer")
let key = ok (P.Criterion.Key.of_string "tests")
let criterion ?(required = true) description = { P.Criterion.key; description; required }

let definition
      ?(revision = 1)
      ?(reviewers = [])
      ?(validators = [])
      ?(enabled = true)
      ?(separate_actor = false)
      ?(criteria = [])
      ?inherited_override
      scope
  =
  ok
    (P.Definition.create
       ~scope
       ~revision
       ~enabled
       ~reviewers
       ~validators
       ~separate_actor
       ~criteria
       ~inherited_override)
;;

let resolve
      ?project:inherited
      ?ticket:local
      ?(project_id = Some project)
      ?(token = Some 1)
      ?(membership_revision = 1)
      ()
  =
  ok
    (P.Effective.resolve
       ~ticket_id:ticket
       ~project_id
       ~membership_revision
       ~project:inherited
       ~ticket:local
       ~minimum_reopening_token:None
       ~ownership_token:token)
;;

let print = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let%expect_test "project and ticket requirements compose with scoped criterion identities"
  =
  let inherited =
    definition
      ~reviewers:[ Named_actor reviewer ]
      ~validators:[ "tests" ]
      ~criteria:[ criterion "Inherited tests" ]
      (P.Scope.Project project)
  in
  let local =
    definition
      ~enabled:false
      ~criteria:[ criterion "Local tests" ]
      (P.Scope.Ticket ticket)
  in
  let effective = resolve ~project:inherited ~ticket:local () in
  print_s
    [%sexp
      (List.length (P.Effective.criteria effective) : int)
    , (P.Effective.validators effective : string list)];
  let local = definition ~criteria:[ criterion "Local tests" ] (P.Scope.Ticket ticket) in
  let composed = resolve ~project:inherited ~ticket:local () in
  print_s [%sexp (List.length (P.Effective.criteria composed) : int)];
  let moved = resolve ~project_id:None ~ticket:local () in
  print_s
    [%sexp
      (String.equal (P.Effective.digest effective) (P.Effective.digest moved) : bool)];
  [%expect
    {|
    (1 (tests))
    2
    false
    |}]
;;

let%expect_test
    "waivers bind one exact project source and stale waivers reapply inherited \
     requirements"
  =
  let inherited =
    definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Project project)
  in
  let override =
    ok
      (P.Inherited_override.create
         ~against:{ P.Source.scope = Project project; revision = 1 }
         ~membership_revision:1
         ~reviewers:[]
         ~validators:[]
         ~criteria:[ key ]
         ~waive_separate_actor:false
         ~reason:"Approved exception")
  in
  let local = definition ~inherited_override:override (P.Scope.Ticket ticket) in
  let effective = resolve ~project:inherited ~ticket:local () in
  print_s
    [%sexp
      (P.Effective.is_configured effective : bool)
    , (Option.is_some (P.Effective.stale_override effective) : bool)];
  let returned = resolve ~project:inherited ~ticket:local ~membership_revision:3 () in
  print_s
    [%sexp
      (P.Effective.is_configured returned : bool)
    , (Option.is_some (P.Effective.stale_override returned) : bool)];
  print (Api_codec.decode P.Effective.codec (P.Effective.jsonaf_of_t returned));
  let inherited =
    definition
      ~revision:2
      ~criteria:[ criterion "Changed tests" ]
      (P.Scope.Project project)
  in
  let stale = resolve ~project:inherited ~ticket:local () in
  print_s
    [%sexp
      (P.Effective.is_configured stale : bool)
    , (Option.is_some (P.Effective.stale_override stale) : bool)];
  let absent = resolve ~project_id:None ~ticket:local () in
  print_s [%sexp (Option.is_some (P.Effective.stale_override absent) : bool)];
  [%expect
    {|
    (false false)
    (true true)
    ok
    (true true)
    true
    |}]
;;

let%expect_test
    "weakening and required statement changes need a nonblank attributed reason"
  =
  let old = definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket) in
  let changed =
    definition ~revision:2 ~criteria:[ criterion "Tests execute" ] (P.Scope.Ticket ticket)
  in
  print (P.Definition.check_update (Some old) ~next:changed ~weakening_reason:None);
  print (P.Definition.check_update (Some old) ~next:changed ~weakening_reason:(Some " "));
  print
    (P.Definition.check_update
       (Some old)
       ~next:changed
       ~weakening_reason:(Some "New acceptance agreement"));
  let strengthened =
    definition
      ~revision:2
      ~criteria:
        [ criterion "Tests pass"
        ; { P.Criterion.key = ok (P.Criterion.Key.of_string "lint")
          ; description = "Lint passes"
          ; required = true
          }
        ]
      (P.Scope.Ticket ticket)
  in
  print (P.Definition.check_update (Some old) ~next:strengthened ~weakening_reason:None);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    ok
    ok
    |}]
;;

let%expect_test
    "binding decoder rejects a changed digest and ownership changes invalidate bindings"
  =
  let local = definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket) in
  let effective = resolve ~ticket:local () in
  let binding = P.Effective.binding effective in
  let json = P.Effective.Binding.jsonaf_of_t binding in
  let tampered =
    match json with
    | `Object fields ->
      `Object
        (List.Assoc.add
           fields
           ~equal:String.equal
           "digest"
           (Json.string (String.make 64 '0')))
    | _ -> assert false
  in
  print (Api_codec.decode P.Effective.Binding.codec tampered);
  let next_owner = resolve ~ticket:local ~token:(Some 2) () in
  print_s
    [%sexp (P.Effective.Binding.equal binding (P.Effective.binding next_owner) : bool)];
  print (Api_codec.decode P.Effective.Binding.codec json);
  [%expect
    {|
    Invalid_argument
    false
    ok
    |}]
;;

let capture
      ?(token = 1)
      ?(attempt = None)
      ?(project = None)
      ?(minimum = None)
      ?(membership_revision = 1)
      ()
      _
  =
  Some
    { Evidence.Ticket_context.project
    ; membership_revision
    ; minimum_reopening_token = minimum
    ; current_token = Some token
    ; ownership = Some { token; actor; run = None }
    ; attempt
    }
;;

let prepare evidence command ~ticket_context =
  Evidence.prepare
    evidence
    command
    ~ticket_context
    ~actor
    ~run:None
    ~timestamp:"now"
    ~sequence:(Evidence.revision evidence + 1)
;;

let put evidence definition ~ticket_context =
  prepare
    evidence
    (Acceptance_policy_put
       { definition
       ; expected_revision = P.Definition.revision definition - 1
       ; weakening_reason = None
       })
    ~ticket_context
  |> ok
  |> Evidence.candidate
;;

let assert_command evidence ~ticket_context ~attempt ~manifest ~passed =
  let effective = ok (Evidence.effective_policy evidence ~ticket_context ~ticket) in
  Evidence.Command.Assert
    { ticket
    ; token = 1
    ; attempt
    ; manifest
    ; expected_policy_digest = P.Effective.digest effective
    ; criterion = { P.Criterion.Ref.scope = Ticket ticket; policy_revision = 1; key }
    ; passed
    ; evidence_pins =
        [ Checksum { source = "test evidence"; digest = String.make 64 'a' } ]
    ; evidence = "Tests pass"
    }
;;

let%expect_test
    "ordinary criteria use exact pins without manufacturing a manifest and cannot carry \
     across ownership"
  =
  let ticket_context = capture () in
  let local = definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket) in
  let evidence = put Evidence.empty local ~ticket_context in
  print (Evidence.ensure_can_complete evidence ~ticket_context ~ticket);
  let prepared =
    prepare
      evidence
      (assert_command evidence ~ticket_context ~attempt:None ~manifest:None ~passed:true)
      ~ticket_context
    |> ok
  in
  let evidence = Evidence.candidate prepared in
  print (Evidence.ensure_can_complete evidence ~ticket_context ~ticket);
  print
    (Evidence.ensure_can_complete evidence ~ticket_context:(capture ~token:2 ()) ~ticket);
  print
    (Evidence.ensure_can_complete
       evidence
       ~ticket_context:(capture ~minimum:(Some 2) ())
       ~ticket);
  let failing =
    prepare
      evidence
      (assert_command evidence ~ticket_context ~attempt:None ~manifest:None ~passed:false)
      ~ticket_context
    |> ok
    |> Evidence.candidate
  in
  print (Evidence.ensure_can_complete failing ~ticket_context ~ticket);
  print
    (prepare
       evidence
       (assert_command
          evidence
          ~ticket_context
          ~attempt:(Some (ok (Attempt.Id.of_string "other")))
          ~manifest:None
          ~passed:true)
       ~ticket_context);
  [%expect
    {|
    Blocked
    ok
    Blocked
    Blocked
    Blocked
    Conflict
    |}]
;;

let independent_policy_event =
  {|{"version":"1","revision":"1","sequence":"1","attribution":{"actor":"owner","run":null,"timestamp":"now"},"update":["Policy_put",{"definition":{"scope":{"kind":"ticket","ticket_id":"work"},"revision":"1","enabled":true,"reviewers":[],"separate_actor":false,"validators":[],"criteria":[{"key":"tests","description":"Tests pass","required":true}],"inherited_override":null},"weakening_reason":null,"attribution":{"actor":"owner","run":null,"timestamp":"now"}}],"reconciliations":[]}|}
;;

let independent_binding =
  let json =
    ok
      (Json.parse
         {|{"ticket_id":"work","project_id":null,"membership_revision":"1","sources":[{"scope":{"kind":"ticket","ticket_id":"work"},"revision":"1"}],"minimum_reopening_token":null,"ownership_token":"1","reviewers":[],"validators":[],"criteria":[{"reference":{"scope":{"kind":"ticket","ticket_id":"work"},"policy_revision":"1","key":"tests"},"criterion":{"key":"tests","description":"Tests pass","required":true}}],"separate_actor":false,"applied_override":null,"stale_override":null}|})
  in
  match json with
  | `Object fields ->
    `Object (fields @ [ "digest", Json.string (Json.hash (Json.canonical json)) ])
  | _ -> assert false
;;

let independent_assertion_event ~token ~artifacts =
  let binding =
    match independent_binding with
    | `Object fields ->
      let fields =
        List.Assoc.remove fields ~equal:String.equal "digest"
        |> fun fields ->
        List.Assoc.add fields ~equal:String.equal "ownership_token" (Json.int token)
      in
      let payload = Json.obj fields in
      Json.obj (fields @ [ "digest", Json.string (Json.hash (Json.canonical payload)) ])
    | _ -> assert false
  in
  ok
    (Json.parse
       (sprintf
          {|{"version":"1","revision":"2","sequence":"2","attribution":{"actor":"owner","run":null,"timestamp":"now"},"update":["Assertion_added",{"serial":"2","ticket":"work","token":"%d","attempt":null,"manifest":null,"artifacts":%s,"policy_binding":%s,"criterion":{"scope":{"kind":"ticket","ticket_id":"work"},"policy_revision":"1","key":"tests"},"passed":true,"evidence_pins":[["Checksum",{"source":"manual","digest":"%s"}]],"evidence":"Tests pass","attribution":{"actor":"owner","run":null,"timestamp":"now"}}],"reconciliations":[]}|}
          token
          artifacts
          (Json.canonical binding)
          (String.make 64 'a')))
;;

let%expect_test
    "independent durable fixtures reject forged ownership and artifact targets"
  =
  let ticket_context = capture () in
  let event = ok (Evidence.Change.decode (ok (Json.parse independent_policy_event))) in
  let evidence = ok (Evidence.apply Evidence.empty event ~ticket_context) in
  let apply token artifacts =
    let event =
      Evidence.Change.decode (independent_assertion_event ~token ~artifacts) |> ok
    in
    Evidence.apply evidence event ~ticket_context
  in
  print (apply 2 "[]");
  print
    (apply
       1
       {|[{"name":"fabricated","pin":["Checksum",{"source":"manual","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}]|});
  let accepted = ok (apply 1 "[]") in
  print (Evidence.ensure_can_complete accepted ~ticket_context ~ticket);
  print
    (Evidence.ensure_can_complete
       accepted
       ~ticket_context:(capture ~project:(Some project) ())
       ~ticket);
  print
    (Evidence.ensure_can_complete
       accepted
       ~ticket_context:(capture ~membership_revision:3 ())
       ~ticket);
  [%expect
    {|
    Stale_claim
    Conflict
    ok
    Blocked
    Blocked
    |}]
;;

let%expect_test
    "an explicit input replacement invalidates an ordinary exact-pin criterion proof"
  =
  let ticket_context = capture () in
  let evidence =
    put
      Evidence.empty
      (definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket))
      ~ticket_context
  in
  let evidence =
    prepare
      evidence
      (assert_command evidence ~ticket_context ~attempt:None ~manifest:None ~passed:true)
      ~ticket_context
    |> ok
    |> Evidence.candidate
  in
  print (Evidence.ensure_can_complete evidence ~ticket_context ~ticket);
  let evidence =
    prepare
      evidence
      (Input_changed
         { previous = Checksum { source = "test evidence"; digest = String.make 64 'a' }
         ; current = Checksum { source = "test evidence"; digest = String.make 64 'b' }
         })
      ~ticket_context
    |> ok
    |> Evidence.candidate
  in
  print (Evidence.ensure_can_complete evidence ~ticket_context ~ticket);
  let historical = List.hd_exn (Evidence.assertions evidence) in
  print_s [%sexp (historical.evidence_pins : Evidence.Pin.t list)];
  [%expect
    {|
    ok
    Blocked
    ((Checksum (source "test evidence")
      (digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)))
    |}]
;;

let%expect_test
    "all evidence public descriptors share actual closed request and result codecs"
  =
  let names =
    List.map Evidence.api_methods ~f:(fun (Api_method.Packed.Pack method_) ->
      Api_method.name method_)
  in
  print_s
    [%sexp
      (List.length names : int)
    , (List.length (List.dedup_and_sort names ~compare:String.compare) : int)];
  let descriptor =
    List.find_exn Evidence.api_methods ~f:(fun (Api_method.Packed.Pack method_) ->
      String.equal (Api_method.name method_) "acceptance.assert")
  in
  (match descriptor with
   | Api_method.Packed.Pack method_ ->
     print_s
       [%sexp
         (Option.value_exn (Api_codec.field_names (Api_method.request_codec method_))
          : string list)]);
  print
    (Evidence.decode
       ~method_:"review.policy.put"
       ~params:
         (ok
            (Json.parse
               {|{"ticket_id":"work","expected_revision":"0","enabled":true,"reviewers":[["Named_actor","owner"]],"separate_actor":false,"validators":[]}|})));
  print
    (Evidence.decode
       ~method_:"review.policy.put"
       ~params:
         (ok
            (Json.parse
               {|{"ticket_id":"work","expected_revision":"0","enabled":true,"reviewers":[{"kind":"actor","actor_id":"owner"}],"separate_actor":false,"validators":[]}|})));
  print
    (Evidence.decode
       ~method_:"input.changed"
       ~params:
         (ok
            (Json.parse
               {|{"previous":{"kind":"checksum","source":"x","digest":"bad"},"current":{"kind":"checksum","source":"x","digest":"bad"}}|})));
  [%expect
    {|
    (32 32)
    (ticket_id token attempt_id manifest expected_policy_digest criterion passed
     evidence_pins evidence)
    Invalid_argument
    ok
    Invalid_argument
    |}]
;;

let%expect_test
    "a new attempt cannot omit a ticket's existing manifest and changed outputs \
     invalidate its assertion"
  =
  let first_attempt = ok (Attempt.Id.of_string "first") in
  let second_attempt = ok (Attempt.Id.of_string "second") in
  let contract = ok (Evidence_id.Contract.of_string "contract") in
  let first_manifest = ok (Evidence_id.Manifest.of_string "first-manifest") in
  let second_manifest = ok (Evidence_id.Manifest.of_string "second-manifest") in
  let first_context = capture ~attempt:(Some first_attempt) () in
  let evidence =
    prepare
      Evidence.empty
      (Contract_put
         { id = contract
         ; expected_revision = 0
         ; schema_version = 1
         ; schema =
             { id = ok (Id.Resource.of_string "schema")
             ; revision = 1
             ; digest = String.make 64 'a'
             }
         ; required_inputs = []
         ; required_outputs = []
         })
      ~ticket_context:first_context
    |> ok
    |> Evidence.candidate
  in
  let publish evidence id attempt digest ~ticket_context =
    prepare
      evidence
      (Manifest_publish
         { id
         ; expected_revision = 0
         ; schema_version = 1
         ; attempt
         ; ticket
         ; contract = { id = contract; revision = 1 }
         ; inputs = []
         ; outputs =
             [ { name = "result"
               ; pin = Checksum { source = "result"; digest = String.make 64 digest }
               }
             ]
         })
      ~ticket_context
    |> ok
    |> Evidence.candidate
  in
  let evidence =
    publish evidence first_manifest first_attempt 'b' ~ticket_context:first_context
  in
  let evidence =
    put
      evidence
      (definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket))
      ~ticket_context:first_context
  in
  let ticket_context = capture ~attempt:(Some second_attempt) () in
  print
    (prepare
       evidence
       (assert_command
          evidence
          ~ticket_context
          ~attempt:(Some second_attempt)
          ~manifest:None
          ~passed:true)
       ~ticket_context);
  let evidence =
    prepare
      evidence
      (assert_command
         evidence
         ~ticket_context
         ~attempt:(Some second_attempt)
         ~manifest:(Some { id = first_manifest; revision = 1 })
         ~passed:true)
      ~ticket_context
    |> ok
    |> Evidence.candidate
  in
  print (Evidence.ensure_can_complete evidence ~ticket_context ~ticket);
  let evidence = publish evidence second_manifest second_attempt 'c' ~ticket_context in
  print (Evidence.ensure_can_complete evidence ~ticket_context ~ticket);
  [%expect
    {|
    Conflict
    ok
    Blocked
    |}]
;;

let%expect_test
    "the narrow review policy update preserves criteria and weak changes need a reason"
  =
  let ticket_context = capture () in
  let evidence =
    put
      Evidence.empty
      (definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket))
      ~ticket_context
  in
  let evidence =
    prepare
      evidence
      (Policy_put
         { ticket
         ; expected_revision = 1
         ; enabled = true
         ; reviewers = [ Named_actor reviewer ]
         ; separate_actor = true
         ; validators = []
         ; weakening_reason = None
         })
      ~ticket_context
    |> ok
    |> Evidence.candidate
  in
  let version = List.hd_exn (Evidence.policy_versions evidence) in
  print_s [%sexp (List.length (P.Definition.criteria version.definition) : int)];
  print
    (prepare
       evidence
       (Policy_put
          { ticket
          ; expected_revision = 2
          ; enabled = false
          ; reviewers = []
          ; separate_actor = false
          ; validators = []
          ; weakening_reason = None
          })
       ~ticket_context);
  print
    (prepare
       evidence
       (Policy_put
          { ticket
          ; expected_revision = 2
          ; enabled = false
          ; reviewers = []
          ; separate_actor = false
          ; validators = []
          ; weakening_reason = Some "Accepted scope reduction"
          })
       ~ticket_context);
  [%expect
    {|
    1
    Invalid_argument
    ok
    |}]
;;

let%expect_test
    "raw evidence references preserve aliases until typed transaction resolution"
  =
  let policy =
    ok
      (Json.parse
         {|{"scope":{"kind":"ticket","ticket_id":"$work"},"expected_revision":"0","enabled":true,"reviewers":[{"kind":"actor","actor_id":"owner"}],"separate_actor":false,"validators":[],"criteria":[{"key":"tests","description":"$work remains literal prose","required":true}]}|})
  in
  let raw = Option.value_exn (Evidence.request_codec ~method_:"acceptance.policy.put") in
  print (Api_codec.decode raw policy);
  print (Evidence.decode ~method_:"acceptance.policy.put" ~params:policy);
  let operation =
    Json.obj [ "method", Json.string "acceptance.policy.put"; "params", policy ]
  in
  let create =
    ok
      (Json.parse
         {|{"method":"ticket.create","as":"work","params":{"ticket_id":"actual","title":"Work"}}|})
  in
  let params = Json.obj [ "operations", `Array [ operation; create ] ] in
  print (Domain_command.decode ~method_:"transaction.apply" ~params);
  let bad_create =
    ok
      (Json.parse
         {|{"method":"project.create","as":"work","params":{"project_id":"actual","title":"Project"}}|})
  in
  print
    (Domain_command.decode
       ~method_:"transaction.apply"
       ~params:(Json.obj [ "operations", `Array [ operation; bad_create ] ]));
  [%expect
    {|
    ok
    Invalid_argument
    ok
    Invalid_argument
    |}]
;;

let%expect_test
    "budgeting preserves complete effective bindings and advances only whole proof items"
  =
  let ticket_context = capture () in
  let long =
    definition ~criteria:[ criterion (String.make 3900 'x') ] (P.Scope.Ticket ticket)
  in
  let evidence = put Evidence.empty long ~ticket_context in
  let query evidence method_ params =
    Evidence.query evidence ~ticket_context ~method_ ~params:(ok (Json.parse params))
  in
  print
    (query
       evidence
       "acceptance.policy.effective"
       {|{"ticket_id":"work","max_bytes":"4096"}|});
  let result =
    ok
      (query
         evidence
         "acceptance.policy.effective"
         {|{"ticket_id":"work","max_bytes":"16384"}|})
  in
  let wire = Api_response.project (Domain_query Evidence) result in
  print
    (Api_codec.decode
       (Option.value_exn (Evidence.response_codec ~method_:"acceptance.policy.effective"))
       (Api_response.data wire));
  print_s
    [%sexp
      (String.length
         (snd
            (List.hd_exn
               (P.Effective.criteria (P.Effective.t_of_jsonaf (Api_response.data wire)))))
           .description
       : int)];
  let evidence =
    put
      Evidence.empty
      (definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket))
      ~ticket_context
  in
  let add evidence =
    let command =
      match
        assert_command evidence ~ticket_context ~attempt:None ~manifest:None ~passed:true
      with
      | Evidence.Command.Assert a ->
        Evidence.Command.Assert { a with evidence = String.make 1200 'x' }
      | _ -> assert false
    in
    prepare evidence command ~ticket_context |> ok |> Evidence.candidate
  in
  let evidence = add (add evidence) in
  let page =
    ok
      (query evidence "acceptance.assertions" {|{"ticket_id":"work","max_bytes":"4096"}|})
  in
  let wire = Api_response.project (Domain_query Evidence) page in
  print
    (Api_codec.decode
       (Option.value_exn (Evidence.response_codec ~method_:"acceptance.assertions"))
       (Api_response.data wire));
  print_s
    [%sexp
      (List.length (Json.list (Json.field (Api_response.data wire) "items")) : int)
    , (Json.field (Api_response.data wire) "next_offset" : Jsonaf.t)
    , (Json.field (Api_response.meta wire) "budget"
       |> fun b -> Json.field b "omitted_items"
       : Jsonaf.t)];
  print_s [%sexp (Api_response.encoded_size (Domain_query Evidence) page <= 4096 : bool)];
  [%expect
    {|
    Invalid_argument
    ok
    3900
    ok
    (1 (String 1) (String 1))
    true
    |}]
;;

let%expect_test
    "every Evidence mutation uses explicit raw references and preserves opaque prose"
  =
  let digest = String.make 64 'a' in
  let samples =
    [ ( "contract.put"
      , {|{"contract_id":"contract","expected_revision":"0","schema_version":"1","schema":{"resource_id":"$schema","revision":"1","digest":"DIGEST"},"required_inputs":[],"required_outputs":[]}|}
      )
    ; ( "manifest.publish"
      , {|{"manifest_id":"manifest","expected_revision":"0","schema_version":"1","attempt_id":"$attempt","ticket_id":"$ticket","contract":{"contract_id":"$contract","revision":"1"},"inputs":[],"outputs":[{"name":"result","pin":{"kind":"checksum","source":"$opaque","digest":"DIGEST"}}]}|}
      )
    ; ( "review.policy.put"
      , {|{"ticket_id":"$ticket","expected_revision":"0","enabled":true,"reviewers":[{"kind":"role","name":"reviewers","member_ids":["$actor"]}],"separate_actor":false,"validators":[]}|}
      )
    ; ( "acceptance.policy.put"
      , {|{"scope":{"kind":"ticket","ticket_id":"$ticket"},"expected_revision":"0","enabled":true,"reviewers":[],"separate_actor":false,"validators":[],"criteria":[],"inherited_override":{"against":{"scope":{"kind":"project","project_id":"$project"},"revision":"1"},"membership_revision":"1","reviewers":[],"validators":[],"criteria":["tests"],"waive_separate_actor":false,"reason":"$opaque"},"weakening_reason":"$opaque"}|}
      )
    ; ( "acceptance.assert"
      , {|{"ticket_id":"$ticket","token":"1","attempt_id":"$attempt","manifest":{"manifest_id":"$manifest","revision":"1"},"expected_policy_digest":"DIGEST","criterion":{"scope":{"kind":"project","project_id":"$project"},"policy_revision":"1","key":"tests"},"passed":true,"evidence_pins":[{"kind":"decision","decision_id":"$decision","revision":"1"}],"evidence":"$opaque"}|}
      )
    ; ( "review.submit"
      , {|{"ticket_id":"$ticket","expected_revision":"0","manifest":{"manifest_id":"$manifest","revision":"1"},"review_request_id":"$request"}|}
      )
    ; ( "review.record"
      , {|{"review_id":"review","ticket_id":"$ticket","generation":"1","verdict":"approve","evidence":"$opaque","comment_id":"$comment"}|}
      )
    ; "review.accept", {|{"ticket_id":"$ticket","expected_revision":"1"}|}
    ; ( "validation.add"
      , {|{"validation_id":"validation","manifest":{"manifest_id":"$manifest","revision":"1"},"name":"tests","expected_policy_digest":"DIGEST","passed":true,"evidence":"$opaque"}|}
      )
    ; ( "decision.put"
      , {|{"decision_id":"decision","expected_revision":"0","scope":{"kind":"project","project_id":"$project"},"title":"$opaque","rationale":{"kind":"comment","comment_id":"$comment","revision":"1"},"evidence":[],"affected":[{"kind":"ticket","ticket_id":"$ticket"}],"supersedes":["$decision"]}|}
      )
    ; ( "input.changed"
      , {|{"previous":{"kind":"resource","resource_id":"$resource","revision":"1","digest":"DIGEST"},"current":{"kind":"resource","resource_id":"$resource","revision":"2","digest":"DIGEST"}}|}
      )
    ; ( "reconciliation.record"
      , {|{"serial":"1","expected_revision":"1","disposition":{"kind":"revised","manifest":{"manifest_id":"$manifest","revision":"1"}}}|}
      )
    ]
  in
  List.iter samples ~f:(fun (method_, bytes) ->
    let params =
      ok (Json.parse (String.substr_replace_all bytes ~pattern:"DIGEST" ~with_:digest))
    in
    let codec = Option.value_exn (Evidence.request_codec ~method_) in
    let actual = ok (Api_codec.decode codec params) in
    if not (String.equal (Json.canonical params) (Json.canonical actual))
    then failwith "raw JSON changed";
    print_endline method_);
  print_s
    [%sexp
      (List.equal
         String.equal
         (List.sort (List.map samples ~f:fst) ~compare:String.compare)
         (List.sort Evidence.mutation_methods ~compare:String.compare)
       : bool)];
  [%expect
    {|
    contract.put
    manifest.publish
    review.policy.put
    acceptance.policy.put
    acceptance.assert
    review.submit
    review.record
    review.accept
    validation.add
    decision.put
    input.changed
    reconciliation.record
    true
    |}]
;;

let%expect_test
    "accepted submissions and validators cannot carry into a later attempt under the \
     same claim"
  =
  let first = ok (Attempt.Id.of_string "first") in
  let next = ok (Attempt.Id.of_string "next") in
  let first_context = capture ~attempt:(Some first) () in
  let next_context = capture ~attempt:(Some next) () in
  let contract = ok (Evidence_id.Contract.of_string "contract") in
  let manifest = ok (Evidence_id.Manifest.of_string "manifest") in
  let manifest_ref = { Evidence.Manifest_ref.id = manifest; revision = 1 } in
  let evidence =
    prepare
      Evidence.empty
      (Contract_put
         { id = contract
         ; expected_revision = 0
         ; schema_version = 1
         ; schema =
             { id = ok (Id.Resource.of_string "schema")
             ; revision = 1
             ; digest = String.make 64 'a'
             }
         ; required_inputs = []
         ; required_outputs = []
         })
      ~ticket_context:first_context
    |> ok
    |> Evidence.candidate
  in
  let evidence =
    prepare
      evidence
      (Manifest_publish
         { id = manifest
         ; expected_revision = 0
         ; schema_version = 1
         ; attempt = first
         ; ticket
         ; contract = { id = contract; revision = 1 }
         ; inputs = []
         ; outputs = []
         })
      ~ticket_context:first_context
    |> ok
    |> Evidence.candidate
  in
  let evidence =
    put
      evidence
      (definition ~validators:[ "tests" ] (P.Scope.Ticket ticket))
      ~ticket_context:first_context
  in
  let validation evidence id ~ticket_context =
    let digest =
      ok (Evidence.effective_policy evidence ~ticket_context ~ticket)
      |> P.Effective.digest
    in
    prepare
      evidence
      (Validate
         { id = ok (Evidence_id.Validation.of_string id)
         ; manifest = manifest_ref
         ; name = "tests"
         ; expected_policy_digest = digest
         ; passed = true
         ; evidence = "Tests pass"
         })
      ~ticket_context
  in
  let evidence =
    validation evidence "first" ~ticket_context:first_context |> ok |> Evidence.candidate
  in
  let evidence =
    prepare
      evidence
      (Submit
         { ticket; expected_revision = 0; manifest = manifest_ref; review_request = None })
      ~ticket_context:first_context
    |> ok
    |> Evidence.candidate
  in
  let accepted =
    prepare
      evidence
      (Accept { ticket; expected_revision = 1 })
      ~ticket_context:first_context
    |> ok
  in
  let current = Evidence.candidate accepted in
  print (Evidence.ensure_can_complete current ~ticket_context:first_context ~ticket);
  print (Evidence.ensure_can_complete current ~ticket_context:next_context ~ticket);
  print (validation current "later" ~ticket_context:next_context);
  print
    (Evidence.apply
       evidence
       (Evidence.Change.t_of_jsonaf
          (Evidence.Change.jsonaf_of_t (List.hd_exn (Evidence.changes accepted))))
       ~ticket_context:next_context);
  [%expect
    {|
    ok
    Conflict
    Conflict
    Conflict
    |}]
;;

let%expect_test "public policy sexp decoders preserve constructor invariants" =
  let rejects label decode text =
    let outcome =
      try
        ignore (decode (Sexp.of_string text) : _);
        "accepted"
      with
      | Sexplib.Conv.Of_sexp_error _ -> "rejected"
    in
    print_s [%sexp (label : string), (outcome : string)]
  in
  rejects
    "empty reviewer role"
    P.Requirement.t_of_sexp
    {|(Role (name tests) (members ()))|};
  rejects
    "blank criterion"
    P.Criterion.t_of_sexp
    {|((key tests) (description " ") (required true))|};
  rejects
    "zero criterion version"
    P.Criterion.Ref.t_of_sexp
    {|((scope (Ticket work)) (policy_revision 0) (key tests))|};
  rejects
    "zero source version"
    P.Source.t_of_sexp
    {|((scope (Project project)) (revision 0))|};
  rejects
    "zero override membership"
    P.Inherited_override.t_of_sexp
    {|((against ((scope (Project project)) (revision 1)))
       (membership_revision 0) (reviewers ()) (validators ()) (criteria (tests))
       (waive_separate_actor false) (reason "Approved exception"))|};
  rejects
    "zero definition version"
    P.Definition.t_of_sexp
    {|((scope (Ticket work)) (revision 0) (enabled true) (reviewers ())
       (separate_actor false) (validators ()) (criteria ()) (inherited_override ()))|};
  let policy = definition ~criteria:[ criterion "Tests pass" ] (P.Scope.Ticket ticket) in
  let effective = resolve ~ticket:policy () in
  let forged =
    match P.Effective.sexp_of_t effective with
    | Sexp.List fields ->
      Sexp.List
        (List.map fields ~f:(function
           | Sexp.List [ Sexp.Atom "digest"; _ ] ->
             Sexp.List [ Sexp.Atom "digest"; Sexp.Atom (String.make 64 '0') ]
           | field -> field))
    | Sexp.Atom _ -> failwith "expected policy record"
  in
  rejects "forged effective digest" P.Effective.t_of_sexp (Sexp.to_string forged);
  rejects "forged binding digest" P.Effective.Binding.t_of_sexp (Sexp.to_string forged);
  print_s
    [%sexp
      (P.Definition.equal policy (P.Definition.t_of_sexp (P.Definition.sexp_of_t policy))
       : bool)
    , (P.Effective.equal
         effective
         (P.Effective.t_of_sexp (P.Effective.sexp_of_t effective))
       : bool)];
  let normalized =
    P.Requirement.t_of_sexp (Sexp.of_string {|(Role (name tests) (members (z a)))|})
  in
  print_s (P.Requirement.sexp_of_t normalized);
  [%expect
    {|
    ("empty reviewer role" rejected)
    ("blank criterion" rejected)
    ("zero criterion version" rejected)
    ("zero source version" rejected)
    ("zero override membership" rejected)
    ("zero definition version" rejected)
    ("forged effective digest" rejected)
    ("forged binding digest" rejected)
    (true true)
    (Role (name tests) (members (a z)))
    |}]
;;
