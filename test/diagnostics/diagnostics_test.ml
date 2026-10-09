open Core
open Workgraph

let print_problem = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_endline (Json.canonical (Problem.to_json problem))
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
