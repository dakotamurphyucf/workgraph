open Core
open Workgraph

let json = Jsonaf.of_string

let unwrap = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error error -> print_endline error.Problem.message
;;

let request method_ params =
  let codec = Option.value_exn (History_api.request_codec ~method_) in
  report (Api_codec.decode codec (json params))
;;

let%expect_test "typed history command encoding exposes canonical public fields" =
  let id = unwrap (Session_id.of_string "conversation") in
  let ref_ = unwrap (Session.Event_ref.create ~session:id ~sequence:1) in
  let input =
    unwrap
      (Session_event.Input.create
         ~client_id:"source"
         ~role:"user"
         ~kind:"message"
         ~phase:"completed"
         ~payload:(Inline "\255\000")
         ~attachments:[]
         ())
  in
  let commands =
    [ History_api.Command.Create
        { id; title = "Conversation"; parent = Some ref_; scopes = [ Workspace ] }
    ; Archive id
    ; Append { session = id; inputs = [ input ] }
    ]
  in
  List.iter commands ~f:(fun command ->
    let method_, params = unwrap (History_api.Command.encode command) in
    report (History_api.Command.decode ~method_ ~params);
    print_endline method_;
    print_endline (Json.canonical params));
  [%expect
    {|
    ok
    session.create
    {"parent_event":{"sequence":"1","session_id":"conversation"},"scopes":[{"kind":"workspace"}],"session_id":"conversation","title":"Conversation"}
    ok
    session.archive
    {"session_id":"conversation"}
    ok
    session.append
    {"events":[{"attachments":[],"client_id":"source","correlation":null,"kind":"message","payload":{"bytes_base64":"/wA=","kind":"inline"},"phase":"completed","provenance":null,"resource_versions":[],"role":"user","searchable_text":null}],"session_id":"conversation"}
    |}]
;;

let%expect_test "history requests reject legacy forms, aliases and malformed controls" =
  request
    "session.create"
    {|{"session_id":"conversation","title":"Conversation","parent":{"session_id":"parent","sequence":"1"}}|};
  request
    "session.create"
    {|{"session_id":"conversation","title":"Conversation","scopes":[{"kind":"ticket","id":"$ticket"}]}|};
  request
    "session.create"
    {|{"session_id":"conversation","title":"Conversation","scopes":[{"kind":"workspace"},{"kind":"workspace"}]}|};
  request "session.append" {|{"session_id":"conversation","events":[]}|};
  request
    "session.append"
    {|{"session_id":"conversation","events":[{"client_id":"source","role":"user","kind":"message","phase":"completed","payload":{"bytes_base64":"/wA="}}]}|};
  request "history.get" {|{"ref":{"session_id":"conversation","sequence":"1"}}|};
  request
    "history.payload"
    {|{"event_ref":{"session_id":"conversation","sequence":"1"},"part":"payload"}|};
  request
    "history.payload"
    {|{"event_ref":{"session_id":"conversation","sequence":"1"},"part":{"kind":"attachment","index":"100"}}|};
  request
    "history.search"
    {|{"text":"needle","after":{"session_id":"conversation","sequence":"1"}}|};
  request
    "history.read"
    {|{"session_id":"conversation","direction":"after","anchor":"-1"}|};
  request "session.list" {|{"head":"bad"}|};
  [%expect
    {|
    /parent: unknown field
    /scopes/0: IDs require 1..96 ASCII letters, digits, underscores or hyphens
    /scopes: duplicate session scope
    /events: append requires 1..128 events
    /events/0/payload/kind: missing field: kind
    /ref: unknown field
    /part/kind: expected object
    /part/index: expected canonical decimal string in 0..99
    /after: unknown field
    /anchor: expected canonical decimal string in 0..1000000
    /head: invalid blob digest/size (maximum 64MiB)
    |}]
;;

