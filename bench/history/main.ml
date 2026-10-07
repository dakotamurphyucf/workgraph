open Core
open Workgraph

let workspace = Id.Workspace.of_string "wg35-history-bench" |> Disk.unwrap
let actor = Id.Actor.of_string "wg35-bench" |> Disk.unwrap

let unwrap = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let make_text ~session_index ~event_index =
  let marker =
    if session_index = 2 && event_index = 60 then "wg35-hit-marker" else "wg35-event"
  in
  let prefix = sprintf "session=%d event=%d %s " session_index event_index marker in
  prefix ^ String.make (2048 - String.length prefix) 'x'
;;

let make_input ~session_index ~event_index =
  let text = make_text ~session_index ~event_index in
  Session_event.Input.create
    ~client_id:(sprintf "session-%d-event-%03d" session_index event_index)
    ~role:"assistant"
    ~kind:"message"
    ~phase:"completed"
    ~payload:(Session_event.Content.Inline text)
    ~searchable_text:(Session_event.Content.Inline text)
    ~attachments:[]
    ()
  |> unwrap
;;

let elapsed_ms clock f =
  let start = Eio.Time.now clock in
  let result = f () in
  let elapsed = (Eio.Time.now clock -. start) *. 1000. in
  result, elapsed
;;

let emit env label elapsed_ms =
  Eio.Flow.copy_string (sprintf "%s: %.3f ms\n" label elapsed_ms) (Eio.Stdenv.stdout env)
;;

let measure_search index capture ~text =
  History_index.search index capture ~text ~limit:10 ~max_bytes:65_536 () |> unwrap
;;

let run env root =
  let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
  let clock = Eio.Stdenv.clock env in
  let root_path = Eio.Path.(fs / root) in
  (match Eio.Path.kind ~follow:false root_path with
   | `Not_found -> Eio.Path.mkdir ~perm:0o700 root_path
   | _ -> failwith "benchmark root must be a fresh, nonexistent path");
  Exn.protect
    ~finally:(fun () -> Eio.Path.rmtree root_path)
    ~f:(fun () ->
      Disk.ensure_directory Eio.Path.(fs / root / "blobs");
      let store = Session_store.open_existing ~fs ~root ~workspace |> unwrap in
      let sessions =
        List.init 5 ~f:(fun session_index ->
          let id = Session_id.of_string (sprintf "session-%d" session_index) |> unwrap in
          let metadata =
            Session.create
              ~workspace
              ~id
              ~title:(sprintf "History benchmark %d" session_index)
              ~actor
              ~scopes:[ Entity_ref.Workspace ]
              ()
            |> unwrap
          in
          ignore
            (Session_store.create
               store
               metadata
               ~key:(sprintf "wg35-bench:create-s%d" session_index)
               ~request_hash:(Json.hash (sprintf "create:%d" session_index))
             |> unwrap
             : Jsonaf.t);
          id)
      in
      let (), append_ms =
        elapsed_ms clock (fun () ->
          List.iteri sessions ~f:(fun session_index session ->
            List.init 120 ~f:(fun offset ->
              make_input ~session_index ~event_index:(offset + 1))
            |> List.chunks_of ~length:32
            |> List.iteri ~f:(fun batch_index inputs ->
              ignore
                (Session_store.append
                   store
                   ~session
                   ~actor
                   ~inputs
                   ~key:(sprintf "wg35-bench:append-s%d-b%d" session_index batch_index)
                   ~request_hash:
                     (Json.hash (sprintf "append:%d:%d" session_index batch_index))
                   ()
                 |> unwrap
                 : Jsonaf.t)));
          ())
      in
      emit env "batched append (600 events)" append_ms;
      let reopened, reopen_ms =
        elapsed_ms clock (fun () ->
          Session_store.open_existing ~fs ~root ~workspace |> unwrap)
      in
      emit env "reopen" reopen_ms;
      let capture = Session_store.capture reopened |> unwrap in
      let counts =
        List.map sessions ~f:(fun session ->
          Session_store.Capture.upper_bound capture ~session)
      in
      let total_events = List.fold counts ~init:0 ~f:( + ) in
      if total_events <> 600 || not (List.for_all counts ~f:(Int.equal 120))
      then failwith "captured event counts do not match the benchmark fixture";
      Eio.Flow.copy_string
        (sprintf
           "verified event counts: %d sessions x 120 = %d\n"
           (List.length sessions)
           total_events)
        (Eio.Stdenv.stdout env);
      let index = History_index.create ~fs ~root in
      let (), index_ms =
        elapsed_ms clock (fun () -> History_index.rebuild index capture |> unwrap)
      in
      emit env "derived index build" index_ms;
      let hit, hit_ms =
        elapsed_ms clock (fun () -> measure_search index capture ~text:"wg35-hit-marker")
      in
      let miss, miss_ms =
        elapsed_ms clock (fun () ->
          measure_search index capture ~text:"wg35-absent-marker")
      in
      emit env "fixed query hit" hit_ms;
      emit env "fixed query miss" miss_ms;
      let hit_count = Json.list (Json.field hit "items") |> List.length in
      let miss_count = Json.list (Json.field miss "items") |> List.length in
      if hit_count <> 1 || miss_count <> 0
      then failwith "fixed query results were unexpected";
      Eio.Flow.copy_string
        (sprintf "verified query results: hit=%d miss=%d\n" hit_count miss_count)
        (Eio.Stdenv.stdout env);
      Gc.full_major ();
      let live_words = (Gc.stat ()).live_words in
      Eio.Flow.copy_string
        (sprintf
           "retained OCaml live words after full_major: %d (%.2f MiB heap estimate; not \
            process RSS)\n"
           live_words
           (Float.of_int (live_words * (Sys.word_size_in_bits / 8)) /. 1_048_576.))
        (Eio.Stdenv.stdout env))
;;

let () =
  match Sys.get_argv () with
  | [| _; root |] when Filename.is_absolute root -> Eio_main.run (fun env -> run env root)
  | _ -> failwith "usage: main.exe ABSOLUTE_FRESH_TEMP_ROOT"
;;
