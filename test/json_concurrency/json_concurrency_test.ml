open Core
open Workgraph

let%expect_test "concurrent parsers preserve exact keys, values and numeric validation" =
  let ready = Atomic.make 0 in
  let worker index =
    let name = "domain_" ^ Int.to_string index in
    let expected =
      Json.obj
        [ name, Json.string (String.make 2048 (Char.of_int_exn (65 + index)))
        ; "escaped", Json.string "\"\\\nλ"
        ; "number", `Number "123.5"
        ]
    in
    let bytes = Json.canonical expected in
    Atomic.incr ready;
    while Atomic.get ready < 4 do
      Domain.cpu_relax ()
    done;
    let failures = ref 0 in
    for _ = 1 to 1000 do
      (match Json.parse bytes with
       | Ok actual when String.equal (Json.canonical actual) bytes -> ()
       | Ok _ | Error _ -> incr failures);
      match Json.parse "{\"bad\":\"unterminated" with
      | Error _ -> ()
      | Ok _ -> incr failures
    done;
    !failures
  in
  let domains = List.init 4 ~f:(fun index -> Domain.spawn (fun () -> worker index)) in
  let failures = List.map domains ~f:Domain.join |> List.sum (module Int) ~f:Fn.id in
  print_s [%sexp (failures : int)];
  [%expect {| 0 |}]
;;
