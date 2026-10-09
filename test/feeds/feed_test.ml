open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let workspace = Id.Workspace.of_string "feed-test" |> unwrap

let event revision actor =
  Json.obj
    [ "revision", Json.int revision
    ; "actor", Json.string actor
    ; "timestamp", Json.string "2026-10-07T00:00:00Z"
    ; "targets", `Array [ Entity_ref.jsonaf_of_t Workspace ]
    ; "changes", `Array [ `Array [ Json.string "Workspace_updated"; Json.obj [] ] ]
    ]
;;

let params fields =
  Json.obj (("workspace_id", Id.Workspace.jsonaf_of_t workspace) :: fields)
;;

let read activity fields =
  Change_feed.read
    ~workspace
    ~revision:(List.length activity)
    ~activity
    ~params:(params fields)
;;

let positions response =
  Json.field response "items"
  |> Json.list
  |> List.map ~f:(fun item -> Json.field item "revision" |> Json.integer)
;;

let%expect_test "snapshot paging survives appended events and then advances" =
  let history = [ event 2 "a"; event 1 "a" ] in
  let page1 = read history [ "limit", Json.int 1 ] |> unwrap in
  let history = event 3 "a" :: history in
  let page2 =
    read history [ "cursor", Json.field page1 "cursor"; "limit", Json.int 1 ] |> unwrap
  in
  let page3 = read history [ "cursor", Json.field page2 "cursor" ] |> unwrap in
  print_s
    [%sexp
      ((positions page1, positions page2, positions page3)
       : int list * int list * int list)];
  [%expect {| ((1) (2) (3)) |}]
;;

let%expect_test "filtered progress and changed filters" =
  let history = [ event 2 "b"; event 1 "a" ] in
  let first = read history [ "actor_id", Json.string "absent" ] |> unwrap in
  let next =
    read
      (event 3 "absent" :: history)
      [ "actor_id", Json.string "absent"; "cursor", Json.field first "cursor" ]
    |> unwrap
  in
  print_s [%sexp ((positions first, positions next) : int list * int list)];
  (match
     read
       history
       [ "actor_id", Json.string "different"; "cursor", Json.field first "cursor" ]
   with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect
    {|
    (() (3))
    Conflict
    |}]
;;

let%expect_test "future cursor and malformed limits reject" =
  List.iter
    [ [ "after", Json.int 4 ]; [ "limit", Json.int 0 ]; [ "cursor", Json.string "%%%" ] ]
    ~f:(fun fields ->
      match read [ event 1 "a" ] fields with
      | Ok _ -> print_endline "unexpected success"
      | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect
    {|
    Conflict
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "cursor cannot cross planning and history sources" =
  let events = [ event 1 "a" ] in
  let history = read events [ "source", Json.string "history" ] |> unwrap in
  (match read events [ "cursor", Json.field history "cursor" ] with
   | Ok _ -> print_endline "unexpected success"
   | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
  [%expect {| Conflict |}]
;;

let%expect_test "whole captured targets fit exactly or retain the cursor position" =
  let targets =
    List.init 100 ~f:(fun index ->
      Entity_ref.Resource
        (unwrap
           (Id.Resource.of_string
              ("resource-" ^ Int.to_string index ^ "-" ^ String.make 50 'x'))))
  in
  let original = event 1 "a" in
  let original =
    match original with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "targets"
             then `Array (List.map targets ~f:Entity_ref.jsonaf_of_t)
             else value )))
    | _ -> assert false
  in
  let history = [ original ] in
  let page = read history [ "max_bytes", Json.int 65536 ] |> unwrap in
  let whole = Json.field page "items" |> Json.list |> List.hd_exn in
  let public_targets = Coordination_wire.decode_exn Change_feed_api.Item.codec whole in
  print_s [%sexp (List.equal Entity_ref.equal targets public_targets.targets : bool)];
  let rec boundary guess =
    let page = read history [ "max_bytes", Json.int guess ] |> unwrap in
    let measured = Api_response.encoded_size Feed page in
    if guess = measured then guess, page else boundary measured
  in
  let exact, page = boundary (Api_response.encoded_size Feed page) in
  let smaller = read history [ "max_bytes", Json.int (exact - 1) ] |> unwrap in
  let budget = Json.field page "budget" in
  let dropped = Json.field smaller "budget" in
  print_s
    [%sexp
      (( exact > 4096
       , List.length (positions page)
       , List.length (positions smaller)
       , Json.integer (Json.field budget "returned_bytes") = exact )
       : bool * int * int * bool)];
  print_s
    [%sexp
      (( Json.integer (Json.field dropped "omitted_items")
       , Json.integer (Json.field dropped "omitted_fields")
       , Json.field smaller "needs_larger_budget" )
       : int * int * Jsonaf.t)];
  let cursor =
    Json.text (Json.field smaller "cursor") |> Base64.decode_exn |> Json.parse |> unwrap
  in
  print_s [%sexp (Json.integer (Json.field cursor "after") : int)];
  let resumed =
    read history [ "cursor", Json.field smaller "cursor"; "max_bytes", Json.int 1048576 ]
    |> unwrap
  in
  print_s [%sexp (positions resumed : int list)];
  ignore
    (Coordination_wire.decode_exn
       Change_feed_api.Response.codec
       (Api_response.data (Api_response.project Feed resumed))
     : Change_feed_api.Response.t);
  [%expect
    {|
    true
    (true 1 0 true)
    (1 0 True)
    0
    (1)
    |}]
;;

let%expect_test "shared feed fields reject aliases duplicates and contradictory pages" =
  let codec = Option.value_exn (Change_feed_api.Request.codec ~method_:"changes.wait") in
  List.iter
    [ params [ "actor_id", Json.string "$a" ]
    ; params [ "kinds", `Array [ Json.string "x"; Json.string "x" ] ]
    ; params [ "cursor", Json.string "cursor"; "after", Json.int 0 ]
    ; params [ "timeout_ms", Json.int 25001 ]
    ]
    ~f:(fun json ->
      match Api_codec.decode codec json with
      | Ok _ -> print_endline "unexpected"
      | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  let request =
    Coordination_wire.decode_exn
      codec
      (params
         [ "source", Json.string "history"
         ; "actor_id", Json.string "a"
         ; "timeout_ms", Json.int 1
         ])
  in
  let next = Change_feed_api.Request.with_cursor request ~cursor:"next" in
  let read_params = unwrap (Change_feed_api.Request.read_params next) in
  print_s
    [%sexp
      (( Change_feed_api.Request.timeout_ms next
       , Option.is_none (Json.optional read_params "timeout_ms")
       , Json.text (Json.field read_params "actor_id") )
       : int * bool * string)];
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    (1 true a)
    |}]
;;

let%expect_test "public kind filters normalize stored variant names only at the boundary" =
  let events = [ event 1 "a" ] in
  let lower =
    read events [ "kinds", `Array [ Json.string "workspace_updated" ] ] |> unwrap
  in
  let upper =
    read events [ "kinds", `Array [ Json.string "Workspace_updated" ] ] |> unwrap
  in
  let kinds =
    Json.field (Json.field lower "items" |> Json.list |> List.hd_exn) "kinds"
    |> Json.list
    |> List.map ~f:Json.text
  in
  print_s
    [%sexp
      ((positions lower, positions upper, kinds) : int list * int list * string list)];
  [%expect {| ((1) () (workspace_updated)) |}]
;;
