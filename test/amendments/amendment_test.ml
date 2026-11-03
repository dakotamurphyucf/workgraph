open Core
open Workgraph
module A = Ticket_amendment

let ok = function
  | Ok x -> x
  | Error e -> failwith e.Problem.message
;;

let actor = Id.Actor.of_string "lead" |> ok
let worker = Id.Actor.of_string "worker" |> ok
let ticket = Id.Ticket.of_string "task" |> ok
let run = Id.Run.of_string "run" |> ok
let ownership token = Some { A.Ownership.actor = worker; run = Some run; token }
let lookup token id = if Id.Ticket.equal ticket id then ownership token else None
let identifier name = Amendment_id.of_string name |> ok
let reference name revision = { A.Reference.id = identifier name; revision }

let publish ?(supersedes = []) ?(expected_revision = 0) ?(require_ack = true) name =
  A.Command.Publish
    { id = identifier name
    ; ticket
    ; expected_revision
    ; title = "Instruction"
    ; source = Text "retained immutable text"
    ; require_ack
    ; supersedes
    }
;;

let prepare ?(by = actor) ?(run = None) ?(token = 1) ?(now_unix_ms = None) state command =
  A.prepare
    state
    command
    ~actor:by
    ~run
    ~timestamp:"recorded"
    ~now_unix_ms
    ~ownership:(lookup token)
;;

let commit ?(by = actor) ?(run = None) ?(token = 1) state command =
  let prepared = prepare ~by ~run ~token state command |> ok in
  List.fold (A.changes prepared) ~init:state ~f:(fun state change ->
    A.apply
      state
      (A.Change.of_json (A.Change.to_json change) |> ok)
      ~ownership:(lookup token)
    |> ok)
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error e -> print_s [%sexp (e.Problem.kind : Problem.kind)]
;;

let pending state token =
  A.pending state ~ticket ~ownership:(ownership token)
  |> List.map ~f:(fun r -> r.A.Reference.revision)
  |> fun l -> print_s [%sexp (l : int list)]
;;

let%expect_test
    "acknowledgements bind exact active revision and current claim, not ordinary progress"
  =
  let state = commit A.empty (publish "instruction") in
  pending state 1;
  report
    (prepare
       ~by:worker
       ~run:(Some run)
       state
       (Acknowledge { amendment = reference "instruction" 1; ticket; token = 2 }));
  let state =
    commit
      ~by:worker
      ~run:(Some run)
      state
      (Acknowledge { amendment = reference "instruction" 1; ticket; token = 1 })
  in
  pending state 1;
  pending state 2;
  report (A.ensure_can_complete state ~ticket ~ownership:(ownership 1));
  let duplicate =
    prepare
      ~by:worker
      ~run:(Some run)
      state
      (Acknowledge { amendment = reference "instruction" 1; ticket; token = 1 })
    |> ok
  in
  print_s [%sexp (List.length (A.changes duplicate) : int)];
  let state = commit state (publish ~expected_revision:1 "instruction") in
  pending state 1;
  report
    (prepare
       ~by:worker
       ~run:(Some run)
       state
       (Acknowledge { amendment = reference "instruction" 1; ticket; token = 1 }));
  print_s [%sexp (Option.is_some (A.get state (reference "instruction" 1)) : bool)];
  [%expect
    {|
  (1)
  Stale_claim
  ()
  (1)
  ok
  0
  (2)
  Conflict
  true
  |}]
;;

let%expect_test "terminal lifecycle is retained, exact and never reactivated" =
  let state = commit A.empty (publish "old") in
  let state = commit state (publish ~supersedes:[ reference "old" 1 ] "replacement") in
  pending state 1;
  List.iter
    (A.history state (identifier "old"))
    ~f:(fun r ->
      print_s [%sexp (r.reference.revision : int), (r.content : A.Revision.Content.t)]);
  report (prepare state (publish ~expected_revision:2 "old"));
  report
    (prepare
       state
       (publish
          ~expected_revision:1
          ~supersedes:[ reference "replacement" 1 ]
          "replacement"));
  let state =
    commit
      state
      (Withdraw { amendment = reference "replacement" 1; reason = "Withdraw explicitly" })
  in
  pending state 1;
  report (prepare state (publish ~expected_revision:2 "replacement"));
  print_s [%sexp (Option.is_some (A.get state (reference "replacement" 1)) : bool)];
  [%expect
    {|
   (1)
   (1
    (Published
     ((title Instruction) (source (Text "retained immutable text"))
      (require_ack true) (supersedes ()))))
   (2
    (Superseded (previous ((id old) (revision 1)))
     (replacement ((id replacement) (revision 1)))))
   Conflict
   Dependency_cycle
   ()
   Conflict
   true
   |}]
