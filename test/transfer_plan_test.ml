open Core
open Workgraph

let replace value name replacement =
  match value with
  | `Object fields ->
    Json.obj (List.Assoc.add fields ~equal:String.equal name replacement)
  | _ -> assert false
;;

let saved_plan ~fs ~ticket =
  let digest = String.make 64 'a' in
  let upload =
    "u_"
    ^ Json.hash
        (Json.canonical
           (Json.obj
              [ "actor", Json.string "author"
              ; "mutation", Json.string "frozen"
              ; "resource", Json.string "artifact"
              ; "digest", Json.string digest
              ; "size", Json.int 3
              ]))
  in
  Transfer.Upload_plan.prepare
    ~fs
    ~params:
      (Json.obj
         ([ "transfer_version", Json.string "2"
          ; "upload_id", Json.string upload
          ; "workspace_id", Json.string "workspace"
          ; "actor_id", Json.string "author"
          ; "run_id", Json.string "run"
          ; "mutation_id", Json.string "frozen"
          ; "resource_id", Json.string "artifact"
          ; "expected_revision", Json.int 7
          ; "title", Json.string "Artifact"
          ; "filename", Json.string "result.bin"
          ; "mime_type", Json.string "application/octet-stream"
          ; "file", Json.string "/nonexistent-pure-link-test-source"
          ; "digest", Json.string digest
          ; "size_bytes", Json.int 3
          ]
          @ if ticket then [ "ticket_id", Json.string "ticket" ] else []))
  |> Disk.unwrap
;;

let version =
  Json.obj
    [ "revision", Json.int 3
    ; "digest", Json.string (String.make 64 'a')
    ; "size_bytes", Json.int 3
    ; "actor_id", Json.string "author"
    ; "timestamp", Json.string "2026-01-01T00:00:00Z"
    ; "filename", Json.string "result.bin"
    ; "mime_type", Json.string "application/octet-stream"
    ]
;;

let data =
  Json.obj
    [ "resource_id", Json.string "artifact"; "revision", Json.int 8; "version", version ]
;;

let publication ?(durable = true) data =
  Api_response.of_json
    (Json.obj
       [ "data", data
       ; ( "meta"
         , Json.obj
             [ ("durable", if durable then `True else `False)
             ; "workspace_revision", Json.int 20
             ] )
       ])
  |> Disk.unwrap
;;

let report = function
  | Ok None -> print_endline "none"
  | Ok (Some request) -> print_endline (Json.canonical (Protocol.Request.to_json request))
  | Error (error : Problem.t) -> print_endline (Problem.wire_name error.kind)
;;

let%expect_test "pure link preserves original identity and does not require source bytes" =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let plan = saved_plan ~fs ~ticket:true in
    Transfer.Upload_plan.link_request plan ~publication:(publication data) |> report;
    Transfer.Upload_plan.link_request
      (saved_plan ~fs ~ticket:false)
      ~publication:(publication data)
    |> report);
  [%expect
    {|
    {"id":"upload-ticket-link","jsonrpc":"2.0","method":"resource.link","params":{"actor_id":"author","expected_revision":"8","mutation_id":"link_c85dd8f72170c29349244417edd6ec5736cdf45c2f2aee32e582e28234436f9d","resource_id":"artifact","run_id":"run","target":{"id":"ticket","kind":"ticket"},"workspace_id":"workspace"},"workgraph_api":"0.7"}
    none
    |}]
;;

let%expect_test
    "link guard cannot derive from nondurable, unrelated or malformed publication"
  =
  Eio_main.run (fun env ->
    let plan = saved_plan ~fs:(Eio.Stdenv.fs env) ~ticket:true in
    Transfer.Upload_plan.link_request plan ~publication:(publication ~durable:false data)
    |> report;
    List.iter
      [ replace data "resource_id" (Json.string "other")
      ; replace data "revision" (Json.int 9)
      ; replace
          data
          "version"
          (replace version "digest" (Json.string (String.make 64 'b')))
      ; replace data "version" (replace version "size_bytes" (Json.int 4))
      ; replace data "version" (replace version "actor_id" (Json.string "other"))
      ; replace data "version" (replace version "filename" (Json.string "other.bin"))
      ; replace data "version" (replace version "mime_type" (Json.string "text/plain"))
      ; replace data "version" (replace version "size_bytes" `Null)
      ; Json.obj [ "resource_id", Json.string "artifact" ]
      ]
      ~f:(fun data ->
        Transfer.Upload_plan.link_request plan ~publication:(publication data) |> report));
  [%expect
    {|
    Outcome_unknown
    Conflict
    Conflict
    Conflict
    Conflict
    Conflict
    Conflict
    Conflict
    Invalid_argument
    Invalid_argument
    |}]
;;
