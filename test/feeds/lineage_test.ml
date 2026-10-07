open Core
open Workgraph

let ok = Disk.unwrap
let workspace = Id.Workspace.of_string "lineage" |> ok

let event revision text =
  Json.obj
    [ "revision", Json.int revision
    ; "actor", Json.string "agent"
    ; "timestamp", Json.string "fixture"
    ; "targets", `Array [ Entity_ref.jsonaf_of_t Workspace ]
    ; "changes", `Array [ `Array [ Json.string "Workspace_updated"; Json.string text ] ]
    ]
;;

let read activity fields =
  Change_feed.read
    ~workspace
    ~revision:(List.length activity)
    ~activity
    ~params:(Json.obj (("workspace_id", Id.Workspace.jsonaf_of_t workspace) :: fields))
;;

let report (result : (Jsonaf.t, Problem.t) Result.t) =
  match result with
  | Ok response ->
    Json.field response "items"
    |> Json.list
    |> List.map ~f:(fun item -> Json.field item "revision" |> Json.integer)
    |> fun positions -> print_s [%sexp (positions : int list)]
  | Error error -> print_s [%sexp (error.kind : Problem.kind)]
;;

let%expect_test "completed cursor rejects same-revision and longer replaced branches" =
  let first = event 1 "first" in
  let original = [ event 2 "original"; first ] in
  let cursor = read original [] |> ok |> fun response -> Json.field response "cursor" in
  List.iter
    [ [ event 2 "replacement"; first ]
    ; [ event 3 "later"; event 2 "replacement"; first ]
    ]
    ~f:(fun replaced -> report (read replaced [ "cursor", cursor ]));
  report (read (event 3 "later" :: original) [ "cursor", cursor ]);
  [%expect
    {|
    Conflict
    Conflict
    (3)
    |}]
;;

let%expect_test "partial cursor checks its full bound and empty prefix can advance" =
  let original = [ event 2 "second"; event 1 "first" ] in
  let page = read original [ "limit", Json.int 1 ] |> ok in
  let replaced = [ event 2 "replacement"; event 1 "first" ] in
  report (read replaced [ "cursor", Json.field page "cursor" ]);
  let empty = read [] [] |> ok in
  report (read [ event 1 "first" ] [ "cursor", Json.field empty "cursor" ]);
  [%expect
    {|
    Conflict
    (1)
    |}]
;;

let%expect_test "current cursors require a lineage anchor" =
  let response = read [ event 1 "first" ] [] |> ok in
  let encoded = Json.field response "cursor" |> Json.text in
  let decoded = Base64.decode_exn encoded |> Json.parse |> ok in
  let missing =
    match decoded with
    | `Object fields ->
      Json.obj (List.filter fields ~f:(fun (key, _) -> not (String.equal key "anchor")))
    | _ -> assert false
  in
  let encoded = Json.canonical missing |> Base64.encode_string |> Json.string in
  report (read [ event 1 "first" ] [ "cursor", encoded ]);
  [%expect {| Invalid_argument |}]
;;
