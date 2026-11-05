open Core
open Workgraph

let registration =
  { Registry.Registration.root = "/tmp/work"
  ; known_name = "Checkpoint 💖"
  ; is_open = false
  ; known_head = None
  ; known_history_head = None
  }
;;

let registry registration =
  { Registry.empty with registrations = String.Map.singleton "work" registration }
;;

let report result =
  match result with
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let%expect_test "durable names roundtrip and reject missing or malformed checkpoints" =
  let encoded = Registry.encode (registry registration) |> Disk.unwrap in
  report (Registry.decode encoded);
  List.iter
    [ ""; " "; String.make 513 'a'; "\255" ]
    ~f:(fun known_name ->
      report (Registry.encode (registry { registration with known_name })));
  let parsed = Json.parse encoded |> Disk.unwrap in
  let entry = Json.field (Json.field parsed "workspaces") "work" in
  let replace_entry entry =
    match parsed with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "workspaces" then Json.obj [ "work", entry ] else value )))
      |> Json.canonical
      |> Registry.decode
    | _ -> assert false
  in
  let fields =
    match entry with
    | `Object fields -> fields
    | _ -> assert false
  in
  report
    (replace_entry
       (Json.obj
          (List.filter fields ~f:(fun (key, _) -> not (String.equal key "known_name")))));
  report
    (replace_entry
       (Json.obj
          (("known_name", Json.string " ")
           :: List.filter fields ~f:(fun (key, _) -> not (String.equal key "known_name"))
          )));
  [%expect
    {|
    ok
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Invalid_argument
    Corrupt_store |}]
;;

let%expect_test "name provenance is validated independently of name value" =
  let capture ~name ~archived ~is_open =
    Administration_wire.Health.capture
      (registry registration)
      ~registry_requires_restart:false
      ~active_exports:0
      ~workspace_status:(fun _ -> name, archived, is_open, None, None)
  in
  let loaded = capture ~name:(Some "Renamed") ~archived:(Some false) ~is_open:true in
  let closed = capture ~name:None ~archived:None ~is_open:false in
  List.iter [ loaded; closed ] ~f:(fun health ->
    let value = Api_codec.encode Administration_wire.Health.codec health |> Disk.unwrap in
    let workspace = Json.field value "workspaces" |> Json.list |> List.hd_exn in
    print_endline (Json.text (Json.field workspace "name"));
    print_endline (Json.text (Json.field workspace "name_source")));
  report
    (Api_codec.encode
       Administration_wire.Health.codec
       (capture ~name:None ~archived:(Some false) ~is_open:true));
  report
    (Api_codec.encode
       Administration_wire.Health.codec
       (capture ~name:(Some "not loaded") ~archived:None ~is_open:false));
  let value = Api_codec.encode Administration_wire.Health.codec closed |> Disk.unwrap in
  let workspace = Json.field value "workspaces" |> Json.list |> List.hd_exn in
  let fields =
    match workspace with
    | `Object fields -> fields
    | _ -> assert false
  in
  List.iter
    [ "name", Json.string " "
    ; "name_source", Json.string "invented"
    ; "name_source", Json.string "current"
    ]
    ~f:(fun (key, field) ->
      let workspace =
        Json.obj
          ((key, field)
           :: List.filter fields ~f:(fun (name, _) -> not (String.equal key name)))
      in
      let value =
        match value with
        | `Object fields ->
          Json.obj
            (List.map fields ~f:(fun (name, field) ->
               ( name
               , if String.equal name "workspaces" then `Array [ workspace ] else field )))
        | _ -> assert false
      in
      report (Api_codec.decode Administration_wire.Health.codec value));
  [%expect
    {|
    Renamed
    current
    Checkpoint 💖
    last_known
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;
