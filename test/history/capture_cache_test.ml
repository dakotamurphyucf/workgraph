open Core
open Workgraph

let%expect_test
    "current captures avoid replay and historical resolution remains immutable"
  =
  History_test.with_store (fun _env fs root store ->
    ignore (History_test.create store : Jsonaf.t);
    let initial = History_test.current store in
    ignore
      (History_test.append store ~key:"first" [ History_test.input "one" "first" ]
       |> Disk.unwrap
       : Jsonaf.t);
    let current = History_test.current store in
    (* An unusable path makes any accidental current-head replay fail. *)
    let reused =
      Session_store.resolve_capture
        current
        ~fs
        ~root:(root ^ "/absent")
        ~head:(Session_store.Capture.head current)
      |> Disk.unwrap
    in
    let historical =
      Session_store.resolve_capture
        current
        ~fs
        ~root
        ~head:(Session_store.Capture.head initial)
      |> Disk.unwrap
    in
    printf
      "current=%d historical=%d\n"
      (History_test.count reused)
      (History_test.count historical);
    let missing =
      Session_store.resolve_capture current ~fs ~root ~head:(Some (String.make 64 'a'))
    in
    History_test.show missing;
    let empty =
      Session_store.resolve_capture current ~fs ~root ~head:None |> Disk.unwrap
    in
    printf
      "empty=%d current remains=%d\n"
      (Session_store.Capture.sequence empty)
      (History_test.count (History_test.current store)));
  [%expect
    {|
    current=1 historical=0
    Conflict
    empty=0 current remains=1
    |}]
;;

let%expect_test "cache limits, generation and workspace identity" =
  History_test.with_store (fun _env _fs root store ->
    ignore (History_test.create store : Jsonaf.t);
    let capture = History_test.current store in
    let cache = History_capture_cache.create () in
    let add generation weight =
      History_capture_cache.add cache ~root ~generation ~capture ~weight
    in
    let found generation =
      History_capture_cache.find
        cache
        ~root
        ~generation
        ~workspace:History_test.workspace
        ~head:(Session_store.Capture.head capture)
      |> Option.is_some
    in
    add 1 (History_capture_cache.weight capture);
    printf "present=%b wrong generation=%b\n" (found 1) (found 2);
    add 2 1024;
    printf "reopen evicts=%b current=%b\n" (not (found 1)) (found 2);
    add 2 ((16 * 1024 * 1024) + 1);
    printf "oversize bypass=%b\n" (not (found 2));
    List.iter (List.range 0 9) ~f:(fun i ->
      History_capture_cache.add
        cache
        ~root:(root ^ Int.to_string i)
        ~generation:0
        ~capture
        ~weight:1024);
    let has i =
      History_capture_cache.find
        cache
        ~root:(root ^ Int.to_string i)
        ~generation:0
        ~workspace:History_test.workspace
        ~head:(Session_store.Capture.head capture)
      |> Option.is_some
    in
    printf "oldest evicted=%b newest retained=%b\n" (not (has 0)) (has 8);
    let other = Id.Workspace.of_string "other" |> Disk.unwrap in
    printf
      "other workspace=%b\n"
      (History_capture_cache.find
         cache
         ~root:(root ^ "8")
         ~generation:0
         ~workspace:other
         ~head:(Session_store.Capture.head capture)
       |> Option.is_some));
  [%expect
    {|
    present=true wrong generation=false
    reopen evicts=true current=true
    oversize bypass=true
    oldest evicted=true newest retained=true
    other workspace=false
    |}]
;;
