open Core
open Workgraph
module E = Evidence

let unwrap = function
  | Ok x -> x
  | Error p -> failwith (Sexp.to_string_hum (Problem.sexp_of_t p))
;;

let actor = Id.Actor.of_string "implementer" |> unwrap
let reviewer = Id.Actor.of_string "reviewer" |> unwrap
let ticket = Id.Ticket.of_string "ticket" |> unwrap
let attempt = Attempt.Id.of_string "attempt" |> unwrap
let contract_id = Evidence_id.Contract.of_string "contract" |> unwrap
let manifest_id = Evidence_id.Manifest.of_string "manifest" |> unwrap

let resource id revision digest =
  { E.Resource_pin.id = Id.Resource.of_string id |> unwrap
  ; revision
  ; digest = String.make 64 digest
  }
;;

let source = resource "source" 1 'a'
let schema = resource "schema" 1 'd'
let output = resource "output" 1 'b'
let cref revision = { E.Contract_ref.id = contract_id; revision }
let mref revision = { E.Manifest_ref.id = manifest_id; revision }
let artifact name pin = { E.Artifact.name; pin }

let step ?(actor = actor) t command =
  let p =
    E.prepare
      t
      command
      ~actor
      ~run:None
      ~timestamp:"2026-10-07"
      ~sequence:(E.revision t + 1)
    |> unwrap
  in
  E.candidate p, List.hd_exn (E.changes p)
;;

let publish
      ?(id = manifest_id)
      ?(attempt = attempt)
      ?(ticket = ticket)
      ?(contract_revision = 1)
      ?(input = E.Pin.Resource source)
      ?(output_revision = 1)
      expected_revision
  =
  E.Command.Manifest_publish
    { id
    ; expected_revision
    ; schema_version = 1
    ; attempt
    ; ticket
    ; contract = cref contract_revision
    ; inputs = [ artifact "source" input ]
    ; outputs =
        [ artifact "binary" (Resource { output with revision = output_revision }) ]
    }
;;

let fixture ?(reviewers = [ E.Policy.Requirement.Named_actor reviewer ]) () =
  let t, c =
    step
      E.empty
      (Contract_put
         { id = contract_id
         ; expected_revision = 0
         ; schema_version = 1
         ; schema
         ; required_inputs = [ "source" ]
         ; required_outputs = [ "binary" ]
         })
  in
  let t, m = step t (publish 0) in
  let t, p =
    step
      t
      (Policy_put
         { ticket
         ; expected_revision = 0
         ; enabled = true
         ; reviewers
         ; separate_actor = true
         ; validators = [ "tests" ]
         })
  in
  let t, s =
    step
      t
      (Submit { ticket; expected_revision = 0; manifest = mref 1; review_request = None })
  in
  t, [ c; m; p; s ]
;;

let print_error = function
  | Ok _ -> print_endline "ok"
  | Error (error : Problem.t) -> print_s [%sexp (error.kind : Problem.kind)]
;;

let validation id manifest passed =
  E.Command.Validate
    { id = Evidence_id.Validation.of_string id |> unwrap
    ; manifest
    ; name = "tests"
    ; passed
    ; evidence = "Exact-version test result"
    }
;;

let review id generation verdict =
  E.Command.Review
    { id = Evidence_id.Review.of_string id |> unwrap
    ; ticket
    ; generation
    ; verdict
    ; evidence = "Reviewed pinned output"
    ; comment = None
    }
;;

