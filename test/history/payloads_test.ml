open Core
open Workgraph

let unwrap = Disk.unwrap
let ref_ = History_test.ref_

let bool value =
  match value with
  | `True -> true
  | _ -> false
;;

let%expect_test "batch payloads retain every ordered reference and explicit continuation" =
  History_test.with_store (fun _env fs root store ->
    ignore (History_test.create store : Jsonaf.t);
    let body = String.init 10000 ~f:(fun index -> Char.of_int_exn (index mod 256)) in
    ignore
      (History_test.append
         store
         ~key:"payloads"
         [ History_test.input "large" body; History_test.input "small" "tail" ]
       |> unwrap
       : Jsonaf.t);
    let capture = History_test.current store in
    let index = History_index.create ~fs ~root in
    let query method_ params =
      History_command.query capture ~fs ~root ~index ~method_ ~params
    in
    let batch ?(max_bytes = 4096) ?(length = 262144) refs =
      query
        "history.payloads"
        (Json.obj
           [ "event_refs", `Array (List.map refs ~f:Session.Event_ref.to_json)
           ; "length", Json.int length
           ; "max_bytes", Json.int max_bytes
           ])
    in
    let result = batch [ ref_ 1; ref_ 2; ref_ 1 ] |> unwrap in
    let items = Json.list (Json.field result "items") in
    printf
      "within budget=%b refs=%s\n"
      (Api_response.encoded_size History result <= 4096)
      (List.map items ~f:(fun item ->
         Json.field (Json.field item "event_ref") "sequence" |> Json.text)
       |> String.concat ~sep:",");
    List.iteri items ~f:(fun index item ->
      let payload = Json.field item "payload" in
      let bytes = Base64.decode_exn (Json.field payload "bytes_base64" |> Json.text) in
      let total = Json.field payload "total_bytes" |> Json.integer in
      let next = Json.field payload "next_offset" |> Json.integer in
      printf
        "item %d present=%b cursor=%b incomplete=%b\n"
        index
        true
        (next = String.length bytes)
        (bool (Json.field payload "has_more"));
      let remaining =
        query
          "history.payload"
          (Json.obj
             [ "event_ref", Json.field item "event_ref"
             ; "offset", Json.int next
             ; "length", Json.int 262144
             ])
        |> unwrap
      in
      let recovered =
        bytes ^ Base64.decode_exn (Json.field remaining "bytes_base64" |> Json.text)
      in
      printf
        "reconstructed=%b size=%b\n"
        (String.equal recovered (if index = 1 then "tail" else body))
        (String.length recovered = total));
    let sixty = List.init 60 ~f:(fun _ -> ref_ 2) in
    let all = batch ~max_bytes:65536 sixty |> unwrap in
    printf
      "sixty items=%d exact=%b\n"
      (List.length (Json.field all "items" |> Json.list))
      (List.for_all
         (Json.field all "items" |> Json.list)
         ~f:(fun item ->
           String.equal
             (Json.field (Json.field item "payload") "bytes_base64" |> Json.text)
             (Base64.encode_string "tail")));
    let hundred =
      batch ~max_bytes:65536 ~length:0 (List.init 100 ~f:(fun _ -> ref_ 1)) |> unwrap
    in
    printf "maximum items=%d\n" (Json.field hundred "items" |> Json.list |> List.length);
    History_test.show (batch (List.init 100 ~f:(fun _ -> ref_ 1)));
    History_test.show (batch []);
    History_test.show (batch (List.init 101 ~f:(fun _ -> ref_ 1)));
    History_test.show (batch [ ref_ 1; ref_ 3 ]);
    ignore
      (History_test.append store ~key:"later" [ History_test.input "later" "new" ]
       |> unwrap
       : Jsonaf.t);
    History_test.show (batch [ ref_ 3 ]);
    let zero = batch ~length:0 [ ref_ 1 ] |> unwrap in
    let payload =
      Json.field (Json.field zero "items" |> Json.list |> List.hd_exn) "payload"
    in
    printf
      "zero bytes explicit=%b\n"
      (String.is_empty (Json.field payload "bytes_base64" |> Json.text)
       && bool (Json.field payload "has_more")
       && Json.integer (Json.field payload "next_offset") = 0));
  [%expect
    {|
    within budget=true refs=1,2,1
    item 0 present=true cursor=true incomplete=true
    reconstructed=true size=true
    item 1 present=true cursor=true incomplete=true
    reconstructed=true size=true
    item 2 present=true cursor=true incomplete=true
    reconstructed=true size=true
    sixty items=60 exact=true
    maximum items=100
    Blocked
    Invalid_argument
    Invalid_argument
    Not_found
    Not_found
    zero bytes explicit=true
    |}]
