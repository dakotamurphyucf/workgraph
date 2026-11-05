open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let matches query =
  Discovery.search ~query () |> unwrap |> Fn.flip Json.field "results" |> Json.list
;;

let names rows = List.map rows ~f:(fun row -> Json.field row "name" |> Json.text)

let%expect_test "curated inventory covers executable methods and all references" =
  (match Discovery.validate () with
   | Ok () -> print_endline "complete and linked"
   | Error errors -> List.iter errors ~f:print_endline);
  [%expect {| complete and linked |}]
;;

let%expect_test "exact operation names reliably select their own contract" =
  List.iter Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
    let name = Api_method.name method_ in
    let first = matches name |> List.hd_exn |> Fn.flip Json.field "name" |> Json.text in
    if not (String.equal name first) then failwith (name ^ " did not rank first"));
  print_endline "every exact method ranks first";
  [%expect {| every exact method ranks first |}]
;;

let%expect_test "search validates limits and distinguishes no match from bad input" =
  List.iter
    [ ""; "the and"; String.make 1025 'x'; "\255" ]
    ~f:(fun query ->
      match Discovery.search ~query () with
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
      | Ok _ -> failwith "invalid query accepted");
  List.iter [ 0; 21 ] ~f:(fun limit ->
    match Discovery.search ~limit ~query:"ticket" () with
    | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
    | Ok _ -> failwith "invalid limit accepted");
  let empty = matches "zzquuximpossibleoperation" in
  print_s [%sexp (names empty : string list)];
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ()
  |}]
;;

let%expect_test "filters and result bounds do not silently lose continuation information" =
  let first = Discovery.search ~query:"ticket" ~limit:1 () |> unwrap in
  let repeated = Discovery.search ~query:"ticket" ~limit:1 () |> unwrap in
  assert (String.equal (Json.canonical first) (Json.canonical repeated));
  assert (List.length (Json.field first "results" |> Json.list) = 1);
  assert (Json.integer (Json.field first "matched_count") > 1);
  assert (String.equal (Json.canonical (Json.field first "has_more")) "true");
  let filtered =
    Discovery.search ~query:"ticket" ~capability:"planning" ~kind:Method ~limit:20 ()
    |> unwrap
  in
  List.iter
    (Json.field filtered "results" |> Json.list)
    ~f:(fun row ->
      assert (String.equal (Json.text (Json.field row "capability")) "planning");
      assert (String.equal (Json.text (Json.field row "kind")) "method");
      assert (Option.is_none (Json.optional row "params")));
  (match Discovery.search ~query:"ticket" ~capability:"invented" () with
   | Error { kind = Invalid_argument; _ } -> ()
   | _ -> failwith "unknown capability accepted");
  print_endline "stable bounded metadata, explicit counts, strict filters";
  [%expect {| stable bounded metadata, explicit counts, strict filters |}]
;;
