open Core
open Workgraph

let unwrap = function
  | Ok x -> x
  | Error p -> failwith (Sexp.to_string_hum (Problem.sexp_of_t p))
;;

let actor = unwrap (Id.Actor.of_string "actor")
let other_actor = unwrap (Id.Actor.of_string "other")
let run = unwrap (Id.Run.of_string "run")
let other_run = unwrap (Id.Run.of_string "other-run")
let ticket = unwrap (Id.Ticket.of_string "ticket")
let worktree = unwrap (Coordination_id.Worktree.of_string "tree")

let target ?(tree = worktree) kind path =
  unwrap (Path_scope.create ~worktree_id:tree ~kind ~path)
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let prepare t ?(actor = actor) ?(run = None) ?(now = 0L) command =
  Agent_run.prepare t ~now_unix_ms:now command ~actor ~run ~timestamp:"now" ~sequence:1
;;

let step t ?actor ?run ?now c =
  Agent_run.candidate (unwrap (prepare t ?actor ?run ?now c))
;;

let register t id actor =
  step
    t
    ~actor
    (Agent_run.Command.Register
       { id
       ; parent = None
       ; parent_stop_policy = Continue
       ; objective = "work"
       ; capabilities = []
       ; process_ref = None
       ; worktree_ref = None
       })
;;

let runs () = register (register Agent_run.empty run actor) other_run other_actor

let acquire t run actor requests =
  prepare
    t
    ~actor
    ~run:(Some run)
    (Agent_run.Command.Coordination (Paths_acquire { run; requests }))
;;

let request target mode duration =
  { Path_reservation.Request.target; mode; lease_duration_ms = duration }
;;

let pin =
  Evidence_event.Pin.Checksum { source = "deployment"; digest = String.make 64 'a' }
;;

let condition_id = unwrap (Coordination_id.Condition.of_string "ready")
let operation_id = unwrap (Coordination_id.Operation.of_string "deploy-1")
let signal_id = unwrap (Coordination_id.Signal.of_string "signal-1")

let declaration expected_revision =
  External_condition.Command.Put
    { condition_id
    ; expected_revision
    ; ticket_id = ticket
    ; operation_id
    ; artifact = pin
    ; required = true
    ; label = "deployment ready"
    ; recipients = []
    }
;;

let signal ?(summary = "confirmed") () =
  External_condition.Command.Signal
    { signal_id
    ; condition_id
    ; expected_revision = 1
    ; operation_id
    ; artifact = pin
    ; evidence = [ pin ]
    ; summary
    }
;;

let condition_prepare t ?(actor = actor) command =
  External_condition.prepare t command ~actor ~run:None ~timestamp:"now" ~sequence:1
;;

