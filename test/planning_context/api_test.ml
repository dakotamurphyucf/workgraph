open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let report method_ params =
  match Planning_context_api.Query.decode ~method_ ~params:(Jsonaf.of_string params) with
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let%expect_test "actual rich query fields reject aliases, nulls, and unguarded paging" =
  report "ticket.list" {|{"priority":"4","status":"todo"}|};
  report "ticket.list" {|{"priority":"5"}|};
  report "ticket.ready" {|{"project_id":"$project"}|};
  report "ticket.readiness" {|{"ticket_id":"task","include_archived":null}|};
  report "ticket.blockers" {|{"ticket_id":"task","offset":"1"}|};
  report "handoff.history" {|{"ticket_id":"task","offset":"1","at_revision":"0"}|};
  report "ticket.resolve" {|{"display_key":"WG-1","offset":"0"}|};
  report "ticket.readiness" {|{"ticket_id":"task","limit":"1"}|};
  report "handoff.history" {|{"ticket_id":"task","include_archived":true}|};
  report "ticket.resolve" {|{"display_key":" "}|};
  report "handoff.get" {|{"ticket_id":"task","id":"task"}|};
  [%expect
    {| ok
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument
 ok
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument |}]
;;

let apply state method_ params =
  let command =
    Domain_command.decode ~method_ ~params:(Jsonaf.of_string params) |> unwrap
  in
  let prepared =
    State.prepare
      state
      command
      ~actor:(Id.Actor.of_string "owner" |> unwrap)
      ~timestamp:"now"
    |> unwrap
  in
  State.replay state (State.events prepared) |> unwrap, State.result prepared
;;

let%expect_test
    "canonical mutation receipts and retained handoff replay use actual read contracts"
  =
  let state =
    State.empty
      ~workspace:(Id.Workspace.of_string "workspace" |> unwrap)
      ~name:"Workspace"
    |> unwrap
  in
  let state, _ = apply state "project.create" {|{"project_id":"p","title":"Project"}|} in
  let state, receipt =
    apply state "ticket.create" {|{"ticket_id":"parent","title":"Parent"}|}
  in
  printf "receipt=%s\n" (Json.text (Json.field receipt "ticket_id"));
  let state, _ =
    apply
      state
      "ticket.create"
      {|{"ticket_id":"child","title":"Child","parent_ticket_id":"parent"}|}
  in
  let state, receipt =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"child","expected_revision":"0","summary":"Exact historical summary","next_steps":"Next","evidence":"Proof"}|}
  in
  printf "handoff=%s\n" (Json.text (Json.field receipt "ticket_id"));
  List.iter
    [ "workspace.overview", {|{}|}
    ; "project.brief", {|{"project_id":"p"}|}
    ; "ticket.context", {|{"ticket_id":"child"}|}
    ; "ticket.list", {|{}|}
    ; "ticket.ready", {|{}|}
    ; "ticket.readiness", {|{"ticket_id":"child"}|}
    ; "ticket.blockers", {|{"ticket_id":"child"}|}
    ; "ticket.resolve", {|{"display_key":"WG-2"}|}
    ; "handoff.get", {|{"ticket_id":"child"}|}
    ; "handoff.history", {|{"ticket_id":"child"}|}
    ]
    ~f:(fun (method_, params) ->
      let result =
        State.query state ~method_ ~params:(Jsonaf.of_string params) |> unwrap
      in
      Planning_context_api.validate_result ~method_ (Json.field result "data");
      printf "%s=validated\n" method_);
  [%expect
    {| receipt=parent
 handoff=child
 workspace.overview=validated
 project.brief=validated
 ticket.context=validated
 ticket.list=validated
 ticket.ready=validated
 ticket.readiness=validated
 ticket.blockers=validated
 ticket.resolve=validated
 handoff.get=validated
 handoff.history=validated |}]
;;
