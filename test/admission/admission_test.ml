open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let%expect_test "admission decode independently validates ceiling units and arithmetic" =
  let json used maximum remaining unit_ =
    Json.obj
      [ "name", Json.string "active_uploads"
      ; "unit", Json.string unit_
      ; "used", Json.string used
      ; "limit", Json.string maximum
      ; "remaining", Json.string remaining
      ; ( "severity"
        , Json.string
            (if String.equal used "8" || String.equal used "9"
             then "critical"
             else "normal") )
      ; ( "threshold_percent"
        , Json.string
            (if String.equal used "8" || String.equal used "9" then "95" else "0") )
      ; ( "percent_used"
        , Json.string
            (if String.equal used "8" || String.equal used "9"
             then "100"
             else if String.equal used "1"
             then "12"
             else "0") )
      ; "lifetime", Json.string "temporary"
      ]
  in
  List.iter
    [ json "0" "8" "8" "count"
    ; json "8" "8" "0" "count"
    ; json "9" "8" "0" "count"
    ; json "1" "9" "8" "count"
    ; json "1" "8" "8" "count"
    ; json "1" "8" "7" "bytes"
    ; json "-1" "8" "9" "count"
    ]
    ~f:(fun json ->
      print_s [%sexp (Result.is_ok (Api_codec.decode Admission.codec json) : bool)]);
  [%expect
    {|
    true
    true
    false
    false
    false
    false
    false
    |}]
;;

let%expect_test "fact tombstones keep admission keys and increase retained bytes" =
  let actor = ok (Id.Actor.of_string "agent") in
  let key = ok (Facts.Key.of_string "answer") in
  let change command state sequence =
    let event, _ =
      ok (Facts.prepare state command ~actor ~run:None ~timestamp:"recorded" ~sequence)
    in
    ok (Facts.apply state event)
  in
  let first =
    change
      (Facts.Command.Put
         { scope = Workspace
         ; key
         ; expected_revision = 0
         ; value = ok (Facts.Value.of_json (Json.string "hello"))
         })
      Facts.empty
      1
  in
  let deleted =
    change (Delete { scope = Workspace; key; expected_revision = 1 }) first 2
  in
  let used state limit =
    Facts.admission state
    |> List.find_exn ~f:(fun meter -> Admission.Limit.equal (Admission.limit meter) limit)
    |> Admission.used
  in
  print_s
    [%sexp
      ((used Facts.empty Fact_keys, used first Fact_keys, used deleted Fact_keys)
       : int * int * int)];
  print_s
    [%sexp
      (used Facts.empty Fact_version_bytes < used first Fact_version_bytes
       && used first Fact_version_bytes < used deleted Fact_version_bytes
       : bool)];
  [%expect
    {|
    (0 1 1)
    true
    |}]
;;
