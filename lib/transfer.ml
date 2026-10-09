open Core

let digest value =
  let value = Json.text value in
  if
    String.length value <> 64
    || not
         (String.for_all value ~f:(fun c ->
            Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
  then Json.fail Invalid_argument "invalid SHA-256 digest";
  value
;;

let invoke_result client method_ fields =
  let request =
    Protocol.Request.create ~id:"file-transfer" ~method_ ~params:(Json.obj fields)
    |> Disk.unwrap
  in
  Client.invoke client request |> Disk.unwrap
;;

let invoke client method_ fields =
  invoke_result client method_ fields
  |> Api_response.of_json
  |> Disk.unwrap
  |> Api_response.data
;;

module Upload_plan = struct
  type t =
    { workspace : Id.Workspace.t
    ; actor : Id.Actor.t
    ; run : Id.Run.t option
    ; mutation : Id.Mutation.t
    ; resource : Id.Resource.t
    ; expected_revision : int
    ; title : string
    ; filename : string
    ; mime_type : string
    ; file : string
    ; digest : string
    ; size_bytes : int
    }

  let params t =
    Json.obj
      ([ "transfer_version", Json.int 1
       ; "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
       ; "actor_id", Id.Actor.jsonaf_of_t t.actor
       ; "mutation_id", Id.Mutation.jsonaf_of_t t.mutation
       ; "resource_id", Id.Resource.jsonaf_of_t t.resource
       ; "expected_revision", Json.int t.expected_revision
       ; "title", Json.string t.title
       ; "filename", Json.string t.filename
       ; "mime_type", Json.string t.mime_type
       ; "file", Json.string t.file
       ; "digest", Json.string t.digest
       ; "size_bytes", Json.int t.size_bytes
       ]
       @ Option.to_list
           (Option.map t.run ~f:(fun run -> "run_id", Id.Run.jsonaf_of_t run)))
  ;;

  let prepare ~fs ~params =
    Disk.protect (fun () ->
      Json.fields
        params
        ~allowed:
          [ "transfer_version"
          ; "workspace_id"
          ; "actor_id"
          ; "run_id"
          ; "mutation_id"
          ; "resource_id"
          ; "expected_revision"
          ; "title"
          ; "filename"
          ; "mime_type"
          ; "file"
          ; "digest"
          ; "size_bytes"
          ];
      let get key = Json.field params key in
      let workspace = Id.Workspace.t_of_jsonaf (get "workspace_id") in
      let actor = Id.Actor.t_of_jsonaf (get "actor_id") in
      let run = Option.map (Json.optional params "run_id") ~f:Id.Run.t_of_jsonaf in
      let mutation = Id.Mutation.t_of_jsonaf (get "mutation_id") in
      let resource = Id.Resource.t_of_jsonaf (get "resource_id") in
      let expected_revision = Json.integer (get "expected_revision") in
      let title = Json.text (get "title") in
      let file = Json.text (get "file") in
      Disk.absolute file;
      let filename =
        Option.value_map
          (Json.optional params "filename")
          ~default:(Filename.basename file)
          ~f:Json.text
      in
      let mime_type =
        Option.value_map
          (Json.optional params "mime_type")
          ~default:"application/octet-stream"
          ~f:Json.text
      in
      Resource.validate_metadata
        { title; filename; mime_type; description = ""; targets = []; archived = false };
      let digest, size_bytes =
        match
          ( Json.optional params "transfer_version"
          , Json.optional params "digest"
          , Json.optional params "size_bytes" )
        with
        | None, None, None -> Blob.inspect Eio.Path.(fs / file) |> Disk.unwrap
        | Some version, Some hash, Some size ->
          if Json.integer version <> 1
          then Json.fail Unsupported_version "upload plan version unsupported";
          digest hash, Json.integer size
        | _ ->
          Json.fail
            Invalid_argument
            "upload plan requires version, digest and size together"
      in
      if size_bytes > Resource.max_blob_bytes
      then Json.fail Invalid_argument "upload exceeds 64MiB";
      { workspace
      ; actor
      ; run
      ; mutation
      ; resource
      ; expected_revision
      ; title
      ; filename
      ; mime_type
      ; file
      ; digest
      ; size_bytes
      })
  ;;
end

let upload (plan : Upload_plan.t) ~client ~fs =
  Disk.protect (fun () ->
    let identity =
      [ "workspace_id", Id.Workspace.jsonaf_of_t plan.workspace
      ; "actor_id", Id.Actor.jsonaf_of_t plan.actor
      ]
    in
    (* Include content identity in the stable upload ID, and therefore the finish
       request hash. Reusing a mutation with different bytes cannot return success. *)
    let upload_id =
      "u_"
      ^ Json.hash
          (Json.canonical
             (Json.obj
                [ "actor", Id.Actor.jsonaf_of_t plan.actor
                ; "mutation", Id.Mutation.jsonaf_of_t plan.mutation
                ; "resource", Id.Resource.jsonaf_of_t plan.resource
                ; "digest", Json.string plan.digest
                ; "size", Json.int plan.size_bytes
                ]))
    in
    let finish =
      identity
      @ Option.to_list
          (Option.map plan.run ~f:(fun run -> "run_id", Id.Run.jsonaf_of_t run))
      @ [ "mutation_id", Id.Mutation.jsonaf_of_t plan.mutation
        ; "upload_id", Json.string upload_id
        ; "resource_id", Id.Resource.jsonaf_of_t plan.resource
        ; "expected_revision", Json.int plan.expected_revision
        ; "title", Json.string plan.title
        ; "filename", Json.string plan.filename
        ; "mime_type", Json.string plan.mime_type
        ]
    in
    let receipt =
      invoke
        client
        "workspace.receipt"
        (identity @ [ "mutation_id", Id.Mutation.jsonaf_of_t plan.mutation ])
    in
    (match Json.text (Json.field receipt "status") with
     | "committed" -> ()
     | "absent" ->
       let actual, size = Blob.inspect Eio.Path.(fs / plan.file) |> Disk.unwrap in
       if not (String.equal actual plan.digest && Int.equal size plan.size_bytes)
       then Json.fail Conflict "source file differs from saved upload plan";
       let scope = identity @ [ "upload_id", Json.string upload_id ] in
       let begun =
         invoke
           client
           "upload.begin"
           (scope
            @ [ "digest", Json.string plan.digest
              ; "size_bytes", Json.int plan.size_bytes
              ])
       in
       let check_received response expected =
         if
           not
             (String.equal (Json.text (Json.field response "upload_id")) upload_id
              && String.equal (digest (Json.field response "digest")) plan.digest
              && Int.equal
                   (Json.integer (Json.field response "size_bytes"))
                   plan.size_bytes)
         then Json.fail Conflict "upload acknowledgement identity differs";
         let received = Json.integer (Json.field response "received") in
         if
           received > plan.size_bytes
           || Option.exists expected ~f:(fun n -> not (Int.equal n received))
         then Json.fail Conflict "upload acknowledgement offset differs";
         received
       in
       let offset = check_received begun None in
       let rec chunks offset =
         if offset < plan.size_bytes
         then (
           let bytes, size =
             Blob.read_range
               Eio.Path.(fs / plan.file)
               ~offset
               ~length:Upload.max_chunk_bytes
             |> Disk.unwrap
           in
           if (not (Int.equal size plan.size_bytes)) || String.is_empty bytes
           then Json.fail Conflict "source changed during upload";
           let next = offset + String.length bytes in
           let response =
             invoke
               client
               "upload.chunk"
               (scope
                @ [ "offset", Json.int offset
                  ; "data_base64", Json.string (Base64.encode_string bytes)
                  ])
           in
           ignore (check_received response (Some next) : int);
           chunks next)
       in
       chunks offset
     | _ -> Json.fail Invalid_argument "invalid workspace receipt status");
    let response = invoke_result client "resource.finish_upload" finish in
    let decoded = Api_response.of_json response |> Disk.unwrap in
    Api_response.require_durable decoded |> Disk.unwrap;
    response)
;;

module Download = struct
  type t =
    { workspace : Id.Workspace.t
    ; resource : Id.Resource.t
    ; version : int option
    ; destination : string
    }

  let of_params params =
    Json.decode (fun () ->
      Json.fields
        params
        ~allowed:[ "workspace_id"; "resource_id"; "version"; "destination" ];
      let workspace = Id.Workspace.t_of_jsonaf (Json.field params "workspace_id") in
      let resource = Id.Resource.t_of_jsonaf (Json.field params "resource_id") in
      let version = Option.map (Json.optional params "version") ~f:Json.integer in
      if Option.exists version ~f:(Int.equal 0)
      then Json.fail Invalid_argument "resource version must be positive";
      let destination = Json.text (Json.field params "destination") in
      Disk.absolute destination;
      { workspace; resource; version; destination })
  ;;
end

let download (plan : Download.t) ~client ~fs ~random =
  Disk.protect (fun () ->
    Disk.absolute plan.destination;
    let dst = Eio.Path.(fs / plan.destination) in
    (match Eio.Path.kind ~follow:false dst with
     | `Not_found -> ()
     | _ -> Json.fail Conflict "download destination already exists");
    let random_bytes = Cstruct.create 32 in
    Eio.Flow.read_exact random random_bytes;
    let temporary =
      Eio.Path.(
        fs
        / (plan.destination ^ ".downloading-" ^ Json.hash (Cstruct.to_string random_bytes)))
    in
    let owned = ref false in
    let cleanup () =
      if !owned
      then
        Eio.Cancel.protect (fun () ->
          ignore
            (Disk.protect (fun () -> Eio.Path.unlink temporary)
             : (unit, Problem.t) Result.t))
    in
    Fun.protect ~finally:cleanup (fun () ->
      let response =
        Eio.Path.with_open_out ~create:(`Exclusive 0o600) temporary (fun output ->
          owned := true;
          let rec chunks offset selected_version expected_digest expected_size context =
            let params =
              [ "workspace_id", Id.Workspace.jsonaf_of_t plan.workspace
              ; "resource_id", Id.Resource.jsonaf_of_t plan.resource
              ; "offset", Json.int offset
              ; "length", Json.int Upload.max_chunk_bytes
              ]
              @ Option.value_map selected_version ~default:[] ~f:(fun version ->
                [ "version", Json.int version ])
            in
            let result = invoke client "resource.read_chunk" params in
            let version = Json.integer (Json.field result "version") in
            let hash = digest (Json.field result "digest") in
            let size = Json.integer (Json.field result "size_bytes") in
            if
              version = 0
              || size > Resource.max_blob_bytes
              || (not
                    (Id.Resource.equal
                       (Id.Resource.t_of_jsonaf (Json.field result "resource_id"))
                       plan.resource))
              || Json.integer (Json.field result "offset") <> offset
              || Option.exists selected_version ~f:(fun previous ->
                not (Int.equal previous version))
              || Option.exists expected_digest ~f:(fun previous ->
                not (String.equal previous hash))
              || Option.exists expected_size ~f:(fun previous ->
                not (Int.equal previous size))
            then Json.fail Conflict "download version or range identity changed";
            let encoded =
              Json.bounded_text
                (Json.field result "data_base64")
                ~max_bytes:((Upload.max_chunk_bytes + 2) / 3 * 4)
            in
            let bytes =
              match Base64.decode encoded with
              | Ok bytes when String.equal (Base64.encode_string bytes) encoded -> bytes
              | Ok _ | Error _ -> Json.fail Corrupt_store "invalid base64 download chunk"
            in
            let length = String.length bytes in
            if
              offset > size
              || length > Upload.max_chunk_bytes
              || length <> Int.min Upload.max_chunk_bytes (size - offset)
              || not
                   (String.equal
                      (Json.hash bytes)
                      (digest (Json.field result "chunk_digest")))
            then Json.fail Corrupt_store "download chunk length or checksum differs";
            let next = offset + length in
            let eof =
              match Json.field result "eof" with
              | `True -> true
              | `False -> false
              | _ -> Json.fail Corrupt_store "invalid download EOF"
            in
            if not (Bool.equal eof (Int.equal next size))
            then Json.fail Corrupt_store "inconsistent download EOF";
            (match Json.field result "next_offset" with
             | `Null when eof -> ()
             | value when (not eof) && Json.integer value = next -> ()
             | _ -> Json.fail Corrupt_store "inconsistent download cursor");
            Eio.Flow.copy_string bytes output;
            let context = Digestif.SHA256.feed_string context bytes in
            if eof
            then (
              if not (String.equal Digestif.SHA256.(get context |> to_hex) hash)
              then Json.fail Corrupt_store "complete download checksum differs";
              Eio.File.sync output;
              Json.obj
                [ "resource_id", Id.Resource.jsonaf_of_t plan.resource
                ; "version", Json.int version
                ; "digest", Json.string hash
                ; "size_bytes", Json.int size
                ; "destination", Json.string plan.destination
                ])
            else chunks next (Some version) (Some hash) (Some size) context
          in
          chunks 0 plan.version None None Digestif.SHA256.empty)
      in
      Platform.link_exclusive ~src:temporary ~dst;
      (match Eio.Path.split dst with
       | None -> assert false
       | Some (parent, _) ->
         (match Disk.protect (fun () -> Platform.sync_directory parent) with
          | Ok () -> ()
          | Error error ->
            Json.fail
              Outcome_unknown
              ("download installed but directory sync failed: " ^ error.message)));
      response))
;;