let%expect_test "approval binds exact output, contract and validator versions" =
  let t, _ = fixture () in
  print_error (E.ensure_can_complete E.empty ~ticket);
  print_error (E.ensure_can_complete t ~ticket);
  let t, _ = step ~actor:reviewer t (review "review_1" 1 Approve) in
  print_error
    (E.prepare
       t
       (Accept { ticket; expected_revision = 1 })
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:6);
  let t, _ = step t (validation "validation_1" (mref 1) true) in
  let t, _ = step t (Accept { ticket; expected_revision = 1 }) in
  print_error (E.ensure_can_complete t ~ticket);
  let t, _ = step t (publish ~output_revision:2 1) in
  print_error (E.ensure_can_complete t ~ticket);
  let t, _ =
    step
      t
      (Submit { ticket; expected_revision = 2; manifest = mref 2; review_request = None })
  in
  print_error
    (E.prepare
       t
       (review "stale_review" 1 Approve)
       ~actor:reviewer
       ~run:None
       ~timestamp:"now"
       ~sequence:10);
  let t, _ = step ~actor:reviewer t (review "review_2" 2 Approve) in
  print_error
    (E.prepare
       t
       (Accept { ticket; expected_revision = 3 })
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:11);
  let t, _ = step t (validation "validation_2" (mref 2) true) in
  let t, _ = step t (Accept { ticket; expected_revision = 3 }) in
  print_error (E.ensure_can_complete t ~ticket);
  [%expect
    {|
    ok
    Blocked
    Blocked
    ok
    Conflict
    Conflict
    Blocked
    ok
|}]
;;

let%expect_test "role membership, actor separation and rejection require a new submission"
  =
  let t, _ =
    fixture ~reviewers:[ Role { name = "reviewers"; members = [ actor; reviewer ] } ] ()
  in
  print_error
    (E.prepare
       t
       (review "self_review" 1 Approve)
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:5);
  let t, _ = step ~actor:reviewer t (review "reject" 1 Request_changes) in
  print_error
    (E.prepare
       t
       (Accept { ticket; expected_revision = 2 })
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:6);
  let t, _ =
    step
      t
      (Submit { ticket; expected_revision = 2; manifest = mref 1; review_request = None })
  in
  let t, _ = step ~actor:reviewer t (review "approve_again" 2 Approve) in
  let t, _ = step t (validation "passing" (mref 1) true) in
  let t, _ = step t (Accept { ticket; expected_revision = 3 }) in
  print_error (E.ensure_can_complete t ~ticket);
  let t, _ = step t (validation "later_failure" (mref 1) false) in
  print_error (E.ensure_can_complete t ~ticket);
  print_s [%sexp (E.review_recipients t ~ticket : Id.Actor.t list)];
  [%expect
    {|
    Conflict
    Conflict
    ok
    Blocked
    (implementer reviewer)
|}]
;;

let%expect_test
    "input changes mark exactly declared old-pin consumers and acknowledgement preserves \
     pins"
  =
  let t, events = fixture () in
  let other_attempt = Attempt.Id.of_string "other_attempt" |> unwrap in
  let other_ticket = Id.Ticket.of_string "other_ticket" |> unwrap in
  let other_manifest = Evidence_id.Manifest.of_string "other_manifest" |> unwrap in
  let t, other =
    step
      t
      (publish
         ~id:other_manifest
         ~attempt:other_attempt
         ~ticket:other_ticket
         ~input:(Resource (resource "other_source" 1 'c'))
         0)
  in
  let replacement =
    E.Pin.Resource { source with revision = 2; digest = String.make 64 'e' }
  in
  let t, changed =
    step t (Input_changed { previous = Resource source; current = replacement })
  in
  let pending = E.pending_reconciliations t ~attempt:None in
  print_s [%sexp (List.map pending ~f:(fun issue -> issue.attempt) : Attempt.Id.t list)];
  let t, acknowledged =
    step t (Reconcile { serial = 1; expected_revision = 1; disposition = Acknowledge })
  in
  print_s
    [%sexp
      (List.length (E.pending_reconciliations t ~attempt:None) : int)
    , (E.Pin.equal
         (List.hd_exn (Option.value_exn (E.get_manifest t (mref 1))).inputs).pin
         (Resource source)
       : bool)];
  let t, repeated =
    step t (Input_changed { previous = Resource source; current = replacement })
  in
  print_s [%sexp (List.length repeated.reconciliations : int)];
  let events = events @ [ other; changed; acknowledged; repeated ] in
  let restored =
    List.fold events ~init:E.empty ~f:(fun t event ->
      E.apply t (E.Change.decode (E.Change.jsonaf_of_t event) |> unwrap) |> unwrap)
  in
  print_s
    [%sexp
      (String.equal (Json.canonical (E.to_json t)) (Json.canonical (E.to_json restored))
       : bool)];
  [%expect
    {|
    (attempt)
    (0 true)
    0
    true
|}]
;;