let%expect_test "opaque input bytes and literal provenance survive actual public codecs" =
  let params =
    json
      {|{"session_id":"conversation","events":[{"client_id":"source","role":"user","kind":"message","phase":"completed","provenance":{"run_id":"$literal","target":{"kind":"ticket","id":"$also-literal"}},"payload":{"kind":"inline","bytes_base64":"/wA="}}]}|}
  in
  let codec = Option.value_exn (History_api.request_codec ~method_:"session.append") in
  let retained = unwrap (Api_codec.decode codec params) in
  printf
    "identity unchanged=%b\n"
    (String.equal (Json.canonical params) (Json.canonical retained));
  let input =
    match unwrap (History_api.Command.decode ~method_:"session.append" ~params) with
    | Append { inputs = [ input ]; _ } -> input
    | _ -> failwith "expected one input"
  in
  let bytes =
    match Session_event.Input.payload input with
    | Inline bytes -> bytes
    | Blob _ -> failwith "expected inline bytes"
  in
  printf
    "opaque byte count=%d exact=%b\n"
    (String.length bytes)
    (String.equal bytes "\255\000");
  print_endline (Json.canonical (Session_event.Input.provenance input));
  let ref_ =
    unwrap
      (Session.Event_ref.create
         ~session:(unwrap (Session_id.of_string "conversation"))
         ~sequence:1)
  in
  let event =
    Session_event.commit
      input
      ~ref_
      ~actor:(unwrap (Id.Actor.of_string "agent"))
      ~run:None
      ~install:(function
        | Session_event.Content.Inline bytes ->
          unwrap
            (Session_event.Blob_ref.create
               ~digest:(Json.hash bytes)
               ~size_bytes:(String.length bytes))
        | Blob ref_ -> ref_)
  in
  let wire = History_wire.event_json event in
  report (Api_codec.decode History_wire.event wire);
  printf
    "public payload kind=%s\n"
    (Json.text (Json.field (Json.field (Json.field wire "event") "payload") "kind"));
  let stored = Session_event.to_json event in
  printf
    "storage payload kind absent=%b\n"
    (Option.is_none
       (Json.optional (Json.field (Json.field stored "event") "payload") "kind"));
  request
    "session.append"
    {|{"session_id":"conversation","events":[{"client_id":"source","role":"user","kind":"message","phase":"completed","payload":{"kind":"inline","bytes_base64":"/wA="},"searchable_text":{"kind":"inline","bytes_base64":"/wA="}}]}|};
  [%expect
    {|
    identity unchanged=true
    opaque byte count=2 exact=true
    {"run_id":"$literal","target":{"id":"$also-literal","kind":"ticket"}}
    ok
    public payload kind=blob
    storage payload kind absent=true
    /events/0: JSON requires valid UTF-8
    |}]
;;

