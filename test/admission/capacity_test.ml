open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let%expect_test "exact 50 80 95 percent bands distinguish retained and temporary capacity"
  =
  List.iter [ 0; 4999; 5000; 7999; 8000; 9499; 9500; 10000 ] ~f:(fun used ->
    let meter = Admission.create Fact_keys ~used |> ok in
    print_s
      [%sexp
        (used : int)
      , (Admission.percent_used meter : int)
      , (Admission.threshold_percent meter : int)
      , (Admission.severity meter : Admission.Severity.t)
      , (Admission.lifetime meter : Admission.Lifetime.t)]);
  print_s
    [%sexp
      (Admission.create Active_uploads ~used:4 |> ok |> Admission.lifetime
       : Admission.Lifetime.t)];
  [%expect
    {|
    (0 0 0 Normal Cumulative)
    (4999 49 0 Normal Cumulative)
    (5000 50 50 Notice Cumulative)
    (7999 79 50 Notice Cumulative)
    (8000 80 80 Warning Cumulative)
    (9499 94 80 Warning Cumulative)
    (9500 95 95 Critical Cumulative)
    (10000 100 95 Critical Cumulative)
    Temporary
    |}]
;;

let%expect_test "capacity decoder refuses fabricated advisory severity and arithmetic" =
  let meter = Admission.create Fact_keys ~used:8000 |> ok in
  let json = Api_codec.encode Admission.codec meter |> ok in
  let replace field value =
    match json with
    | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal field value)
    | _ -> assert false
  in
  List.iter
    [ json
    ; replace "severity" (Json.string "normal")
    ; replace "threshold_percent" (Json.string "50")
    ; replace "percent_used" (Json.string "79")
    ; replace "lifetime" (Json.string "temporary")
    ; replace "remaining" (Json.string "1999")
    ]
    ~f:(fun value ->
      print_s [%sexp (Result.is_ok (Api_codec.decode Admission.codec value) : bool)]);
  [%expect
    {|
    true
    false
    false
    false
    false
    false
    |}]
;;

let%expect_test
    "health capacity summary bounds visible meters and validates hidden counts"
  =
  let meters =
    List.map Admission.Limit.all ~f:(fun limit ->
      Admission.create
        limit
        ~used:(if Admission.Limit.equal limit Active_uploads then 8 else 0)
      |> ok)
  in
  let summary = Admission.Summary.create meters |> ok in
  let json = Api_codec.encode Admission.Summary.codec summary |> ok in
  print_endline (Json.text (Json.field json "highest_severity"));
  print_endline (Json.text (Json.field json "warning_count"));
  print_endline (Json.text (Json.field json "omitted_meters"));
  print_s [%sexp (List.length (Admission.Summary.meters summary) : int)];
  let invalid =
    match json with
    | `Object fields ->
      Json.obj
        (List.Assoc.add fields ~equal:String.equal "warning_count" (Json.string "14"))
    | _ -> assert false
  in
  print_s [%sexp (Result.is_ok (Api_codec.decode Admission.Summary.codec invalid) : bool)];
  print_s [%sexp (Result.is_ok (Admission.Summary.create (List.tl_exn meters)) : bool)];
  [%expect
    {|
    critical
    1
    11
    3
    false
    false
    |}]
;;

let%expect_test
    "binding capacity refusal retains typed proposed total and operator guidance"
  =
  let problem =
    Admission.refusal Active_uploads ~used:8 ~attempted:9 ~kind:Invalid_argument
  in
  let json = Problem.to_json problem in
  let decoded = Problem_wire.of_json json |> ok in
  print_s
    [%sexp (Option.equal Problem.Details.equal problem.details decoded.details : bool)];
  let details = Json.field json "details" in
  List.iter
    [ "meter"; "used"; "attempted"; "limit"; "unit"; "operator_action" ]
    ~f:(fun key -> print_endline (Json.text (Json.field details key)));
  let invalid =
    match details with
    | `Object fields ->
      Json.obj (List.Assoc.add fields ~equal:String.equal "attempted" (Json.string "-1"))
    | _ -> assert false
  in
  print_s [%sexp (Result.is_ok (Api_codec.decode Problem_wire.details invalid) : bool)];
  [%expect
    {|
    true
    active_uploads
    8
    9
    8
    count
    docs/agent/capacity-rollover.md#temporary-upload-occupancy
    false
    |}]
;;

let%expect_test "retained fact guards identify binding meters without changing source" =
  let actor = Id.Actor.of_string "agent" |> ok in
  let fill ~keys ~value =
    let rec loop state revision previous =
      let key =
        Facts.Key.of_string (if keys then "key-" ^ Int.to_string revision else "same")
        |> ok
      in
      let prepared =
        Facts.prepare
          state
          (Put
             { scope = Workspace
             ; key
             ; expected_revision = (if keys then 0 else revision - 1)
             ; value
             })
          ~actor
          ~run:None
          ~timestamp:"recorded"
          ~sequence:revision
      in
      let before = Facts.admission state in
      match prepared with
      | Ok (event, _) -> loop (Facts.apply state event |> ok) (revision + 1) (Some event)
      | Error problem ->
        let proposal =
          match Facts.Change.to_json (Option.value_exn previous) with
          | `Object fields ->
            List.fold
              [ "key", Json.string (Facts.Key.to_string key)
              ; "revision", Json.int (if keys then 1 else revision)
              ; "changed_at_revision", Json.int revision
              ]
              ~init:fields
              ~f:(fun fields (name, value) ->
                List.Assoc.add fields ~equal:String.equal name value)
            |> Json.obj
            |> Facts.Change.of_json
            |> ok
          | _ -> assert false
        in
        let replay = Facts.apply state proposal in
        print_s
          [%sexp
            ((match replay with
              | Error replay_problem ->
                Option.equal Problem.Details.equal problem.details replay_problem.details
              | Ok _ -> false)
             : bool)];
        let after = Facts.admission state in
        print_s [%sexp (List.equal Admission.equal before after : bool)];
        (match problem.details with
         | Some (Capacity { meter; used; limit; attempted; _ }) ->
           print_s
             [%sexp
               (meter : string)
             , (used <= limit : bool)
             , (attempted > limit : bool)
             , (Problem.equal_kind problem.kind Blocked : bool)]
         | _ -> failwith "expected binding retained capacity diagnostic");
        let read =
          Facts.query
            state
            ~workspace_revision:revision
            ~method_:"fact.keys"
            ~params:(Json.obj [ "scope", Json.obj [ "kind", Json.string "workspace" ] ])
        in
        print_s [%sexp (Result.is_ok read : bool)]
    in
    loop Facts.empty 1 None
  in
  fill ~keys:true ~value:(Facts.Value.of_json `Null |> ok);
  fill ~keys:false ~value:(Facts.Value.of_json (Json.string (String.make 4094 'x')) |> ok);
  [%expect
    {|
    true
    true
    (fact_keys true true true)
    true
    true
    true
    (fact_version_bytes true true true)
    true
    |}]
;;
