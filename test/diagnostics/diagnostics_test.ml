open Core
open Workgraph

let print_problem = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_endline (Json.canonical (Problem.to_json problem))
;;

let%expect_test "byte limits retain exact counts and nested JSON pointer paths" =
  let open Api_codec in
  let text =
    text ~max_bytes:3
    |> with_error_context ~context:"use resource.upload for larger bodies"
  in
  let codec =
    object_
      (Fields.required
         "ops/a"
         (list (object_ (Fields.required "text" text)) ~max_items:2))
  in
  print_problem
    (decode codec (`Object [ "ops/a", `Array [ `Object [ "text", `String "éé" ] ] ]));
  let codec = object_ (Fields.required "value" (json ~max_bytes:4 ~max_depth:4)) in
  print_problem (decode codec (`Object [ "value", `String "abc" ]));
  [%expect
    {|
    {"details":{"actual":"4","maximum":"3","path":["ops/a","0","text"],"type":"size","unit":"utf8_bytes"},"kind":"Invalid_argument","message":"/ops~1a/0/text: text is 4 UTF-8 bytes; maximum is 3; use resource.upload for larger bodies"}
    {"details":{"actual":"5","maximum":"4","path":["value"],"type":"size","unit":"canonical_json_bytes"},"kind":"Invalid_argument","message":"/value: JSON is 5 canonical bytes; maximum is 4"}
    |}]
;;

let%expect_test "blocker totals survive both producer and escaped transport bounds" =
  let blockers = List.init 125 ~f:(fun i -> sprintf "prerequisite:%03d" i) in
  let detail = Problem.readiness_details ~ticket_id:"blocked" ~blockers in
  (match detail with
   | Readiness { blockers; omitted_blockers; _ } ->
     printf "producer listed=%d omitted=%d\n" (List.length blockers) omitted_blockers
   | _ -> assert false);
  let problem = Problem.with_details (Problem.create Blocked "not ready") detail in
  let encoded =
    Protocol.error_response_json ~id:(`String "r") ~code:Application_failure problem
  in
  let restored =
    Json.field (Json.field encoded "error") "data" |> Problem_wire.of_json |> Disk.unwrap
  in
  (match restored.details with
   | Some (Readiness { blockers; omitted_blockers; _ }) ->
     printf
       "wire listed=%d omitted=%d first=%s total=%d\n"
       (List.length blockers)
       omitted_blockers
       (List.hd_exn blockers)
       (List.length blockers + omitted_blockers)
   | _ -> assert false);
  assert (String.length (Json.canonical encoded) <= 65536);
  [%expect
    {|
    producer listed=100 omitted=25
    wire listed=16 omitted=109 first=prerequisite:000 total=125
  |}]
;;

let%expect_test "claim and conflict details are strict and disclose no fencing token" =
  let open Problem.Details in
  List.iter
    [ Claim { ticket_id = "t"; ownership = Unclaimed }
    ; Claim
        { ticket_id = "t"
        ; ownership = Mismatch { field = Run; actor_id = "owner"; run_id = Some "run" }
        }
    ; Entity_revision { entity = Request; entity_id = "q"; expected = 2; actual = 3 }
    ; Identity_collision { entity = Message; entity_id = "m" }
    ]
    ~f:(fun detail ->
      let encoded = to_json detail in
      let decoded = Api_codec.decode Problem_wire.details encoded |> Disk.unwrap in
      assert (equal detail decoded);
      print_endline (Json.canonical encoded));
  List.iter
    [ {|{"type":"claim","ticket_id":"t","status":"unclaimed","actor_id":"a"}|}
    ; {|{"type":"claim","ticket_id":"t","status":"mismatch","field":"run","actor_id":"a","run_id":"r","token":"3"}|}
    ; {|{"type":"claim","ticket_id":"t","status":"mismatch","field":"epoch","actor_id":"a","run_id":null}|}
    ; {|{"type":"identity_collision","entity":"future","entity_id":"m"}|}
    ; {|{"type":"entity_revision","entity":"request","entity_id":"q","expected":"2","actual":"2"}|}
    ; {|{"type":"size","path":[],"actual":"4","maximum":"4","unit":"utf8_bytes"}|}
    ; {|{"type":"readiness","ticket_id":"t","blockers":["one"],"omitted_blockers":"4611686018427387903"}|}
    ; {|{"type":"readiness","ticket_id":"t","blockers":[],"omitted_blockers":"0"}|}
    ]
    ~f:(fun bytes ->
      match Api_codec.decode Problem_wire.details (Json.parse bytes |> Disk.unwrap) with
      | Ok _ -> failwith "malformed diagnostic admitted"
      | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  [%expect
    {|
    {"status":"unclaimed","ticket_id":"t","type":"claim"}
    {"actor_id":"owner","field":"run","run_id":"run","status":"mismatch","ticket_id":"t","type":"claim"}
    {"actual":"3","entity":"request","entity_id":"q","expected":"2","type":"entity_revision"}
    {"entity":"message","entity_id":"m","type":"identity_collision"}
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

let%expect_test "nested paths, bounds, enum choices and conservative suggestions" =
  let open Api_codec in
  let item = object_ (Fields.required "revision" (decimal ~max:9)) in
  let codec = object_ (Fields.required "operations" (list item ~max_items:2)) in
  List.iter
    [ {|{"operations":[{"revision":"10"}]}|}
    ; {|{"operations":[{}]}|}
    ; {|{"operation":[]}|}
    ; {|{"operations":[{"revision":2}]}|}
    ]
    ~f:(fun s -> print_problem (decode codec (Json.parse s |> Disk.unwrap)));
  print_problem (decode (enum [ "todo", 0; "done", 1 ] ~equal:Int.equal) (`String "bad"));
  [%expect
    {|
    {"details":{"expected":"expected canonical decimal string in 0..9","path":["operations","0","revision"],"suggestion":null,"type":"field"},"kind":"Invalid_argument","message":"/operations/0/revision: expected canonical decimal string in 0..9"}
    {"details":{"expected":"missing field: revision","path":["operations","0","revision"],"suggestion":null,"type":"field"},"kind":"Invalid_argument","message":"/operations/0/revision: missing field: revision"}
    {"details":{"expected":"unknown field; did you mean operations?","path":["operation"],"suggestion":"operations","type":"field"},"kind":"Invalid_argument","message":"/operation: unknown field; did you mean operations?"}
    {"details":{"expected":"expected canonical decimal string in 0..9","path":["operations","0","revision"],"suggestion":null,"type":"field"},"kind":"Invalid_argument","message":"/operations/0/revision: expected canonical decimal string in 0..9"}
    {"kind":"Invalid_argument","message":"expected one of: todo, done"}
    |}]
