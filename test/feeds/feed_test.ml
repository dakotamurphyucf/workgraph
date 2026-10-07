open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let workspace = Id.Workspace.of_string "feed-test" |> unwrap

let event revision actor =
  Json.obj
    [ "revision", Json.int revision
    ; "actor", Json.string actor
    ; "timestamp", Json.string "2026-10-07T00:00:00Z"
    ; "targets", `Array [ Entity_ref.jsonaf_of_t Workspace ]
    ; "changes", `Array [ `Array [ Json.string "Workspace_updated"; Json.obj [] ] ]
    ]
;;

let params fields =
  Json.obj (("workspace_id", Id.Workspace.jsonaf_of_t workspace) :: fields)
;;

let read activity fields =
  Change_feed.read
    ~workspace
    ~revision:(List.length activity)
    ~activity
    ~params:(params fields)
;;

let positions response =
  Json.field response "items"
  |> Json.list
  |> List.map ~f:(fun item -> Json.field item "revision" |> Json.integer)
;;

let%expect_test "snapshot paging survives appended events and then advances" =
  let history = [ event 2 "a"; event 1 "a" ] in
  let page1 = read history [ "limit", Json.int 1 ] |> unwrap in
  let history = event 3 "a" :: history in
  let page2 =
    read history [ "cursor", Json.field page1 "cursor"; "limit", Json.int 1 ] |> unwrap
  in
  let page3 = read history [ "cursor", Json.field page2 "cursor" ] |> unwrap in
  print_s
    [%sexp
      ((positions page1, positions page2, positions page3)
       : int list * int list * int list)];
  [%expect {| ((1) (2) (3)) |}]
;;

let%expect_test "filtered progress and changed filters" =
  let history = [ event 2 "b"; event 1 "a" ] in
  let first = read history [ "actor_id", Json.string "absent" ] |> unwrap in
  let next =
    read
      (event 3 "absent" :: history)
      [ "actor_id", Json.string "absent"; "cursor", Json.field first "cursor" ]
    |> unwrap
  in
  print_s [%sexp ((positions first, positions next) : int list * int list)];
  (match
     read
       history
       [ "actor_id", Json.string "different"; "cursor", Json.field first "cursor" ]
   with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect
    {|
    (() (3))
    Conflict
    |}]
;;

let%expect_test "future cursor and malformed limits reject" =
  List.iter
    [ [ "after", Json.int 4 ]; [ "limit", Json.int 0 ]; [ "cursor", Json.string "%%%" ] ]
    ~f:(fun fields ->
      match read [ event 1 "a" ] fields with
      | Ok _ -> print_endline "unexpected success"
      | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect
    {|
    Conflict
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "cursor cannot cross planning and history sources" =
  let events = [ event 1 "a" ] in
  let history = read events [ "source", Json.string "history" ] |> unwrap in
  (match read events [ "cursor", Json.field history "cursor" ] with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect {| Conflict |}]
;;
