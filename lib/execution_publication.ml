open Core

type t =
  { saved_request : string
  ; request : Protocol.Request.t
  ; plan : Transfer.Upload_plan.t
  }

let saved_request t = t.saved_request
let request t = t.request
let request_path directory = Filename.concat directory "publication.json"

let load ~fs ~directory =
  Disk.protect (fun () ->
    Disk.absolute directory;
    Disk.require_directory Eio.Path.(fs / directory);
    let saved_request = request_path directory in
    let request =
      Disk.read Eio.Path.(fs / saved_request)
      |> Json.parse
      |> Disk.unwrap
      |> Protocol.Request.of_json
      |> Disk.unwrap
    in
    if not (String.equal (Protocol.Request.method_ request) "resource.upload")
    then Json.fail Corrupt_store "execution publication is not a resource upload";
    let params = Protocol.Request.params request in
    let plan = Transfer.Upload_plan.prepare ~fs ~params |> Disk.unwrap in
    if
      not
        (String.equal
           (Json.canonical params)
           (Json.canonical (Transfer.Upload_plan.params plan)))
    then
      Json.fail
        Corrupt_store
        "execution publication must retain a complete exact upload plan";
    if
      not
        (String.equal
           (Json.text (Json.field params "file"))
           (Filename.concat directory "capture.json"))
    then Json.fail Corrupt_store "execution publication source differs from stage";
    { saved_request; request; plan })
;;

let prepare stage ~fs ~random ~params =
  Disk.protect (fun () ->
    Json.fields
      params
      ~allowed:
        [ "workspace_id"
        ; "actor_id"
        ; "run_id"
        ; "mutation_id"
        ; "resource_id"
        ; "expected_revision"
        ; "title"
        ];
    let stage =
      Execution_stage.load ~fs ~directory:(Execution_stage.directory stage) |> Disk.unwrap
    in
    let file =
      match Execution_stage.capture_file stage with
      | Some file -> file
      | None ->
        Json.fail Conflict "execution is unfinished; no publication or implicit rerun"
    in
    let fields =
      match params with
      | `Object fields -> fields
      | _ -> assert false
    in
    let plan =
      Transfer.Upload_plan.prepare
        ~fs
        ~params:
          (Json.obj
             (fields
              @ [ "file", Json.string file
                ; "filename", Json.string "execution-capture.json"
                ; "mime_type", Json.string "application/json"
                ]))
      |> Disk.unwrap
    in
    let capture =
      match Execution_stage.state stage with
      | Finished capture -> capture
      | Unfinished _ -> assert false
    in
    let expected_digest =
      Api_codec.encode Execution_capture.codec capture
      |> Disk.unwrap
      |> Json.canonical
      |> Json.hash
    in
    if
      not
        (String.equal
           expected_digest
           (Json.text (Json.field (Transfer.Upload_plan.params plan) "digest")))
    then
      Json.fail
        Conflict
        "capture bytes changed or differ from the canonical staged outcome";
    let request =
      Protocol.Request.create
        ~id:"execution-publication"
        ~method_:"resource.upload"
        ~params:(Transfer.Upload_plan.params plan)
      |> Disk.unwrap
    in
    let directory = Execution_stage.directory stage in
    let saved_request = request_path directory in
    let nonce = Cstruct.create 32 in
    Eio.Flow.read_exact random nonce;
    let temporary =
      Eio.Path.(fs / directory / (".publication-" ^ Json.hash (Cstruct.to_string nonce)))
    in
    Disk.write_new temporary (Protocol.Request.to_json request |> Json.canonical);
    (* A stale private file is harmless. No partially written final intent is
       visible and no existing request can be replaced by a fresh mutation. *)
    Platform.link_exclusive ~src:temporary ~dst:Eio.Path.(fs / saved_request);
    Platform.sync_directory Eio.Path.(fs / directory);
    Eio.Path.unlink temporary;
    { saved_request; request; plan })
;;

let publish t ~client ~fs = Transfer.upload t.plan ~client ~fs
