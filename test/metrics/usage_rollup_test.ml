open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error e -> failwith e.Problem.message
;;

let json text = ok (Json.parse text)

let set object_ key value =
  match object_ with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key value)
  | _ -> assert false
;;

let report id run actor metrics =
  { Usage_record.id = ok (Usage_record.Id.of_string id)
  ; scope = Run (ok (Id.Run.of_string run))
  ; actor = ok (Id.Actor.of_string actor)
  ; tokens = 3L
  ; elapsed_ms = 4L
  ; metrics
  ; provenance = "caller"
  ; timestamp = "recorded"
  }
;;

let sample name unit_ value = { Usage_record.Metric.name; unit_; value }

let read ?(revision = 0) ?(activity = []) reports params =
  Usage_rollup.read
    ~workspace:(ok (Id.Workspace.of_string "usage"))
    ~revision
    ~activity
    ~reports
    ~runs:Agent_run.empty
    ~tickets:[]
    ~params
;;

let data response = Json.field response "data"
let items response = Json.field (data response) "items" |> Json.list
let text field json = Json.field json field |> Json.text
let cursor response = Json.field (data response) "cursor"

let error result =
  match result with
  | Ok _ -> print_s [%sexp "unexpected success"]
  | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
;;

let%expect_test "compact layouts preserve deduplicated unit series and summary dimensions"
  =
  let a = report "a" "one" "agent" [ sample "spend" "microUSD" Int64.max_value ] in
  let b = report "b" "one" "agent" [ sample "spend" "microUSD" 1L ] in
  let c = report "c" "two" "other" [ sample "spend" "centEUR" 9L ] in
  let reports = [ a; a; b; c ] in
  List.iter [ "rows"; "nested"; "totals_only" ] ~f:(fun layout ->
    let response =
      ok
        (read
           reports
           (json (sprintf {|{"metrics_layout":"%s","group_by":"run"}|} layout)))
    in
    let rows = items response in
    print_s
      [%sexp
        (layout : string)
      , (List.length rows : int)
      , (text "tokens" (Json.field (data response) "totals") : string)
      , (text "metric_series" (Json.field (data response) "totals") : string)];
    if String.equal layout "nested"
    then
      List.iter rows ~f:(fun row ->
        List.iter
          (Json.field row "metrics" |> Json.list)
          ~f:(fun metric ->
            print_s
              [%sexp
                (text "unit" metric : string)
              , (text "samples" metric : string)
              , (text "value" metric : string)
              , (Json.field metric "overflow" : Jsonaf.t)])));
  let selected =
    ok
      (read
         reports
         (json {|{"metrics_layout":"nested","run_id":"one","actor_id":"other"}|}))
  in
  print_s
    [%sexp
      (List.length (items selected) : int)
    , (text "observations" (Json.field (data selected) "totals") : string)];
  [%expect
    {|
    (rows 4 9 2)
    (nested 2 9 2)
    (microUSD 2 9223372036854775807 True)
    (centEUR 1 9 False)
    (totals_only 2 9 2)
    (0 0)
    |}]
;;

let%expect_test "whole nested groups retry without clipping metrics or advancing cursor" =
  let large =
    List.init 4 ~f:(fun batch ->
      report
        (sprintf "large%d" batch)
        "a"
        "agent"
        (List.init 16 ~f:(fun i ->
           sample
             (sprintf "metric%03d%s" ((batch * 16) + i) (String.make 55 '_'))
             (String.make 32 'u')
             1L)))
  in
  let reports = large @ [ report "small" "b" "agent" [ sample "x" "count" 2L ] ] in
  let params =
    json {|{"group_by":"run","metrics_layout":"nested","limit":"1","max_bytes":"4096"}|}
  in
  let small = ok (read reports params) in
  let required = Json.field (data small) "required_bytes" |> Json.integer in
  print_s
    [%sexp
      (List.length (items small) : int)
    , (Json.field (data small) "needs_larger_budget" : Jsonaf.t)
    , (required > 4096 : bool)
    , (Api_response.encoded_size Planning_read small <= 4096 : bool)];
  let unchanged = ok (read reports (set params "cursor" (cursor small))) in
  print_s
    [%sexp
      (String.equal (Json.canonical (cursor small)) (Json.canonical (cursor unchanged))
       : bool)];
  let retry = set (set params "cursor" (cursor small)) "max_bytes" (Json.int required) in
  let first = ok (read reports retry) in
  let first_group = List.hd_exn (items first) in
  print_s
    [%sexp
      (text "run_id" (Json.field first_group "group") : string)
    , (List.length (Json.field first_group "metrics" |> Json.list) : int)
    , (Json.field (data first) "needs_larger_budget" : Jsonaf.t)];
  let second = ok (read reports (set retry "cursor" (cursor first))) in
  print_s
    [%sexp
      (text "run_id" (Json.field (List.hd_exn (items second)) "group") : string)
    , (Json.field (data second) "has_more" : Jsonaf.t)];
  let totals =
    ok (read reports (set params "metrics_layout" (Json.string "totals_only")))
  in
  print_s
    [%sexp
      (List.length (items totals) : int)
    , (text "metric_series" (Json.field (List.hd_exn (items totals)) "totals") : string)];
  let rows = ok (read reports (set params "metrics_layout" (Json.string "rows"))) in
  print_s
    [%sexp
      (List.length (items rows) : int), (text "kind" (List.hd_exn (items rows)) : string)];
  [%expect
    {|
    (0 True true true)
    true
    (a 64 False)
    (b False)
    (1 64)
    (1 usage)
    |}]
