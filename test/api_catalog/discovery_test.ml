open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

(* Independent expansion of local references, including literal JSON protection. *)
let expand schema =
  let definitions =
    match Json.optional schema "$defs" with
    | Some value -> value
    | None -> Json.obj []
  in
  let rec visit value =
    match value with
    | `Array values -> `Array (List.map values ~f:visit)
    | `Object [ ("$ref", `String reference) ] ->
      let name = String.chop_prefix_exn reference ~prefix:"#/$defs/" in
      visit (Json.field definitions name)
    | `Object fields ->
      Json.obj
        (List.filter_map fields ~f:(fun (key, value) ->
           if String.equal key "$defs"
           then None
           else
             Some
               ( key
               , if
                   List.mem
                     [ "const"; "enum"; "examples"; "default" ]
                     key
                     ~equal:String.equal
                   || String.is_prefix key ~prefix:"x-"
                 then value
                 else visit value )))
    | _ -> value
  in
  visit schema
;;

let%expect_test "all executable schemas expand to their exact codec declarations" =
  List.iter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
    let description = Api_method.describe method_ in
    List.iter
      [ "params", Api_codec.schema (Api_method.request_codec method_)
      ; ( "result"
        , Api_codec.schema (Api_response.codec (Api_method.response_codec method_)) )
      ]
      ~f:(fun (key, original) ->
        let compact = Json.field description key in
        if not (String.equal (Json.canonical original) (Json.canonical (expand compact)))
        then failwith (Api_method.name method_ ^ ": " ^ key ^ " changed validation")));
  print_endline "all codec contracts preserved with offline references";
  [%expect {| all codec contracts preserved with offline references |}]
;;

let%expect_test "schema factoring preserves literals and existing reference scopes" =
  let shared =
    Json.obj
      [ "type", Json.string "object"
      ; "description", Json.string (String.make 500 'x')
      ; "additionalProperties", `False
      ; "required", `Array [ Json.string "enabled" ]
      ; "properties", Json.obj [ "enabled", Json.obj [ "type", Json.string "boolean" ] ]
      ]
  in
  let literal = Json.obj [ "$ref", Json.string "literal-data" ] in
  let schema =
    Json.obj
      [ "properties", Json.obj [ "left", shared; "right", shared ]
      ; "const", literal
      ; "x-arbitrary", literal
      ; "unevaluatedProperties", `False
      ]
  in
  let compact = Api_schema.compact schema in
  print_s [%sexp (Option.is_some (Json.optional compact "$defs") : bool)];
  print_s
    [%sexp
      (String.equal (Json.canonical (expand compact)) (Json.canonical schema) : bool)];
  List.iter [ "$schema"; "$id"; "$ref"; "$anchor"; "$dynamicRef"; "$defs" ] ~f:(fun key ->
    let scoped = Json.obj [ "allOf", `Array [ schema ]; key, Json.string "existing" ] in
    if
      not
        (String.equal
           (Json.canonical scoped)
           (Json.canonical (Api_schema.compact scoped)))
    then failwith ("scope changed: " ^ key));
  let deep =
    List.fold (List.init 129 ~f:Fn.id) ~init:schema ~f:(fun schema _ ->
      Json.obj [ "allOf", `Array [ schema ] ])
  in
  print_s
    [%sexp
      (String.equal (Json.canonical deep) (Json.canonical (Api_schema.compact deep))
       : bool)];
  [%expect
    {|
    true
    true
    true
    |}]
;;

let%expect_test "brief discovery preserves every input and fits the initial ceiling" =
  List.iter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
    let name = Api_method.name method_ in
    let text = Cli_reference.help ~method_name:(Some name) () |> unwrap in
    let fields =
      Api_codec.field_names (Api_method.request_codec method_) |> Option.value_exn
    in
    List.iter fields ~f:(fun field ->
      if not (String.is_substring text ~substring:("  " ^ field ^ " ["))
      then failwith (name ^ ": missing input " ^ field));
    if String.length text > 8192 then failwith (name ^ ": brief exceeds 8 KiB"));
  print_endline "every method fits, with every declared input";
  [%expect {| every method fits, with every declared input |}]
;;

let%expect_test "every example is accepted by the actual mapped request codec" =
  List.iter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
    let name = Api_method.name method_ in
    let text = Cli_reference.help ~method_name:(Some name) () |> unwrap in
    let line =
      String.split_lines text
      |> List.find_exn ~f:(fun line -> String.is_prefix line ~prefix:"Example ")
    in
    match String.chop_prefix line ~prefix:"Example params: " with
    | None -> failwith (name ^ ": unexpected rejected skeleton")
    | Some params ->
      let params = Json.parse params |> unwrap in
      (match Api_codec.decode (Api_method.request_codec method_) params with
       | Ok _ -> ()
       | Error problem -> failwith (name ^ ": " ^ problem.message)));
  print_endline "all executable method examples satisfy stateless request validation";
  [%expect {| all executable method examples satisfy stateless request validation |}]
;;

