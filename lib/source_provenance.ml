open Core

type observation =
  { root : string
  ; head : string option
  ; paths_sha256 : string
  ; contents_sha256 : string
  ; listed_paths : int
  ; hashed_paths : int
  ; hashed_bytes : int
  ; omissions : (string * int) list
  }

type t =
  | Not_requested
  | Unavailable of
      { root : string
      ; reason : string
      }
  | Git of observation

let not_requested = Not_requested

let root = function
  | Not_requested -> None
  | Unavailable { root; _ } | Git { root; _ } -> Some root
;;

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let root_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:4096)
    ~decode:(fun root ->
      Json.decode (fun () ->
        if (not (Filename.is_absolute root)) || String.mem root '\000'
        then Json.fail Invalid_argument "source root must be an absolute path without NUL";
        root))
    ~encode:Fn.id
    ~description:"Explicit absolute Git working-tree root."
;;

let unavailable ~root ~reason =
  Json.decode (fun () ->
    Api_codec.encode root_codec root |> unwrap |> ignore;
    Api_codec.encode (Api_codec.text ~max_bytes:4096) reason |> unwrap |> ignore;
    if String.is_empty (String.strip reason)
    then Json.fail Invalid_argument "source unavailability requires a reason";
    Unavailable { root; reason })
;;

