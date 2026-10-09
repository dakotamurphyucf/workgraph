open Core
open Workgraph

let report codec json =
  match Api_codec.decode codec json with
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
;;

let replace json name value =
  match json with
  | `Object fields ->
    Json.obj ((name, value) :: List.Assoc.remove fields name ~equal:String.equal)
  | _ -> failwith "record required"
;;

let fixture =
  Jsonaf.of_string
    {|{"revision":"3","actor_id":"owner","run_id":null,"timestamp":"now","targets":[{"kind":"ticket","ticket_id":"task"}],"changes":[{"kind":"facts_changed","fact":{"scope":{"kind":"ticket","id":"task"},"key":"nullable","revision":"1","deleted":false,"value":null,"actor_id":"owner","timestamp":"now","changed_at_revision":"3"}}]}|}
;;

let%expect_test
    "full retained fact source validates exact value, source attribution and named \
     alternatives"
  =
  report Planning_activity_wire.Activity.codec fixture;
  report
    Planning_activity_wire.Activity.codec
    (replace fixture "actor_id" (Json.string "other"));
  report Planning_activity_wire.Activity.codec (replace fixture "revision" (Json.int 4));
  report
    Planning_activity_wire.Activity.codec
    (replace
       fixture
       "changes"
       (`Array [ `Array [ Json.string "Facts_changed"; Json.obj [] ] ]));
  let changes = Json.list (Json.field fixture "changes") in
  let change = List.hd_exn changes in
  let fact = Json.field change "fact" in
  let changed fact = replace fixture "changes" (`Array [ replace change "fact" fact ]) in
  report Planning_activity_wire.Activity.codec (changed (replace fact "deleted" `True));
  report
    Planning_activity_wire.Activity.codec
    (changed
       (replace
          fact
          "scope"
          (Json.obj [ "kind", Json.string "resource"; "id", Json.string "resource" ])));
  [%expect
    {| ok
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument |}]
;;

let%expect_test
    "search source identities and exact match coordinates reject old generic fields"
  =
  let codec = Planning_context_wire.Search.Version.codec in
  report codec (Jsonaf.of_string {|{"kind":"ticket","ticket_id":"task","revision":"2"}|});
  report codec (Jsonaf.of_string {|{"kind":"ticket","id":"task","revision":"2"}|});
  report
    codec
    (Jsonaf.of_string
       {|{"kind":"fact","scope":{"kind":"resource","id":"resource"},"key":"k","revision":"1"}|});
  report
    Planning_context_wire.Search.Match.codec
    (Jsonaf.of_string
       {|{"field":"title","match_offset":"4","match_bytes":"2","snippet_offset":"0","snippet":"abcdef"}|});
  report
    Planning_context_wire.Search.Match.codec
    (Jsonaf.of_string
       {|{"field":"title","match_offset":"5","match_bytes":"2","snippet_offset":"0","snippet":"abcdef"}|});
  report
    Planning_context_wire.Search.Match.codec
    (Jsonaf.of_string
       {|{"field":"title","match_offset":"1","match_bytes":"1","snippet_offset":"0","snippet":"é"}|});
  [%expect
    {| ok
 Invalid_argument
 Invalid_argument
 ok
 Invalid_argument
 Invalid_argument |}]
;;

let%expect_test
    "activity selectors reject ignored archive options and contradictory target selectors"
  =
  List.iter
    [ {|{"include_archived":true}|}
    ; {|{"target":{"kind":"ticket","ticket_id":"task"},"project_id":"project"}|}
    ; {|{"actor_id":null}|}
    ; {|{"after":"03"}|}
    ]
    ~f:(fun json ->
      match
        Planning_context_api.Query.decode
          ~method_:"activity.since"
          ~params:(Jsonaf.of_string json)
      with
      | Ok _ -> print_endline "ok"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {| Invalid_argument
 Invalid_argument
 Invalid_argument
 Invalid_argument |}]
;;

let audit change = replace fixture "changes" (`Array [ change ])
let modify_field json name f = replace json name (f (Json.field json name))
let string = Json.string

let%expect_test
    "historical discussion, handoff and publication validate retained attribution"
  =
  let discussion =
    Jsonaf.of_string
      {|{"kind":"comment_changed","change":{"kind":"create","comment_id":"note","target":{"kind":"ticket","ticket_id":"task"},"reply_to_comment_id":null,"comment_kind":"comment","origin":"authored","version":{"revision":"1","serial":"1","sequence":"3","actor_id":"owner","timestamp":"now","body":"Exact original","tombstone":false}}}|}
  in
  let handoff =
    Jsonaf.of_string
      {|{"kind":"handoff_put","handoff":{"ticket_id":"task","actor_id":"owner","summary":"Exact","next_steps":"Next","evidence":"Proof","revision":"1","objective":"","completed":"","decisions":"","blockers":"","resource_ids":[],"timestamp":"now","covers_through":"0"}}|}
  in
  let resource =
    Jsonaf.of_string
      {|{"kind":"resource_changed","change":{"kind":"published","resource_id":"resource","revision":"1","metadata":{"title":"Resource","filename":"r.txt","mime_type":"text/plain","description":"","archived":false,"targets":[]},"version":{"revision":"1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":"3","actor_id":"owner","timestamp":"now","filename":"r.txt","mime_type":"text/plain"}}}|}
  in
  let validate value = report Planning_activity_wire.Activity.codec (audit value) in
  List.iter [ discussion; handoff; resource ] ~f:validate;
  let version change name value =
    modify_field change "change" (fun change ->
      modify_field change "version" (fun version -> replace version name value))
  in
  validate (version discussion "actor_id" (string "other"));
  validate (version discussion "timestamp" (string "earlier"));
  validate (version discussion "sequence" (Json.int 2));
  validate
    (modify_field handoff "handoff" (fun value ->
       replace value "actor_id" (string "other")));
  validate
    (modify_field handoff "handoff" (fun value ->
       replace value "timestamp" (string "earlier")));
  validate (version resource "actor_id" (string "other"));
  validate (version resource "timestamp" (string "earlier"));
  validate (version resource "size_bytes" `Null);
  [%expect
    {|
    ok
    ok
    ok
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

let%expect_test
    "signal receipts retain original clocks but require identical accepted content and \
     actor"
  =
  let receipt =
    Jsonaf.of_string
      {|{"kind":"signal_receipt","receipt":{"command":{"signal_id":"signal","condition_id":"condition","expected_revision":"1","operation_id":"operation","artifact":{"kind":"checksum","source":"deploy","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"evidence":[{"kind":"checksum","source":"result","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"summary":"Done"},"original":{"signal_id":"signal","condition_id":"condition","condition_revision":"1","operation_id":"operation","artifact":{"kind":"checksum","source":"deploy","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"evidence":[{"kind":"checksum","source":"result","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"summary":"Done","actor_id":"owner","run_id":null,"timestamp":"earlier","sequence":"2"}}}|}
  in
  let change part name value =
    modify_field receipt "receipt" (fun receipt ->
      modify_field receipt part (fun part -> replace part name value))
  in
  let validate value = report Planning_activity_wire.Activity.codec (audit value) in
  validate receipt;
  validate (change "original" "sequence" (Json.int 3));
  List.iter
    [ "signal_id", string "other"
    ; "condition_id", string "other"
    ; "expected_revision", Json.int 2
    ; "operation_id", string "other"
    ; "summary", string "Different"
    ; "evidence", `Array []
    ]
    ~f:(fun (name, value) -> validate (change "command" name value));
  let receipt_fields = Json.field receipt "receipt" in
  let command = Json.field receipt_fields "command" in
  validate
    (change
       "command"
       "artifact"
       (replace (Json.field command "artifact") "source" (string "other")));
  let evidence = List.hd_exn (Json.list (Json.field command "evidence")) in
  validate
    (change "command" "evidence" (`Array [ replace evidence "source" (string "other") ]));
  validate (change "original" "actor_id" (string "other"));
  validate (change "original" "run_id" (string "run"));
  validate (change "original" "sequence" (Json.int 4));
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
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "audit summaries preserve positive change counts and distinct targets" =
  let summary = replace fixture "changes" (Json.int 1) in
  report Planning_activity_wire.Summary.codec summary;
  report Planning_activity_wire.Summary.codec (replace summary "changes" (Json.int 0));
  report
    Planning_activity_wire.Summary.codec
    (replace
       summary
       "targets"
       (`Array
           (Json.list (Json.field fixture "targets")
            @ Json.list (Json.field fixture "targets"))));
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    |}]
;;
