open Core
open Workgraph

let json = Jsonaf.of_string

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let report codec value =
  match Api_codec.decode codec value with
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let%expect_test
    "ephemeral request codecs reject mutation envelopes and malformed byte ranges"
  =
  let identity =
    [ "workspace_id", Json.string "w"
    ; "actor_id", Json.string "a"
    ; "upload_id", Json.string "u"
    ]
  in
  let bytes encoded offset =
    Json.obj
      (identity @ [ "offset", Json.string offset; "data_base64", Json.string encoded ])
  in
  report Upload_api.Identity.codec (Json.obj identity);
  report
    Upload_api.Identity.codec
    (Json.obj (identity @ [ "mutation_id", Json.string "m" ]));
  report Upload_api.Identity.codec (Json.obj (identity @ [ "run_id", Json.string "r" ]));
  report
    Upload_api.Identity.codec
    (Json.obj
       [ "workspace_id", Json.string "w"
       ; "actor_id", Json.string "a"
       ; "upload_id", Json.string "$alias"
       ]);
  List.iter
    [ "/wA=", "0"; "/wA", "0"; "", "0"; "aA==", "-1"; "aA==", "01"; "aA==", "67108864" ]
    ~f:(fun (encoded, offset) ->
      report Upload_api.Chunk_request.codec (bytes encoded offset));
  let request =
    unwrap (Api_codec.decode Upload_api.Chunk_request.codec (bytes "/wA=" "0"))
  in
  printf
    "opaque bytes preserved=%b\n"
    (String.equal (Upload_api.Chunk_request.bytes request) "\255\000");
  List.iter Upload_api.methods ~f:(fun (Api_method.Packed.Pack method_) ->
    printf "%s " (Api_method.name method_);
    print_s [%sexp (Api_method.mode method_ : Api_method.Mode.t)]);
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
    opaque bytes preserved=true
    upload.begin Write
    upload.chunk Write
    upload.status Write
    upload.abort Write
    |}]
;;

let status upload received size =
  Json.obj
    [ "upload_id", Json.string upload
    ; "received", Json.int received
    ; "size_bytes", Json.int size
    ; "digest", Json.string (Json.hash "\255\000")
    ]
;;

let%expect_test "staging observations cannot forge progress or a different upload" =
  report Upload_api.Status.codec (status "u" 2 2);
  report Upload_api.Status.codec (status "u" 3 2);
  report Upload_api.Aborted.codec (json {|{"aborted":true}|});
  report Upload_api.Aborted.codec (json {|{"aborted":false}|});
  let identity =
    unwrap
      (Api_codec.decode
         Upload_api.Identity.codec
         (json {|{"workspace_id":"w","actor_id":"a","upload_id":"u"}|}))
  in
  List.iter
    [ status "u" 2 2; status "other" 2 2; status "u" 3 2 ]
    ~f:(fun result ->
      match Upload_api.Status.of_result identity ~method_:"upload.status" result with
      | _ -> print_endline "verified worker result"
      | exception Api_method.Invalid_response (method_, _) ->
        printf "programmer output rejected: %s\n" method_);
  [%expect
    {|
    ok
    Invalid_argument
    ok
    Invalid_argument
    verified worker result
    programmer output rejected: upload.status
    programmer output rejected: upload.status
    |}]
;;

let%expect_test "finish validates metadata and generated identity before installing bytes"
  =
  let request params = report Resource_api.Finish_request.codec (json params) in
  request
    {|{"upload_id":"u","expected_revision":"0","title":"Resource","filename":"resource.bin","mime_type":"application/octet-stream"}|};
  request
    {|{"upload_id":"u","expected_revision":"1","title":"Resource","filename":"resource.bin","mime_type":"application/octet-stream"}|};
  request
    {|{"upload_id":"u","resource_id":"$alias","expected_revision":"0","title":"Resource","filename":"resource.bin","mime_type":"application/octet-stream"}|};
  request
    {|{"upload_id":"u","expected_revision":"0","title":" ","filename":"resource.bin","mime_type":"application/octet-stream"}|};
  request
    {|{"upload_id":"u","expected_revision":"0","title":"Resource","filename":"../resource.bin","mime_type":"application/octet-stream"}|};
  request
    {|{"upload_id":"u","expected_revision":"0","title":"Resource","filename":"resource.bin","mime_type":"text/plain; charset=utf-8"}|};
  request
    {|{"upload_id":"u","expected_revision":"0","title":"Resource","filename":"resource.bin","mime_type":"application/octet-stream","digest":"untrusted"}|};
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let resource () =
  let id = unwrap (Id.Resource.of_string "attachment") in
  let actor = unwrap (Id.Actor.of_string "worker") in
  let metadata : Resource.Metadata.t =
    { title = "Resource"
    ; filename = "attachment.bin"
    ; mime_type = "application/octet-stream"
    ; description = String.make 65536 'x'
    ; archived = false
    ; targets = [ Workspace ]
    }
  in
  let version : Resource.Version.t =
    { revision = 1
    ; digest = Json.hash "\255\000"
    ; size_bytes = Some 2
    ; actor
    ; timestamp = "2026-10-08T00:00:00Z"
    ; filename = metadata.filename
    ; mime_type = metadata.mime_type
    }
  in
  Resource.apply None (Published { id; revision = 1; metadata; version })