let%expect_test
    "contract changes invalidate acceptance and preserve exact historical manifests"
  =
  let t, _ = fixture () in
  let t, _ = step ~actor:reviewer t (review "approved" 1 Approve) in
  let t, _ = step t (validation "passing" (mref 1) true) in
  let t, _ = step t (Accept { ticket; expected_revision = 1 }) in
  let t, event =
    step
      t
      (Contract_put
         { id = contract_id
         ; expected_revision = 1
         ; schema_version = 1
         ; schema = { schema with revision = 2 }
         ; required_inputs = [ "source" ]
         ; required_outputs = [ "binary" ]
         })
  in
  print_s [%sexp (List.length event.reconciliations : int)];
  print_error (E.ensure_can_complete t ~ticket);
  let t, _ = step t (publish ~contract_revision:2 1) in
  let t, _ =
    step
      t
      (Reconcile { serial = 1; expected_revision = 1; disposition = Revised (mref 2) })
  in
  print_s
    [%sexp
      (List.length (E.pending_reconciliations t ~attempt:None) : int)
    , ((Option.value_exn (E.get_manifest t (mref 1))).contract.revision : int)
    , ((Option.value_exn (E.get_manifest t (mref 2))).contract.revision : int)];
  [%expect
    {|
    1
    Conflict
    (0 1 2)
|}]
;;

let%expect_test "superseding decisions flags declared consumers and rejects cycles" =
  let t, _ = fixture () in
  let first = Evidence_id.Decision.of_string "first" |> unwrap in
  let second = Evidence_id.Decision.of_string "second" |> unwrap in
  let decision id expected_revision supersedes =
    E.Command.Decision_put
      { id
      ; expected_revision
      ; scope = Entity_ref.Ticket ticket
      ; title = "Accepted architecture"
      ; rationale = Resource source
      ; evidence = []
      ; affected = [ Entity_ref.Ticket ticket ]
      ; supersedes
      }
  in
  let t, _ = step t (decision first 0 []) in
  let t, _ = step t (publish ~input:(Decision { id = first; revision = 1 }) 1) in
  let t, event = step t (decision second 0 [ first ]) in
  print_s [%sexp (List.length event.reconciliations : int)];
  print_error
    (E.prepare
       t
       (decision first 1 [ second ])
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:8);
  let context =
    E.query
      t
      ~method_:"evidence.context"
      ~params:(Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t ticket ])
    |> unwrap
  in
  print_s
    [%sexp
      (List.length (Json.list (Json.field context "decisions")) : int)
    , (List.length (Json.list (Json.field context "reconciliations")) : int)];
  [%expect
    {|
    1
    Dependency_cycle
    (2 1)
|}]
;;

let%expect_test
    "malformed pins, missing artifacts, unsupported versions and replay corruption \
     reject atomically"
  =
  let t, events = fixture () in
  print_error
    (E.prepare
       t
       (Manifest_publish
          { id = manifest_id
          ; expected_revision = 1
          ; schema_version = 1
          ; attempt
          ; ticket
          ; contract = cref 1
          ; inputs = []
          ; outputs = []
          })
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:5);
  print_error
    (E.prepare
       t
       (Contract_put
          { id = contract_id
          ; expected_revision = 1
          ; schema_version = 2
          ; schema
          ; required_inputs = []
          ; required_outputs = []
          })
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:5);
  let event = List.hd_exn events in
  let bad =
    match E.Change.jsonaf_of_t event with
    | `Object fields -> Json.obj (("unknown", `True) :: fields)
    | _ -> assert false
  in
  print_error (E.Change.decode bad);
  print_error (E.Change.decode (E.Change.jsonaf_of_t { event with revision = 0 }));
  let changed =
    E.prepare
      t
      (Input_changed
         { previous = Resource source; current = Resource { source with revision = 2 } })
      ~actor
      ~run:None
      ~timestamp:"now"
      ~sequence:5
    |> unwrap
  in
  let change = List.hd_exn (E.changes changed) in
  print_error (E.apply t { change with reconciliations = [] });
  let attempt_record =
    { Attempt.id = attempt
    ; revision = 1
    ; run = Id.Run.of_string "run" |> unwrap
    ; ticket
    ; token = 1
    ; state = Running
    ; sessions = []
    ; checkpoints = []
    ; evidence = ""
    }
  in
  print_error
    (E.validate_references
       t
       ~attempt:(fun id ->
         if Attempt.Id.equal id attempt then Some attempt_record else None)
       ~pin_exists:(function
         | Resource p -> not (Id.Resource.equal p.id source.id)
         | Event _ | Commit _ | Checksum _ | Comment _ | Contract _ | Decision _ -> true)
       ~entity_exists:(fun _ -> true)
       ~review_request_exists:(fun _ -> true));
  let command = publish 1 in
  let method_, params = E.encode command |> unwrap in
  let decoded = E.decode ~method_ ~params |> unwrap in
  print_s
    [%sexp
      (String.equal
         (Sexp.to_string (E.Command.sexp_of_t command))
         (Sexp.to_string (E.Command.sexp_of_t decoded))
       : bool)];
  [%expect
    {|
    Invalid_argument
    Unsupported_version
    Invalid_argument
    Corrupt_store
    Corrupt_store
    Not_found
    true
|}]
;;