let%expect_test
    "finish examples use positive fencing tokens and metadata describes a mutation"
  =
  let finish = Cli_reference.help ~method_name:(Some "ticket.finish") () |> unwrap in
  let example =
    String.split_lines finish
    |> List.find_exn ~f:(fun line -> String.is_prefix line ~prefix:"Example params: ")
  in
  let params =
    String.chop_prefix_exn example ~prefix:"Example params: " |> Json.parse |> unwrap
  in
  print_endline (Json.text (Json.field params "token"));
  let (Api_method.Packed.Pack metadata) =
    Api_catalog.find "ticket.metadata" |> Option.value_exn
  in
  print_s [%sexp (Api_method.mode metadata : Api_method.Mode.t)];
  print_endline (Api_method.summary metadata);
  [%expect
    {|
    1
    Mutation
    Update a ticket's priority, assignee, labels, acceptance criteria or status.
    |}]
;;

let%expect_test "brief help bounds nested shapes and makes context preconditions explicit"
  =
  let help name = Cli_reference.help ~method_name:(Some name) () |> unwrap in
  let field name field =
    String.split_lines (help name)
    |> List.find_exn ~f:(fun line -> String.is_prefix line ~prefix:("  " ^ field ^ " ["))
  in
  let recipients = field "request.ask" "recipients" in
  print_s
    [%sexp (String.is_substring recipients ~substring:"array of object {kind:" : bool)];
  print_s [%sexp (String.is_substring recipients ~substring:"const=\"actor\"" : bool)];
  print_s [%sexp (String.is_substring recipients ~substring:"const=\"run\"" : bool)];
  let scope = field "board.put" "scope" in
  print_s [%sexp (String.is_substring scope ~substring:"object {kind:" : bool)];
  let nested = field "acceptance.policy.put" "inherited_override" in
  print_s [%sexp (String.is_substring nested ~substring:"against: object;" : bool)];
  print_s [%sexp (String.is_substring nested ~substring:"reviewers: array;" : bool)];
  print_s [%sexp (not (String.is_substring nested ~substring:"contract_id") : bool)];
  let claim = help "ticket.claim_next" in
  print_s [%sexp (String.is_substring claim ~substring:"registered live run" : bool)];
  print_s [%sexp (String.is_substring claim ~substring:"fresh attempt_id" : bool)];
  print_s [%sexp (String.is_substring claim ~substring:"context without run_id" : bool)];
  print_s
    [%sexp
      (String.is_substring claim ~substring:"context does not default target_run_id"
       : bool)];
  [%expect
    {|
    true
    true
    true
    true
    true
    true
    true
    true
    true
    true
    true
    |}]
;;

let%expect_test
    "creation examples and allocation attribution satisfy workflow preconditions"
  =
  let example name =
    Cli_reference.help ~method_name:(Some name) ()
    |> unwrap
    |> String.split_lines
    |> List.find_map_exn ~f:(fun line ->
      Option.map (String.chop_prefix line ~prefix:"Example params: ") ~f:(fun text ->
        Json.parse text |> unwrap))
  in
  List.iter [ "board.put"; "thread.put" ] ~f:(fun name ->
    print_endline (name ^ ": " ^ Json.text (Json.field (example name) "expected_revision")));
  let claim = example "ticket.claim_next" in
  print_s
    [%sexp
      (String.equal
         (Json.text (Json.field claim "run_id"))
         (Json.text (Json.field claim "target_run_id"))
       : bool)];
  [%expect
    {|
    board.put: 0
    thread.put: 0
    true
    |}]
;;

let%expect_test
    "read summaries describe discovery without stale-writer ownership instructions"
  =
  List.iter
    [ "ticket.resolve"; "activity.since"; "allocation.pools"; "run.actions" ]
    ~f:(fun name ->
      let (Api_method.Packed.Pack method_) = Api_catalog.find name |> Option.value_exn in
      let summary = Api_method.summary method_ in
      print_s [%sexp (String.is_substring summary ~substring:"ownership" : bool)]);
  [%expect
    {|
    false
    false
    false
    false
    |}]
;;

let%expect_test "resume query bounds describe entries and bytes rather than records" =
  List.iter
    [ "activity.digest", "limit", "1..100; default 50"
    ; "activity.digest", "max_bytes", "4096..1048576 bytes; default 65536"
    ; "ticket.resume", "change_limit", "1..100 entries; default 10"
    ; "ticket.resume", "max_bytes", "4096..1048576 bytes; default 65536"
    ]
    ~f:(fun (method_, field, description) ->
      let line =
        Cli_reference.help ~method_name:(Some method_) ()
        |> unwrap
        |> String.split_lines
        |> List.find_exn ~f:(fun line ->
          String.is_prefix line ~prefix:("  " ^ field ^ " ["))
      in
      print_s
        [%sexp
          (( String.is_substring line ~substring:description
           , not (String.is_substring line ~substring:"cooperative coordination record")
           )
           : bool * bool)]);
  List.iter [ "0"; "1"; "100"; "101" ] ~f:(fun value ->
    print_s
      [%sexp
        (Api_codec.decode
           Resume_api.Digest_request.codec
           (Json.obj [ "limit", Json.string value ])
         |> Result.is_ok
         : bool)]);
  List.iter [ "4095"; "4096"; "1048576"; "1048577" ] ~f:(fun value ->
    print_s
      [%sexp
        (Api_codec.decode
           Resume_api.Resume_request.codec
           (Json.obj [ "ticket_id", Json.string "task"; "max_bytes", Json.string value ])
         |> Result.is_ok
         : bool)]);
  [%expect
    {|
    (true true)
    (true true)
    (true true)
    (true true)
    false
    true
    true
    false
    false
    true
    true
    false
    |}]
;;
