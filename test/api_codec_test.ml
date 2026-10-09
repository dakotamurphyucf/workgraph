open Core
open Workgraph

let report = function
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let%expect_test "wire object declarations distinguish omission from nullable clearing" =
  let open Api_codec in
  let codec =
    Fields.both
      (Fields.required "revision" (decimal ~max:9))
      (Fields.optional "note" (nullable (text ~max_bytes:2)))
    |> object_
  in
  List.iter
    [ {|{"revision":"1"}|}
    ; {|{"revision":"1","note":null}|}
    ; {|{"revision":"1","note":"é"}|}
    ; {|{"revision":"01"}|}
    ; {|{"revision":1}|}
    ; {|{"revision":"10"}|}
    ; {|{"revision":"1","note":"€"}|}
    ; {|{"revision":"1","extra":true}|}
    ; {|{"note":null}|}
    ]
    ~f:(fun bytes -> report (Result.bind (Json.parse bytes) ~f:(decode codec)));
  report (decode codec (`Object [ "revision", Json.int 1; "revision", Json.int 2 ]));
  report (encode codec (-1, None));
  report (encode codec (1, Some (Some "long")));
  print_endline (Json.canonical (encode codec (1, None) |> Disk.unwrap));
  print_endline (Json.canonical (encode codec (1, Some None) |> Disk.unwrap));
  print_endline (Json.canonical (schema codec));
  [%expect
    {|
    ok
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    {"revision":"1"}
    {"note":null,"revision":"1"}
    {"additionalProperties":false,"properties":{"note":{"anyOf":[{"type":"string","x-maxUtf8Bytes":2},{"type":"null"}]},"revision":{"pattern":"^(0|[1-9][0-9]*)(?![\\s\\S])","type":"string","x-maximumDecimal":"9"}},"required":["revision"],"type":"object"}
  |}]
;;

let%expect_test "mutation fields cannot override identity or treat null as omission" =
  let identity =
    { Mutation_request.workspace = Id.Workspace.of_string "workspace" |> Disk.unwrap
    ; actor = Id.Actor.of_string "actor" |> Disk.unwrap
    ; mutation = Id.Mutation.of_string "once" |> Disk.unwrap
    ; run = None
    }
  in
  let params =
    Mutation_request.params
      identity
      ~parameters:(Json.obj [ "title", Json.string "Work" ])
    |> Disk.unwrap
  in
  let decoded, body = Mutation_request.of_params params |> Disk.unwrap in
  print_endline (Mutation_request.key decoded);
  print_endline (Json.canonical body);
  List.iter [ "workspace_id"; "actor_id"; "mutation_id"; "run_id" ] ~f:(fun name ->
    report
      (Mutation_request.params
         identity
         ~parameters:(Json.obj [ name, Json.string "override" ])));
  report
    (Mutation_request.params
       identity
       ~parameters:(`Object [ "title", `Null; "title", `Null ]));
  List.iter
    [ {|{"workspace_id":"workspace","actor_id":"actor","mutation_id":"once","run_id":null}|}
    ; {|{"workspace_id":"workspace","actor_id":"actor","mutation_id":"bad/id"}|}
    ; {|{"workspace_id":"workspace","actor_id":"actor"}|}
    ]
    ~f:(fun json -> report (Mutation_request.of_params (Json.parse json |> Disk.unwrap)));
  [%expect
    {|
    actor:once
    {"title":"Work"}
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;

let%expect_test
    "codec bounds apply in both directions without swallowing unexpected exceptions"
  =
  let codec = Api_codec.list (Api_codec.decimal64 ~max:9L) ~max_items:1 in
  report (Api_codec.encode codec [ 1L; 2L ]);
  report (Api_codec.decode codec (`Array [ Json.string "10" ]));
  report
    (Api_codec.decode
       (Api_codec.enum [ "yes", true; "no", false ] ~equal:Bool.equal)
       (Json.string "YES"));
  let codec =
    Api_codec.map
      Api_codec.boolean
      ~decode:(fun _ -> failwith "implementation bug")
      ~encode:Fn.id
      ~description:"test unexpected failure"
  in
  (match Api_codec.decode codec `True with
   | _ -> failwith "unexpected exception was swallowed"
   | exception Failure message -> print_endline message);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    implementation bug
  |}]
;;

let%expect_test "direct codec inputs validate UTF-8 and duplicate mutation keys" =
  let codec = Api_codec.text ~max_bytes:10 in
  report (Api_codec.encode codec "\255");
  report (Api_codec.decode codec (`String "\255"));
  report (Api_codec.decode (Api_codec.decimal ~max:9) (Json.string "1\n"));
  let fields =
    [ "workspace_id", Json.string "work"
    ; "actor_id", Json.string "actor"
    ; "mutation_id", Json.string "once"
    ]
  in
  report
    (Mutation_request.of_params (`Object (fields @ [ "actor_id", Json.string "other" ])));
  report
    (Mutation_request.of_params (`Object (fields @ [ "body", `Null; "body", `Null ])));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;

let%expect_test
    "method descriptors validate before effects and reject invalid handler output"
  =
  let descriptor =
    Api_method.create
      ~name:"test.write"
      ~summary:"Exercise validation around a handler."
      ~mode:Write
      ~request:(Api_codec.object_ Api_codec.Fields.empty)
      ~response:(Api_codec.decimal ~max:1)
  in
  let ran = ref false in
  report
    (Api_method.invoke
       descriptor
       ~params:(Json.obj [ "surprise", `True ])
       ~f:(fun () ->
         ran := true;
         Ok 1));
  print_s [%sexp (!ran : bool)];
  (match Api_method.invoke descriptor ~params:(Json.obj []) ~f:(fun () -> Ok 2) with
   | _ -> failwith "invalid response returned as ordinary result"
   | exception Api_method.Invalid_response (name, problem) ->
     print_s [%sexp (name : string), (problem.kind : Problem.kind)]);
  let description = Api_method.describe Daemon_methods.initialize in
  print_endline (Json.text (Json.field description "mode"));
  report
    (Api_method.invoke Daemon_methods.initialize ~params:(Json.obj []) ~f:(fun () ->
       Ok (Daemon_methods.Initialization.current ())));
  let shutdown =
    Protocol.Request.create ~id:"test" ~method_:"daemon.shutdown" ~params:(Json.obj [])
    |> Disk.unwrap
  in
  print_s [%sexp (Protocol.Request.mode shutdown : Protocol.Request.mode)];
  [%expect
    {|
    Invalid_argument
    false
    (test.write Invalid_argument)
    read
    ok
    Write
  |}]
