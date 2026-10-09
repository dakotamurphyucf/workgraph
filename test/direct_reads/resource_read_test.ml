open Core
open Workgraph

let print_result result =
  match result with
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let%expect_test
    "public resource result decoders validate complete content and chunk positions"
  =
  let digest = Json.hash "body" in
  let text =
    [ "resource_id", Json.string "r"
    ; "version", Json.int 1
    ; "digest", Json.string digest
    ; "size_bytes", Json.int 4
    ; "text", Json.string "body"
    ]
  in
  print_result (Api_codec.decode Resource_read.Text.codec (Json.obj text));
  List.iter
    [ "size_bytes", Json.int 3
    ; "digest", Json.string (String.make 64 'f')
    ; "version", Json.int 0
    ]
    ~f:(fun (key, value) ->
      let fields =
        (key, value)
        :: List.filter text ~f:(fun (field, _) -> not (String.equal key field))
      in
      print_result (Api_codec.decode Resource_read.Text.codec (Json.obj fields)));
  let chunk =
    [ "resource_id", Json.string "r"
    ; "version", Json.int 1
    ; "digest", Json.string digest
    ; "size_bytes", Json.int 4
    ; "offset", Json.int 0
    ; "data_base64", Json.string "Ym9keQ=="
    ; "chunk_digest", Json.string digest
    ; "next_offset", `Null
    ; "eof", `True
    ]
  in
  print_result (Api_codec.decode Resource_read.Chunk.codec (Json.obj chunk));
  List.iter
    [ "offset", Json.int 5
    ; "next_offset", Json.int 4
    ; "eof", `False
    ; "chunk_digest", Json.string (String.make 64 'f')
    ; "digest", Json.string (String.make 64 'f')
    ; "data_base64", Json.string "Ym9keQ"
    ]
    ~f:(fun (key, value) ->
      let fields =
        (key, value)
        :: List.filter chunk ~f:(fun (field, _) -> not (String.equal key field))
      in
      print_result (Api_codec.decode Resource_read.Chunk.codec (Json.obj fields)));
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "constructors reject content versions different from explicit selectors" =
  let params =
    Json.obj
      [ "workspace_id", Json.string "w"
      ; "resource_id", Json.string "r"
      ; "version", Json.int 2
      ]
  in
  let unwrap = function
    | Ok value -> value
    | Error error -> raise (Json.Decode_error error)
  in
  let request = Api_codec.decode Resource_read.Request.codec params |> unwrap in
  let version =
    { Resource.Version.revision = 1
    ; digest = Json.hash "body"
    ; size_bytes = Some 4
    ; actor = Id.Actor.of_string "a" |> unwrap
    ; timestamp = "2026-10-08"
    ; filename = "r.txt"
    ; mime_type = "text/plain"
    }
  in
  print_result (Resource_read.Text.create request ~version ~text:"body");
  let fields =
    match params with
    | `Object fields -> fields
    | _ -> assert false
  in
  let request =
    Api_codec.decode
      Resource_read.Chunk_request.codec
      (Json.obj (fields @ [ "length", Json.int 4 ]))
    |> unwrap
  in
  print_result (Resource_read.Chunk.create request ~version ~bytes:"body" ~total_bytes:4);
  [%expect
    {|
    Invalid_argument
    Invalid_argument |}]
;;
