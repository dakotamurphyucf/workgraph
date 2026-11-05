open Core

module Namespace = struct
  type t =
    | Registry
    | Planning of Id.Workspace.t
    | History of Id.Workspace.t
  [@@deriving equal, compare, sexp]

  let to_json = function
    | Registry -> Json.obj [ "kind", Json.string "registry" ]
    | Planning workspace ->
      Json.obj
        [ "kind", Json.string "planning"
        ; "workspace_id", Id.Workspace.jsonaf_of_t workspace
        ]
    | History workspace ->
      Json.obj
        [ "kind", Json.string "history"
        ; "workspace_id", Id.Workspace.jsonaf_of_t workspace
        ]
  ;;
end

module Mutation = struct
  type t =
    { namespace : Namespace.t
    ; actor : Id.Actor.t
    ; mutation : Id.Mutation.t
    ; run : Id.Run.t option
    ; method_ : string
    ; request_hash : string
    }

  let to_json t =
    Json.obj
      [ "namespace", Namespace.to_json t.namespace
      ; "actor_id", Id.Actor.jsonaf_of_t t.actor
      ; "mutation_id", Id.Mutation.jsonaf_of_t t.mutation
      ; "run_id", Option.value_map t.run ~default:`Null ~f:Id.Run.jsonaf_of_t
      ; "method", Json.string t.method_
      ; "request_hash", Json.string t.request_hash
      ]
  ;;

  let key t =
    Json.canonical
      (Json.obj
         [ "namespace", Namespace.to_json t.namespace
         ; "actor_id", Id.Actor.jsonaf_of_t t.actor
         ; "mutation_id", Id.Mutation.jsonaf_of_t t.mutation
         ])
  ;;

  let create request =
    let method_ = Protocol.Request.method_ request in
    let params = Protocol.Request.params request in
    let administrative =
      List.exists
        Administration_api.methods
        ~f:(fun (Api_method.Packed.Pack method_definition) ->
          String.equal method_ (Api_method.name method_definition))
    in
    if administrative
    then (
      let _, request_hash = Registry.request ~method_ ~params |> Disk.unwrap in
      { namespace = Registry
      ; actor = Id.Actor.t_of_jsonaf (Json.field params "actor_id")
      ; mutation = Id.Mutation.t_of_jsonaf (Json.field params "mutation_id")
      ; run = None
      ; method_
      ; request_hash
      })
    else (
      let identity, parameters = Mutation_request.of_params params |> Disk.unwrap in
      let history =
        List.mem History_command.mutation_methods method_ ~equal:String.equal
      in
      { namespace =
          (if history then History identity.workspace else Planning identity.workspace)
      ; actor = identity.actor
      ; mutation = identity.mutation
      ; run = identity.run
      ; method_
      ; request_hash =
          (if history
           then Registry.request ~method_ ~params |> Disk.unwrap |> snd
           else Mutation_request.request_hash identity ~method_ ~parameters)
      })
  ;;
end

module Entry = struct
  type t =
    { method_ : string
    ; envelope_hash : string
    ; mutation : Mutation.t option
    ; upload_plan : bool
    ; ticket_link : Id.Ticket.t option
    }

  let mutation t = t.mutation

  let create request ~fs =
    Json.decode (fun () ->
      let method_ = Protocol.Request.method_ request in
      let params = Protocol.Request.params request in
      let upload_plan = String.equal method_ "resource.upload" in
      let mutation, ticket_link =
        if upload_plan
        then (
          List.iter
            [ "transfer_version"; "upload_id"; "digest"; "size_bytes" ]
            ~f:(fun key -> ignore (Json.field params key : Jsonaf.t));
          let plan = Transfer.Upload_plan.prepare ~fs ~params |> Disk.unwrap in
          if
            not
              (String.equal
                 (Json.canonical params)
                 (Json.canonical (Transfer.Upload_plan.params plan)))
          then
            Json.fail Invalid_argument "inspection requires a complete frozen upload plan";
          ( Some (Mutation.create (Transfer.Upload_plan.finish_request plan))
          , Option.map (Json.optional params "ticket_id") ~f:Id.Ticket.t_of_jsonaf ))
        else (
          match Api_catalog.find method_ with
          | None ->
            Json.fail
              Invalid_argument
              "saved method is not in the current executable catalog; inspection never \
               rewrites aliases"
          | Some (Api_method.Packed.Pack definition) ->
            ignore
              (Api_codec.decode (Api_method.request_codec definition) params
               |> Disk.unwrap);
            ( (match Api_method.mode definition with
               | Mutation -> Some (Mutation.create request)
               | Read | Write -> None)
            , None ))
      in
      { method_
      ; envelope_hash = Json.hash (Json.canonical (Protocol.Request.to_json request))
      ; mutation
      ; upload_plan
      ; ticket_link
      })
  ;;

  let to_json t =
    Json.obj
      [ "method", Json.string t.method_
      ; "kind", Json.string (if t.upload_plan then "upload_plan" else "request")
      ; "envelope_hash", Json.string t.envelope_hash
      ; "mutation", Option.value_map t.mutation ~default:`Null ~f:Mutation.to_json
      ; ( "ticket_link"
        , Option.value_map t.ticket_link ~default:`Null ~f:Id.Ticket.jsonaf_of_t )
      ; "commit_status", Json.string "unchecked"
      ; "transmission_status", Json.string "unknown"
      ]
  ;;
end

let path request ~directory =
  Json.decode (fun () ->
    Disk.absolute directory;
    let digest = Protocol.Request.to_json request |> Json.canonical |> Json.hash in
    Filename.concat directory (digest ^ ".json"))
;;

module Saved = struct
  type t =
    | Created
    | Reused
  [@@deriving equal, sexp]
end

let sync_bytes path ~bytes =
  let invalid message =
    Json.fail
      Invalid_argument
      (sprintf "sync request journal %S: %s" (Eio.Path.native_exn path) message)
  in
  (match Eio.Path.kind ~follow:false path with
   | `Regular_file -> ()
   | _ -> invalid "journal winner must be a regular file, not a link or special file");
  Eio.Path.with_open_out ~append:true ~create:`Never path (fun file ->
    let size = Optint.Int63.of_int (String.length bytes) in
    let check_size () =
      if not (Optint.Int63.equal (Eio.File.size file) size)
      then invalid "journal destination contains different bytes; retry the original file"
    in
    check_size ();
    let actual = Cstruct.create (String.length bytes) in
    (try Eio.File.pread_exact file ~file_offset:Optint.Int63.zero [ actual ] with
     | End_of_file -> invalid "journal winner changed during read");
    check_size ();
    if not (String.equal bytes (Cstruct.to_string actual))
    then invalid "journal destination contains different bytes; retry the original file";
    Eio.File.sync file)
;;

let sync_existing request ~fs ~destination =
  Local_file.protect ~operation:"sync request journal" ~path:destination (fun () ->
    Disk.absolute destination;
    let path = Eio.Path.(fs / destination) in
    sync_bytes path ~bytes:(Protocol.Request.to_json request |> Json.canonical);
    match Eio.Path.split path with
    | Some (parent, _) -> Platform.sync_directory parent
    | None -> Json.fail Invalid_argument "journal requires a parent directory")
;;

let save request ~fs ~random ~destination =
  Local_file.protect ~operation:"save request journal" ~path:destination (fun () ->
    Disk.absolute destination;
    let invalid message =
      Json.fail
        Invalid_argument
        (sprintf "save request journal %S: %s" destination message)
    in
    let path = Eio.Path.(fs / destination) in
    let parent, _ =
      match Eio.Path.split path with
      | Some pair -> pair
      | None -> invalid "journal requires a parent directory"
    in
    Local_file.require_directory parent ~operation:"save request journal";
    let bytes = Protocol.Request.to_json request |> Json.canonical in
    match Eio.Path.kind ~follow:false path with
    | `Regular_file ->
      sync_bytes path ~bytes;
      Platform.sync_directory parent;
      Saved.Reused
    | `Not_found ->
      let nonce = Cstruct.create 32 in
      Eio.Flow.read_exact random nonce;
      let stage =
        Eio.Path.(parent / (".journal-" ^ Json.hash (Cstruct.to_string nonce) ^ ".stage"))
      in
      Disk.write_new stage bytes;
      let result =
        try
          Platform.link_exclusive ~src:stage ~dst:path;
          Saved.Created
        with
        | Json.Decode_error { kind = Conflict; _ } ->
          sync_bytes path ~bytes;
          Saved.Reused
      in
      Platform.sync_directory parent;
      Eio.Path.unlink stage;
      Platform.sync_directory parent;
      result
    | _ -> invalid "journal destination must be absent or an identical regular file")
;;

let decode bytes ~fs =
  let open Result.Let_syntax in
  let%bind value = Json.parse bytes in
  let%bind request = Protocol.Request.of_json value in
  Entry.create request ~fs
;;

let inspect filename ~fs =
  let open Result.Let_syntax in
  let%bind bytes =
    Local_file.protect ~operation:"inspect journal" ~path:filename (fun () ->
      Disk.absolute filename;
      Local_file.read Eio.Path.(fs / filename) ~operation:"inspect journal")
  in
  decode bytes ~fs
;;

module Page = struct
  type row =
    { filename : string
    ; entry : (Entry.t, Problem.t) Result.t
    }

  type t =
    { directory : string
    ; rows : row list
    ; complete : bool
    ; next_after : string option
    ; stop : string
    ; charged_bytes : int
    }

  let row_to_json row =
    Json.obj
      [ "filename", Json.string row.filename
      ; ( "entry"
        , match row.entry with
          | Ok entry -> Entry.to_json entry
          | Error _ -> `Null )
      ; ( "problem"
        , match row.entry with
          | Ok _ -> `Null
          | Error problem -> Problem.to_json problem )
      ]
  ;;

  let groups rows =
    List.fold rows ~init:String.Map.empty ~f:(fun groups row ->
      match Result.ok row.entry |> Option.bind ~f:Entry.mutation with
      | None -> groups
      | Some mutation ->
        Map.update groups (Mutation.key mutation) ~f:(fun previous ->
          (mutation, row.filename) :: Option.value previous ~default:[]))
    |> Map.to_alist
    |> List.filter_map ~f:(fun (_, members) ->
      if List.length members < 2
      then None
      else (
        let first = fst (List.hd_exn members) in
        let hashes =
          List.map members ~f:(fun (mutation, _) -> mutation.Mutation.request_hash)
          |> List.dedup_and_sort ~compare:String.compare
        in
        Some
          (Json.obj
             [ "namespace", Namespace.to_json first.namespace
             ; "actor_id", Id.Actor.jsonaf_of_t first.actor
             ; "mutation_id", Id.Mutation.jsonaf_of_t first.mutation
             ; ( "kind"
               , Json.string
                   (if List.length hashes = 1
                    then "same_request_hash"
                    else "conflicting_request_hashes") )
             ; ( "filenames"
               , `Array
                   (List.map (List.rev members) ~f:(fun (_, filename) ->
                      Json.string filename)) )
             ; "request_hashes", `Array (List.map hashes ~f:Json.string)
             ])))
  ;;

  let to_json t =
    Json.obj
      [ "directory", Json.string t.directory
      ; "items", `Array (List.map t.rows ~f:row_to_json)
      ; ("complete", if t.complete then `True else `False)
      ; "next_after", Option.value_map t.next_after ~default:`Null ~f:Json.string
      ; "stop", Json.string t.stop
      ; "charged_bytes", Json.int t.charged_bytes
      ; "groups", `Array (groups t.rows)
      ; "group_scope", Json.string "returned_entries_only"
      ; "commit_status", Json.string "unchecked"
      ]
  ;;
