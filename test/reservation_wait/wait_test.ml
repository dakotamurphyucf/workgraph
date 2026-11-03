open Core
open Workgraph

let unwrap = Disk.unwrap
let json text = Json.parse text |> unwrap

let request
      ?(method_ = "reservation.acquire")
      ?(requests = {|[{"reservation_id":"build","mode":"exclusive"}]|})
      ()
  =
  Protocol.Request.create
    ~id:"original"
    ~method_
    ~params:
      (json
         ("{\"workspace_id\":\"w\",\"actor_id\":\"owner\",\"run_id\":\"invocation\",\"mutation_id\":\"first\",\"target_run_id\":\"waiter\",\"requests\":"
          ^ requests
          ^ "}"))
  |> unwrap
;;

let plan ?(limits = Reservation_wait.Limits.default) () =
  Reservation_wait.create (request ()) ~limits |> unwrap
;;

let envelope ?(durable = false) data =
  Json.obj
    [ "data", data
    ; ( "meta"
      , Json.obj
          ([ "workspace_revision", Json.int 5 ]
           @ if durable then [ "durable", `True ] else []) )
    ]
;;

let feed ?(cursor = "position") ?(has_more = false) ?(needs = false) () =
  let items =
    if has_more && not needs
    then
      [ json
          {|{"revision":"5","actor_id":"other","timestamp":"now","targets":[],"kinds":["agent_run_changed"],"run_id":null}|}
      ]
    else []
  in
  envelope
    (Json.obj
       [ "source", Json.string "planning"
       ; "through", Json.int 5
       ; "items", `Array items
       ; "cursor", Json.string cursor
       ; ("has_more", if has_more then `True else `False)
       ; ("needs_larger_budget", if needs then `True else `False)
       ])
;;

let grant ?(target = "build") ?(owner = "owner") ?(durable = true) () =
  envelope
    ~durable
    (json
       ("{\"coordination_revision\":\"7\",\"holds\":[{\"reservation_id\":\""
        ^ target
        ^ "\",\"holder\":{\"run_id\":\"waiter\",\"actor_id\":\""
        ^ owner
        ^ "\",\"token\":\"1\",\"mode\":\"exclusive\",\"lease\":{\"epoch\":\"1\",\"revision\":\"1\",\"duration_ms\":null,\"last_unix_ms\":\"0\",\"deadline_unix_ms\":null},\"origin\":{\"kind\":\"manual\"}}}]}"
       ))
;;

let contention ?(target = "build") () =
  Problem.with_details
    (Problem.create Conflict "actual contention")
    (Reservation_conflict
       { requested = Named target
       ; owners =
           [ { target = Named target
             ; actor_id = "other"
             ; run_id = "holder"
             ; mode = Exclusive
             }
           ]
       ; omitted_owners = 0
       })
;;

let data outcome =
  Reservation_wait.Outcome.to_json outcome |> fun value -> Json.field value "data"
;;

let metadata outcome = Json.field (data outcome) "wait"

let summary outcome =
  let value = metadata outcome in
  print_endline
    (Json.canonical
       (Json.obj
          [ "stop", Json.field value "stop"
          ; "attempts", Json.field value "attempt_count"
          ; "completed", Json.field value "completed"
          ]))
;;

let run ?(plan = plan ()) ?(clock = ref 0.) ?(save_extra = fun _ -> ()) on_write on_wait =
  let saved = ref []
  and events = ref []
  and identities = ref 0 in
  let log item = events := item :: !events in
  let save request =
    let id = Json.text (Json.field (Protocol.Request.params request) "mutation_id") in
    log ("save:" ^ id);
    saved := request :: !saved;
    save_extra request;
    Ok ("/tmp/" ^ id ^ ".json")
  in
  let exchange ~timeout_seconds request =
    assert (Float.(timeout_seconds > 0. && timeout_seconds <= 30.));
    let method_ = Protocol.Request.method_ request in
    log method_;
    match method_ with
    | "workspace.get" -> Ok (envelope (Json.obj []))
    | "changes.read" -> Ok (feed ())
    | "changes.wait" -> on_wait clock request
    | "reservation.acquire" ->
      assert (
        List.exists !saved ~f:(fun saved ->
          String.equal
            (Json.canonical (Protocol.Request.to_json saved))
            (Json.canonical (Protocol.Request.to_json request))));
      on_write clock request
    | _ -> assert false
  in
  let result =
    Reservation_wait.collect
      plan
      ~now:(fun () -> !clock)
      ~max_exchange_seconds:30.
      ~fresh_mutation:(fun () ->
        incr identities;
        Id.Mutation.of_string ("next" ^ Int.to_string !identities) |> unwrap)
      ~save
      ~exchange
    |> unwrap
  in
  result, List.rev !saved, List.rev !events, !identities
;;

let%expect_test "cursor precedes acquisition, exact journals precede each fresh write" =
  let count = ref 0 in
  let outcome, saved, events, identities =
    run
      (fun _ _ ->
         incr count;
         if !count = 1 then Error (contention ()) else Ok (grant ()))
      (fun clock request ->
         assert (
           String.equal
             (Json.text (Json.field (Protocol.Request.params request) "cursor"))
             "position");
         clock := 0.1;
         Ok (feed ~cursor:"advanced" ()))
  in
  summary outcome;
  print_s [%sexp (events : string list)];
  assert (identities = 1);
  let original = List.hd_exn saved
  and next = List.nth_exn saved 1 in
  let without_identity request =
    match Protocol.Request.params request with
    | `Object fields ->
      Json.obj (List.Assoc.remove fields "mutation_id" ~equal:String.equal)
      |> Json.canonical
    | _ -> assert false
  in
  assert (String.equal (without_identity original) (without_identity next));
  assert (
    String.equal
      (Json.canonical (Json.field (data outcome) "daemon_response"))
      (Json.canonical (grant ())));
  [%expect
    {|
    {"attempts":"2","completed":true,"stop":"acquired"}
    (workspace.get changes.read save:first reservation.acquire changes.wait
     save:next1 reservation.acquire)
  |}]
;;

let%expect_test "only actual typed contention for an original batch target permits retry" =
  List.iter
    [ Problem.create Conflict "ordinary conflict"
    ; Problem.create Already_claimed "untyped contention"
    ; contention ~target:"foreign" ()
    ; Problem.create Outcome_unknown "lost reply"
    ]
    ~f:(fun problem ->
      let outcome, _, _, fresh =
        run (fun _ _ -> Error problem) (fun _ _ -> assert false)
      in
      summary outcome;
      assert (fresh = 0);
      assert (
        String.equal
          (Json.canonical (Json.field (metadata outcome) "problem"))
          (Json.canonical (Problem.to_json problem))));
  [%expect
    {|
    {"attempts":"1","completed":false,"stop":"failed"}
    {"attempts":"1","completed":false,"stop":"failed"}
    {"attempts":"1","completed":false,"stop":"failed"}
    {"attempts":"1","completed":false,"stop":"uncertain"}
  |}]
;;

let%expect_test
    "nondurable malformed or mismatched grants stop uncertain on original journal"
  =
  List.iter
    [ grant ~durable:false ()
    ; grant ~target:"foreign" ()
    ; grant ~owner:"other" ()
    ; envelope ~durable:true (Json.obj [])
    ]
    ~f:(fun response ->
      let outcome, saved, _, fresh =
        run (fun _ _ -> Ok response) (fun _ _ -> assert false)
      in
      summary outcome;
      assert (fresh = 0 && List.length saved = 1);
      assert (
        String.equal
          (Json.canonical (Json.field (data outcome) "daemon_response"))
          (Json.canonical response));
      assert (
        String.equal
          (Json.text (Json.field (metadata outcome) "saved_request"))
          "/tmp/first.json");
      assert (
        String.equal
          (Json.text (Json.field (Json.field (metadata outcome) "problem") "kind"))
          "Outcome_unknown"));
  [%expect
    {|
    {"attempts":"1","completed":false,"stop":"uncertain"}
    {"attempts":"1","completed":false,"stop":"uncertain"}
    {"attempts":"1","completed":false,"stop":"uncertain"}
    {"attempts":"1","completed":false,"stop":"uncertain"}
  |}]
;;

let%expect_test
    "deadline after sync retains saved unsent request; after wait creates no identity"
  =
  let clock = ref 0. in
  let limits =
    Reservation_wait.Limits.create ~timeout_ms:1000 ~max_attempts:3 ~wait_slice_ms:100
    |> unwrap
  in
  let outcome, _, _, fresh =
    run
      ~plan:(plan ~limits ())
      ~clock
      ~save_extra:(fun _ -> clock := 1.1)
      (fun _ _ -> assert false)
      (fun _ _ -> assert false)
  in
  summary outcome;
  assert (fresh = 0);
  let journal = Json.list (Json.field (metadata outcome) "journals") |> List.hd_exn in
  assert (
    match Json.field journal "started" with
    | `False -> true
    | _ -> false);
  let outcome, _, _, fresh =
    run
      (fun _ _ -> Error (contention ()))
      (fun clock _ ->
         clock := 31.;
         Ok (feed ()))
  in
  summary outcome;
  assert (fresh = 0);
  [%expect
    {|
    {"attempts":"0","completed":false,"stop":"deadline"}
    {"attempts":"1","completed":false,"stop":"deadline"}
  |}]
;;

let%expect_test
    "attempt exhaustion, retained feed omissions and no progress are incomplete"
  =
  let limits =
    Reservation_wait.Limits.create ~timeout_ms:30000 ~max_attempts:1 ~wait_slice_ms:1000
    |> unwrap
  in
  let outcome, _, _, _ =
    run
      ~plan:(plan ~limits ())
      (fun _ _ -> Error (contention ()))
      (fun _ _ -> assert false)
  in
  summary outcome;
  List.iter
    [ feed ~has_more:true ~needs:true (); feed ~has_more:true () ]
    ~f:(fun response ->
      let outcome, _, _, fresh =
        run (fun _ _ -> Error (contention ())) (fun _ _ -> Ok response)
      in
      summary outcome;
      assert (fresh = 0);
      assert (
        String.equal
          (Json.canonical (Json.field (metadata outcome) "feed_response"))
          (Json.canonical response)));
  [%expect
    {|
    {"attempts":"1","completed":false,"stop":"attempt_limit"}
    {"attempts":"1","completed":false,"stop":"needs_larger_budget"}
    {"attempts":"1","completed":false,"stop":"no_progress"}
  |}]
;;

let%expect_test "cancellation/unexpected errors after synchronization never retry" =
  let saved = ref false in
  (try
     ignore
       (run
          ~save_extra:(fun _ -> saved := true)
          (fun _ _ -> raise (Eio.Cancel.Cancelled (Failure "cancel")))
          (fun _ _ -> assert false)
        : _ * _ * _ * _)
   with
   | Eio.Cancel.Cancelled _ -> print_endline "cancellation propagated with journal");
  assert !saved;
  (try
     ignore
       (run (fun _ _ -> failwith "unexpected") (fun _ _ -> assert false) : _ * _ * _ * _)
   with
   | Failure message -> print_endline message);
  [%expect
    {|
    cancellation propagated with journal
    unexpected
  |}]
;;

let%expect_test "public constructor rejects unsupported empty and duplicate batches" =
  List.iter
    [ request ~requests:"[]" ()
    ; request
        ~requests:
          {|[{"reservation_id":"build","mode":"exclusive"},{"reservation_id":"build","mode":"shared"}]|}
        ()
    ; request ~method_:"reservation.release" ()
    ]
    ~f:(fun request ->
      match Reservation_wait.create request ~limits:Reservation_wait.Limits.default with
      | Ok _ -> print_endline "incorrectly accepted"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;

let%expect_test "durable in-flight success remains success after total deadline" =
  let outcome, _, _, fresh =
    run
      (fun clock _ ->
         clock := 31.;
         Ok (grant ()))
      (fun _ _ -> assert false)
  in
  summary outcome;
  assert (fresh = 0);
  [%expect {| {"attempts":"1","completed":true,"stop":"acquired"} |}]
;;

let%expect_test "save failure after contention retains original journal and stops sends" =
  let saved = ref []
  and writes = ref 0
  and ids = ref 0 in
  let problem = Problem.create Local_io "disk unavailable" in
  let outcome =
    Reservation_wait.collect
      (plan ())
      ~now:(fun () -> 0.)
      ~max_exchange_seconds:5.
      ~fresh_mutation:(fun () ->
        incr ids;
        Id.Mutation.of_string "next" |> unwrap)
      ~save:(fun request ->
        if !ids > 0
        then Error problem
        else (
          saved := request :: !saved;
          Ok "/tmp/first.json"))
      ~exchange:(fun ~timeout_seconds request ->
        assert (Float.(timeout_seconds > 0. && timeout_seconds <= 5.));
        match Protocol.Request.method_ request with
        | "workspace.get" -> Ok (envelope (Json.obj []))
        | "changes.read" | "changes.wait" -> Ok (feed ())
        | "reservation.acquire" ->
          incr writes;
          Error (contention ())
        | _ -> assert false)
    |> unwrap
  in
  summary outcome;
  assert (!writes = 1 && List.length !saved = 1 && !ids = 1);
  assert (
    String.equal
      (Json.text (Json.field (metadata outcome) "saved_request"))
      "/tmp/first.json");
  assert (
    String.equal
      (Json.canonical (Json.field (metadata outcome) "problem"))
      (Json.canonical (Problem.to_json problem)));
  [%expect {| {"attempts":"1","completed":false,"stop":"failed"} |}]
;;
