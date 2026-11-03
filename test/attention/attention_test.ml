open Core
open Workgraph

let unwrap = function
  | Ok x -> x
  | Error e -> failwith e.Problem.message
;;

let error = function
  | Ok _ -> print_endline "ok"
  | Error (e : Problem.t) -> print_s [%sexp (e.kind : Problem.kind)]
;;

let workspace = Id.Workspace.of_string "workspace" |> unwrap

let%expect_test "attention cursors bind filters, captured prefix, clock and lineage" =
  let event value = Json.obj [ "revision", Json.int 1; "value", Json.string value ] in
  let filter = Json.obj [ "view", Json.string "attention"; "filter", Json.obj [] ] in
  let capture =
    Attention_cursor.capture
      ~workspace
      ~revision:1
      ~activity:[ event "original" ]
      ~filter
      ~after:None
      ~cursor:None
      ~now_unix_ms:10L
    |> unwrap
  in
  let cursor = Attention_cursor.encode capture ~workspace ~filter in
  let check ?(activity = [ event "original" ]) ?(filter = filter) ?(now = 10L) () =
    Attention_cursor.capture
      ~workspace
      ~revision:1
      ~activity
      ~filter
      ~after:None
      ~cursor:(Some cursor)
      ~now_unix_ms:now
    |> error
  in
  check ();
  check ~activity:[ event "replaced" ] ();
  check ~filter:(Json.obj [ "view", Json.string "other" ]) ();
  check ~now:9L ();
  let consumed = Attention_cursor.advance capture ~count:0 ~complete:true in
  let cursor = Attention_cursor.encode consumed ~workspace ~filter in
  let next =
    Attention_cursor.capture
      ~workspace
      ~revision:2
      ~activity:[ Json.obj [ "revision", Json.int 2 ]; event "original" ]
      ~filter
      ~after:None
      ~cursor:(Some cursor)
      ~now_unix_ms:11L
    |> unwrap
  in
  print_s [%sexp (next.after : int), (next.through : int), (next.offset : int)];
  [%expect
    {|
    ok
    Conflict
    Conflict
    Conflict
    (1 2 0)
    |}]
;;

let%expect_test "captured group decoder rejects mismatched raw IDs and invalid fragments" =
  let descriptor id =
    Json.obj
      [ "notification_id", Json.int id
      ; ( "source"
        , Json.obj [ "kind", Json.string "request"; "request_id", Json.string "request" ]
        )
      ; "source_revision", Json.int 1
      ; "kind", Json.string "request_created"
      ; "causal_body", `Null
      ]
  in
  let row ~ids ~index ~count =
    Json.obj
      [ "kind", Json.string "communication_group"
      ; ( "source"
        , Json.obj [ "workspace_revision", Json.int 1; "change_index", Json.int 0 ] )
      ; "group_id", Json.string "workspace:1:request:request"
      ; "fragment_index", Json.int index
      ; "fragment_count", Json.int count
      ; "notification_ids", `Array (List.map ids ~f:Json.int)
      ; "notifications", `Array [ descriptor 1 ]
      ]
  in
  List.iter
    [ row ~ids:[ 1 ] ~index:0 ~count:1
    ; row ~ids:[ 2 ] ~index:0 ~count:1
    ; row ~ids:[ 1 ] ~index:1 ~count:1
    ; row ~ids:[] ~index:0 ~count:1
    ]
    ~f:(fun row -> Api_codec.decode Attention_api.row_codec row |> error);
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "filter sets are canonical and unread selection is explicit" =
  let filter kinds =
    Json.obj
      [ "kinds", `Array (List.map kinds ~f:Json.string)
      ; "ticket_ids", `Array [ Json.string "z"; Json.string "a" ]
      ]
  in
  let encode json =
    Api_codec.decode Attention_api.Filter.codec json
    |> unwrap
    |> Api_codec.encode Attention_api.Filter.codec
    |> unwrap
    |> Json.canonical
  in
  print_s
    [%sexp
      (String.equal
         (encode (filter [ "ticket"; "fact" ]))
         (encode (filter [ "fact"; "ticket" ]))
       : bool)];
  Api_codec.decode
    Attention_api.Filter.codec
    (Json.obj [ "kinds", `Array [ Json.string "communication" ] ])
  |> error;
  Api_codec.decode
    Attention_api.Filter.codec
    (Json.obj
       [ "kinds", `Array [ Json.string "ticket" ]; "fact_prefix", Json.string "x" ])
  |> error;
  [%expect
    {|
    true
    Invalid_argument
    Invalid_argument
    |}]
;;
