open Core
open Workgraph

let unwrap = Disk.unwrap
let actor = Id.Actor.of_string "alice" |> unwrap
let request_id = Communication_id.Request.of_string "question" |> unwrap

let fixture () =
  let initial =
    State.empty ~workspace:(Id.Workspace.of_string "w" |> unwrap) ~name:"Work" |> unwrap
  in
  State.prepare
    initial
    (Communication
       (Request_ask
          { id = request_id
          ; destination =
              New_thread { board = None; title = "Captured title"; ticket = None }
          ; body = "Question"
          ; recipients = [ Actor actor ]
          ; resolver = actor
          ; kind = Clarification
          ; priority = 0
          ; deadline_unix_ms = None
          ; related = []
          ; supersedes = []
          }))
    ~actor
    ~timestamp:"2026-11-05"
  |> unwrap
  |> State.candidate
;;

let replace json name value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal name value)
  | _ -> failwith "object expected"
;;

let%expect_test "request list summary decoder preserves source totals and rejects lies" =
  let state = fixture () in
  let page = State.query state ~method_:"request.list" ~params:(Json.obj []) |> unwrap in
  let row = Json.field page "items" |> Json.list |> List.hd_exn in
  let summary = Json.field row "thread_summary" in
  print_endline (Json.canonical summary);
  List.iter
    [ replace summary "title_bytes" (Json.int 1)
    ; replace summary "link_count" (Json.int 101)
    ; replace summary "links" (`Array [ Json.obj [ "kind", Json.string "workspace" ] ])
    ; replace summary "thread_revision" (Json.int 0)
    ; replace summary "extra" `True
    ]
    ~f:(fun bad ->
      match
        Api_codec.decode
          Communication_wire.request_list
          (replace row "thread_summary" bad)
      with
      | Ok _ -> failwith "malformed summary accepted"
      | Error _ -> print_endline "rejected");
  let prefix = replace summary "title" (Json.string "Captured") in
  ignore
    (Api_codec.decode
       Communication_wire.request_list
       (replace row "thread_summary" prefix)
     |> unwrap
     : Jsonaf.t);
  print_endline "disclosed prefix accepted";
  [%expect
    {|
    {"link_count":"0","links":[],"scope":{"kind":"workspace"},"thread_revision":"2","title":"Captured title","title_bytes":"14"}
    rejected
    rejected
    rejected
    rejected
    rejected
    disclosed prefix accepted
    |}]
;;

let%expect_test "projection rejects mismatched thread and leaves durable codecs separate" =
  let state = fixture () in
  let communication = State.communication state in
  let request = Communication.get_request communication request_id |> Option.value_exn in
  let thread =
    Communication.get_thread communication request.thread |> Option.value_exn
  in
  let historical = Communication_wire.request_json request in
  ignore (Api_codec.decode Communication_wire.request historical |> unwrap : Jsonaf.t);
  assert (Option.is_none (Json.optional historical "thread_summary"));
  let mismatched =
    { thread with id = Communication_id.Thread.of_string "other-thread" |> unwrap }
  in
  (match
     Communication_wire.request_list_json request ~thread:mismatched ~scope:Workspace
   with
   | Ok _ -> failwith "mismatched source accepted"
   | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  (match Api_codec.decode Communication_wire.request_list historical with
   | Ok _ -> failwith "summary absent from list record"
   | Error _ -> print_endline "list summary required; durable request independent");
  [%expect
    {|
    Invalid_argument
    list summary required; durable request independent
    |}]
;;
