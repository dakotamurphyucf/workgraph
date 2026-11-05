open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let actor = ok (Id.Actor.of_string "worker")
let run = ok (Id.Run.of_string "run")
let other = ok (Id.Run.of_string "other")
let parse s = ok (Json.parse s)

let prepare ?(actor = actor) ?run ?(now = 100L) t method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(parse params))
    ~f:(fun c ->
      State.prepare t c ~actor ?run ~now_unix_ms:now ~timestamp:"2026-11-03T00:00:00Z")
;;

let step ?actor ?run ?now t method_ params =
  let p = ok (prepare ?actor ?run ?now t method_ params) in
  let next = State.candidate p in
  let replay = ok (State.replay t (State.events p)) in
  assert (
    String.equal
      (Json.canonical (State.to_json next))
      (Json.canonical (State.to_json replay)));
  next
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_endline (Problem.wire_name p.Problem.kind)
;;

let target path kind =
  ok
    (Path_scope.create
       ~worktree_id:(ok (Coordination_id.Worktree.of_string "tree"))
       ~kind
       ~path)
;;

let paths t id kind path =
  step
    t
    "ticket.paths.put"
    (sprintf
       {|{"ticket_id":"%s","expected_revision":"0","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"%s","path":"%s"},"mode":"exclusive"}]}|}
       id
       kind
       path)
;;

let fixture () =
  let t =
    ok
      (State.empty
         ~workspace:(ok (Id.Workspace.of_string "reservations"))
         ~name:"Reservations")
  in
  let t = step t "run.register" {|{"target_run_id":"run","objective":"work"}|} in
  let t = step t "run.register" {|{"target_run_id":"other","objective":"work"}|} in
  let t =
    List.fold [ "a"; "b"; "c" ] ~init:t ~f:(fun t id ->
      step t "ticket.create" (sprintf {|{"ticket_id":"%s","title":"%s"}|} id id))
  in
  let t = paths t "a" "subtree" "src" in
  let t = paths t "b" "file" "src/b.ml" in
  paths t "c" "file" "elsewhere"
;;

let holders t path kind =
  Option.value_map
    (Agent_run.get_path_reservation (State.agent_runs t) (target path kind))
    ~default:[]
    ~f:(fun r -> r.holders)
;;

let show t =
  let hs = holders t "src" Subtree in
  print_s
    [%sexp
      (List.length hs : int)
    , (List.map hs ~f:(fun h ->
         match h.Reservation.Holder.origin with
         | Manual -> "manual", []
         | Automatic cs ->
           ( "automatic"
           , List.map cs ~f:(fun c -> Id.Ticket.to_string c.Reservation.Claim.ticket) ))
       : (string * string list) list)]
;;

let%expect_test
    "shared automatic coverage outlives one sibling and releases only last borrower"
  =
  let t =
    step ~run (fixture ()) "ticket.start" {|{"ticket_id":"a","attempt_id":"try-a"}|}
  in
  let t = step ~run t "ticket.start" {|{"ticket_id":"b","attempt_id":"try-b"}|} in
  show t;
  let t =
    step ~run t "ticket.finish" {|{"ticket_id":"a","token":"1","evidence":"done a"}|}
  in
  show t;
  let t = step ~run t "ticket.release" {|{"ticket_id":"b","token":"1"}|} in
  show t;
  [%expect
    {|
    (1 ((automatic (a b))))
    (1 ((automatic (b))))
    (0 ())
    |}]
;;

let%expect_test
    "manual covering hold is reused without adoption and survives expired claim release"
  =
  let t =
    step
      ~run
      (fixture ())
      "reservation.paths.acquire"
      {|{"target_run_id":"run","requests":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive","lease_duration_ms":"10"}]}|}
  in
  let t = step ~run t "ticket.claim" {|{"ticket_id":"a","lease_duration_ms":"5"}|} in
  show t;
  let t = step ~run ~now:1000L t "ticket.release" {|{"ticket_id":"a","token":"1"}|} in
  show t;
  report (prepare ~run:other ~now:1000L t "ticket.claim" {|{"ticket_id":"b"}|});
  [%expect
    {|
    (1 ((manual ())))
    (1 ((manual ())))
    Blocked
    |}]
;;

let%expect_test
    "attempt and run terminal metadata retain claim borrower and fenced cleanup"
  =
  let t =
    step ~run (fixture ()) "ticket.start" {|{"ticket_id":"a","attempt_id":"try"}|}
  in
  let t =
    step
      ~run
      t
      "attempt.finish"
      {|{"attempt_id":"try","expected_revision":"1","state":"failed","evidence":"failed"}|}
  in
  show t;
  let t =
    step
      ~run
      t
      "run.transition"
      {|{"target_run_id":"run","expected_revision":"1","status":"failed","evidence":"failed"}|}
  in
  show t;
  report
    (prepare
       ~run
       t
       "reservation.path.release"
       {|{"target_run_id":"run","target":{"worktree_id":"tree","kind":"subtree","path":"src"},"token":"1"}|});
  report (prepare ~run t "ticket.release" {|{"ticket_id":"a","token":"2"}|});
  let t = step ~run t "ticket.release" {|{"ticket_id":"a","token":"1"}|} in
  show t;
  [%expect
    {|
    (1 ((automatic (a))))
    (1 ((automatic (a))))
    Conflict
    Stale_claim
    (0 ())
    |}]
;;

let%expect_test "reassignment atomically cleans old borrower but preserves siblings" =
  let t = step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a"}|} in
  let t = step ~run t "ticket.claim" {|{"ticket_id":"b"}|} in
  report
    (prepare
       t
       "ticket.reassign"
       {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"other","reason":"handoff"}|});
  show t;
  let t = step ~run t "ticket.release" {|{"ticket_id":"b","token":"1"}|} in
  let t =
    step
      t
      "ticket.reassign"
      {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"other","reason":"handoff"}|}
  in
  show t;
  let h = List.hd_exn (holders t "src" Subtree) in
  printf "owner=%s token=%d\n" (Id.Run.to_string h.run) h.token;
  let t = step ~run:other t "ticket.release" {|{"ticket_id":"a","token":"2"}|} in
  show t;
  [%expect
    {|
    Already_claimed
    (1 ((automatic (a b))))
    (1 ((automatic (a))))
    owner=other token=2
    (0 ())
    |}]
;;

let%expect_test "guarded ticket recovery releases exact borrower and preserves sibling" =
  let t =
    step ~run (fixture ()) "ticket.start" {|{"ticket_id":"a","attempt_id":"try"}|}
  in
  let t = step ~run t "ticket.start" {|{"ticket_id":"b","attempt_id":"sibling"}|} in
  let t =
    step
      t
      "ticket.recover"
      {|{"recovery_id":"recover","ticket_id":"a","expected_revision":"2","old_actor_id":"worker","old_run_id":"run","token":"1","expected_lease_revision":"1","disposition":"requeue","confirmation":"isolated","reason":"sandbox quarantined"}|}
  in
  show t;
  print_s
    [%sexp
      ((Option.value_exn
          (Agent_run.get_attempt
             (State.agent_runs t)
             (ok (Attempt.Id.of_string "sibling"))))
         .state
       : Attempt.State.t)];
  print_s
    [%sexp
      ((Option.value_exn
          (Agent_run.get_attempt (State.agent_runs t) (ok (Attempt.Id.of_string "try"))))
         .state
       : Attempt.State.t)];
  [%expect
    {|
    (1 ((automatic (b))))
    Running
    Cancelled
    |}]
;;

let%expect_test "guarded holder recovery audits impacted claims without transferring them"
  =
  let t = step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a"}|} in
  let t = step ~run t "ticket.claim" {|{"ticket_id":"b"}|} in
  let t =
    step
      t
      "reservation.path.recover"
      {|{"recovery_id":"recover-hold","target":{"kind":"path","target":{"worktree_id":"tree","kind":"subtree","path":"src"}},"expected_epoch":"1","old_run_id":"run","old_actor_id":"worker","token":"1","expected_lease_revision":"1","confirmation":"stopped","reason":"runner exited"}|}
  in
  show t;
  let audit =
    Option.value_exn
      (Agent_run.get_recovery
         (State.agent_runs t)
         (ok (Coordination_id.Recovery.of_string "recover-hold")))
  in
  print_s
    [%sexp
      (List.map audit.borrowers ~f:(fun c ->
         Id.Ticket.to_string c.Reservation.Claim.ticket)
       : string list)];
  let t =
    step
      ~run:other
      t
      "reservation.paths.acquire"
      {|{"target_run_id":"other","requests":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive"}]}|}
  in
  report
    (prepare
       ~run
       t
       "attempt.start"
       {|{"attempt_id":"unsafe","target_run_id":"run","ticket_id":"a","token":"1"}|});
  show t;
  [%expect
    {|
    (0 ())
    (a b)
    Already_claimed
    (1 ((manual ())))
    |}]
;;

let%expect_test "acquisition receipts expose own fences and batches fail atomically" =
  let t = fixture () in
  let p =
    ok
      (prepare
         ~run
         t
         "reservation.paths.acquire"
         {|{"target_run_id":"run","requests":[{"target":{"worktree_id":"tree","kind":"file","path":"z"},"mode":"shared"},{"target":{"worktree_id":"tree","kind":"file","path":"a"},"mode":"exclusive"}]}|})
  in
  let holds = Json.list (Json.field (State.result p) "holds") in
  print_s
    [%sexp
      (List.map holds ~f:(fun row ->
         ( Json.text (Json.field (Json.field row "target") "path")
         , Json.integer (Json.field (Json.field row "holder") "token") ))
       : (string * int) list)];
  ignore
    (ok
       (Api_codec.decode
          (Option.value_exn
             (Agent_coordination_api.response_codec ~method_:"reservation.paths.acquire"))
          (State.result p))
     : Jsonaf.t);
  let t = State.candidate p in
  let before = Json.canonical (State.to_json t) in
  report
    (prepare
       ~run:other
       t
       "reservation.paths.acquire"
       {|{"target_run_id":"other","requests":[{"target":{"worktree_id":"tree","kind":"file","path":"0-free"},"mode":"exclusive"},{"target":{"worktree_id":"tree","kind":"file","path":"z"},"mode":"exclusive"}]}|});
  printf
    "unchanged=%b free=%d\n"
    (String.equal before (Json.canonical (State.to_json t)))
    (List.length (holders t "0-free" File));
  let p =
    ok
      (prepare
         ~run
         t
         "reservation.acquire"
         {|{"target_run_id":"run","requests":[{"reservation_id":"db","mode":"exclusive"}]}|})
  in
  ignore
    (ok
       (Api_codec.decode
          (Option.value_exn (Agent_run_api.response_codec ~method_:"reservation.acquire"))
          (State.result p))
     : Jsonaf.t);
  let row = List.hd_exn (Json.list (Json.field (State.result p) "holds")) in
  printf
    "named=%s token=%d\n"
    (Json.text (Json.field row "reservation_id"))
    (Json.integer (Json.field (Json.field row "holder") "token"));
  [%expect
    {|
    ((a 1) (z 1))
    Already_claimed
    unchanged=true free=0
    named=db token=1
    |}]
;;

let%expect_test "filters apply before page limit and use one matching holder" =
  let t =
    step
      ~run
      (fixture ())
      "reservation.paths.acquire"
      {|{"target_run_id":"run","requests":[{"target":{"worktree_id":"tree","kind":"file","path":"a"},"mode":"exclusive"},{"target":{"worktree_id":"other-tree","kind":"file","path":"z"},"mode":"exclusive"}]}|}
  in
  let t =
    step
      ~run:other
      t
      "reservation.paths.acquire"
      {|{"target_run_id":"other","requests":[{"target":{"worktree_id":"tree","kind":"file","path":"z"},"mode":"exclusive"}]}|}
  in
  let query method_ params = ok (State.query t ~method_ ~params:(parse params)) in
  let data j = Option.value (Json.optional j "data") ~default:j in
  let r =
    data
      (query
         "reservation.path.list"
         {|{"limit":"1","target_run_id":"other","actor_id":"worker","worktree_id":"tree","overlaps":{"worktree_id":"tree","kind":"subtree","path":"."}}|})
  in
  let rows = Json.list (Json.field r "items") in
  print_s
    [%sexp
      (List.map rows ~f:(fun row ->
         Json.text (Json.field (Json.field row "target") "path"))
       : string list)];
  printf "omitted=%d\n" (Json.integer (Json.field r "omitted"));
  let t =
    step
      ~run
      t
      "reservation.acquire"
      {|{"target_run_id":"run","requests":[{"reservation_id":"a","mode":"exclusive"}]}|}
  in
  let t =
    step
      ~run:other
      t
      "reservation.acquire"
      {|{"target_run_id":"other","requests":[{"reservation_id":"z","mode":"exclusive"}]}|}
  in
  let r =
    data
      (ok
         (State.query
            t
            ~method_:"reservation.list"
            ~params:(parse {|{"limit":"1","target_run_id":"other","actor_id":"worker"}|})))
  in
  print_s
    [%sexp
      (List.map
         (Json.list (Json.field r "items"))
         ~f:(fun row -> Json.text (Json.field row "reservation_id"))
       : string list)];
  [%expect
    {|
    (z)
    omitted=0
    (z)
    |}]
;;

let rec map_objects json ~f =
  match json with
  | `Object fields ->
    f (List.map fields ~f:(fun (key, value) -> key, map_objects value ~f))
  | `Array values -> `Array (List.map values ~f:(fun value -> map_objects value ~f))
  | value -> value
;;

let%expect_test "public and durable provenance decoders reject forged borrowers" =
  let before = fixture () in
  let p = ok (prepare ~run before "ticket.claim" {|{"ticket_id":"a"}|}) in
  let t = State.candidate p in
  let reservation =
    Option.value_exn
      (Agent_run.get_path_reservation (State.agent_runs t) (target "src" Subtree))
  in
  let public = Agent_coordination_api.path_reservation_json reservation in
  let codec = Agent_coordination_api.path_reservation_codec in
  report (Api_codec.decode codec public);
  let replace_origin origin =
    map_objects public ~f:(fun fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "origin" then origin else value)))
  in
  List.iter
    [ {|{"kind":"automatic","borrowers":[]}|}
    ; {|{"kind":"manual","borrowers":[]}|}
    ; {|{"kind":"automatic","borrowers":[{"ticket_id":"a","token":"1","run_id":"other","actor_id":"worker"}]}|}
    ; {|{"kind":"automatic","borrowers":[{"ticket_id":"a","token":"0","run_id":"run","actor_id":"worker"}]}|}
    ; {|{"kind":"automatic","borrowers":[{"ticket_id":"a","token":"1","run_id":"run","actor_id":"worker"},{"ticket_id":"a","token":"1","run_id":"run","actor_id":"worker"}]}|}
    ]
    ~f:(fun origin -> report (Api_codec.decode codec (replace_origin (parse origin))));
  let forged =
    map_objects (State.events p) ~f:(fun fields ->
      if List.Assoc.mem fields "previous_claim" ~equal:String.equal
      then
        `Object
          (List.map fields ~f:(fun (key, value) ->
             ( key
             , if String.equal key "claim"
               then
                 map_objects value ~f:(fun fields ->
                   `Object
                     (List.map fields ~f:(fun (key, value) ->
                        key, if String.equal key "token" then Json.int 99 else value)))
               else value )))
      else `Object fields)
  in
  report (State.replay before forged);
  let no_ticket =
    map_objects (State.events p) ~f:(fun fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "changes"
             then
               `Array
                 (List.filter (Json.list value) ~f:(function
                    | `Array (`String "Ticket_put" :: _) -> false
                    | _ -> true))
             else value ))))
  in
  report (State.replay before no_ticket);
  let grant_change =
    List.find_map
      (Json.list (Json.field (State.events p) "changes"))
      ~f:(function
        | `Array [ `String "Agent_run_changed"; change ] ->
          Some (Agent_run_event.t_of_jsonaf change)
        | _ -> None)
    |> Option.value_exn
  in
  let change =
    { grant_change with
      revision = Agent_run.revision (State.agent_runs t) + 1
    ; update = Path_reservation_put { reservation with holders = [] }
    }
  in
  report (Agent_run.apply (State.agent_runs t) change);
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Conflict
    Invalid_argument
    Invalid_argument
    Corrupt_store
    Corrupt_store
    Conflict
    |}]
;;

let%expect_test "claim expiry and unrelated holds never authorize automatic release" =
  let t =
    step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a","lease_duration_ms":"5"}|}
  in
  let t = step ~run t "ticket.claim" {|{"ticket_id":"c"}|} in
  report (prepare ~run:other ~now:1000L t "ticket.claim" {|{"ticket_id":"b"}|});
  show t;
  let t = step ~run ~now:1000L t "ticket.release" {|{"ticket_id":"a","token":"1"}|} in
  show t;
  printf "unrelated=%d\n" (List.length (holders t "elsewhere" File));
  [%expect
    {|
    Blocked
    (1 ((automatic (a))))
    (0 ())
    unrelated=1
    |}]
;;

let%expect_test "bounded conflicts report exact omitted owner count without fences" =
  let t = fixture () in
  let t =
    List.fold (List.init 20 ~f:Fn.id) ~init:t ~f:(fun t i ->
      let name = sprintf "holder-%02d" i in
      let owner = ok (Id.Run.of_string name) in
      let t =
        step t "run.register" (sprintf {|{"target_run_id":"%s","objective":"work"}|} name)
      in
      step
        ~run:owner
        t
        "reservation.paths.acquire"
        (sprintf
           {|{"target_run_id":"%s","requests":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"shared"}]}|}
           name))
  in
  let failure =
    match prepare ~run t "ticket.claim" {|{"ticket_id":"a"}|} with
    | Error p -> p
    | Ok _ -> failwith "expected conflict"
  in
  (match failure.details with
   | Some (Reservation_conflict c) ->
     printf "listed=%d omitted=%d\n" (List.length c.owners) c.omitted_owners
   | _ -> failwith "missing typed conflict");
  let wire = Problem.to_json failure in
  ignore (ok (Api_codec.decode Problem_wire.codec wire) : Problem.t);
  let text = Json.canonical wire in
  printf
    "token=%b lease=%b\n"
    (String.is_substring text ~substring:"token")
    (String.is_substring text ~substring:"lease");
  [%expect
    {|
    listed=16 omitted=4
    token=false lease=false
    |}]
;;

let%expect_test "borrower bound refuses before changing retained sibling ownership" =
  let t = step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a"}|} in
  let t =
    List.fold (List.init 99 ~f:Fn.id) ~init:t ~f:(fun t i ->
      let id = sprintf "borrow-%02d" i in
      let t =
        step t "ticket.create" (sprintf {|{"ticket_id":"%s","title":"borrow"}|} id)
      in
      let t = paths t id "file" (sprintf "src/%02d.ml" i) in
      step ~run t "ticket.claim" (sprintf {|{"ticket_id":"%s"}|} id))
  in
  let holder = List.hd_exn (holders t "src" Subtree) in
  printf
    "borrowers=%d\n"
    (match holder.origin with
     | Automatic cs -> List.length cs
     | Manual -> 0);
  let before = Json.canonical (State.to_json t) in
  report (prepare ~run t "ticket.claim" {|{"ticket_id":"b"}|});
  printf "unchanged=%b\n" (String.equal before (Json.canonical (State.to_json t)));
  [%expect
    {|
    borrowers=100
    Invalid_argument
    unchanged=true
    |}]
;;

let%expect_test
    "ordered internal transitions permit full lifecycles within one atomic batch"
  =
  let before = fixture () in
  let t =
    step
      ~run
      before
      "transaction.apply"
      {|{"operations":[{"method":"ticket.start","params":{"ticket_id":"a","attempt_id":"batch-try"}},{"method":"ticket.finish","params":{"ticket_id":"a","token":"1","evidence":"batch done"}}]}|}
  in
  show t;
  let t =
    step
      ~run
      before
      "transaction.apply"
      {|{"operations":[{"method":"ticket.claim","params":{"ticket_id":"a"}},{"method":"ticket.release","params":{"ticket_id":"a","token":"1"}}]}|}
  in
  show t;
  let t = step ~run before "ticket.claim" {|{"ticket_id":"a"}|} in
  let t =
    step
      ~run
      t
      "transaction.apply"
      {|{"operations":[{"method":"ticket.reassign","params":{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"other","reason":"first"}},{"method":"ticket.reassign","params":{"ticket_id":"a","expected_revision":"3","claimant_id":"worker","claimant_run_id":"run","reason":"second"}}]}|}
  in
  let h = List.hd_exn (holders t "src" Subtree) in
  printf "owner=%s fence=%d\n" (Id.Run.to_string h.run) h.token;
  let t =
    step
      t
      "ticket.reassign"
      {|{"ticket_id":"a","expected_revision":"4","claimant_id":null,"reason":"return to queue"}|}
  in
  show t;
  [%expect
    {|
    (0 ())
    (0 ())
    owner=run fence=3
    (0 ())
    |}]
;;

let%expect_test "path policy freezes under claim and release-edit-reclaim remains atomic" =
  let t = step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a"}|} in
  let edit =
    {|{"ticket_id":"a","expected_revision":"1","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"file","path":"new"},"mode":"exclusive"}]}|}
  in
  report (prepare t "ticket.paths.put" edit);
  let t =
    step
      ~run
      t
      "transaction.apply"
      {|{"operations":[{"method":"ticket.release","params":{"ticket_id":"a","token":"1"}},{"method":"ticket.paths.put","params":{"ticket_id":"a","expected_revision":"1","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"file","path":"new"},"mode":"exclusive"}]}},{"method":"ticket.claim","params":{"ticket_id":"a"}}]}|}
  in
  show t;
  printf "new=%d\n" (List.length (holders t "new" File));
  let p =
    ok
      (prepare
         (fixture ())
         "ticket.paths.put"
         {|{"ticket_id":"a","expected_revision":"1","require_reservations":false,"declarations":[]}|})
  in
  let current = step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a"}|} in
  let forged =
    map_objects (State.events p) ~f:(fun fields ->
      let run_change =
        List.Assoc.mem fields "actor_run" ~equal:String.equal
        && List.Assoc.mem fields "update" ~equal:String.equal
      in
      let transaction = List.Assoc.mem fields "changes" ~equal:String.equal in
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if run_change && String.equal key "revision"
             then Json.int (Agent_run.revision (State.agent_runs current) + 1)
             else if
               (run_change && String.equal key "sequence")
               || (transaction && String.equal key "revision")
             then Json.int (State.revision current + 1)
             else value ))))
  in
  report (State.replay current forged);
  [%expect
    {|
    Conflict
    (0 ())
    new=1
    Conflict
    |}]
;;

let%expect_test "replay rejects omitted forged standalone or wrongly attributed cleanup" =
  let t = step ~run (fixture ()) "ticket.claim" {|{"ticket_id":"a"}|} in
  let p = ok (prepare ~run t "ticket.release" {|{"ticket_id":"a","token":"1"}|}) in
  let alter_changes f =
    map_objects (State.events p) ~f:(fun fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "changes" then `Array (f (Json.list value)) else value)))
  in
  let is_cleanup = function
    | `Array [ `String "Agent_run_changed"; change ] ->
      (match Json.field change "update" with
       | `Array (`String "Claim_paths_released" :: _) -> true
       | _ -> false)
    | _ -> false
  in
  report (State.replay t (alter_changes (List.filter ~f:(fun c -> not (is_cleanup c)))));
  report (State.replay t (alter_changes (List.filter ~f:is_cleanup)));
  let forged_targets =
    map_objects (State.events p) ~f:(fun fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if
               String.equal key "targets"
               && List.Assoc.mem fields "claim" ~equal:String.equal
             then `Array []
             else value ))))
  in
  report (State.replay t forged_targets);
  let wrong_owner =
    map_objects (State.events p) ~f:(fun fields ->
      `Object
        (List.filter_map fields ~f:(fun (key, value) ->
           if String.equal key "run_id" || String.equal key "actor_run"
           then if String.equal key "actor_run" then Some (key, `Null) else None
           else
             Some (key, if String.equal key "actor" then Json.string "operator" else value))))
  in
  report (State.replay t wrong_owner);
  show t;
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Invalid_argument
    Corrupt_store
    (1 ((automatic (a))))
    |}]
;;

let%expect_test "every claim exit preserves a reused manual hold" =
  let base =
    step
      ~run
      (fixture ())
      "reservation.paths.acquire"
      {|{"target_run_id":"run","requests":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive"}]}|}
  in
  let claimed = step ~run base "ticket.claim" {|{"ticket_id":"a"}|} in
  List.iter
    [ "ticket.finish", {|{"ticket_id":"a","token":"1","evidence":"done"}|}, Some run
    ; "ticket.release", {|{"ticket_id":"a","token":"1"}|}, Some run
    ; ( "ticket.reassign"
      , {|{"ticket_id":"a","expected_revision":"2","claimant_id":null,"reason":"unassign"}|}
      , None )
    ; ( "ticket.recover"
      , {|{"recovery_id":"manual-recovery","ticket_id":"a","expected_revision":"2","old_actor_id":"worker","old_run_id":"run","token":"1","expected_lease_revision":"1","disposition":"preserve_status","confirmation":"isolated","reason":"quarantined"}|}
      , None )
    ]
    ~f:(fun (method_, params, invocation) ->
      show (step ?run:invocation claimed method_ params));
  report
    (prepare
       claimed
       "ticket.reassign"
       {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"other","reason":"transfer"}|});
  [%expect
    {|
    (1 ((manual ())))
    (1 ((manual ())))
    (1 ((manual ())))
    (1 ((manual ())))
    Already_claimed
    |}]
;;

let%expect_test "receipt decoders reject empty duplicate and mixed-owner grant rows" =
  List.iter
    [ ( "reservation.paths.acquire"
      , {|{"target_run_id":"run","requests":[{"target":{"worktree_id":"tree","kind":"file","path":"a"},"mode":"shared"},{"target":{"worktree_id":"tree","kind":"file","path":"b"},"mode":"shared"}]}|}
      )
    ; ( "reservation.acquire"
      , {|{"target_run_id":"run","requests":[{"reservation_id":"a","mode":"shared"},{"reservation_id":"b","mode":"shared"}]}|}
      )
    ]
    ~f:(fun (method_, params) ->
      let p = ok (prepare ~run (fixture ()) method_ params) in
      let codec = Option.value_exn (Agent_run_api.response_codec ~method_) in
      let receipt = State.result p in
      let rows = Json.list (Json.field receipt "holds") in
      let alter holds =
        match receipt with
        | `Object fields ->
          `Object (List.Assoc.add fields ~equal:String.equal "holds" (`Array holds))
        | _ -> assert false
      in
      report (Api_codec.decode codec (alter []));
      report (Api_codec.decode codec (alter [ List.hd_exn rows; List.hd_exn rows ]));
      let second =
        map_objects (List.nth_exn rows 1) ~f:(fun fields ->
          `Object
            (List.map fields ~f:(fun (key, value) ->
               key, if String.equal key "run_id" then Json.string "other" else value)))
      in
      report (Api_codec.decode codec (alter [ List.hd_exn rows; second ])));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test
    "cleanup-only transfer to manual coverage requires its exact ordered install"
  =
  let t =
    step
      (fixture ())
      "ticket.paths.put"
      {|{"ticket_id":"a","expected_revision":"1","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"shared"}]}|}
  in
  let t =
    step
      ~run:other
      t
      "reservation.paths.acquire"
      {|{"target_run_id":"other","requests":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"shared"}]}|}
  in
  let t = step ~run t "ticket.claim" {|{"ticket_id":"a"}|} in
  let p =
    ok
      (prepare
         t
         "ticket.reassign"
         {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"other","reason":"transfer"}|})
  in
  let next =
    step
      t
      "ticket.reassign"
      {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"other","reason":"transfer"}|}
  in
  show next;
  let standalone =
    map_objects (State.events p) ~f:(fun fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "changes"
             then
               `Array
                 (List.filter (Json.list value) ~f:(function
                    | `Array [ `String "Agent_run_changed"; _ ] -> true
                    | _ -> false))
             else value ))))
  in
  report (State.replay t standalone);
  let forged_previous =
    map_objects (State.events p) ~f:(fun fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "previous_claim"
             then
               map_objects value ~f:(fun fields ->
                 `Object
                   (List.map fields ~f:(fun (key, value) ->
                      key, if String.equal key "token" then Json.int 99 else value)))
             else value ))))
  in
  report (State.replay t forged_previous);
  show t;
  [%expect
    {|
    (1 ((manual ())))
    Corrupt_store
    Corrupt_store
    (2 ((manual ()) (automatic (a))))
    |}]
;;

let%expect_test
    "error frame fitting retains exact conflict omissions and typed valid paths"
  =
  let target =
    Reservation_conflict.Target.Path
      { worktree_id = "tree"; kind = Subtree; path = String.make 4096 'a' }
  in
  let owners =
    List.init 20 ~f:(fun i ->
      { Reservation_conflict.Owner.target
      ; actor_id = "worker"
      ; run_id = sprintf "run-%d" i
      ; mode = Shared
      })
  in
  let problem =
    Problem.with_details
      (Problem.create Already_claimed "busy")
      (Reservation_conflict { requested = target; owners; omitted_owners = 0 })
  in
  let frame =
    Protocol.error_response_json
      ~id:(Json.string "test")
      ~code:Application_failure
      problem
  in
  let decoded =
    ok (Problem_wire.of_json (Json.field (Json.field frame "error") "data"))
  in
  let total =
    match decoded.details with
    | Some (Reservation_conflict c) -> List.length c.owners + c.omitted_owners
    | _ -> failwith "lost details"
  in
  printf "bounded=%b total=%d\n" (String.length (Json.canonical frame) <= 65536) total;
  [%expect {| bounded=true total=20 |}]
;;
