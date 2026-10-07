open Core

module Target = struct
  type t =
    { source : string
    ; root : string
    ; capture : Export_job.Capture.t
    ; manifest_hash : string
    }
end

type t =
  { request_hash : string
  ; token : string
  ; targets : Target.t list
  }

let validate t =
  let digest value =
    if
      String.length value <> 64
      || not
           (String.for_all value ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Corrupt_store "invalid restore digest"
  in
  digest t.request_hash;
  digest t.token;
  if List.is_empty t.targets || List.length t.targets > 1000
  then Json.fail Corrupt_store "restore requires 1..1000 targets";
  let roots = ref String.Set.empty
  and ids = ref String.Set.empty in
  List.iter t.targets ~f:(fun target ->
    let absolute path =
      if (not (Filename.is_absolute path)) || String.mem path '\000'
      then Json.fail Corrupt_store "invalid restore path"
    in
    absolute target.Target.source;
    absolute target.root;
    digest target.manifest_hash;
    let id = Id.Workspace.to_string target.capture.workspace in
    if Set.mem !roots target.root || Set.mem !ids id
    then Json.fail Corrupt_store "duplicate restore target";
    roots := Set.add !roots target.root;
    ids := Set.add !ids id;
    Export_job.Capture.validate target.capture)
;;

let to_json t =
  Json.obj
    [ "request_hash", Json.string t.request_hash
    ; "token", Json.string t.token
    ; ( "targets"
      , `Array
          (List.map t.targets ~f:(fun target ->
             Json.obj
               [ "source", Json.string target.Target.source
               ; "root", Json.string target.root
               ; "capture", Export_job.Capture.to_json target.capture
               ; "manifest_hash", Json.string target.manifest_hash
               ])) )
    ]
;;

let of_json json =
  Json.fields json ~allowed:[ "request_hash"; "token"; "targets" ];
  let t =
    { request_hash = Json.text (Json.field json "request_hash")
    ; token = Json.text (Json.field json "token")
    ; targets =
        List.map
          (Json.list (Json.field json "targets"))
          ~f:(fun json ->
            Json.fields json ~allowed:[ "source"; "root"; "capture"; "manifest_hash" ];
            { Target.source = Json.text (Json.field json "source")
            ; root = Json.text (Json.field json "root")
            ; capture = Export_job.Capture.of_json (Json.field json "capture")
            ; manifest_hash = Json.text (Json.field json "manifest_hash")
            })
    }
  in
  validate t;
  t
;;