;;

let%expect_test "CLI scalar selection preserves strings and explicit JSON semantics" =
  let open Api_codec in
  let codec =
    object_
      (Fields.both
         (Fields.required "leaf_only" boolean)
         (Fields.required "text" (text ~max_bytes:20)))
  in
  let print field value =
    match cli_value codec ~field value with
    | Ok json -> print_endline (Json.canonical json)
    | Error problem -> print_endline problem.message
  in
  print "leaf_only" "true";
  print "leaf_only" "false";
  print "leaf_only" "yes";
  print "text" "true";
  print_problem
    (decode codec (`Object [ "leaf_only", `String "true"; "text", `String "true" ]));
  let nullable = object_ (Fields.required "flag" (nullable boolean)) in
  print_problem (cli_value nullable ~field:"flag" "true");
  [%expect
    {|
    true
    false
    /leaf_only: expected true or false
    "true"
    {"details":{"expected":"expected boolean","path":["leaf_only"],"suggestion":null,"type":"field"},"kind":"Invalid_argument","message":"/leaf_only: expected boolean"}
    {"details":{"expected":"ambiguous field type; use --json-field with explicit JSON","path":["flag"],"suggestion":null,"type":"field"},"kind":"Invalid_argument","message":"/flag: ambiguous field type; use --json-field with explicit JSON"}
    |}]
;;

let%expect_test
    "diagnostic details survive public error transport and reject malformed records"
  =
  let request =
    Protocol.Request.create ~id:"read" ~method_:"initialize" ~params:(`Object [])
    |> Disk.unwrap
  in
  let problem =
    Problem.with_details
      (Problem.create Conflict "revision changed")
      (Revision { expected = 1; actual = 2 })
  in
  let response = Protocol.response_json request (Failure problem) in
  (match Protocol.decode_response request response |> Disk.unwrap with
   | Failure restored -> print_endline (Json.canonical (Problem.to_json restored))
   | Success _ -> assert false);
  List.iter
    [ {|{"type":"revision","expected":"-1","actual":"2"}|}
    ; {|{"type":"ownership","actor_id":"owner","run_id":null,"token":"99"}|}
    ; {|{"type":"field","path":[0],"expected":"boolean","suggestion":null}|}
    ]
    ~f:(fun s ->
      match Api_codec.decode Problem_wire.details (Json.parse s |> Disk.unwrap) with
      | Ok _ -> print_endline "unexpected success"
      | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  [%expect
    {|
    {"details":{"actual":"2","expected":"1","type":"revision"},"kind":"Conflict","message":"revision changed"}
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "CLI structured fields explain explicit JSON without guessing text" =
  let open Api_codec in
  let structured =
    object_ (Fields.required "items" (nullable (list (text ~max_bytes:10) ~max_items:4)))
  in
  print_problem (cli_value structured ~field:"items" "[]");
  let nested =
    object_
      (Fields.required "scope" (object_ (Fields.required "id" (text ~max_bytes:10))))
  in
  print_problem (cli_value nested ~field:"scope" "{}");
  let text_field = object_ (Fields.required "value" (nullable (text ~max_bytes:10))) in
  let arbitrary = object_ (Fields.required "value" (json ~max_bytes:100 ~max_depth:4)) in
  List.iter [ "null"; "[]" ] ~f:(fun value ->
    cli_value text_field ~field:"value" value
    |> Disk.unwrap
    |> Json.canonical
    |> print_endline);
  print_problem (decode arbitrary (`Object [ "value", `Null ]));
  [%expect
    {|
    {"details":{"expected":"structured field requires explicit JSON; use --json-field items JSON (or --params-file ABS_FILE)","path":["items"],"suggestion":"--json-field items JSON (or --params-file ABS_FILE)","type":"field"},"kind":"Invalid_argument","message":"/items: structured field requires explicit JSON; use --json-field items JSON (or --params-file ABS_FILE)"}
    {"details":{"expected":"structured field requires explicit JSON; use --json-field scope JSON (or --params-file ABS_FILE)","path":["scope"],"suggestion":"--json-field scope JSON (or --params-file ABS_FILE)","type":"field"},"kind":"Invalid_argument","message":"/scope: structured field requires explicit JSON; use --json-field scope JSON (or --params-file ABS_FILE)"}
    "null"
    "[]"
    ok
    |}]
;;

let%expect_test "diagnostic context keeps field paths, bounds and unexpected exceptions" =
  let bounded =
    Api_codec.decimal ~max:25000
    |> Api_codec.with_error_context ~context:"25-second server cap"
  in
  let codec = Api_codec.object_ (Api_codec.Fields.required "timeout_ms" bounded) in
  print_problem
    (Api_codec.decode codec (Json.parse {|{"timeout_ms":"300000"}|} |> Disk.unwrap));
  let exceptional =
    Api_codec.map
      Api_codec.boolean
      ~decode:(fun _ -> raise Exit)
      ~encode:Fn.id
      ~description:"exception fixture"
    |> Api_codec.with_error_context ~context:"does not swallow bugs"
  in
  print_s
    [%sexp
      ((try
          ignore (Api_codec.decode exceptional `True);
          false
        with
        | Exit -> true)
       : bool)];
  [%expect
    {|
    {"details":{"expected":"expected canonical decimal string in 0..25000; 25-second server cap","path":["timeout_ms"],"suggestion":null,"type":"field"},"kind":"Invalid_argument","message":"/timeout_ms: expected canonical decimal string in 0..25000; 25-second server cap"}
    true
    |}]
;;
