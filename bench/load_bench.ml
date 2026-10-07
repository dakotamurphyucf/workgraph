open Core
open Workgraph

let () =
  match Sys.get_argv () with
  | [| _; root |] ->
    Eio_main.run (fun env ->
      Eio.Switch.run (fun sw ->
        let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
        let clock = Eio.Stdenv.mono_clock env in
        let output value =
          Eio.Flow.copy_string (Json.canonical value ^ "\n") (Eio.Stdenv.stdout env)
        in
        let measure label f =
          Gc.full_major ();
          let words = Gc.allocated_words () in
          let start = Eio.Time.Mono.now clock in
          let result = f () in
          let elapsed =
            Mtime.span start (Eio.Time.Mono.now clock) |> Mtime.Span.to_float_ns
          in
          let allocated = (Gc.allocated_words () - words) * (Sys.word_size_in_bits / 8) in
          output
            (Json.obj
               [ "operation", Json.string label
               ; "elapsed_ms", Json.string (Float.to_string (elapsed /. 1_000_000.))
               ; "allocated_bytes", Json.int allocated
               ]);
          result
        in
        let store, state =
          measure "recovery" (fun () -> Store.open_existing ~sw ~fs ~root |> Disk.unwrap)
        in
        Exn.protect
          ~finally:(fun () -> Store.close store)
          ~f:(fun () ->
            Gc.full_major ();
            let stats = Gc.stat () in
            output
              (Json.obj
                 [ "operation", Json.string "retained"
                 ; "live_bytes", Json.int (stats.live_words * (Sys.word_size_in_bits / 8))
                 ; "heap_bytes", Json.int (stats.heap_words * (Sys.word_size_in_bits / 8))
                 ; "revision", Json.int (State.revision state)
                 ]);
            List.iter
              [ "ticket.context", Json.obj [ "ticket_id", Json.string "t05000" ]
              ; "workspace.overview", Json.obj []
              ; "search.query", Json.obj [ "text", Json.string "evidence" ]
              ]
              ~f:(fun (method_, params) ->
                for _ = 1 to 3 do
                  ignore
                    (measure method_ (fun () ->
                       State.query state ~method_ ~params |> Disk.unwrap |> Json.canonical)
                     : string)
                done);
            let command =
              Domain_command.Comment_add
                { id = None
                ; target = Ticket (Id.Ticket.of_string "t05000" |> Disk.unwrap)
                ; reply_to = None
                ; kind = Progress
                ; body = "Allocation measurement"
                }
            in
            for _ = 1 to 3 do
              ignore
                (measure "prepare_one_comment" (fun () ->
                   State.prepare
                     state
                     command
                     ~actor:(Id.Actor.of_string "bench" |> Disk.unwrap)
                     ~timestamp:"2026-10-07T00:00:00Z"
                   |> Disk.unwrap)
                 : State.prepared)
            done)))
  | _ -> failwith "usage: load_bench ABSOLUTE_CLOSED_WORKSPACE_ROOT"
;;
