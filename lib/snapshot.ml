open Core

type t =
  { state : State.t
  ; source_root : string
  ; descriptor : string
  ; head_bytes : string
  ; head : string option
  ; transactions : (string * string) list
  ; history : Session_store.Capture.t option
  }

let workspace t = State.workspace t.state
let revision t = State.revision t.state
let head t = t.head
let history_head t = Option.bind t.history ~f:Session_store.Capture.head

let with_history t history =
  if not (Id.Workspace.equal (workspace t) (Session_store.Capture.workspace history))
  then Error (Problem.create Conflict "history capture belongs to another workspace")
  else Ok { t with history = Some history }
;;

let history_files t =
  Option.value_map t.history ~default:[] ~f:(fun history ->
    if Session_store.Capture.sequence history = 0
    then []
    else
      ( "history/HEAD.json"
      , Json.hash (Session_store.Capture.head_bytes history)
      , String.length (Session_store.Capture.head_bytes history) )
      :: Session_store.Capture.portable_files history)
;;

let check_hash hash =
  if
    String.length hash <> 64
    || not
         (String.for_all hash ~f:(fun c -> Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
  then Json.fail Corrupt_store "invalid manifest digest"
;;

let decode_head bytes =
  let head = Json.parse bytes |> Disk.unwrap |> Storage.Head.of_json |> Disk.unwrap in
  Storage.Head.sequence head, Storage.Head.digest head
;;

let create ~state ~source_root ~descriptor ~head_bytes ~transactions =
  Json.decode (fun () ->
    Disk.absolute source_root;
    let sequence, head = decode_head head_bytes in
    let metadata =
      Json.parse descriptor |> Disk.unwrap |> Storage.Descriptor.of_json |> Disk.unwrap
    in
    if
      (not
         (Id.Workspace.equal
            (Storage.Descriptor.workspace metadata)
            (State.workspace state)))
      || sequence <> State.revision state
      || List.length transactions <> sequence
    then Json.fail Corrupt_store "capture identity or revision differs from storage";
    { state; source_root; descriptor; head_bytes; head; transactions; history = None })
;;

let write t ~fs ~destination ~stage ~check_cancelled ~before_publish =
  Disk.protect (fun () ->
    Disk.absolute destination;
    Disk.absolute stage;
    if String.equal destination stage
    then Json.fail Invalid_argument "stage equals destination";
    let target = Eio.Path.(fs / destination)
    and stage_path = Eio.Path.(fs / stage) in
    (match Eio.Path.kind ~follow:false target with
     | `Not_found -> ()
     | _ -> Json.fail Conflict "export destination exists");
    check_cancelled ();
    Eio.Path.mkdir ~perm:0o700 stage_path;
    List.iter
      [ "projects"
      ; "milestones"
      ; "comments"
      ; "tickets"
      ; "portable"
      ; "portable/transactions"
      ; "portable/blobs"
      ; "resources"
      ; "facts"
      ]
      ~f:(fun name -> Disk.ensure_directory Eio.Path.(stage_path / name));
    let files = ref [] in
    let total_bytes = ref 0
    and file_count = ref 0 in
    let account size =
      incr file_count;
      total_bytes := !total_bytes + size;
      if
        size > 1024 * 1024 * 1024
        || !total_bytes > 4 * 1024 * 1024 * 1024
        || !file_count > 499_990
      then Json.fail Invalid_argument "export exceeds file/inventory verification limits"
    in
    let write name bytes =
      check_cancelled ();
      account (String.length bytes);
      Disk.write_new Eio.Path.(stage_path / name) bytes;
      files := (name, Json.string (Json.hash bytes)) :: !files
    in
    Sequence.iter (State.readable_files t.state) ~f:(fun (name, bytes) ->
      write name bytes);
    write "portable/workspace.json" t.descriptor;
    write "portable/HEAD.json" t.head_bytes;
    write "portable/.gitignore" ".local/\n";
    List.iter t.transactions ~f:(fun (name, bytes) ->
      write ("portable/transactions/" ^ name) bytes);
    List.iter (State.blob_digests t.state) ~f:(fun digest ->
      let copy name =
        check_cancelled ();
        let actual, size =
          Blob.copy
            Eio.Path.(fs / t.source_root / "blobs" / digest)
            ~dst:Eio.Path.(stage_path / name)
          |> Disk.unwrap
        in
        if not (String.equal actual digest)
        then Json.fail Corrupt_store "export blob digest mismatch";
        account size;
        files := (name, Json.string digest) :: !files
      in
      copy ("portable/blobs/" ^ digest);
      copy ("resources/" ^ digest ^ ".bin"));
    Option.iter t.history ~f:(fun history ->
      if Session_store.Capture.sequence history > 0
      then (
        List.iter
          [ "portable/history"; "portable/history/batches"; "history" ]
          ~f:(fun name -> Disk.ensure_directory Eio.Path.(stage_path / name));
        write "portable/history/HEAD.json" (Session_store.Capture.head_bytes history);
        write
          "history/index.json"
          (Json.canonical (Session_store.Capture.to_json history));
        List.iter (Session_store.Capture.sessions history) ~f:(fun session ->
          write
            ("history/" ^ Session_id.to_string (Session.id session) ^ ".json")
            (Json.canonical
               (Json.obj
                  [ "session", Session.to_json session
                  ; ( "events"
                    , `Array
                        (List.map
                           (Session_store.Capture.events
                              history
                              ~session:(Session.id session))
                           ~f:Session_event.to_json) )
                  ])));
        List.iter
          (Session_store.Capture.portable_files history)
          ~f:(fun (relative, digest, expected_size) ->
            check_cancelled ();
            let name = "portable/" ^ relative in
            match List.Assoc.find !files name ~equal:String.equal with
            | Some previous ->
              if not (String.equal (Json.text previous) digest)
              then Json.fail Corrupt_store "history/domain file identities conflict"
            | None ->
              let actual, size =
                File_content.copy
                  Eio.Path.(fs / t.source_root / relative)
                  ~dst:Eio.Path.(stage_path / name)
                  ~max_bytes:(1024 * 1024 * 1024)
                |> Disk.unwrap
              in
              if (not (String.equal actual digest)) || size <> expected_size
              then Json.fail Corrupt_store "history export file differs from capture";
              account size;
              files := (name, Json.string digest) :: !files)));
    let manifest =
      Json.obj
        [ "version", Json.int 1
        ; "workspace_id", Id.Workspace.jsonaf_of_t (workspace t)
        ; "revision", Json.int (revision t)
        ; "head", Option.value_map t.head ~default:`Null ~f:Json.string
        ; "history_head", Option.value_map (history_head t) ~default:`Null ~f:Json.string
        ; "complete", `True
        ; "options", Json.obj [ "full", `True ]
        ; "files", Json.obj !files
        ]
    in
    let manifest_bytes = Json.canonical manifest in
    if String.length manifest_bytes > 64 * 1024 * 1024
    then Json.fail Invalid_argument "export manifest exceeds 64MiB";
    Disk.write_new Eio.Path.(stage_path / "manifest.json") manifest_bytes;
    Platform.sync_directory stage_path;
    before_publish ();
    (match Eio.Path.kind ~follow:false target with
     | `Not_found -> ()
     | _ -> Json.fail Conflict "export destination appeared before publication");
    Platform.rename_exclusive ~src:stage_path ~dst:target;
    match Eio.Path.split target with
    | None -> assert false
    | Some (parent, _) ->
      (match Disk.protect (fun () -> Platform.sync_directory parent) with
       | Ok () -> manifest
       | Error error ->
         Json.fail
           Outcome_unknown
           ("export installed but parent sync failed: " ^ error.message)))
;;

module Verified = struct
  type t =
    { directory : string
    ; manifest : Jsonaf.t
    ; files : string String.Map.t
    ; workspace : Id.Workspace.t
    ; revision : int
    ; head : string option
    ; history_head : string option
    }

  let manifest t = t.manifest
  let workspace t = t.workspace
  let revision t = t.revision
  let head t = t.head
  let history_head t = t.history_head
end

let max_file_bytes = 1024 * 1024 * 1024
let max_manifest_bytes = 64 * 1024 * 1024

let safe_name name =
  if
    String.is_empty name
    || Filename.is_absolute name
    || String.mem name '\000'
    || String.mem name '\\'
    || String.length name > 4096
  then Json.fail Corrupt_store "unsafe manifest path";
  let parts = String.split name ~on:'/' in
  if
    List.length parts > 32
    || List.exists parts ~f:(fun part ->
      String.is_empty part || String.equal part "." || String.equal part "..")
  then Json.fail Corrupt_store "unsafe manifest path components"
;;

let verify ~fs ~directory =
  Disk.protect (fun () ->
    Disk.absolute directory;
    let root = Eio.Path.(fs / directory) in
    (match Eio.Path.kind ~follow:false root with
     | `Directory -> ()
     | _ -> Json.fail Corrupt_store "export root must be a real directory");
    let manifest =
      Disk.read_with_limit Eio.Path.(root / "manifest.json") ~max_bytes:max_manifest_bytes
      |> Json.parse_with_limit ~max_bytes:max_manifest_bytes
      |> Disk.unwrap
    in
    let version = Json.integer (Json.field manifest "version") in
    if version <> 1
    then Json.fail Unsupported_version "export manifest version unsupported";
    Json.fields
      manifest
      ~allowed:
        [ "version"
        ; "workspace_id"
        ; "revision"
        ; "head"
        ; "history_head"
        ; "complete"
        ; "options"
        ; "files"
        ];
    (match Json.field manifest "complete" with
     | `True -> ()
     | _ -> Json.fail Corrupt_store "partial export cannot be restored");
    (let options = Json.field manifest "options" in
     Json.fields options ~allowed:[ "full" ];
     match Json.field options "full" with
     | `True -> ()
     | _ -> Json.fail Corrupt_store "filtered export cannot be restored");
    let workspace = Id.Workspace.t_of_jsonaf (Json.field manifest "workspace_id") in
    let revision = Json.integer (Json.field manifest "revision") in
    let files =
      match Json.field manifest "files" with
      | `Object fields ->
        if List.length fields > 500_000
        then Json.fail Corrupt_store "manifest file limit exceeded";
        String.Map.of_alist_exn
          (List.map fields ~f:(fun (name, value) ->
             safe_name name;
             if String.equal name "manifest.json"
             then Json.fail Corrupt_store "self-referential manifest";
             let hash = Json.text value in
             check_hash hash;
             name, hash))
      | _ -> Json.fail Corrupt_store "invalid manifest file map"
    in
    let observed = ref String.Set.empty
    and nodes = ref 0 in
    let rec walk pending =
      match pending with
      | [] -> ()
      | relative :: rest ->
        incr nodes;
        if !nodes > 500_000
        then Json.fail Corrupt_store "export tree entry limit exceeded";
        if not (String.is_empty relative) then safe_name relative;
        let path = Eio.Path.(root / relative) in
        (match Eio.Path.kind ~follow:false path with
         | `Directory ->
           let children =
             Eio.Path.read_dir path
             |> List.map ~f:(fun name ->
               if String.is_empty relative then name else relative ^ "/" ^ name)
           in
           walk (List.rev_append children rest)
         | `Regular_file ->
           if not (String.equal relative "manifest.json")
           then observed := Set.add !observed relative;
           walk rest
         | _ -> Json.fail Corrupt_store "export contains symlink or unsupported entry")
    in
    walk [ "" ];
    if not (Set.equal !observed (Map.key_set files))
    then Json.fail Corrupt_store "manifest file inventory differs from export";
    let total_bytes = ref 0 in
    Map.iteri files ~f:(fun ~key:name ~data:expected ->
      let actual, size =
        File_content.inspect Eio.Path.(root / name) ~max_bytes:max_file_bytes
        |> Disk.unwrap
      in
      total_bytes := !total_bytes + size;
      if !total_bytes > 4 * 1024 * 1024 * 1024
      then Json.fail Corrupt_store "export aggregate bytes exceed 4GiB";
      if not (String.equal actual expected)
      then Json.fail Corrupt_store ("export checksum differs: " ^ name));
    List.iter
      [ "portable/workspace.json"; "portable/HEAD.json"; "portable/.gitignore" ]
      ~f:(fun name ->
        if not (Map.mem files name)
        then Json.fail Corrupt_store "export missing canonical metadata");
    Map.iter_keys files ~f:(fun name ->
      if String.is_prefix name ~prefix:"portable/"
      then (
        match String.split name ~on:'/' with
        | [ "portable"; ("workspace.json" | "HEAD.json" | ".gitignore") ] -> ()
        | [ "portable"; "transactions"; filename ]
          when String.is_suffix filename ~suffix:".json" -> ()
        | [ "portable"; "blobs"; digest ] -> check_hash digest
        | [ "portable"; "history"; "HEAD.json" ] -> ()
        | [ "portable"; "history"; "batches"; filename ]
          when String.is_suffix filename ~suffix:".json" ->
          check_hash (String.drop_suffix filename 5)
        | _ -> Json.fail Corrupt_store "unsupported private/canonical file in export"));
    let descriptor =
      Disk.read Eio.Path.(root / "portable/workspace.json")
      |> Json.parse
      |> Disk.unwrap
      |> Storage.Descriptor.of_json
      |> Disk.unwrap
    in
    let sequence, head = decode_head (Disk.read Eio.Path.(root / "portable/HEAD.json")) in
    if
      (not (Id.Workspace.equal workspace (Storage.Descriptor.workspace descriptor)))
      || sequence <> revision
    then Json.fail Corrupt_store "manifest identity/revision differs from portable head";
    (let expected =
       match Json.field manifest "head" with
       | `Null -> None
       | value -> Some (Json.text value)
     in
     if not (Option.equal String.equal head expected)
     then Json.fail Corrupt_store "manifest head differs from portable head");
    let history_head =
      if Map.mem files "portable/history/HEAD.json"
      then (
        let h =
          Disk.read Eio.Path.(root / "portable/history/HEAD.json")
          |> Json.parse
          |> Disk.unwrap
          |> History_storage.Head.of_json
          |> Disk.unwrap
        in
        if not (Id.Workspace.equal workspace (History_storage.Head.workspace h))
        then Json.fail Corrupt_store "history export workspace differs";
        History_storage.Head.digest h)
      else None
    in
    let declared_history_head =
      match Json.field manifest "history_head" with
      | `Null -> None
      | value -> Some (Json.text value)
    in
    if not (Option.equal String.equal history_head declared_history_head)
    then Json.fail Corrupt_store "manifest history head differs from portable history";
    { Verified.directory; manifest; files; workspace; revision; head; history_head })
;;

let validate_canonical (verified : Verified.t) ~snapshot =
  Json.decode (fun () ->
    let expected =
      [ "portable/workspace.json", Json.hash snapshot.descriptor
      ; "portable/HEAD.json", Json.hash snapshot.head_bytes
      ; "portable/.gitignore", Json.hash ".local/\n"
      ]
      @ List.map snapshot.transactions ~f:(fun (name, bytes) ->
        "portable/transactions/" ^ name, Json.hash bytes)
      @ List.map (State.blob_references snapshot.state) ~f:(fun (digest, _) ->
        "portable/blobs/" ^ digest, digest)
      @ List.map (history_files snapshot) ~f:(fun (name, digest, _) ->
        "portable/" ^ name, digest)
      |> String.Map.of_alist_reduce ~f:(fun a _ -> a)
    in
    let actual =
      Map.filter_keys verified.files ~f:(String.is_prefix ~prefix:"portable/")
    in
    if not (Map.equal String.equal actual expected)
    then
      Json.fail Corrupt_store "portable inventory differs from replayed canonical state")
;;

let copy_portable (verified : Verified.t) ~fs ~destination =
  Disk.protect (fun () ->
    Disk.absolute destination;
    let dst = Eio.Path.(fs / destination) in
    (match Eio.Path.kind ~follow:false dst with
     | `Not_found -> ()
     | _ -> Json.fail Conflict "restore staging root already exists");
    Eio.Path.mkdir ~perm:0o700 dst;
    List.iter [ "transactions"; "blobs" ] ~f:(fun name ->
      Disk.ensure_directory Eio.Path.(dst / name));
    if Map.mem verified.files "portable/history/HEAD.json"
    then
      List.iter [ "history"; "history/batches" ] ~f:(fun name ->
        Disk.ensure_directory Eio.Path.(dst / name));
    Map.iteri verified.files ~f:(fun ~key:name ~data:expected ->
      match String.chop_prefix name ~prefix:"portable/" with
      | None -> ()
      | Some relative ->
        let hash, _ =
          File_content.copy
            Eio.Path.(fs / verified.directory / name)
            ~dst:Eio.Path.(dst / relative)
            ~max_bytes:max_file_bytes
          |> Disk.unwrap
        in
        if not (String.equal hash expected)
        then Json.fail Corrupt_store "export changed while copying portable data");
    Platform.sync_directory dst;
    match Eio.Path.split dst with
    | None -> assert false
    | Some (parent, _) -> Platform.sync_directory parent)
;;
