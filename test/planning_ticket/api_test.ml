open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let report codec value =
  match Api_codec.decode codec value with
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let set value name field =
  match value with
  | `Object fields ->
    Json.obj ((name, field) :: List.Assoc.remove fields name ~equal:String.equal)
  | _ -> failwith "fixture requires record"
;;

let%expect_test
    "typed public lease preserves actual deadline and ownership epoch invariants"
  =
  let lease =
    Allocation_lease.create ~epoch:7 ~now_unix_ms:2000L ~policy:(Duration_ms 1000L) ()
    |> unwrap
  in
  let view = Planning_ticket_wire.Lease.of_domain lease in
  let json = Api_codec.encode Planning_ticket_wire.Lease.codec view |> unwrap in
  printf "deadline=%s\n" (Json.text (Json.field json "deadline_unix_ms"));
  report Planning_ticket_wire.Lease.codec (set json "deadline_unix_ms" (Json.int64 3001L));
  report Planning_ticket_wire.Lease.codec (set json "duration_ms" `Null);
  report
    Planning_ticket_wire.Ownership.codec
    (Json.obj
       [ "actor_id", Json.string "worker"
       ; "run_id", `Null
       ; "token", Json.int 8
       ; "lease", json
       ]);
  (match
     Api_codec.encode
       Planning_ticket_wire.Lease.codec
       { view with deadline_unix_ms = Some 3001L }
   with
   | Ok _ -> print_endline "invalid encoder accepted"
   | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {| deadline=3000
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument |}]
;;

let fixture =
  Jsonaf.of_string
    {|{"ticket_id":"task","display_key":"WG-1","title":"Task","description":"","project_id":null,"membership_revision":"1","parent_ticket_id":null,"milestone_id":null,"archived":false,"status_id":null,"priority":"0","assignee_id":null,"label_ids":[],"acceptance_criteria":"","status":"todo","revision":"1","hold":null,"waivers":[],"prerequisite_ticket_ids":[],"related_ticket_ids":[],"claim":null,"created_order":"1","reopened_token":null,"reassessments":[],"created_sequence":"1","created_at":"now","updated_at":"now","next_token":"1"}|}
;;

let%expect_test
    "canonical ticket rejects legacy identity and contradictory control metadata"
  =
  report Planning_ticket_wire.Ticket.codec fixture;
  report Planning_ticket_wire.Ticket.codec (set fixture "id" (Json.string "task"));
  report
    Planning_ticket_wire.Ticket.codec
    (set fixture "membership_revision" (Json.int 2));
  report Planning_ticket_wire.Ticket.codec (set fixture "next_token" (Json.int 3));
  report
    Planning_ticket_wire.Ticket.codec
    (set fixture "label_ids" (`Array [ Json.string "a"; Json.string "a" ]));
  report
    Planning_ticket_wire.Ticket.codec
    (set
       fixture
       "hold"
       (Json.obj
          [ "actor", Json.string "worker"
          ; "reason", Json.string "waiting"
          ; "timestamp", Json.string "now"
          ]));
  [%expect
    {| ok
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument |}]
;;

let%expect_test
    "real completion/readiness projection validates configured checks independently"
  =
  let state =
    State.empty
      ~workspace:(Id.Workspace.of_string "workspace" |> unwrap)
      ~name:"Workspace"
    |> unwrap
  in
  let command =
    Domain_command.decode
      ~method_:"ticket.create"
      ~params:(Jsonaf.of_string {|{"ticket_id":"task","title":"Task"}|})
    |> unwrap
  in
  let prepared =
    State.prepare
      state
      command
      ~actor:(Id.Actor.of_string "worker" |> unwrap)
      ~timestamp:"now"
    |> unwrap
  in
  let state = State.replay state (State.events prepared) |> unwrap in
  let response =
    State.query
      state
      ~method_:"ticket.readiness"
      ~params:(Jsonaf.of_string {|{"ticket_id":"task"}|})
    |> unwrap
  in
  let data = Json.field response "data" in
  report Planning_ticket_wire.Readiness.codec data;
  report Planning_ticket_wire.Readiness.codec (set data "reason_count" (Json.int 1));
  let completion = Json.field data "completion" in
  report
    Planning_ticket_wire.Completion.codec
    (set completion "blocked_prerequisite_count" (Json.int 1));
  [%expect
    {| ok
 Invalid_argument
 Invalid_argument |}]
;;