;;

let%expect_test "search coverage remains distinct from terminal and limited pages" =
  History_test.with_store (fun _env fs root store ->
    ignore (History_test.create store : Jsonaf.t);
    ignore
      (History_test.append
         store
         ~key:"search-pages"
         [ History_test.input ~text:"needle" "one" "one"
         ; History_test.input ~text:"needle" "two" "two"
         ]
       |> unwrap
       : Jsonaf.t);
    let capture = History_test.current store in
    let index = History_index.create ~fs ~root in
    let search ?after ~limit () =
      History_index.search index capture ~text:"needle" ?after ~limit ~max_bytes:65536 ()
      |> unwrap
    in
    let show name result =
      printf
        "%s index_complete=%b has_more=%b next_null=%b restart=%b hits=%d\n"
        name
        (Json.field result "index_complete" |> bool)
        (Json.field result "has_more" |> bool)
        (match Json.field result "next" with
         | `Null -> true
         | _ -> false)
        (Json.field result "restart_after_indexing" |> bool)
        (Json.field result "items" |> Json.list |> List.length)
    in
    show "unindexed" (search ~limit:100 ());
    (* A later unsafe destination interrupts rebuild after the first event was indexed. *)
    let second = Session_store.Capture.event capture (ref_ 2) |> unwrap in
    let destination =
      Eio.Path.(
        fs / root / ".local/history-index" / (Session_event.identity_hash second ^ ".text"))
    in
    Disk.ensure_directory Eio.Path.(fs / root / ".local");
    Disk.ensure_directory Eio.Path.(fs / root / ".local/history-index");
    Eio.Path.mkdir ~perm:0o700 destination;
    History_test.show (History_index.rebuild index capture);
    show "interrupted" (search ~limit:100 ());
    Eio.Path.rmdir destination;
    History_index.rebuild index capture |> unwrap;
    show "limited" (search ~limit:1 ());
    show "last" (search ~after:(ref_ 1) ~limit:1 ());
    show "empty" (search ~after:(ref_ 2) ~limit:1 ()));
  [%expect
    {|
    unindexed index_complete=false has_more=false next_null=true restart=true hits=0
    Corrupt_store
    interrupted index_complete=false has_more=false next_null=true restart=true hits=1
    limited index_complete=true has_more=true next_null=false restart=false hits=1
    last index_complete=true has_more=false next_null=true restart=false hits=1
    empty index_complete=true has_more=false next_null=true restart=false hits=0
    |}]
;;

let%expect_test "public search decoder rejects contradictory coverage and EOF cursors" =
  let codec = History_api.response_codec ~method_:"history.search" |> Option.value_exn in
  let result ~complete ~restart ~more ~next ~missing =
    Json.obj
      [ "items", `Array []
      ; "coverage", `Array []
      ; ("index_complete", if complete then `True else `False)
      ; ("restart_after_indexing", if restart then `True else `False)
      ; ("has_more", if more then `True else `False)
      ; "next", next
      ; "unindexed_events", Json.int missing
      ; "unsearchable_events", Json.int 0
      ; "omitted_for_budget", Json.int 0
      ]
  in
  List.iter
    [ result ~complete:true ~restart:false ~more:false ~next:`Null ~missing:0
    ; result
        ~complete:true
        ~restart:false
        ~more:false
        ~next:(Session.Event_ref.to_json (ref_ 1))
        ~missing:0
    ; result ~complete:true ~restart:false ~more:true ~next:`Null ~missing:0
    ; result ~complete:false ~restart:true ~more:false ~next:`Null ~missing:1
    ; result ~complete:false ~restart:false ~more:false ~next:`Null ~missing:1
    ; result ~complete:true ~restart:false ~more:false ~next:`Null ~missing:1
    ]
    ~f:(fun value -> Api_codec.decode codec value |> History_test.show);
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    |}]
;;