end

let list directory ~fs ~after ~limit ~max_bytes =
  Local_file.protect ~operation:"list journals" ~path:directory (fun () ->
    Disk.absolute directory;
    if
      limit < 1
      || limit > 1000
      || max_bytes < 4 * 1024 * 1024
      || max_bytes > 64 * 1024 * 1024
    then
      Json.fail
        Invalid_argument
        "journal limits require1..1000 entries and4194304..67108864 input bytes";
    Option.iter after ~f:(fun name ->
      if
        String.is_empty name
        || String.mem name '/'
        || String.mem name '\000'
        || List.mem [ "."; ".." ] name ~equal:String.equal
      then Json.fail Invalid_argument "journal after cursor must be one basename");
    let parent = Eio.Path.(fs / directory) in
    Local_file.require_directory parent ~operation:"list journals";
    let names = Eio.Path.read_dir parent in
    if List.length names > 10_000
    then
      Json.fail
        Invalid_argument
        "journal directory exceeds10000 names; use smaller run-scoped directories";
    let names =
      List.filter names ~f:(fun name ->
        String.is_suffix name ~suffix:".json"
        && Option.for_all after ~f:(fun after -> String.compare name after > 0))
      |> List.sort ~compare:String.compare
    in
    let directory_bytes = String.length (Json.canonical (Json.string directory)) in
    let finish rows ~complete ~next_after ~stop ~charged_bytes =
      let page =
        { Page.directory
        ; rows = List.rev rows
        ; complete
        ; next_after
        ; stop
        ; charged_bytes
        }
      in
      if String.length (Json.canonical (Page.to_json page)) > 1024 * 1024
      then Json.fail Invalid_argument "journal page exceeds output limit";
      page
    in
    let rec scan names rows ~count ~charged_bytes ~row_bytes ~cursor =
      match names with
      | [] -> finish rows ~complete:true ~next_after:None ~stop:"complete" ~charged_bytes
      | _ when count >= limit ->
        finish rows ~complete:false ~next_after:cursor ~stop:"entry_limit" ~charged_bytes
      | _ when charged_bytes >= max_bytes ->
        finish
          rows
          ~complete:false
          ~next_after:cursor
          ~stop:"input_byte_limit"
          ~charged_bytes
      | filename :: rest ->
        let budget = Int.min (4 * 1024 * 1024) (max_bytes - charged_bytes) in
        let read =
          Local_file.protect ~operation:"inspect journal" ~path:filename (fun () ->
            Local_file.read
              ~max_bytes:budget
              Eio.Path.(parent / filename)
              ~operation:"inspect journal")
        in
        (match read with
         | Error _ when budget < 4 * 1024 * 1024 ->
           finish
             rows
             ~complete:false
             ~next_after:cursor
             ~stop:"input_byte_limit"
             ~charged_bytes
         | read ->
           let entry, charged =
             match read with
             | Ok bytes -> decode bytes ~fs, String.length bytes
             | Error problem -> Error problem, budget
           in
           let row = { Page.filename; entry } in
           let size = String.length (Json.canonical (Page.row_to_json row)) in
           if (2 * (row_bytes + size)) + directory_bytes + 8192 > 1024 * 1024
           then (
             if List.is_empty rows
             then
               Json.fail Invalid_argument "journal entry diagnostic exceeds output limit";
             finish
               rows
               ~complete:false
               ~next_after:cursor
               ~stop:"output_byte_limit"
               ~charged_bytes)
           else
             scan
               rest
               (row :: rows)
               ~count:(count + 1)
               ~charged_bytes:(charged_bytes + charged)
               ~row_bytes:(row_bytes + size)
               ~cursor:(Some filename))
    in
    scan names [] ~count:0 ~charged_bytes:0 ~row_bytes:0 ~cursor:after)
;;