;;

let%expect_test
    "cursor binds effective layout, filters, capture and lineage but permits page \
     resizing"
  =
  let reports =
    [ report "a" "one" "agent" [ sample "x" "count" 1L ]; report "b" "two" "agent" [] ]
  in
  let params = json {|{"limit":"1"}|} in
  let first = ok (read reports params) in
  let continued = set params "cursor" (cursor first) in
  print_s
    [%sexp
      (Result.is_ok
         (read
            reports
            (set
               (set continued "metrics_layout" (Json.string "rows"))
               "group_by"
               (Json.string "workspace")))
       : bool)];
  print_s
    [%sexp (Result.is_ok (read reports (set continued "limit" (Json.int 100))) : bool)];
  error (read reports (set continued "metrics_layout" (Json.string "nested")));
  error (read reports (set continued "actor_id" (Json.string "other")));
  error (read ~revision:1 ~activity:[ json {|{"revision":"1"}|} ] reports continued);
  let activity marker = [ json (sprintf {|{"revision":"1","marker":"%s"}|} marker) ] in
  let first = ok (read ~revision:1 ~activity:(activity "a") reports params) in
  error
    (read
       ~revision:1
       ~activity:(activity "b")
       reports
       (set params "cursor" (cursor first)));
  [%expect
    {|
    true
    true
    Conflict
    Conflict
    Conflict
    Conflict
    |}]
;;

let%expect_test "public response decoder rejects partial or contradictory nested groups" =
  let reports =
    [ report "a" "one" "agent" [ sample "x" "count" 1L; sample "z" "count" 2L ] ]
  in
  let original = ok (read reports (json {|{"metrics_layout":"nested"}|})) |> data in
  let row = List.hd_exn (Json.field original "items" |> Json.list) in
  let metrics = Json.field row "metrics" |> Json.list in
  let check json =
    print_s
      [%sexp
        (Result.is_error (Api_codec.decode Usage_rollup_api.response_codec json) : bool)]
  in
  let with_row row = set original "items" (`Array [ row ]) in
  check (with_row (set row "metrics" (`Array (List.take metrics 1))));
  check (with_row (set row "metrics" (`Array (List.rev metrics))));
  check
    (with_row (set row "metrics" (`Array [ List.hd_exn metrics; List.hd_exn metrics ])));
  check
    (with_row (set row "totals" (set (Json.field row "totals") "metric_overflow" `True)));
  check (set original "metrics_layout" (Json.string "totals_only"));
  check (set original "metrics_layout" (Json.string "rows"));
  print_s
    [%sexp
      (List.length (items (ok (read [] (json {|{"metrics_layout":"nested"}|})))) : int)];
  [%expect
    {|
    true
    true
    true
    true
    true
    true
    0
    |}]
;;

let%expect_test "compact layouts agree with the row model across source combinations" =
  let without_metrics = function
    | `Object fields -> Json.obj (List.Assoc.remove fields ~equal:String.equal "metrics")
    | _ -> assert false
  in
  Quickcheck.test
    (Quickcheck.Generator.list_with_length 12 (Int.gen_incl 0 8))
    ~trials:100
    ~f:(fun values ->
      let reports =
        List.concat_mapi values ~f:(fun i value ->
          let report =
            report
              (sprintf "source%d" i)
              (sprintf "run%d" (i % 3))
              "agent"
              [ sample
                  (sprintf "measure%d" value)
                  (if i % 2 = 0 then "count" else "microUSD")
                  (if value = 0 then Int64.max_value else Int64.of_int value)
              ]
          in
          if value % 3 = 0 then [ report; report ] else [ report ])
      in
      let rows = ok (read reports (json {|{"group_by":"run","limit":"100"}|})) |> items in
      let nested =
        ok (read reports (json {|{"group_by":"run","metrics_layout":"nested"}|})) |> items
      in
      let totals =
        ok (read reports (json {|{"group_by":"run","metrics_layout":"totals_only"}|}))
        |> items
      in
      let expanded =
        List.concat_map nested ~f:(fun group ->
          without_metrics group
          :: List.map
               (Json.field group "metrics" |> Json.list)
               ~f:(fun metric ->
                 Json.obj
                   [ "kind", Json.string "metric"
                   ; "group", Json.field group "group"
                   ; "metric", metric
                   ]))
      in
      assert (
        String.equal (Json.canonical (`Array expanded)) (Json.canonical (`Array rows)));
      assert (
        String.equal
          (Json.canonical (`Array totals))
          (Json.canonical (`Array (List.map nested ~f:without_metrics)))));
  print_s [%sexp "100 source combinations agree"];
  [%expect {| "100 source combinations agree" |}]
;;
