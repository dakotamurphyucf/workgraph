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

let%expect_test "text ranges retain whole UTF8 scalars and reject invalid selected bytes" =
  let actor = Id.Actor.of_string "a" |> Disk.unwrap in
  let range bytes ~offset ~length =
    let request =
      Api_codec.decode
        Resource_read.Chunk_request.codec
        (Json.obj
           [ "workspace_id", Json.string "w"
           ; "resource_id", Json.string "r"
           ; "offset", Json.int offset
           ; "length", Json.int length
           ])
      |> Disk.unwrap
    in
    let version =
      { Resource.Version.revision = 1
      ; digest = Json.hash bytes
      ; size_bytes = Some (String.length bytes)
      ; actor
      ; timestamp = "test"
      ; filename = "r.txt"
      ; mime_type = "text/plain"
      }
    in
    Resource_read.Text_range.create
      request
      ~version
      ~bytes:
        (String.sub
           bytes
           ~pos:offset
           ~len:(Int.min length (String.length bytes - offset)))
      ~total_bytes:(String.length bytes)
  in
  let text = "a💖é€z" in
  List.iter
    [ 0, 1; 0, 4; 1, 4; 5, 3; 7, 4; 11, 4 ]
    ~f:(fun (offset, length) ->
      let result = range text ~offset ~length |> Disk.unwrap in
      let json = Api_codec.encode Resource_read.Text_range.codec result |> Disk.unwrap in
      printf
        "%s next=%s eof=%b\n"
        (Json.text (Json.field json "text"))
        (Json.canonical (Json.field json "next_offset"))
        (match Json.field json "eof" with
         | `True -> true
         | _ -> false));
  List.iter
    [ 1, 3; 2, 4 ]
    ~f:(fun (offset, length) -> print_result (range text ~offset ~length));
  List.iter
    [ "\192\128"; "\237\160\128"; "\244\144\128\128"; "a\255b"; "a\240\159" ]
    ~f:(fun bytes -> print_result (range bytes ~offset:0 ~length:4));
  (* A malformed trailing lead must not be silently postponed as if truncated. *)
  print_result (range "a\255suffix" ~offset:0 ~length:2);
  (* Valid incomplete scalars of each width are retained for a later range. *)
  List.iter [ "aéz"; "a€z"; "a💖z" ] ~f:(fun bytes ->
    let result = range bytes ~offset:0 ~length:2 |> Disk.unwrap in
    let json = Api_codec.encode Resource_read.Text_range.codec result |> Disk.unwrap in
    printf
      "boundary=%s next=%s\n"
      (Json.text (Json.field json "text"))
      (Json.canonical (Json.field json "next_offset")));
  [%expect
    {|
    a next="1" eof=false
    a next="1" eof=false
    💖 next="5" eof=false
    é next="7" eof=false
    €z next=null eof=true
     next=null eof=true
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    boundary=a next="1"
    boundary=a next="1"
    boundary=a next="1"
  |}]
;;

let%expect_test "public UTF8 range decoder rejects forged bytes and continuations" =
  let fields =
    [ "resource_id", Json.string "r"
    ; "version", Json.int 1
    ; "digest", Json.string (Json.hash "é!")
    ; "size_bytes", Json.int 3
    ; "offset", Json.int 0
    ; "text", Json.string "é"
    ; "chunk_digest", Json.string (Json.hash "é")
    ; "next_offset", Json.int 2
    ; "eof", `False
    ]
  in
  print_result (Api_codec.decode Resource_read.Text_range.codec (Json.obj fields));
  List.iter
    [ "text", Json.string "\255"
    ; "chunk_digest", Json.string (Json.hash "other")
    ; "next_offset", Json.int 1
    ; "eof", `True
    ; "offset", Json.int 4
    ]
    ~f:(fun (key, value) ->
      let json =
        Json.obj ((key, value) :: List.Assoc.remove fields key ~equal:String.equal)
      in
      print_result (Api_codec.decode Resource_read.Text_range.codec json));
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;
