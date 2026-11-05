open Core

type t =
  { saved_request : string
  ; request : Protocol.Request.t
  ; plan : Transfer.Upload_plan.t
  }

let saved_request t = t.saved_request
let request t = t.request
let request_path directory = Filename.concat directory "publication.json"

let journal t ~fs ~random ~destination =
  Result.map
    (Request_journal.save t.request ~fs ~random ~destination)
    ~f:(fun (_ : Request_journal.Saved.t) -> ())
;;

let journal_path t ~directory = Request_journal.path t.request ~directory

let load ~fs ~directory =
  Local_file.protect ~operation:"load publication stage" ~path:directory (fun () ->
    Disk.absolute directory;
    Local_file.require_directory
      Eio.Path.(fs / directory)
      ~operation:"load publication stage";
    let saved_request = request_path directory in
    let request =
      Local_file.read Eio.Path.(fs / saved_request) ~operation:"read publication intent"
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
    let t = { saved_request; request; plan } in
    Request_journal.sync_existing request ~fs ~destination:saved_request |> Disk.unwrap;
    t)
;;

let prepare stage ~fs ~random ~params =
  let directory = Execution_stage.directory stage in
  Local_file.protect ~operation:"prepare publication stage" ~path:directory (fun () ->
    Execution_stage.with_lock ~fs ~directory ~f:(fun _ ->
      let saved_request = request_path directory in
      (match Eio.Path.kind ~follow:false Eio.Path.(fs / saved_request) with
       | `Not_found -> ()
       | _ ->
         Json.fail
           Invalid_argument
           (sprintf
              "prepare publication %S: destination already exists; retry the saved stage"
              saved_request));
      Json.fields
        params
        ~allowed:
          [ "workspace_id"
          ; "actor_id"
          ; "run_id"
          ; "ticket_id"
          ; "mutation_id"
          ; "resource_id"
          ; "expected_revision"
          ; "title"
          ];
      let stage =
        Execution_stage.load ~fs ~directory:(Execution_stage.directory stage)
        |> Disk.unwrap
      in
      let file =
        match Execution_stage.capture_file stage with
        | Some file -> file
        | None ->
          Json.fail Conflict "execution is unfinished; no publication or implicit rerun"
      in
      let identity =
        Protocol.Request.create
          ~id:"execution-publication"
          ~method_:"resource.upload"
          ~params
        |> Disk.unwrap
        |> Cli_mutation_identity.ensure ~random ~allow_generate:true
        |> Disk.unwrap
      in
      let fields =
        match Protocol.Request.params identity with
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
      let nonce = Cstruct.create 32 in
      Eio.Flow.read_exact random nonce;
      let temporary =
        Eio.Path.(
          fs / directory / (".publication-" ^ Json.hash (Cstruct.to_string nonce)))
      in
      Local_file.write_new
        temporary
        ~operation:"save publication intent"
        (Protocol.Request.to_json request |> Json.canonical);
      (* A stale private file is harmless. No partially written final intent is
       visible and no existing request can be replaced by a fresh mutation. *)
      Local_file.link_exclusive
        ~src:temporary
        ~dst:Eio.Path.(fs / saved_request)
        ~operation:"save publication intent";
      Platform.sync_directory Eio.Path.(fs / directory);
      Eio.Path.unlink temporary;
      { saved_request; request; plan })
    |> Disk.unwrap)
;;

let publish t ~client ~fs = Transfer.upload t.plan ~client ~fs
let publish_with_link t ~client ~fs = Transfer.upload_with_link t.plan ~client ~fs