let%expect_test "lexical scopes normalize; boundary and worktree identities remain exact" =
  let subtree = target Subtree "./src//./"
  and file = target File "src/main.ml" in
  print_s
    [%sexp
      (Path_scope.path subtree : string)
    , (Path_scope.overlaps subtree file : bool)
    , (Path_scope.overlaps subtree (target File "src-extra/main.ml") : bool)
    , (Path_scope.overlaps
         subtree
         (target
            ~tree:(unwrap (Coordination_id.Worktree.of_string "other"))
            File
            "src/main.ml")
       : bool)];
  List.iter
    [ "../escape"; "a/../../escape"; "/absolute"; "a\\b"; "a*"; "\000"; "\255" ]
    ~f:(fun path -> report (Path_scope.create ~worktree_id:worktree ~kind:File ~path));
  report
    (Json.decode (fun () ->
       Path_scope.t_of_jsonaf
         (Json.obj
            [ "worktree_id", Json.string "tree"
            ; "kind", Json.string "file"
            ; "path", Json.string "./src/main.ml"
            ])));
  [%expect
    {|
    (src true false false)
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

let%expect_test "path overlap algebra stays symmetric over varied component boundaries" =
  let scopes =
    List.concat_map [ "."; "a"; "a/b"; "ab"; "a/bb"; "a/b/c" ] ~f:(fun path ->
      if String.equal path "."
      then [ target Subtree path ]
      else [ target File path; target Subtree path ])
  in
  List.iter scopes ~f:(fun a ->
    List.iter scopes ~f:(fun b ->
      assert (Bool.equal (Path_scope.overlaps a b) (Path_scope.overlaps b a));
      if Path_scope.covers a b then assert (Path_scope.overlaps a b)));
  print_endline "all scope pairs passed";
  [%expect {| all scope pairs passed |}]
;;

let%expect_test "shared overlap cooperates; exclusive conflicts retain expired owners" =
  let t = runs () in
  let subtree = target Subtree "src"
  and file = target File "src/main.ml" in
  let t =
    Agent_run.candidate
      (unwrap (acquire t run actor [ request subtree Shared (Some 1L) ]))
  in
  let t =
    Agent_run.candidate
      (unwrap (acquire t other_run other_actor [ request file Shared None ]))
  in
  report
    (acquire
       t
       other_run
       other_actor
       [ request (target File "src/other.ml") Exclusive None ]);
  let held = Option.value_exn (Agent_run.get_path_reservation t subtree) in
  print_s
    [%sexp
      (List.length held.holders : int)
    , (Allocation_lease.status (List.hd_exn held.holders).lease ~now_unix_ms:100L
       : Allocation_lease.Status.t)];
  [%expect
    {|
    Already_claimed
    (1 Expired)
    |}]
;;

let%expect_test "an unavailable path aborts every earlier grant in the batch" =
  let t = runs () in
  let blocked = target Subtree "z"
  and free = target File "a" in
  let t =
    Agent_run.candidate (unwrap (acquire t run actor [ request blocked Exclusive None ]))
  in
  report
    (acquire
       t
       other_run
       other_actor
       [ request free Exclusive None; request (target File "z/file") Exclusive None ]);
  print_s [%sexp (Option.is_none (Agent_run.get_path_reservation t free) : bool)];
  [%expect
    {|
    Already_claimed
    true
    |}]
;;

let%expect_test "required paths demand a run and prepare atomic reusable ownership" =
  let t = runs ()
  and path = target Subtree "src" in
  let t =
    step
      t
      (Coordination
         (Ticket_paths_put
            { ticket_id = ticket
            ; expected_revision = 0
            ; declarations =
                [ { Ticket_paths.Declaration.target = path; mode = Exclusive } ]
            ; require_reservations = true
            }))
  in
  print_s
    [%sexp
      (List.length (Agent_run.start_blockers t ~ticket ~run:None ~now_unix_ms:0L) : int)];
  let p =
    unwrap
      (Agent_run.prepare_start_reservations
         t
         ~ticket
         ~run
         ~actor
         ~timestamp:"now"
         ~sequence:1
         ~now_unix_ms:0L)
  in
  print_s
    [%sexp
      (List.length (Agent_run.changes p) : int)
    , (List.length
         (Agent_run.start_blockers
            (Agent_run.candidate p)
            ~ticket
            ~run:(Some run)
            ~now_unix_ms:0L)
       : int)];
  let p =
    unwrap
      (Agent_run.prepare_start_reservations
         (Agent_run.candidate p)
         ~ticket
         ~run
         ~actor
         ~timestamp:"now"
         ~sequence:2
         ~now_unix_ms:0L)
  in
  print_s [%sexp (List.length (Agent_run.changes p) : int)];
  [%expect
    {|
    1
    (1 0)
    0
    |}]
;;

let%expect_test
    "recovery matches old actor epoch lease and fence, with durable admin attribution"
  =
  let path = target File "src/main.ml" in
  let t =
    Agent_run.candidate
      (unwrap (acquire (runs ()) run actor [ request path Exclusive (Some 1L) ]))
  in
  let recovery =
    { Ownership_recovery.Request.recovery_id =
        unwrap (Coordination_id.Recovery.of_string "recover-1")
    ; target = Path path
    ; expected_epoch = 1
    ; old_run_id = run
    ; old_actor_id = actor
    ; token = 1
    ; expected_lease_revision = 1
    ; confirmation = Isolated
    ; reason = "old sandbox quarantined"
    ; evidence = [ pin ]
    }
  in
  report
    (prepare
       t
       ~actor:other_actor
       (Coordination (Recover { recovery with old_actor_id = other_actor })));
  let p =
    unwrap (prepare t ~actor:other_actor ~now:100L (Coordination (Recover recovery)))
  in
  let t = Agent_run.candidate p in
  let audit = Option.value_exn (Agent_run.get_recovery t recovery.recovery_id) in
  print_s
    [%sexp
      (Id.Actor.equal audit.actor_id other_actor : bool)
    , (List.is_empty (Option.value_exn (Agent_run.get_path_reservation t path)).holders
       : bool)];
  let t =
    Agent_run.candidate
      (unwrap (acquire t other_run other_actor [ request path Exclusive None ]))
  in
  report
    (prepare
       t
       ~actor:other_actor
       (Coordination
          (Recover
             { recovery with
               recovery_id = unwrap (Coordination_id.Recovery.of_string "recover-2")
             })));
  let replayed =
    List.fold
      (Agent_run.changes p)
      ~init:
        (Agent_run.candidate
           (unwrap (acquire (runs ()) run actor [ request path Exclusive (Some 1L) ])))
      ~f:(fun t c ->
        unwrap
          (Agent_run.apply
             t
             (Agent_run_event.t_of_jsonaf (Agent_run_event.jsonaf_of_t c))))
  in
  print_s [%sexp (List.length (Agent_run.recoveries replayed) : int)];
  [%expect
    {|
    Stale_claim
    (true true)
    Stale_claim
    1
    |}]
;;

let%expect_test
    "signal identity binds full content and attribution; declaration revision resets \
     satisfaction"
  =
  let t =
    External_condition.candidate
      (unwrap (condition_prepare External_condition.empty (declaration 0)))
  in
  print_s [%sexp (List.length (External_condition.blockers t ~ticket) : int)];
  let p = unwrap (condition_prepare t (signal ())) in
  let t = External_condition.candidate p in
  print_s [%sexp (List.length (External_condition.blockers t ~ticket) : int)];
  let duplicate =
    unwrap
      (External_condition.prepare
         t
         (signal ())
         ~actor
         ~run:None
         ~timestamp:"later"
         ~sequence:99)
  in
  print_s
    [%sexp
      (List.length (External_condition.changes duplicate) : int)
    , (Json.integer (Json.field (External_condition.result duplicate) "sequence") : int)];
  report (condition_prepare t ~actor:other_actor (signal ()));
  report (condition_prepare t (signal ~summary:"different" ()));
  let t = External_condition.candidate (unwrap (condition_prepare t (declaration 1))) in
  print_s [%sexp (List.length (External_condition.blockers t ~ticket) : int)];
  report
    (External_condition.validate_references
       t
       ~ticket_exists:(fun _ -> true)
       ~pin_exists:(fun _ -> false));
  [%expect
    {|
    1
    0
    (0 1)
    Conflict
    Conflict
    1
    Not_found
    |}]
;;

let%expect_test "resolved replay refuses forged signal revision and recovery evidence" =
  let t =
    External_condition.candidate
      (unwrap (condition_prepare External_condition.empty (declaration 0)))
  in
  let p = unwrap (condition_prepare t (signal ())) in
  let s =
    Option.value_exn
      (External_condition.signal (External_condition.candidate p) signal_id)
  in
  report
    (External_condition.apply
       t
       (Signal { s with condition_revision = 2 })
       ~actor
       ~run:None
       ~timestamp:"now"
       ~sequence:1);
  report
    (Api_codec.decode
       Evidence_wire.pin
       (Json.obj
          [ "kind", Json.string "checksum"
          ; "source", Json.string "external"
          ; "digest", Json.string "broken"
          ]));
  [%expect
    {|
    Conflict
    Invalid_argument
    |}]
;;

let%expect_test
    "required reservations retain expiry and never upgrade same target implicitly"
  =
  let path = target File "src/main.ml" in
  let with_policy t =
    step
      t
      (Coordination
         (Ticket_paths_put
            { ticket_id = ticket
            ; expected_revision = 0
            ; declarations =
                [ { Ticket_paths.Declaration.target = path; mode = Exclusive } ]
            ; require_reservations = true
            }))
  in
  let shared =
    with_policy
      (Agent_run.candidate
         (unwrap (acquire (runs ()) run actor [ request path Shared None ])))
  in
  print_s
    [%sexp
      (Agent_run.start_blockers shared ~ticket ~run:(Some run) ~now_unix_ms:0L
       : Agent_run.Start_blocker.t list)];
  let expired =
    with_policy
      (Agent_run.candidate
         (unwrap (acquire (runs ()) run actor [ request path Exclusive (Some 1L) ])))
  in
  report
    (Agent_run.prepare_start_reservations
       expired
       ~ticket
       ~run
       ~actor
       ~timestamp:"now"
       ~sequence:1
       ~now_unix_ms:1L);
  print_s
    [%sexp
      (List.length
         (Option.value_exn (Agent_run.get_path_reservation expired path)).holders
       : int)];
  [%expect
    {|
    ((Ownership_mode (target ((worktree_id tree) (kind File) (path src/main.ml)))
      (holder
       ((run run) (actor actor) (token 1) (mode Shared)
        (lease
         ((epoch 1) (revision 1) (policy Indefinite) (last_unix_ms 0)
          (deadline_unix_ms ())))))))
    Blocked
    1
    |}]
;;

let%expect_test
    "path algebra matches a component reference model across generated targets"
  =
  Quickcheck.test
    ~trials:100
    (Quickcheck.Generator.list_with_length 4 (Int.gen_incl 0 30))
    ~f:(fun values ->
      let make a b =
        let path =
          if a mod 7 = 0
          then "."
          else
            String.concat
              ~sep:"/"
              (List.init ((a mod 4) + 1) ~f:(fun n -> Int.to_string ((b + n) mod 3)))
        in
        let kind =
          if a mod 2 = 0 || String.equal path "." then Path_scope.Kind.Subtree else File
        in
        target
          ~tree:
            (unwrap
               (Coordination_id.Worktree.of_string
                  (if b mod 2 = 0 then "tree" else "other")))
          kind
          path
      in
      match values with
      | [ a; b; c; d ] ->
        let x = make a b
        and y = make c d in
        let components p =
          if String.equal (Path_scope.path p) "."
          then []
          else String.split (Path_scope.path p) ~on:'/'
        in
        let covers a b =
          Coordination_id.Worktree.equal
            (Path_scope.worktree_id a)
            (Path_scope.worktree_id b)
          &&
          match Path_scope.kind a with
          | File ->
            Path_scope.Kind.equal (Path_scope.kind b) File
            && List.equal String.equal (components a) (components b)
          | Subtree ->
            List.is_prefix (components b) ~prefix:(components a) ~equal:String.equal
        in
        assert (Bool.equal (Path_scope.overlaps x y) (covers x y || covers y x))
      | _ -> assert false);
  print_endline "100 generated reference comparisons passed";
  [%expect {| 100 generated reference comparisons passed |}]
;;

let%expect_test
    "latest ticket attempt orders immutable creation revisions, including terminal \
     attempts"
  =
  let t = runs () in
  let older = unwrap (Attempt.Id.of_string "z-old")
  and newer = unwrap (Attempt.Id.of_string "a-new") in
  let start t id =
    unwrap
      (prepare
         t
         ~run:(Some run)
         (Attempt_start { id; run; ticket; token = 1; sessions = [] }))
  in
  let finish t id =
    unwrap
      (prepare
         t
         ~run:(Some run)
         (Attempt_finish { id; expected_revision = 1; state = Failed; evidence = "done" }))
  in
  let p1 = start t older in
  let p2 = finish (Agent_run.candidate p1) older in
  let p3 = start (Agent_run.candidate p2) newer in
  let p4 = finish (Agent_run.candidate p3) newer in
  let replayed =
    List.fold
      (List.concat_map [ p1; p2; p3; p4 ] ~f:Agent_run.changes)
      ~init:t
      ~f:(fun t c ->
        unwrap
          (Agent_run.apply
             t
             (Agent_run_event.t_of_jsonaf (Agent_run_event.jsonaf_of_t c))))
  in
  let latest =
    Option.value_exn (Agent_run.latest_attempt_for_ticket replayed ~ticket ~token:1)
  in
  print_s [%sexp (latest.id : Attempt.Id.t)];
  print_s
    [%sexp
      (Option.is_none (Agent_run.latest_attempt_for_ticket replayed ~ticket ~token:2)
       : bool)];
  [%expect
    {|
    a-new
    true
    |}]
;;

let%expect_test
    "raw coordination references share fields and resolved commands reject aliases"
  =
  let params =
    unwrap
      (Json.parse
         {|{"ticket_id":"$ticket","expected_revision":"0","declarations":[],"require_reservations":false}|})
  in
  let codec =
    Option.value_exn (Agent_coordination_api.request_codec ~method_:"ticket.paths.put")
  in
  print_s [%sexp (Result.is_ok (Api_codec.decode codec params) : bool)];
  print_s
    [%sexp
      (Result.is_error
         (Agent_coordination_api.decode_command ~method_:"ticket.paths.put" ~params)
       : bool)];
  let signal =
    unwrap
      (Json.parse
         (Printf.sprintf
            {|{"signal_id":"signal","condition_id":"condition","expected_revision":"1","operation_id":"operation","artifact":{"kind":"comment","comment_id":"$note","revision":"1"},"evidence":[{"kind":"checksum","source":"$literal","digest":"%s"}],"summary":"$literal"}|}
            (String.make 64 'a')))
  in
  let codec =
    Option.value_exn (Agent_coordination_api.request_codec ~method_:"condition.signal")
  in
  let decoded = unwrap (Api_codec.decode codec signal) in
  print_s [%sexp (Json.text (Json.field decoded "summary") : string)];
  let bad =
    match signal with
    | `Object fields ->
      `Object
        (List.Assoc.add
           fields
           ~equal:String.equal
           "operation_id"
           (Json.string "$operation"))
    | _ -> assert false
  in
  print_s [%sexp (Result.is_error (Api_codec.decode codec bad) : bool)];
  [%expect
    {|
    true
    true
    $literal
    true
    |}]
;;
