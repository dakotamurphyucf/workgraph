open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error e -> failwith e.Problem.message
;;

let json value = Json.parse value |> ok

let status = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
;;

let%expect_test "strict participant request bounds and capture" =
  List.iter
    [ "{}"
    ; {|{"offset":"1","at_revision":"3"}|}
    ; {|{"offset":"1"}|}
    ; {|{"limit":"0"}|}
    ; {|{"limit":"101"}|}
    ; {|{"limit":"100","max_bytes":"4096"}|}
    ; {|{"max_bytes":"4095"}|}
    ; {|{"max_bytes":"1048577"}|}
    ; {|{"at_revision":null}|}
    ; {|{"include_archived":true}|}
    ]
    ~f:(fun input ->
      Api_codec.decode Participant_api.Request.codec (json input) |> status);
  Api_codec.decode
    Participant_api.Request.codec
    (`Object [ "limit", `String "1"; "limit", `String "2" ])
  |> status;
  [%expect
    {|
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "participant codec rejects fabricated provenance" =
  let test fields =
    Api_codec.decode
      Participant_api.Participant.codec
      (json ("{\"actor_id\":\"a\",\"registration\":null," ^ fields ^ "}"))
    |> status
  in
  test
    {|"observed":{"first_revision":"1","last_revision":"3"},"sources":["activity","fact"]|};
  test {|"observed":null,"sources":["fact"]|};
  test {|"observed":null,"sources":["catalog"]|};
  test {|"observed":{"first_revision":"1","last_revision":"3"},"sources":[]|};
  test {|"observed":{"first_revision":"3","last_revision":"1"},"sources":["activity"]|};
  test {|"observed":{"first_revision":"0","last_revision":"1"},"sources":["activity"]|};
  test
    {|"observed":{"first_revision":"1","last_revision":"3"},"sources":["activity","activity"]|};
  test
    {|"observed":{"first_revision":"1","last_revision":"3"},"sources":["fact","activity"]|};
  let value : Participant_api.Participant.t =
    { actor_id = Id.Actor.of_string "a" |> ok
    ; registration = None
    ; observed = None
    ; sources = [ Fact ]
    }
  in
  Api_codec.encode Participant_api.Participant.codec value |> status;
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "page identity and catalog consistency apply to encoding too" =
  let actor = Id.Actor.of_string "a" |> ok in
  let other = Id.Actor.of_string "b" |> ok in
  let registration : Planning_wire.Actor.t =
    { actor_id = actor; name = "A"; kind = Agent; revision = 1; archived = false }
  in
  let row : Participant_api.Participant.t =
    { actor_id = actor
    ; registration = Some registration
    ; observed = None
    ; sources = [ Catalog ]
    }
  in
  let codec = Participant_api.Participant.codec in
  Api_codec.encode codec row |> status;
  Api_codec.encode codec { row with actor_id = other } |> status;
  Api_codec.encode codec { row with sources = [ Activity ] } |> status;
  let page : Participant_api.Participant.t Planning_wire.Page.t =
    { items = [ row; row ]; offset = 0; remaining = 0; next_offset = None }
  in
  Api_codec.encode Participant_api.response_codec page |> status;
  Api_codec.decode
    Participant_api.response_codec
    (json {|{"items":[],"offset":"0","remaining":"2","next_offset":null}|})
  |> status;
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;
