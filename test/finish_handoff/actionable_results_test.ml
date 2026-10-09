open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let json text = ok (Json.parse text)
let actor = ok (Id.Actor.of_string "worker")

let prepare state method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(json params))
    ~f:(fun command ->
      State.prepare state command ~actor ~timestamp:"2026-10-09T00:00:00Z")
;;

let apply state method_ params = State.candidate (ok (prepare state method_ params))

let started () =
  ok (State.empty ~workspace:(ok (Id.Workspace.of_string "results")) ~name:"Results")
  |> fun state ->
  apply state "ticket.create" {|{"ticket_id":"task","title":"Task"}|}
  |> fun state -> apply state "ticket.start" {|{"ticket_id":"task"}|}
;;

let%expect_test "finish and release return captured entity revisions and replay" =
  List.iter
    [ "ticket.finish", {|{"ticket_id":"task","token":"1","evidence":"Checked"}|}
    ; "ticket.release", {|{"ticket_id":"task","token":"1"}|}
    ]
    ~f:(fun (method_, params) ->
      let state = started () in
      let prepared = ok (prepare state method_ params) in
      let result = State.result prepared in
      let candidate = State.candidate prepared in
      let context =
        ok
          (State.query
             candidate
             ~method_:"ticket.context"
             ~params:(json {|{"ticket_id":"task"}|}))
        |> fun response -> Json.field (Json.field response "data") "ticket"
      in
      printf "%s %s\n" method_ (Json.canonical result);
      print_s
        [%sexp
          (Int.equal
             (Json.integer (Json.field result "ticket_revision"))
             (Json.integer (Json.field context "revision"))
           : bool)];
      print_s
        [%sexp
          (String.equal
             (Json.canonical (State.to_json candidate))
             (Json.canonical
                (State.to_json (ok (State.replay state (State.events prepared)))))
           : bool)]);
  [%expect
    {|
    ticket.finish {"completed":true,"ticket_revision":"3"}
    true
    true
    ticket.release {"released":true,"ticket_revision":"3"}
    true
    true
    |}]
;;

let%expect_test "blocked finish identifies prerequisite without publishing handoff" =
  let state =
    started ()
    |> fun state ->
    apply state "ticket.create" {|{"ticket_id":"dep","title":"Dependency"}|}
    |> fun state ->
    apply state "dependency.add" {|{"ticket_id":"task","prerequisite_id":"dep"}|}
  in
  let before = Json.canonical (State.to_json state) in
  (match
     prepare
       state
       "ticket.finish"
       {|{"ticket_id":"task","token":"1","evidence":"Checked","handoff":{"summary":"Must not publish","next_steps":""}}|}
   with
   | Ok _ -> print_endline "unexpected completion"
   | Error problem -> print_endline (Json.canonical (Problem.to_json problem)));
  print_s [%sexp (String.equal before (Json.canonical (State.to_json state)) : bool)];
  [%expect
    {|
    {"details":{"blockers":["prerequisite:dep"],"ticket_id":"task","type":"readiness"},"kind":"Blocked","message":"unfinished prerequisites"}
    true
    |}]
;;

let%expect_test "finish and release decoders reject absent or zero entity revision" =
  List.iter
    [ "ticket.finish", "completed"; "ticket.release", "released" ]
    ~f:(fun (method_, field) ->
      let decode value =
        if String.equal method_ "ticket.finish"
        then Api_codec.decode (ok (Ticket_lifecycle.response_codec method_)) value
        else Api_codec.decode (Option.value_exn (Planning_result.codec ~method_)) value
      in
      List.iter [ None; Some "0" ] ~f:(fun revision ->
        let value =
          Json.obj
            ((field, `True)
             :: Option.to_list
                  (Option.map revision ~f:(fun value ->
                     "ticket_revision", Json.string value)))
        in
        print_s [%sexp (Result.is_error (decode value) : bool)]));
  [%expect
    {|
    true
    true
    true
    true
    |}]
;;