;;

let%expect_test "public response separates scopes and preserves arbitrary data" =
  let render layout json =
    Api_response.project layout (Json.parse json |> Disk.unwrap)
    |> Api_response.to_json
    |> Json.canonical
    |> print_endline
  in
  render Value {|{"budget":"user value","data":"opaque"}|};
  render Value {|null|};
  render
    Planning_write
    {|{"workspace_revision":"8","durable":true,"result":{"revision":"2"}}|};
  render Registry_write {|{"opened":true}|};
  render
    (Domain_query Communication)
    {|{"revision":"7","record":{"revision":"2","id":"thread"}}|};
  render (Domain_record Runs) {|{"revision":"2","id":"run"}|};
  render Feed {|{"source":"history","workspace_revision":"9","through":"8","items":[]}|};
  List.iter
    [ {|{"result":{}}|}
    ; {|{"data":{},"meta":null}|}
    ; {|{"data":{},"meta":{"workspace_revision":1}}|}
    ; {|{"data":{},"meta":{"durable":"true"}}|}
    ]
    ~f:(fun json -> report (Api_response.of_json (Json.parse json |> Disk.unwrap)));
  [%expect
    {|
    {"data":{"budget":"user value","data":"opaque"},"meta":{}}
    {"data":null,"meta":{}}
    {"data":{"revision":"2"},"meta":{"durable":true,"workspace_revision":"8"}}
    {"data":{"opened":true},"meta":{"durable":true}}
    {"data":{"id":"thread","revision":"2"},"meta":{"query_revision":"7","query_scope":"communication"}}
    {"data":{"id":"run","revision":"2"},"meta":{"query_scope":"runs"}}
    {"data":{"items":[],"source":"history","through":"8"},"meta":{"history_sequence":"9"}}
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;

let%expect_test "response metadata rejects malformed nested captures and budgets" =
  let decode meta = Api_response.of_json (Json.obj [ "data", `Null; "meta", meta ]) in
  let parse bytes = Json.parse bytes |> Disk.unwrap in
  List.iter
    [ {|{"query_revision":"1"}|}
    ; {|{"workspace_revision":"1","history_sequence":"1"}|}
    ; {|{"budget":{}}|}
    ; {|{"history_capture":{}}|}
    ; {|{"history_capture":{"workspace_id":"w","head":null,"sequence":"1","sessions":[]}}|}
    ; {|{"history_capture":{"workspace_id":"w","head":null,"sequence":"0","sessions":[{"session_id":"s","through":"0"}]}}|}
    ; {|{"history_capture":{"workspace_id":"w","head":null,"sequence":"0","sessions":[]}}|}
    ]
    ~f:(fun bytes -> report (decode (parse bytes)));
  let budget =
    parse
      {|{"max_bytes":"4096","returned_bytes":"123","truncated":false,"omitted_fields":"0","omitted_items":"0","details":[],"details_complete":true}|}
  in
  let budget_with key value =
    match budget with
    | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key value)
    | _ -> assert false
  in
  List.iter
    [ budget
    ; budget_with "returned_bytes" (Json.int 4097)
    ; budget_with "truncated" `True
    ; budget_with "details_complete" `False
    ; budget_with "extra" `Null
    ]
    ~f:(fun value -> report (decode (Json.obj [ "budget", value ])));
  List.iter
    [ {|{"max_bytes":"4096","returned_bytes":"123","truncated":true,"omitted_fields":"0","omitted_items":"1","details":[],"details_complete":true}|}
    ; {|{"max_bytes":"4096","returned_bytes":"123","truncated":true,"omitted_fields":"0","omitted_items":"1","details":[{"path":"/data/items","kind":"items","omitted":"2"}],"details_complete":false}|}
    ; {|{"max_bytes":"4096","returned_bytes":"123","truncated":true,"omitted_fields":"0","omitted_items":"1","details":[{"path":"/data/body","kind":"text_bytes","omitted":"1"}],"details_complete":false}|}
    ; {|{"max_bytes":"4096","returned_bytes":"123","truncated":true,"omitted_fields":"0","omitted_items":"1","details":[{"path":"/data/~invalid","kind":"items","omitted":"1"}],"details_complete":true}|}
    ; {|{"max_bytes":"4096","returned_bytes":"123","truncated":true,"omitted_fields":"0","omitted_items":"1","details":[{"path":"/data/~0~1","kind":"items","omitted":"1"}],"details_complete":true}|}
    ; {|{"max_bytes":"4096","returned_bytes":"123","truncated":true,"omitted_fields":"1","omitted_items":"1","details":[],"details_complete":false}|}
    ]
    ~f:(fun bytes -> report (decode (Json.obj [ "budget", parse bytes ])));
  let description = Api_method.describe Daemon_methods.initialize in
  let schema = Json.field description "result" in
  print_endline (Json.canonical (Json.field schema "required"));
  report
    (Api_codec.decode
       (Api_response.codec Api_codec.boolean)
       (parse
          {|{"data":true,"meta":{"query_scope":"communication","query_revision":"2"}}|}));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    ok
    ["data","meta"]
    ok
  |}]
;;

let%expect_test "public query budgets measure projected bytes and rebase omission paths" =
  let result =
    Query_budget.fit
      ~measure:(Api_response.encoded_size (Domain_query Communication))
      ~max_bytes:4096
      (Json.obj
         [ "revision", Json.int 1
         ; "record", Json.obj [ "body", Json.string (String.make 8000 'x') ]
         ])
    |> Api_response.project (Domain_query Communication)
  in
  let budget = Json.field (Api_response.meta result) "budget" in
  let json = Api_response.to_json result in
  let bytes = String.length (Json.canonical json) in
  print_s
    [%sexp
      (bytes <= 4096 : bool)
    , (bytes = Json.integer (Json.field budget "returned_bytes") : bool)];
  List.iter
    (Json.list (Json.field budget "details"))
    ~f:(fun detail -> print_endline (Json.text (Json.field detail "path")));
  [%expect
    {|
    (true true)
    /data/body
  |}]
;;

let%expect_test "receipt-bearing clients require explicit publication confirmation" =
  List.iter [ "{}"; {|{"durable":false}|}; {|{"durable":true}|} ] ~f:(fun bytes ->
    let response =
      Api_response.of_json
        (Json.obj [ "data", Json.obj []; "meta", Json.parse bytes |> Disk.unwrap ])
      |> Disk.unwrap
    in
    report (Api_response.require_durable response));
  [%expect
    {|
    Outcome_unknown
    Outcome_unknown
    ok
  |}]
;;

let%expect_test
    "raw references distinguish literal IDs and aliases without touching opaque JSON"
  =
  let literal =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode:Id.Ticket.of_string
      ~encode:Id.Ticket.to_string
      ~description:"Ticket ID."
  in
  let reference = Api_codec.reference literal in
  List.iter
    [ "work"; "$work"; "$"; "$bad/id"; "$work\n"; String.make 98 'a' ]
    ~f:(fun value ->
      match Api_codec.decode reference (Json.string value) with
      | Ok (Literal id) -> print_endline ("literal:" ^ Id.Ticket.to_string id)
      | Ok (Alias name) -> print_endline ("alias:" ^ name)
      | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]);
  report (Api_codec.encode reference (Alias "bad/id"));
  let declaration =
    Api_codec.object_
      (Api_codec.Fields.both
         (Api_codec.Fields.required "ticket_id" reference)
         (Api_codec.Fields.required
            "opaque"
            (Api_codec.json ~max_bytes:1024 ~max_depth:8)))
    |> Api_codec.as_json
  in
  let json =
    Json.parse {|{"ticket_id":"$work","opaque":{"ticket_id":"$leave-me"}}|} |> Disk.unwrap
  in
  print_endline (Api_codec.decode declaration json |> Disk.unwrap |> Json.canonical);
  let alternatives =
    Json.field (Api_codec.schema reference) "anyOf"
    |> function
    | `Array values -> values
    | _ -> assert false
  in
  print_endline (Json.field (List.nth_exn alternatives 1) "pattern" |> Json.text);
  [%expect
    {|
    literal:work
    alias:work
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    {"opaque":{"ticket_id":"$leave-me"},"ticket_id":"$work"}
    ^\$[A-Za-z0-9_-]{1,96}(?![\s\S])
    |}]
;;
