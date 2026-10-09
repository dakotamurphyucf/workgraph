open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json = Fn.compose ok Json.parse

let candidate id =
  { Allocation.Candidate.ticket = Id.Ticket.of_string id |> ok
  ; priority = 0
  ; creation_sequence = 1
  ; ready = true
  ; available = true
  ; required_capabilities = [ "ocaml"; "eio" ]
  ; pools = [ { name = "build"; limit = 1; active = 1 } ]
  }
;;

let%expect_test "overlapping reasons are bounded, deterministic and count tickets once" =
  let candidates = List.init 9 ~f:(fun i -> candidate ("t" ^ Int.to_string i)) in
  let explain candidates =
    Allocation.Explanation.create
      ~captured_workspace_revision:12
      ~candidates
      ~capabilities:[]
      ~parent_filtered:(fun _ -> true)
      ~limits:[]
    |> ok
    |> Allocation.Explanation.to_json
  in
  let result = explain candidates in
  print_endline (Json.canonical result);
  print_s
    [%sexp
      (String.equal
         (Json.canonical result)
         (Json.canonical (explain (List.rev candidates)))
       : bool)];
  let bad =
    json
      {|{"captured_workspace_revision":"12","candidate_count":"1","reasons":[{"kind":"pool_full","count":"2","example_ticket_ids":["t"],"omitted_examples":"1"}],"run_limits":[]}|}
  in
  print_s
    [%sexp (Result.is_error (Api_codec.decode Allocation.Explanation.codec bad) : bool)];
  print_s
    [%sexp
      (Result.is_error
         (Api_codec.decode
            Allocation.Budget_limit.codec
            (json {|{"kind":"active_attempts","used":"0","limit":"1"}|}))
       : bool)];
  [%expect
    {|
    {"candidate_count":"9","captured_workspace_revision":"12","reasons":[{"count":"9","example_ticket_ids":["t0","t1","t2","t3","t4"],"kind":"missing_capability","omitted_examples":"4"},{"count":"9","example_ticket_ids":["t0","t1","t2","t3","t4"],"kind":"pool_full","omitted_examples":"4"},{"count":"9","example_ticket_ids":["t0","t1","t2","t3","t4"],"kind":"parent_filtered","omitted_examples":"4"}],"run_limits":[]}
    true
    true
    true
    |}]
;;

let%expect_test "empty scope and budget-bound eligible candidates have distinct diagnoses"
  =
  let explain candidates limits =
    Allocation.Explanation.create
      ~captured_workspace_revision:3
      ~candidates
      ~capabilities:[ "ocaml"; "eio" ]
      ~parent_filtered:(fun _ -> false)
      ~limits
  in
  let eligible = { (candidate "t") with pools = [] } in
  print_s [%sexp (Result.is_error (explain [ eligible ] []) : bool)];
  List.iter
    [ explain [] []
    ; explain
        [ eligible ]
        [ { Allocation.Budget_limit.kind = Attempts; used = 2; limit = 2 } ]
    ]
    ~f:(fun result ->
      print_endline (Json.canonical (Allocation.Explanation.to_json (ok result))));
  [%expect
    {|
    true
    {"candidate_count":"0","captured_workspace_revision":"3","reasons":[],"run_limits":[]}
    {"candidate_count":"1","captured_workspace_revision":"3","reasons":[],"run_limits":[{"kind":"attempts","limit":"2","used":"2"}]}
    |}]
;;