let%expect_test "complete family descriptors and payload cursors validate actual data" =
  printf "methods=%d\n" (List.length History_api.methods);
  List.iter History_api.methods ~f:(fun (Api_method.Packed.Pack descriptor) ->
    printf
      "%s fields=%d\n"
      (Api_method.name descriptor)
      (Api_codec.field_names (Api_method.request_codec descriptor)
       |> Option.value_exn
       |> List.length));
  let codec = Option.value_exn (History_api.response_codec ~method_:"history.payload") in
  let result next =
    Json.obj
      [ ( "blob"
        , Session_event.Blob_ref.to_json
            (unwrap
               (Session_event.Blob_ref.create
                  ~digest:(Json.hash "\255\000")
                  ~size_bytes:2)) )
      ; "offset", Json.int 0
      ; "bytes_base64", Json.string "/wA="
      ; "next_offset", Json.int next
      ; "total_bytes", Json.int 2
      ; "has_more", `False
      ]
  in
  report (Api_codec.decode codec (result 2));
  report (Api_codec.decode codec (result 1));
  [%expect
    {|
    methods=9
    session.create fields=4
    session.archive fields=1
    session.append fields=2
    session.get fields=3
    session.list fields=5
    history.get fields=3
    history.read fields=6
    history.search fields=7
    history.payload fields=6
    ok
    inconsistent history payload cursor or byte length
    |}]
;;

let%expect_test
    "history execution retains durable retries, immutable captures and complete byte \
     retrieval"
  =
  History_test.with_store (fun _env fs root store ->
    let actor = History_test.actor in
    let workspace = History_test.workspace in
    let execute method_ params key =
      let command =
        unwrap (History_command.decode ~workspace ~actor ~method_ ~params ())
      in
      unwrap
        (History_command.execute
           store
           command
           ~actor
           ~key:("agent:" ^ key)
           ~request_hash:(Json.hash (Json.canonical params))
           ())
    in
    let created =
      execute
        "session.create"
        (json {|{"session_id":"conversation","title":"Conversation"}|})
        "create"
    in
    let public = Api_response.project History created in
    printf
      "session ID=%s durable=%b\n"
      (Json.text
         (Json.field (Json.field (Api_response.data public) "session") "session_id"))
      (Result.is_ok (Api_response.require_durable public));
    let bytes = String.make 9000 '\255' ^ "\000tail" in
    let input =
      unwrap
        (Session_event.Input.create
           ~client_id:"source"
           ~role:"user"
           ~kind:"message"
           ~phase:"completed"
           ~payload:(Inline bytes)
           ~searchable_text:(Inline "needle beyond context")
           ~attachments:[]
           ())
    in
    let params =
      Json.obj
        [ "session_id", Json.string "conversation"
        ; "events", `Array [ unwrap (Api_codec.encode History_wire.input input) ]
        ]
    in
    let appended = execute "session.append" params "append" in
    let retry = execute "session.append" params "append" in
    printf
      "exact append retry=%b\n"
      (String.equal (Json.canonical appended) (Json.canonical retry));
    let capture = unwrap (Session_store.capture store) in
    let index = History_index.create ~fs ~root in
    let query method_ params =
      unwrap (History_command.query capture ~fs ~root ~index ~method_ ~params)
    in
    let ref_ = json {|{"session_id":"conversation","sequence":"1"}|} in
    let rec retrieve offset acc chunks =
      let result =
        query
          "history.payload"
          (Json.obj
             [ "event_ref", ref_
             ; "offset", Json.int offset
             ; "length", Json.int 262144
             ; "max_bytes", Json.int 4096
             ])
      in
      if Api_response.encoded_size History result > 4096 then failwith "budget exceeded";
      let projected = Api_response.project History result in
      if Option.is_none (Json.optional (Api_response.meta projected) "history_capture")
      then failwith "missing capture";
      let chunk = Base64.decode_exn (Json.text (Json.field result "bytes_base64")) in
      let next = Json.integer (Json.field result "next_offset") in
      let acc = chunk :: acc in
      match Json.field result "has_more" with
      | `True ->
        if next <= offset
        then failwith "nonadvancing payload"
        else retrieve next acc (chunks + 1)
      | _ -> String.concat (List.rev acc), chunks + 1
    in
    let recovered, chunks = retrieve 0 [] 0 in
    printf
      "complete bytes=%d exact=%b chunks=%d\n"
      (String.length recovered)
      (String.equal bytes recovered)
      chunks;
    let _ =
      execute
        "session.append"
        (json
           {|{"session_id":"conversation","events":[{"client_id":"later","role":"user","kind":"message","phase":"completed","payload":{"kind":"inline","bytes_base64":"bGF0ZXI="}}]}|})
        "later"
    in
    let page =
      query "history.read" (json {|{"session_id":"conversation","direction":"after"}|})
    in
    printf
      "captured through=%s items=%d\n"
      (Json.text (Json.field page "through"))
      (List.length (Json.list (Json.field page "items")));
    let _ = unwrap (History_index.rebuild index capture) in
    let hits =
      query "history.search" (json {|{"text":"needle"}|})
      |> fun result -> Json.list (Json.field result "items")
    in
    printf
      "canonical hit reference=%b\n"
      (Option.is_some (Json.optional (List.hd_exn hits) "event_ref"));
    let _ =
      execute "session.archive" (json {|{"session_id":"conversation"}|}) "archive"
    in
    let retry =
      execute
        "session.create"
        (json {|{"session_id":"conversation","title":"Conversation"}|})
        "create"
    in
    printf
      "create receipt stable after archive=%b\n"
      (String.equal (Json.canonical created) (Json.canonical retry)));
  [%expect
    {|
    session ID=conversation durable=true
    exact append retry=true
    complete bytes=9005 exact=true chunks=4
    captured through=1 items=1
    canonical hit reference=true
    create receipt stable after archive=true
    |}]
;;