;;

let%expect_test
    "public resource views remain distinct from durable records and validate after \
     fitting"
  =
  let resource = resource () in
  let summary = Resource_wire.summary_json resource in
  report Resource_wire.summary summary;
  printf "public resource_id=%s\n" (Json.text (Json.field summary "resource_id"));
  printf
    "public actor_id=%s\n"
    (Json.text (Json.field (Json.field summary "current_version") "actor_id"));
  let stored = Resource.jsonaf_of_t resource in
  printf
    "durable id=%s actor=%s\n"
    (Json.text (Json.field stored "id"))
    (Json.text
       (Json.field (List.hd_exn (Json.list (Json.field stored "versions"))) "actor"));
  report Resource_wire.summary stored;
  let internal = Json.obj [ "workspace_revision", Json.int 1; "data", summary ] in
  let fitted =
    Query_budget.fit
      ~measure:(Api_response.encoded_size Planning_read)
      ~max_bytes:4096
      internal
  in
  let public = Api_response.project Planning_read fitted in
  report Resource_wire.summary (Api_response.data public);
  printf
    "budget bounded=%b omissions disclosed=%b\n"
    (Api_response.encoded_size Planning_read fitted <= 4096)
    (String.equal
       (Json.text
          (Json.field (Json.field (Api_response.meta public) "budget") "omitted_fields"))
       "1");
  let version = Resource.get_version resource ~revision:None in
  let publication =
    Json.obj
      [ "resource_id", Json.string "attachment"
      ; "revision", Json.int 1
      ; "version", Resource_wire.version_json version
      ]
  in
  report Resource_wire.publication publication;
  report
    Resource_wire.publication
    (Json.obj
       [ "resource_id", Json.string "attachment"
       ; "revision", Json.int 1
       ; "version", Resource_wire.version_json { version with size_bytes = None }
       ]);
  [%expect
    {|
    ok
    public resource_id=attachment
    public actor_id=worker
    durable id=attachment actor=worker
    Invalid_argument
    ok
    budget bounded=true omissions disclosed=true
    ok
    Invalid_argument
    |}]
;;

let%expect_test "resource pagination and references use actual request and result codecs" =
  let request method_ params =
    let codec = Option.value_exn (Resource_api.request_codec ~method_) in
    report codec (json params)
  in
  request
    "resource.list"
    {|{"target":{"kind":"ticket","id":"task"},"offset":"1","at_revision":"2"}|};
  request "resource.list" {|{"offset":"1"}|};
  request "resource.list" {|{"target":["Ticket","task"]}|};
  request "resource.list" {|{"target":{"kind":"ticket","id":"$alias"}}|};
  request "resource.get" {|{"resource_id":"attachment","version":"1"}|};
  request "resource.history" {|{"resource_id":"attachment","max_bytes":"4095"}|};
  let page = Option.value_exn (Resource_api.response_codec ~method_:"resource.list") in
  report page (json {|{"items":[],"offset":"0","remaining":"1","next_offset":"0"}|});
  report page (json {|{"items":[],"offset":"0","remaining":"1","next_offset":null}|});
  report page (json {|{"items":[],"offset":"0","remaining":"0","next_offset":"0"}|});
  printf "methods=%d\n" (List.length Resource_api.methods + List.length Upload_api.methods);
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    methods=8
    |}]
;;