let digest_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun digest ->
      Json.decode (fun () ->
        if
          String.length digest <> 64
          || not
               (String.for_all digest ~f:(fun c ->
                  Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
        then Json.fail Invalid_argument "invalid source SHA256";
        digest))
    ~encode:Fn.id
    ~description:"Lowercase SHA256."
;;

let head_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun head ->
      Json.decode (fun () ->
        if
          (not (List.mem [ 40; 64 ] (String.length head) ~equal:Int.equal))
          || not
               (String.for_all head ~f:(fun c ->
                  Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
        then Json.fail Invalid_argument "invalid Git HEAD object identity";
        head))
    ~encode:Fn.id
    ~description:"Git SHA1 or SHA256 object identity."
;;

let observation_codec =
  let open Api_codec in
  object_
    Fields.(
      both
        (both (required "root" root_codec) (required "head" (nullable head_codec)))
        (both
           (both
              (required "paths_sha256" digest_codec)
              (required "contents_sha256" digest_codec))
           (both
              (both
                 (required "listed_paths" (decimal ~max:4194304))
                 (required "hashed_paths" (decimal ~max:10000)))
              (both
                 (required "hashed_bytes" (decimal ~max:67108864))
                 (required
                    "omissions"
                    (dictionary (decimal ~max:4194304) ~max_items:32 ~max_key_bytes:96))))))
  |> map
       ~decode:
         (fun
           ( (root, head)
           , ( (paths_sha256, contents_sha256)
             , ((listed_paths, hashed_paths), (hashed_bytes, omissions)) ) ) ->
         Json.decode (fun () ->
           if
             hashed_paths > listed_paths
             || List.exists omissions ~f:(fun (_, count) -> count <= 0)
           then Json.fail Invalid_argument "invalid source observation counts";
           if List.is_empty omissions && hashed_paths <> listed_paths
           then Json.fail Invalid_argument "source observation silently omits paths";
           { root
           ; head
           ; paths_sha256
           ; contents_sha256
           ; listed_paths
           ; hashed_paths
           ; hashed_bytes
           ; omissions =
               List.sort omissions ~compare:(fun (a, _) (b, _) -> String.compare a b)
           }))
       ~encode:
         (fun
           { root
           ; head
           ; paths_sha256
           ; contents_sha256
           ; listed_paths
           ; hashed_paths
           ; hashed_bytes
           ; omissions
           } ->
         ( (root, head)
         , ( (paths_sha256, contents_sha256)
           , ((listed_paths, hashed_paths), (hashed_bytes, omissions)) ) ))
       ~description:
         "Git tracked and nonignored untracked working files only. Missing tracked paths \
          and symlink target bytes participate. Omissions make identity incomplete."
;;

let codec =
  let open Api_codec in
  let none =
    object_ Fields.(required "kind" (literal "not_requested"))
    |> map
         ~decode:(fun () -> Ok Not_requested)
         ~encode:(function
           | Not_requested -> ()
           | Unavailable _ | Git _ -> Json.fail Invalid_argument "not requested branch")
         ~description:"No source root supplied."
  in
  let absent =
    object_
      Fields.(
        both
          (required "kind" (literal "unavailable"))
          (both (required "root" root_codec) (required "reason" (text ~max_bytes:4096))))
    |> map
         ~decode:(fun ((), (root, reason)) -> unavailable ~root ~reason)
         ~encode:(function
           | Unavailable { root; reason } -> (), (root, reason)
           | Not_requested | Git _ -> Json.fail Invalid_argument "unavailable branch")
         ~description:"Requested source provenance could not be observed."
  in
  let git =
    merge_objects (object_ Fields.(required "kind" (literal "git"))) observation_codec
    |> map
         ~decode:(fun ((), observation) -> Ok (Git observation))
         ~encode:(function
           | Git observation -> (), observation
           | Not_requested | Unavailable _ -> Json.fail Invalid_argument "Git branch")
         ~description:
           "Bounded non-atomic Git working-tree observation, excluding ignored files and \
            submodule contents."
  in
  tagged
    ~discriminator:"kind"
    ~cases:[ "not_requested", none; "unavailable", absent; "git", git ]
    ~select:(function
      | Not_requested -> "not_requested"
      | Unavailable _ -> "unavailable"
      | Git _ -> "git")
;;

let identity = function
  | Not_requested | Unavailable _ -> None
  | Git observation ->
    if List.is_empty observation.omissions
    then
      Some
        (Api_codec.encode observation_codec observation
         |> unwrap
         |> Json.canonical
         |> Json.hash)
    else None
;;

let drift ~before ~after =
  match identity before, identity after with
  | Some before, Some after -> Some (not (String.equal before after))
  | None, _ | _, None -> None
;;

let capture ~env ~root =
  let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
  let path = Eio.Path.(fs / root) in
  let unavailable reason = unavailable ~root ~reason |> unwrap in
  Api_codec.encode root_codec root |> unwrap |> ignore;
  let observe () =
    Disk.require_directory path;
    let git ?(allow_missing_head = false) args =
      let parser input =
        let buffer = Buffer.create 4096 in
        let rec loop () =
          if Eio.Buf_read.at_end_of_input input
          then Buffer.contents buffer
          else (
            let chunk = Eio.Buf_read.peek input in
            let length = Cstruct.length chunk in
            if Buffer.length buffer + length > 4194304
            then Json.fail Blocked "Git enumeration exceeds 4MiB";
            Buffer.add_string buffer (Cstruct.to_string chunk);
            Eio.Buf_read.consume input length;
            loop ())
        in
        loop ()
      in
      Eio.Path.with_open_out
        ~create:`Never
        Eio.Path.(fs / "/dev/null")
        (fun stderr ->
           Eio.Process.parse_out
             (Eio.Stdenv.process_mgr env)
             ~cwd:path
             ~stdin:(Eio.Flow.string_source "")
             ~stderr
             ~is_success:(fun code -> code = 0 || (allow_missing_head && code = 128))
             parser
             ("git" :: args))
    in
    let canonical_root = Platform.realpath root in
    let reported_root =
      match String.chop_suffix (git [ "rev-parse"; "--show-toplevel" ]) ~suffix:"\n" with
      | Some root -> root
      | None -> Json.fail Invalid_argument "Git did not report its working-tree root"
    in
    if not (String.equal (Platform.realpath reported_root) canonical_root)
    then Json.fail Invalid_argument "source root must be the Git working-tree root";
    let get_head () =
      let text =
        String.strip (git ~allow_missing_head:true [ "rev-parse"; "--verify"; "HEAD" ])
      in
      if String.is_empty text
      then None
      else Some (Api_codec.decode head_codec (Json.string text) |> unwrap)
    in
    let enumerate () =
      git [ "ls-files"; "-z"; "--cached"; "--others"; "--exclude-standard" ]
    in
    let head = get_head () in
    let listing = enumerate () in
    let paths =
      String.split listing ~on:'\000'
      |> List.filter ~f:(Fn.non String.is_empty)
      |> List.dedup_and_sort ~compare:String.compare
    in
    let omissions = ref String.Map.empty in
    let omit reason count =
      omissions
      := Map.update !omissions reason ~f:(fun previous ->
           Option.value previous ~default:0 + count)
    in
    let bytes = ref 0 in
    let hashed = ref 0 in
    let ctx = ref Digestif.SHA256.empty in
    let feed relative fields =
      incr hashed;
      ctx
      := Digestif.SHA256.feed_string
           !ctx
           (Json.canonical
              (Json.obj
                 (("path_base64", Json.string (Base64.encode_exn relative)) :: fields))
            ^ "\n")
    in
    let safe_path relative =
      let components = String.split relative ~on:'/' in
      if
        Filename.is_absolute relative
        || List.exists components ~f:(fun part ->
          String.is_empty part || String.equal part "." || String.equal part "..")
      then false
      else (
        let rec parents parent = function
          | [] | [ _ ] -> true
          | name :: rest ->
            let child = Eio.Path.(parent / name) in
            (match Eio.Path.kind ~follow:false child with
             | `Directory -> parents child rest
             | `Not_found -> true
             | _ -> false)
        in
        parents path components)
    in
    let same_stat (a : Eio.File.Stat.t) (b : Eio.File.Stat.t) =
      Int64.equal a.dev b.dev
      && Int64.equal a.ino b.ino
      && Int.equal a.perm b.perm
      && Optint.Int63.equal a.size b.size
      && Float.equal a.mtime b.mtime
      && Float.equal a.ctime b.ctime
    in
    List.iteri paths ~f:(fun index relative ->
      if index >= 10000
      then omit "path_limit" 1
      else if not (safe_path relative)
      then omit "unsafe_path_or_symlink_ancestor" 1
      else (
        let file = Eio.Path.(path / relative) in
        let inspect () =
          match Eio.Path.kind ~follow:false file with
          | `Not_found -> feed relative [ "kind", Json.string "missing" ]
          | `Symbolic_link ->
            let before = Eio.Path.stat ~follow:false file in
            let target = Eio.Path.read_link file in
            if not (same_stat before (Eio.Path.stat ~follow:false file))
            then omit "symlink_changed_during_scan" 1
            else
              feed
                relative
                [ "kind", Json.string "symlink"
                ; "target_base64", Json.string (Base64.encode_exn target)
                ; "mode", Json.int before.perm
                ]
          | `Regular_file ->
            let before = Eio.Path.stat ~follow:false file in
            if
              Optint.Int63.compare before.size (Optint.Int63.of_int (8 * 1024 * 1024)) > 0
            then omit "file_byte_limit" 1
            else if
              Optint.Int63.compare before.size (Optint.Int63.of_int (67108864 - !bytes))
              > 0
            then omit "total_byte_limit" 1
            else (
              let remaining = 67108864 - !bytes in
              let digest, size =
                File_content.inspect
                  file
                  ~max_bytes:(Int.max 1 (Int.min (8 * 1024 * 1024) remaining))
                |> unwrap
              in
              if size > remaining
              then omit "total_byte_limit" 1
              else (
                bytes := !bytes + size;
                if not (same_stat before (Eio.Path.stat ~follow:false file))
                then omit "file_changed_during_scan" 1
                else
                  feed
                    relative
                    [ "kind", Json.string "file"
                    ; "sha256", Json.string digest
                    ; "size_bytes", Json.int size
                    ; "mode", Json.int before.perm
                    ]))
          | `Directory -> omit "submodule_or_directory" 1
          | _ -> omit "unsupported_entry" 1
        in
        match Disk.protect inspect with
        | Ok () -> ()
        | Error _ -> omit "file_read_failed" 1));
    if
      (not (String.equal listing (enumerate ())))
      || not (Option.equal String.equal head (get_head ()))
    then omit "git_state_changed_during_scan" 1;
    Git
      { root
      ; head
      ; paths_sha256 = Json.hash listing
      ; contents_sha256 = Digestif.SHA256.(get !ctx |> to_hex)
      ; listed_paths = List.length paths
      ; hashed_paths = !hashed
      ; hashed_bytes = !bytes
      ; omissions = Map.to_alist !omissions
      }
  in
  try
    match
      Disk.protect (fun () ->
        Eio.Time.Timeout.run_exn
          (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 10.)
          observe)
    with
    | Ok observation -> observation
    | Error problem -> unavailable (String.prefix problem.message 4096)
  with
  | Eio.Time.Timeout -> unavailable "source observation exceeded 10 seconds"
;;