;;

let%expect_test "independent replay rejects fabricated ack and omitted supersession audit"
  =
  let state = commit A.empty (publish "old") in
  let prepared =
    prepare state (publish ~supersedes:[ reference "old" 1 ] "replacement") |> ok
  in
  let change = List.hd_exn (A.changes prepared) in
  let tampered =
    match change.update with
    | Revisions (first :: _) -> { change with update = Revisions [ first ] }
    | _ -> assert false
  in
  report (A.apply state tampered ~ownership:(lookup 1));
  let ack =
    { A.Acknowledgement.amendment = reference "old" 1
    ; ticket
    ; ownership = { actor = worker; run = Some run; token = 2 }
    ; timestamp = "recorded"
    ; observed_unix_ms = None
    }
  in
  report
    (A.apply
       state
       { revision = A.revision state + 1; update = Acknowledged ack }
       ~ownership:(lookup 1));
  let state =
    commit state (Withdraw { amendment = reference "old" 1; reason = "obsolete" })
  in
  report
    (prepare
       ~by:worker
       ~run:(Some run)
       state
       (Acknowledge { amendment = reference "old" 2; ticket; token = 1 }));
  report
    (A.validate_references
       state
       ~ticket_exists:(fun _ -> false)
       ~resource_digest:(fun _ ~revision:_ -> None));
  [%expect
    {|
  Corrupt_store
  Stale_claim
  Conflict
  Not_found
  |}]
;;

let set json name value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields name value ~equal:String.equal)
  | _ -> assert false
;;

let remove json name =
  match json with
  | `Object fields -> Json.obj (List.Assoc.remove fields name ~equal:String.equal)
  | _ -> assert false
;;

let response method_ value =
  List.find_map
    Ticket_amendment_api.methods
    ~f:(fun (Api_method.Packed.Pack method_definition) ->
      if String.equal method_ (Api_method.name method_definition)
      then
        Some
          (Result.map
             (Api_codec.decode (Api_method.response_codec method_definition) value)
             ~f:(fun _ -> ()))
      else None)
  |> Option.value_exn
;;

let query state method_ fields =
  Ticket_amendment_api.query
    state
    ~workspace_revision:10
    ~ownership:(lookup 1)
    ~ticket_completed:(Fn.const false)
    ~method_
    ~params:(Json.obj fields)
;;

let%expect_test
    "public publication decoding bounds body and exact supersession references"
  =
  let method_, valid = Ticket_amendment_api.encode (publish "instruction") |> ok in
  let decode json = Ticket_amendment_api.decode ~method_ ~params:json |> report in
  decode valid;
  decode
    (set
       valid
       "source"
       (Json.obj [ "kind", `String "text"; "body", `String (String.make 65537 'x') ]));
  let ref_json r = Api_codec.encode A.Reference.codec r |> ok in
  decode (set valid "supersedes" (`Array [ ref_json (reference "instruction" 1) ]));
  decode
    (set
       valid
       "supersedes"
       (`Array [ ref_json (reference "old" 1); ref_json (reference "old" 2) ]));
  decode
    (set
       valid
       "supersedes"
       (`Array (List.init 33 ~f:(fun i -> ref_json (reference (sprintf "old%d" i) 1)))));
  [%expect
    {|
   ok
   Invalid_argument
   Dependency_cycle
   Invalid_argument
   Invalid_argument
   |}]
;;

