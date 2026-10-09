open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let parse bytes = Json.parse bytes |> unwrap

let report = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
;;

let%expect_test "heartbeat contracts separate advisory writes from durable mutations" =
  let request = Api_method.request_codec Heartbeat_api.observe in
  List.iter
    [ {|{"workspace_id":"w","actor_id":"a","target_run_id":"r"}|}
    ; {|{"workspace_id":"w","actor_id":"a","run_id":"r"}|}
    ; {|{"workspace_id":"w","actor_id":"a","target_run_id":"r","mutation_id":"m"}|}
    ]
    ~f:(fun bytes -> report (Api_codec.decode request (parse bytes)));
  let response = Api_method.response_codec Heartbeat_api.observe in
  List.iter
    [ {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":null,"durable":false,"advisory":true}|}
    ; {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":{"actor_id":"a","observed_unix_ms":"1"},"durable":false,"advisory":true}|}
    ; {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":{"actor_id":"a","observed_unix_ms":"2"},"durable":true,"advisory":true}|}
    ; {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":null,"durable":true,"advisory":true}|}
    ; {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":{"actor_id":"b","observed_unix_ms":"1"},"durable":false,"advisory":true}|}
    ; {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":{"actor_id":"a","observed_unix_ms":"3"},"durable":false,"advisory":true}|}
    ; {|{"target_run_id":"r","observation":{"actor_id":"a","observed_unix_ms":"2"},"persisted":null,"durable":false,"advisory":false}|}
    ]
    ~f:(fun bytes -> report (Api_codec.decode response (parse bytes)));
  print_s [%sexp (Api_method.mode Heartbeat_api.observe : Api_method.Mode.t)];
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    ok
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Write
    |}]
;;

let%expect_test "invalid composition declarations fail before processing requests" =
  let open Api_codec in
  let object_a = object_ (Fields.required "a" boolean) in
  let rejects f =
    match f () with
    | () -> print_endline "unexpected success"
    | exception Invalid_argument _ -> print_endline "invalid declaration"
  in
  rejects (fun () -> ignore (merge_objects object_a object_a : _ t));
  rejects (fun () -> ignore (merge_objects object_a boolean : _ t));
  rejects (fun () -> ignore (merge_objects object_a (nullable object_a) : _ t));
  rejects (fun () ->
    ignore
      (merge_objects object_a (dictionary boolean ~max_items:2 ~max_key_bytes:10) : _ t));
  rejects (fun () -> ignore (literal "\255" : unit t));
  let method_name = literal "ticket.start" in
  report (decode method_name (Json.string "ticket.start"));
  report (decode method_name (Json.string "ticket_start"));
  print_endline (Json.canonical (schema method_name));
  [%expect
    {|
    invalid declaration
    invalid declaration
    invalid declaration
    invalid declaration
    invalid declaration
    ok
    Invalid_argument
    {"const":"ticket.start","type":"string"}
    |}]
;;

let%expect_test "flat composition keeps mapped and nested object invariants" =
  let open Api_codec in
  let header = object_ (Fields.required "workspace_id" (text ~max_bytes:96)) in
  let payload =
    object_
      (Fields.both
         (Fields.required "revision" (decimal ~max:10))
         (Fields.optional
            "patch"
            (object_ (Fields.optional "note" (nullable (text ~max_bytes:20))))))
    |> map
         ~decode:(fun ((revision, _) as value) ->
           if revision > 0
           then Ok value
           else Error (Problem.create Invalid_argument "revision must be positive"))
         ~encode:Fn.id
         ~description:"A positive revision."
  in
  let codec = merge_objects header payload in
  List.iter
    [ {|{"workspace_id":"w","revision":"1"}|}
    ; {|{"workspace_id":"w","revision":"1","patch":{"note":null}}|}
    ; {|{"workspace_id":"w","revision":"0"}|}
    ; {|{"workspace_id":"w","revision":"1","patch":{"extra":true}}|}
    ; {|{"workspace_id":"w","revision":"1","extra":true}|}
    ; {|{"revision":"1"}|}
    ]
    ~f:(fun bytes -> report (decode codec (parse bytes)));
  report
    (decode
       codec
       (`Object
           [ "workspace_id", `String "w"
           ; "revision", `String "1"
           ; "revision", `String "2"
           ]));
  report (encode codec ("w", (0, None)));
  print_s [%sexp (field_names codec : string list option)];
  [%expect
    {|
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ((patch revision workspace_id))
    |}]
;;

let%expect_test "tagged composition closes each alternative and preserves nested schemas" =
  let open Api_codec in
  let branch kind name =
    object_
      (Fields.both
         (Fields.required "kind" (enum [ kind, () ] ~equal:Unit.equal))
         (Fields.required name (object_ (Fields.required "value" boolean))))
    |> as_json
  in
  let body =
    tagged
      ~discriminator:"kind"
      ~cases:[ "a", branch "a" "left"; "b", branch "b" "right" ]
      ~select:(fun json -> Json.text (Json.field json "kind"))
  in
  let header = object_ (Fields.required "workspace_id" (text ~max_bytes:96)) in
  let codec = merge_objects header body in
  List.iter
    [ {|{"workspace_id":"w","kind":"a","left":{"value":true}}|}
    ; {|{"workspace_id":"w","kind":"b","right":{"value":false}}|}
    ; {|{"workspace_id":"w","kind":"a","left":{"value":true},"right":{"value":true}}|}
    ; {|{"workspace_id":"w","kind":"a","left":{"value":true,"extra":false}}|}
    ; {|{"workspace_id":"w","kind":"unknown","left":{"value":true}}|}
    ]
    ~f:(fun bytes -> report (decode codec (parse bytes)));
  let schema = schema codec in
  let cases =
    Json.field schema "allOf"
    |> Json.list
    |> List.last_exn
    |> fun schema -> Json.field schema "oneOf" |> Json.list
  in
  let first = List.hd_exn cases in
  print_s [%sexp (Option.is_none (Json.optional first "additionalProperties") : bool)];
  print_endline
    (Json.canonical
       (Json.field
          (Json.field (Json.field first "properties") "left")
          "additionalProperties"));
  print_endline (Json.canonical (Json.field schema "unevaluatedProperties"));
  [%expect
    {|
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    true
    false
    false
    |}]
;;

let%expect_test
    "JSON adapters preserve omission and ordering without bypassing validation"
  =
  let codec =
    Api_codec.object_
      (Api_codec.Fields.both
         (Api_codec.Fields.required "title" (Api_codec.text ~max_bytes:20))
         (Api_codec.Fields.optional "note" (Api_codec.nullable Api_codec.boolean)))
    |> Api_codec.as_json
  in
  List.iter [ {|{"title":"t"}|}; {|{"note":null,"title":"t"}|} ] ~f:(fun bytes ->
    let json = parse bytes in
    let encoded =
      Api_codec.decode codec json |> unwrap |> Api_codec.encode codec |> unwrap
    in
    print_s
      [%sexp (String.equal (Jsonaf.to_string json) (Jsonaf.to_string encoded) : bool)]);
  report (Api_codec.encode codec (parse {|{"title":"t","note":1}|}));
  [%expect
    {|
    true
    true
    Invalid_argument
    |}]
;;

let%expect_test "catalog combines real headers with domain contracts" =
  let check method_ bytes =
    match Api_catalog.validate_request ~method_ ~params:(parse bytes) with
    | None -> print_endline "uncovered"
    | Some result -> report result
  in
  check "initialize" "{}";
  check "initialize" {|{"workspace_id":"w"}|};
  check "fact.get" {|{"workspace_id":"w","scope":{"kind":"workspace"},"key":"answer"}|};
  check "fact.get" {|{"scope":{"kind":"workspace"},"key":"answer"}|};
  check
    "fact.get"
    {|{"workspace_id":"w","scope":{"kind":"workspace"},"key":"answer","actor_id":"a"}|};
  check "run.get" {|{"workspace_id":"w","target_run_id":"r"}|};
  check "run.get" {|{"workspace_id":"w","target_run_id":"r","run_id":"r"}|};
  check "no.such.method" "{}";
  let names = Option.value_exn (Api_catalog.request_fields "ticket.create") in
  List.iter
    [ "workspace_id"; "actor_id"; "mutation_id"; "run_id"; "title" ]
    ~f:(fun name -> print_s [%sexp (List.mem names name ~equal:String.equal : bool)]);
  let names = Option.value_exn (Api_catalog.request_fields "run.list") in
  print_s [%sexp (List.mem names "at_revision" ~equal:String.equal : bool)];
  [%expect
    {|
    ok
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    uncovered
    true
    true
    true
    true
    true
    false
    |}]
;;
