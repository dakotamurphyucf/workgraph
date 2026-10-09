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
