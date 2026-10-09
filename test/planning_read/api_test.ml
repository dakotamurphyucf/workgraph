open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let report codec json =
  match Api_codec.decode codec json with
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let%expect_test
    "base read requests reject aliases nulls malformed limits and unpinned offsets"
  =
  List.iter Planning_read_api.methods ~f:(fun (Api_method.Packed.Pack method_) ->
    printf "%s " (Api_method.name method_);
    print_s [%sexp (Api_method.mode method_ : Api_method.Mode.t)]);
  let codec name = Option.value_exn (Planning_read_api.request_codec ~method_:name) in
  List.iter
    [ "project.get", {|{"project_id":"p"}|}
    ; "project.get", {|{"project_id":"$p"}|}
    ; "project.list", {|{"include_archived":null}|}
    ; "project.list", {|{"limit":"0"}|}
    ; "project.list", {|{"offset":"1"}|}
    ; "project.list", {|{"offset":"1","at_revision":"0"}|}
    ; "milestone.list", {|{"project_id":null}|}
    ; "workspace.get", {|{"unexpected":true}|}
    ]
    ~f:(fun (name, json) -> report (codec name) (Jsonaf.of_string json));
  [%expect
    {|
 workspace.get Read
 project.get Read
 project.list Read
 milestone.get Read
 milestone.list Read
 actor.list Read
 label.list Read
 status.list Read
 ok
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument
 ok
 Invalid_argument
 Invalid_argument |}]
;;

let project id : Planning_wire.Project.t =
  { project_id = Id.Project.of_string id |> unwrap
  ; title = String.make 512 'T'
  ; description = String.make 65536 'd'
  ; revision = 7
  ; status = Todo
  ; priority = 4
  ; summary = String.make 65536 's'
  ; acceptance_criteria = String.make 65536 'a'
  ; archived = false
  }
;;

let%expect_test
    "typed fitter protects identity title revision category and advancing page cursors"
  =
  let source = project "project" in
  let fitted =
    Planning_wire.Response.fit (Project source) ~workspace_revision:11 ~max_bytes:4096
    |> unwrap
  in
  let public = Api_response.project Planning_read fitted in
  let view =
    Api_codec.decode Planning_wire.Project.codec (Api_response.data public) |> unwrap
  in
  printf
    "protected=%b budget=%b\n"
    (Id.Project.equal source.project_id view.project_id
     && String.equal source.title view.title
     && Int.equal source.revision view.revision
     && Workflow.Category.equal source.status view.status
     && Int.equal source.priority view.priority)
    (String.length (Json.canonical (Api_response.to_json public)) <= 4096);
  let budget = Json.field (Api_response.meta public) "budget" in
  printf
    "omitted descriptive fields=%d\n"
    (Json.integer (Json.field budget "omitted_fields"));
  let items = List.init 100 ~f:(fun index -> project (Printf.sprintf "p%d" index)) in
  let page =
    { Planning_wire.Page.items; offset = 7; remaining = 13; next_offset = Some 107 }
  in
  let fitted =
    Planning_wire.Response.fit (Projects page) ~workspace_revision:11 ~max_bytes:4096
    |> unwrap
  in
  let data = Json.field fitted "data" in
  let count = List.length (Json.list (Json.field data "items")) in
  printf
    "nonempty=%b cursor=%b remaining=%b\n"
    (count > 0)
    (Int.equal (Json.integer (Json.field data "next_offset")) (7 + count))
    (Int.equal (Json.integer (Json.field data "remaining")) (113 - count));
  ignore
    (unwrap
       (Api_metadata.of_json
          (Api_response.meta (Api_response.project Planning_read fitted)))
     : Api_metadata.t);
  [%expect
    {|
 protected=true budget=true
 omitted descriptive fields=3
 nonempty=true cursor=true remaining=true |}]
;;

let%expect_test
    "canonical mutation projection leaves independent replay event identities intact"
  =
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Workspace"
    |> unwrap
  in
  let command =
    Domain_command.decode
      ~method_:"project.create"
      ~params:(Jsonaf.of_string {|{"project_id":"p","title":"Project"}|})
    |> unwrap
  in
  let prepared =
    State.prepare state command ~actor:(Id.Actor.of_string "a" |> unwrap) ~timestamp:"now"
    |> unwrap
  in
  print_endline (Json.text (Json.field (State.result prepared) "project_id"));
  let restored = State.replay state (State.events prepared) |> unwrap in
  let read =
    State.query
      restored
      ~method_:"project.get"
      ~params:(Jsonaf.of_string {|{"project_id":"p"}|})
    |> unwrap
  in
  printf
    "replayed=%b\n"
    (String.equal (Json.text (Json.field (Json.field read "data") "project_id")) "p");
  report
    Planning_wire.Project.codec
    (Jsonaf.of_string
       {|{"id":"p","title":"Project","description":"","revision":"1","status":"todo","priority":"0","summary":"","acceptance_criteria":"","archived":false}|});
  [%expect
    {|
 p
 replayed=true
 Invalid_argument |}]
;;
