open Core
open Workgraph
open Workgraph_ui

let target ?(socket = "/tmp/ui-test.sock") ?(workspace = "demo") () =
  View_settings.Target.create
    ~connection:(State_tests.profile ~socket ())
    ~workspace:(Id.Workspace.of_string workspace |> Disk.unwrap)
;;

let document ?(source = {|{"future_version":42}|}) id =
  View_settings.Document.create ~id:(Id.Resource.of_string id |> Disk.unwrap) ~source
  |> Disk.unwrap
;;

let save store target revision documents selected =
  View_settings.replace
    store
    target
    ~expected_revision:revision
    ~documents
    ~selected_id:
      (Option.map selected ~f:(fun id -> Id.Resource.of_string id |> Disk.unwrap))
;;

let describe snapshot =
  printf
    "revision=%d documents=%d selected=%s\n"
    (View_settings.Snapshot.revision snapshot)
    (List.length (View_settings.Snapshot.documents snapshot))
    (Option.value_map
       (View_settings.Snapshot.selected_id snapshot)
       ~default:"none"
       ~f:Id.Resource.to_string)
;;

let%expect_test "private CAS survives restart; conflict does not rebase a draft" =
  State_tests.with_root (fun _ root ->
    let store = View_settings.create root |> Disk.unwrap in
    let target = target () in
    View_settings.read store target |> Disk.unwrap |> describe;
    save store target 0 [ document "view" ] (Some "view") |> Disk.unwrap |> describe;
    State_tests.problem (save store target 0 [ document "replacement" ] None);
    let restarted = View_settings.create root |> Disk.unwrap in
    View_settings.read restarted target |> Disk.unwrap |> describe;
    let source =
      View_settings.read restarted target
      |> Disk.unwrap
      |> View_settings.Snapshot.documents
      |> List.hd_exn
      |> View_settings.Document.to_json
      |> fun value -> Json.field value "source" |> Json.text
    in
    printf "opaque-source=%s\n" source);
  [%expect
    {| 
    revision=0 documents=0 selected=none
    revision=1 documents=1 selected=view
    Conflict
    revision=1 documents=1 selected=view
    opaque-source={"future_version":42}
    |}]
;;

let%expect_test "global CAS and exact endpoint/workspace buckets never transplant guards" =
  State_tests.with_root (fun _ root ->
    let store = View_settings.create root |> Disk.unwrap in
    let original = target () in
    let other = target ~workspace:"other" () in
    save store original 0 [ document "view" ] None |> Disk.unwrap |> describe;
    State_tests.problem (save store other 0 [ document "view" ] None);
    save store other 1 [ document "view" ] None |> Disk.unwrap |> describe;
    View_settings.read store original |> Disk.unwrap |> describe;
    State_tests.problem
      (View_settings.read store (target ~socket:"/tmp/retargeted.sock" ()));
    State_tests.problem (save store (target ~socket:"/tmp/retargeted.sock" ()) 2 [] None);
    View_settings.read store original |> Disk.unwrap |> ignore;
    save store original 2 [] None |> Disk.unwrap |> describe;
    State_tests.problem (save store original 0 [ document "view" ] None));
  [%expect
    {| 
    revision=1 documents=1 selected=none
    Conflict
    revision=2 documents=1 selected=none
    revision=2 documents=1 selected=none
    Conflict
    Outcome_unknown
    revision=3 documents=0 selected=none
    Conflict
    |}]
;;

let%expect_test
    "duplicate ids missing selection and UTF8/source bounds reject before save"
  =
  State_tests.with_root (fun _ root ->
    let store = View_settings.create root |> Disk.unwrap in
    let target = target () in
    State_tests.problem (save store target 0 [ document "a"; document "a" ] None);
    State_tests.problem (save store target 0 [ document "a" ] (Some "missing"));
    List.iter
      [ String.make 65537 'a'; "\255" ]
      ~f:(fun source ->
        State_tests.problem
          (View_settings.Document.create
             ~id:(Id.Resource.of_string "a" |> Disk.unwrap)
             ~source));
    View_settings.read store target |> Disk.unwrap |> describe);
  [%expect
    {| 
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    revision=0 documents=0 selected=none
    |}]
;;

