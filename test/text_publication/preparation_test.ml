open Core
open Workgraph

let fields =
  [ "workspace_id", Json.string "w"
  ; "actor_id", Json.string "a"
  ; "ticket_id", Json.string "t"
  ; "expected_revision", Json.int 0
  ; "title", Json.string "Note"
  ; "text", Json.string "💖\r\n"
  ]
;;

let%expect_test "expansion freezes ordered atomic operations and cooperative attribution" =
  let prepared = Text_publication.of_params (Json.obj fields) |> Disk.unwrap in
  print_endline (Json.canonical (Text_publication.params prepared));
  [%expect
    {| {"actor_id":"a","operations":[{"as":"published","method":"resource.put_text","params":{"expected_revision":"0","text":"💖\r\n","title":"Note"}},{"method":"resource.link","params":{"expected_revision":"1","resource_id":"$published","target":{"id":"t","kind":"ticket"}}}],"workspace_id":"w"} |}]
;;

let%expect_test "local inputs reject duplicate unknown invalid and overflowing values" =
  let replace key value =
    (key, value) :: List.filter fields ~f:(fun (field, _) -> not (String.equal key field))
  in
  List.iter
    [ ("text", Json.string "duplicate") :: fields
    ; ("extra", Json.string "unknown") :: fields
    ; replace "ticket_id" (Json.string "$outside")
    ; ("resource_id", Json.string "$outside") :: fields
    ; ("run_id", `Null) :: fields
    ; ("mutation_id", Json.string "") :: fields
    ; replace "expected_revision" (Json.string "01")
    ; replace "expected_revision" (Json.int Int.max_value)
    ; replace "expected_revision" (Json.int (Int.max_value - 1))
    ; replace "text" (Json.string (String.make 65_537 'x'))
    ; List.filter fields ~f:(fun (key, _) -> not (String.equal key "title"))
    ]
    ~f:(fun fields ->
      match Text_publication.of_params (Json.obj fields) with
      | Ok _ -> print_endline "unexpected success"
      | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;