let%expect_test
    "whole revision budget fallback retains exact expansion and captured continuation"
  =
  let big =
    A.Command.Publish
      { id = identifier "large"
      ; ticket
      ; expected_revision = 0
      ; title = "Large"
      ; source = Text (String.make 65536 'x')
      ; require_ack = true
      ; supersedes = []
      }
  in
  let state = commit A.empty big in
  let get_fields = [ "amendment_id", `String "large"; "max_bytes", Json.int 4096 ] in
  let small =
    query state "ticket.amendment.get" get_fields
    |> ok
    |> fun value -> Json.field value "data"
  in
  report (response "ticket.amendment.get" small);
  print_s
    [%sexp
      (Option.is_none (Json.optional small "absent") : bool)
    , (Json.field small "item" : Jsonaf.t)
    , (Json.field small "needs_larger_budget" : Jsonaf.t)];
  let needed = Json.field small "required_bytes" |> Json.integer in
  let full =
    query
      state
      "ticket.amendment.get"
      [ "amendment_id", `String "large"; "max_bytes", Json.int needed ]
    |> ok
    |> fun v -> Json.field v "data"
  in
  report (response "ticket.amendment.get" full);
  print_s
    [%sexp
      (Json.field full "item"
       |> Api_codec.decode A.Revision.codec
       |> ok
       |> fun r ->
       match r.A.Revision.content with
       | Published { source = Text text; _ } -> String.length text
       | _ -> assert false
       : int)];
  let page =
    query state "ticket.amendment.list" [ "max_bytes", Json.int 4096 ]
    |> ok
    |> fun value -> Json.field value "data"
  in
  report (response "ticket.amendment.list" page);
  print_s
    [%sexp
      (Json.field page "items" |> Json.list |> List.length : int)
    , (Json.field page "next_offset" : Jsonaf.t)
    , (Json.field page "needs_larger_budget" : Jsonaf.t)];
  report (response "ticket.amendment.list" (set page "next_offset" (Json.int 1)));
  report (response "ticket.amendment.get" (set small "needs_larger_budget" `False));
  report (query state "ticket.amendment.list" [ "offset", Json.int 1 ]);
  report
    (query
       state
       "ticket.amendment.list"
       [ "offset", Json.int 1; "at_revision", Json.int 9 ]);
  let finished =
    query
      state
      "ticket.amendment.list"
      [ "offset", Json.int 1; "at_revision", Json.int 10 ]
    |> ok
    |> fun value -> Json.field value "data"
  in
  report (response "ticket.amendment.list" finished);
  print_s
    [%sexp
      (Json.field finished "remaining" : Jsonaf.t)
    , (Json.field finished "next_offset" : Jsonaf.t)];
  [%expect
    {|
   ok
   (true Null True)
   ok
   65536
   ok
   (0 (String 0) True)
   Invalid_argument
   Invalid_argument
   Invalid_argument
   Conflict
   ok
   ((String 0) Null)
   |}]
;;

let%expect_test "ack server observation is retained but is outside stable claim binding" =
  let state = commit A.empty (publish "instruction") in
  let command =
    A.Command.Acknowledge { amendment = reference "instruction" 1; ticket; token = 1 }
  in
  let prepared =
    prepare ~by:worker ~run:(Some run) ~now_unix_ms:(Some 100L) state command |> ok
  in
  let change = List.hd_exn (A.changes prepared) in
  let json = A.Change.to_json change in
  let state = A.apply state (A.Change.of_json json |> ok) ~ownership:(lookup 1) |> ok in
  let ack = List.hd_exn (A.acknowledgements state (reference "instruction" 1)) in
  print_s [%sexp (ack.observed_unix_ms : int64 option)];
  let duplicate =
    prepare ~by:worker ~run:(Some run) ~now_unix_ms:(Some 200L) state command |> ok
  in
  print_s [%sexp (List.length (A.changes duplicate) : int)];
  report (prepare ~by:worker ~run:(Some run) ~now_unix_ms:(Some (-1L)) state command);
  report
    (A.prepare
       state
       command
       ~actor:worker
       ~run:(Some run)
       ~timestamp:""
       ~now_unix_ms:(Some 200L)
       ~ownership:(lookup 1));
  report
    (prepare
       ~by:worker
       ~run:(Some run)
       ~now_unix_ms:(Some (-1L))
       (commit A.empty (publish "instruction"))
       command);
  let update = Json.field json "update" in
  let ack = Json.field update "acknowledgement" in
  report
    (A.Change.of_json
       (set json "update" (set update "acknowledgement" (remove ack "observed_unix_ms"))));
  [%expect
    {|
    (100)
    0
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "captured ack replay lease clock rejects missing, expired and regressed observation"
  =
  let lease =
    Allocation_lease.create ~epoch:1 ~now_unix_ms:100L ~policy:(Duration_ms 10L) () |> ok
  in
  let ack clock =
    { A.Acknowledgement.amendment = reference "instruction" 1
    ; ticket
    ; ownership = { actor = worker; run = Some run; token = 1 }
    ; timestamp = "recorded"
    ; observed_unix_ms = clock
    }
  in
  let replay clock = A.Acknowledgement.validate_lease (ack clock) ~lease |> report in
  replay (Some 100L);
  replay None;
  replay (Some 110L);
  replay (Some 99L);
  replay (Some (-1L));
  let indefinite = Allocation_lease.create ~epoch:1 ~now_unix_ms:100L () |> ok in
  report (A.Acknowledgement.validate_lease (ack None) ~lease:indefinite);
  let renewed =
    Allocation_lease.renew lease ~expected_revision:1 ~epoch:1 ~now_unix_ms:105L |> ok
  in
  (* Replay uses the pre-ack lease, never a later renewed lease's clock. *)
  report (A.Acknowledgement.validate_lease (ack (Some 101L)) ~lease);
  report (A.Acknowledgement.validate_lease (ack (Some 101L)) ~lease:renewed);
  [%expect
    {|
 ok
 Invalid_argument
 Stale_claim
 Stale_claim
 Invalid_argument
 ok
 ok
 Stale_claim
 |}]
;;

let%expect_test
    "exact amendment evidence pins retain source identity and ascending invalidations"
  =
  let pin id revision = Evidence.Pin.Amendment { id = identifier id; revision } in
  let previous = pin "instruction" 1
  and current = pin "instruction" 2 in
  let encoded = Api_codec.encode Evidence_wire.pin current |> ok in
  let decoded = Api_codec.decode Evidence_wire.pin encoded |> ok in
  print_s [%sexp (Evidence.Pin.equal decoded current : bool)];
  let durable = Evidence.Pin.jsonaf_of_t current |> Evidence.Pin.t_of_jsonaf in
  print_s [%sexp (Evidence.Pin.equal durable current : bool)];
  report (Api_codec.decode Evidence_wire.pin (set encoded "revision" (Json.int 0)));
  let prepare previous current =
    Evidence.prepare
      Evidence.empty
      (Input_changed { previous; current })
      ~ticket_context:(fun _ -> None)
      ~actor
      ~run:None
      ~timestamp:"recorded"
      ~sequence:1
  in
  let prepared = prepare previous current |> ok in
  print_s [%sexp (List.length (Evidence.changes prepared) : int)];
  List.iter (Evidence.changes prepared) ~f:(fun change ->
    report (Evidence.apply Evidence.empty change ~ticket_context:(fun _ -> None)));
  report (prepare current previous);
  report (prepare previous (pin "other" 2));
  [%expect
    {|
    true
    true
    Invalid_argument
    1
    ok
    Conflict
    Conflict
    |}]
;;

let%expect_test
    "resource amendment authority retains exact immutable content pin after withdrawal"
  =
  let resource = Id.Resource.of_string "source" |> ok in
  let digest = String.make 64 'a' in
  let command =
    A.Command.Publish
      { id = identifier "resource-instruction"
      ; ticket
      ; expected_revision = 0
      ; title = "Pinned instruction"
      ; source = Resource { id = resource; revision = 3; digest }
      ; require_ack = true
      ; supersedes = []
      }
  in
  let state = commit A.empty command in
  let validate state digest_lookup =
    A.validate_references
      state
      ~ticket_exists:(Id.Ticket.equal ticket)
      ~resource_digest:(fun id ~revision ->
        if Id.Resource.equal id resource && revision = 3 then digest_lookup else None)
  in
  report (validate state (Some digest));
  report (validate state (Some (String.make 64 'b')));
  let state =
    commit
      state
      (Withdraw { amendment = reference "resource-instruction" 1; reason = "obsolete" })
  in
  report (validate state (Some digest));
  report (validate state None);
  [%expect
    {|
    ok
    Not_found
    ok
    Not_found
    |}]
;;