let%expect_test "capacity includes all targets and canonical escaping overhead" =
  State_tests.with_root (fun _ root ->
    let store = View_settings.create root |> Disk.unwrap in
    let docs source count =
      List.init count ~f:(fun i -> document ~source ("view-" ^ Int.to_string i))
    in
    save store (target ()) 0 (docs (String.make 65536 'a') 25) None
    |> Disk.unwrap
    |> describe;
    State_tests.problem
      (save store (target ~workspace:"other" ()) 1 [ document "extra" ] None);
    State_tests.problem
      (save store (target ()) 1 (docs (String.make 65536 '\001') 25) None);
    View_settings.read store (target ()) |> Disk.unwrap |> describe);
  [%expect
    {| 
    revision=1 documents=25 selected=none
    Invalid_argument
    Invalid_argument
    revision=1 documents=25 selected=none
    |}]
;;

let%expect_test "corrupt unsupported and replaced state never become empty settings" =
  State_tests.with_root (fun _ root ->
    let store = View_settings.create root |> Disk.unwrap in
    save store (target ()) 0 [ document "view" ] None |> Disk.unwrap |> ignore;
    let name = "view-settings.json" in
    let original = State_root.read root ~name |> Disk.unwrap |> Option.value_exn in
    let replace key value =
      match original with
      | `Object fields -> Json.obj (List.Assoc.add fields key value ~equal:String.equal)
      | _ -> assert false
    in
    State_root.save root ~name ~value:(replace "format" (Json.string "future"))
    |> Disk.unwrap;
    State_tests.problem (View_settings.read store (target ()));
    State_tests.problem (save store (target ()) 1 [ document "new" ] None);
    State_root.save root ~name ~value:(replace "revision" (Json.int 0)) |> Disk.unwrap;
    State_tests.problem (View_settings.create root);
    State_root.save root ~name ~value:original |> Disk.unwrap;
    View_settings.read store (target ()) |> Disk.unwrap |> describe;
    Eio.Path.unlink Eio.Path.(State_root.directory root / name);
    State_tests.problem (View_settings.read store (target ()));
    State_tests.problem (save store (target ()) 1 [ document "new" ] None);
    State_root.save root ~name ~value:original |> Disk.unwrap;
    View_settings.read store (target ()) |> Disk.unwrap |> describe;
    save store (target ()) 1 [ document "repaired" ] None |> Disk.unwrap |> describe);
  [%expect
    {| 
    Unsupported_version
    Outcome_unknown
    Corrupt_store
    revision=1 documents=1 selected=none
    Corrupt_store
    Outcome_unknown
    revision=1 documents=1 selected=none
    revision=2 documents=1 selected=none
    |}]
;;

let fault_fs
      ?(failure = Problem.Local_io)
      (Eio.Resource.T (directory, ops), path)
      ~armed
      ~parent_sync
      ~stage_syncs
  =
  let fail_parent = ref false in
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let is_stage name =
    String.is_substring name ~substring:"view-settings.json"
    && String.is_substring name ~substring:".tmp-"
  in
  let module Wrapped = struct
    include Directory

    let open_out directory ~sw ~append ~create name =
      let (Eio.Resource.T (file, file_ops)) =
        Directory.open_out directory ~sw ~append ~create name
      in
      let module File = (val Eio.Resource.get file_ops Eio.File.Pi.Write) in
      let module Wrapped_file = struct
        include File

        let sync file =
          if is_stage name then incr stage_syncs;
          if !armed && (not parent_sync) && is_stage name
          then (
            armed := false;
            Json.fail failure "injected stage file sync failure");
          File.sync file
        ;;
      end
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.File.Pi.Write, (module Wrapped_file))
             :: Eio.Resource.bindings file_ops) )
    ;;

    let rename directory source destination target =
      Directory.rename directory source destination target;
      if !armed && parent_sync && is_stage source then fail_parent := true
    ;;

    let open_in directory ~sw name =
      if !fail_parent
      then (
        fail_parent := false;
        armed := false;
        Json.fail failure "injected parent-directory sync acquisition failure");
      Directory.open_in directory ~sw name
    ;;
  end
  in
  ( Eio.Resource.T
      ( directory
      , Eio.Resource.handler
          (Eio.Resource.H (Eio.Fs.Pi.Dir, (module Wrapped)) :: Eio.Resource.bindings ops)
      )
  , path )
;;

let%expect_test
    "post-install sync failure fences saved guards until explicit durable read"
  =
  List.iter [ Problem.Local_io; Problem.Conflict ] ~f:(fun failure ->
    printf "original=%s\n" (Sexp.to_string (Problem.sexp_of_kind failure));
    State_tests.with_root (fun env original ->
      let armed = ref false in
      let fs =
        fault_fs
          ~failure
          (Eio.Stdenv.fs env)
          ~armed
          ~parent_sync:true
          ~stage_syncs:(ref 0)
      in
      Eio.Switch.run (fun sw ->
        let root =
          State_root.acquire
            ~sw
            ~fs
            ~random:(Eio.Stdenv.secure_random env)
            ~path:(Filename.concat (State_root.path original) "settings-fault")
          |> Disk.unwrap
        in
        let store = View_settings.create root |> Disk.unwrap in
        armed := true;
        (match save store (target ()) 0 [ document "view" ] None with
         | Ok _ -> failwith "Expected injected post-install failure"
         | Error problem ->
           State_tests.problem (Error problem);
           printf
             "original-cause-retained=%b\n"
             (String.is_substring
                problem.message
                ~substring:(Sexp.to_string (Problem.sexp_of_kind failure))));
        State_tests.problem (save store (target ()) 0 [ document "different" ] None);
        View_settings.read store (target ()) |> Disk.unwrap |> describe;
        let restarted = View_settings.create root |> Disk.unwrap in
        View_settings.read restarted (target ()) |> Disk.unwrap |> describe;
        State_tests.problem (save store (target ()) 0 [ document "different" ] None);
        save store (target ()) 1 [ document "explicit-new" ] None
        |> Disk.unwrap
        |> describe)));
  [%expect
    {|
    original=Local_io
    Outcome_unknown
    original-cause-retained=true
    Outcome_unknown
    revision=1 documents=1 selected=none
    revision=1 documents=1 selected=none
    Conflict
    revision=2 documents=1 selected=none
    original=Conflict
    Outcome_unknown
    original-cause-retained=true
    Outcome_unknown
    revision=1 documents=1 selected=none
    revision=1 documents=1 selected=none
    Conflict
    revision=2 documents=1 selected=none
    |}]
;;

let%expect_test "private HTTP CAS uses retained profiles and never needs a live daemon" =
  State_tests.with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let router, profiles, _, _ = Http_tests.router env root ~sw ~host:Http_tests.host in
      Connection_profile.Store.put
        profiles
        (State_tests.profile ())
        ~expected_generation:None
      |> Disk.unwrap;
      let router =
        Http_router.with_view_settings router (View_settings.create root |> Disk.unwrap)
      in
      let invoke action body =
        let response =
          Http_router.dispatch
            router
            (Http_tests.request
               ~method_:"POST"
               ~body
               ("/ui-api/v1/view-settings/" ^ action))
        in
        printf "status=%d\n" response.status;
        response
      in
      let base = {|"connection_id":"local","generation":"1","workspace_id":"demo"|} in
      let response = invoke "inspect" ("{" ^ base ^ "}") in
      printf
        "revision=%s\n"
        (Json.field (Http_tests.data response) "revision" |> Json.text);
      let body =
        "{"
        ^ base
        ^ {|,"expected_revision":"0","documents":[{"id":"view","source":"future opaque"}],"selected_id":"view"}|}
      in
      let response = invoke "replace" body in
      printf
        "revision=%s\n"
        (Json.field (Http_tests.data response) "revision" |> Json.text);
      ignore (invoke "replace" body : Http_router.response);
      ignore
        (invoke
           "inspect"
           {|{"connection_id":"local","generation":"2","workspace_id":"demo"}|}
         : Http_router.response);
      ignore
        (invoke "inspect" ("{" ^ base ^ {|,"unexpected":true}|}) : Http_router.response)));
  [%expect
    {|
    status=200
    revision=0
    status=200
    revision=1
    status=409
    status=404
    status=400
    |}]
;;

let%expect_test
    "bounded inventory preserves old target identity for explicit capacity cleanup"
  =
  State_tests.with_root (fun _ root ->
    let store = View_settings.create root |> Disk.unwrap in
    save store (target ()) 0 [ document "old" ] (Some "old") |> Disk.unwrap |> ignore;
    save store (target ~workspace:"other" ()) 1 [ document "other" ] None
    |> Disk.unwrap
    |> ignore;
    let summary = View_settings.list store |> Disk.unwrap in
    let items = Json.field summary "items" |> Json.list in
    printf
      "revision=%s buckets=%d\n"
      (Json.field summary "revision" |> Json.text)
      (List.length items);
    let old = List.hd_exn items in
    printf
      "socket=%s documents=%s\n"
      (Json.field (Json.field (Json.field old "target") "connection") "socket"
       |> Json.text)
      (Json.field old "document_ids" |> Json.canonical);
    save store (target ()) 2 [] None |> Disk.unwrap |> ignore;
    let summary = View_settings.list store |> Disk.unwrap in
    printf
      "remaining-buckets=%d\n"
      (Json.field summary "items" |> Json.list |> List.length));
  [%expect
    {|
    revision=2 buckets=2
    socket=/tmp/ui-test.sock documents=["old"]
    remaining-buckets=1
    |}]
;;
