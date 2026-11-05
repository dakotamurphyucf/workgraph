open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error e -> failwith e.Problem.message
;;

let json text = Json.parse text |> ok

let%expect_test "excerpt byte counts reject fabrication and preserve UTF8" =
  let excerpt = Brief_view.Excerpt.of_text "ééé" ~max_bytes:5 in
  print_s
    [%sexp
      (excerpt.text : string), (excerpt.total_bytes : int), (excerpt.omitted_bytes : int)];
  List.iter
    [ {|{"text":"x","total_bytes":"0","omitted_bytes":"0"}|}
    ; {|{"text":"x","total_bytes":"3","omitted_bytes":"1"}|}
    ]
    ~f:(fun text ->
      print_s
        [%sexp
          (Result.is_error (Api_codec.decode Brief_view.Excerpt.codec (json text)) : bool)]);
  [%expect
    {|
   ("\195\169\195\169" 6 2)
   true
   true
   |}]
;;

let%expect_test "brief selectors and revision guards are exact" =
  List.iter
    [ {|{"ticket_id":"task","at_revision":"01"}|}
    ; {|{"ticket_id":"task","max_bytes":"4095"}|}
    ; {|{"ticket_id":"task","resource_id":"asset"}|}
    ; {|{"ticket_id":"task","view":"full"}|}
    ]
    ~f:(fun text ->
      print_s
        [%sexp
          (Result.is_error (Brief_api.Request.decode ~method_:"ticket.brief" (json text))
           : bool)]);
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "brief" |> ok) ~name:"Brief" |> ok
  in
  let command =
    Domain_command.decode
      ~method_:"ticket.create"
      ~params:
        (json {|{"ticket_id":"task","title":"Task","description":"full description"}|})
    |> ok
  in
  let prepared =
    State.prepare state command ~actor:(Id.Actor.of_string "agent" |> ok) ~timestamp:"now"
    |> ok
  in
  let state = State.replay state (State.events prepared) |> ok in
  let brief =
    State.query
      state
      ~method_:"ticket.brief"
      ~params:(json {|{"ticket_id":"task","at_revision":"1"}|})
    |> ok
  in
  let data = Json.field brief "data" in
  print_s [%sexp (Result.is_ok (Api_codec.decode Brief_view.ticket_codec data) : bool)];
  let set json key value =
    match json with
    | `Object fields ->
      Json.obj
        ((key, value)
         :: List.filter fields ~f:(fun (name, _) -> not (String.equal name key)))
    | _ -> assert false
  in
  let expansion = Json.field data "expand" in
  let parameters = Json.field expansion "params" in
  let mismatched =
    set
      data
      "expand"
      (set expansion "params" (set parameters "ticket_id" (Json.string "other")))
  in
  print_s
    [%sexp (Result.is_error (Api_codec.decode Brief_view.ticket_codec mismatched) : bool)];
  let focused =
    State.query state ~method_:"ticket.read" ~params:(json {|{"ticket_id":"task"}|})
    |> ok
    |> fun value -> Json.field value "data"
  in
  let codec = Api_method.response_codec Ticket_read_api.method_ in
  print_s [%sexp (Result.is_ok (Api_codec.decode codec focused) : bool)];
  let expansion = Json.field focused "expand_context" in
  let wrong_id =
    set
      focused
      "expand_context"
      (set
         expansion
         "params"
         (set (Json.field expansion "params") "ticket_id" (Json.string "other")))
  in
  print_s [%sexp (Result.is_error (Api_codec.decode codec wrong_id) : bool)];
  print_s
    [%sexp
      (Result.is_error
         (Api_codec.decode
            Ticket_read_api.Request.codec
            (json {|{"ticket_id":"task","max_bytes":"4095"}|}))
       : bool)];
  let full =
    State.query state ~method_:"ticket.context" ~params:(json {|{"ticket_id":"task"}|})
    |> ok
  in
  print_s
    [%sexp (Option.is_some (Json.optional (Json.field full "data") "attempts") : bool)];
  print_s
    [%sexp
      (Result.is_error
         (State.query
            state
            ~method_:"ticket.brief"
            ~params:(json {|{"ticket_id":"task","at_revision":"0"}|}))
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