let%expect_test
    "replay exactly reproduces declared input edges across independently selected \
     consumers"
  =
  Quickcheck.test
    ~trials:50
    (Quickcheck.Generator.list_with_length 8 Bool.quickcheck_generator)
    ~f:(fun consumes ->
      let t, events = fixture () in
      let t, events =
        List.foldi consumes ~init:(t, events) ~f:(fun index (t, events) consumes ->
          let id =
            Evidence_id.Manifest.of_string (sprintf "manifest_%d" index) |> unwrap
          in
          let attempt = Attempt.Id.of_string (sprintf "attempt_%d" index) |> unwrap in
          let ticket = Id.Ticket.of_string (sprintf "ticket_%d" index) |> unwrap in
          let input =
            if consumes
            then E.Pin.Resource source
            else Resource (resource "unrelated" 1 'c')
          in
          let t, event = step t (publish ~id ~attempt ~ticket ~input 0) in
          t, events @ [ event ])
      in
      let t, event =
        step
          t
          (Input_changed
             { previous = Resource source
             ; current = Resource { source with revision = 2 }
             })
      in
      let count = 1 + List.count consumes ~f:Fn.id in
      if not (Int.equal count (List.length event.reconciliations))
      then failwith "consumer reference model differs";
      let restored =
        List.fold (events @ [ event ]) ~init:E.empty ~f:(fun t event ->
          E.apply t (E.Change.decode (E.Change.jsonaf_of_t event) |> unwrap) |> unwrap)
      in
      if
        not
          (String.equal
             (Json.canonical (E.to_json t))
             (Json.canonical (E.to_json restored)))
      then failwith "replayed evidence differs");
  print_endline "50 consumer/replay properties passed";
  [%expect {| 50 consumer/replay properties passed |}]
;;

let%expect_test "attempt completion requires its own manifest even without a review gate" =
  let t, events = fixture () in
  let ungated =
    List.take events 2
    |> List.fold ~init:E.empty ~f:(fun t event -> E.apply t event |> unwrap)
  in
  let replacement = Attempt.Id.of_string "replacement" |> unwrap in
  print_error (E.ensure_attempt_can_complete E.empty ~attempt ~ticket);
  print_error (E.ensure_attempt_can_complete ungated ~attempt ~ticket);
  print_error (E.ensure_attempt_can_complete ungated ~attempt:replacement ~ticket);
  let t, _ = step ~actor:reviewer t (review "approved" 1 Approve) in
  let t, _ = step t (validation "passed" (mref 1) true) in
  let t, _ = step t (Accept { ticket; expected_revision = 1 }) in
  print_error (E.ensure_attempt_can_complete t ~attempt ~ticket);
  print_error (E.ensure_attempt_can_complete t ~attempt:replacement ~ticket);
  [%expect
    {|
    Blocked
    ok
    Blocked
    ok
    Blocked
  |}]
;;
