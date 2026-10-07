open Core
open Workgraph

let () =
  Eio_main.run (fun env ->
    let workspace = Id.Workspace.of_string "bench" |> Disk.unwrap in
    let actor = Id.Actor.of_string "bench" |> Disk.unwrap in
    let state = ref (State.empty ~workspace ~name:"Query fixture" |> Disk.unwrap) in
    let apply commands =
      let prepared =
        State.prepare
          !state
          (Domain_command.Batch commands)
          ~actor
          ~timestamp:"2026-10-07T00:00:00Z"
        |> Disk.unwrap
      in
      state := State.candidate prepared
    in
    let count = 1000 in
    List.init count ~f:(fun i ->
      let id = Id.Ticket.of_string (sprintf "t%04d" i) |> Disk.unwrap in
      Domain_command.Ticket_create
        { id
        ; title = "Search fixture"
        ; description = String.make 512 'x'
        ; project = None
        ; parent = None
        ; milestone = None
        })
    |> List.chunks_of ~length:32
    |> List.iter ~f:apply;
    List.init count ~f:(fun i ->
      let ticket = Id.Ticket.of_string (sprintf "t%04d" i) |> Disk.unwrap in
      Domain_command.Comment_add
        { id = None
        ; target = Entity_ref.Ticket ticket
        ; reply_to = None
        ; kind = Progress
        ; body = "Needle progress " ^ String.make 512 'x'
        })
    |> List.chunks_of ~length:32
    |> List.iter ~f:apply;
    let clock = Eio.Stdenv.clock env in
    let measure method_ params =
      Gc.full_major ();
      let words = Gc.allocated_words () in
      let start = Eio.Time.now clock in
      let result = State.query !state ~method_ ~params |> Disk.unwrap in
      let elapsed_ms = (Eio.Time.now clock -. start) *. 1000. in
      let bytes_allocated =
        (Gc.allocated_words () - words) * (Sys.word_size_in_bits / 8)
      in
      Eio.Flow.copy_string
        (sprintf
           "%s: %.3f ms, %d allocated bytes, %d response bytes\n"
           method_
           elapsed_ms
           bytes_allocated
           (String.length (Json.canonical result)))
        (Eio.Stdenv.stdout env)
    in
    Eio.Flow.copy_string
      (sprintf
         "fixture: %d tickets, %d comments, revision %d\n"
         count
         count
         (State.revision !state))
      (Eio.Stdenv.stdout env);
    measure "ticket.context" (Json.obj [ "ticket_id", Json.string "t0500" ]);
    measure "workspace.overview" (Json.obj []);
    measure "search.query" (Json.obj [ "text", Json.string "needle" ]))
;;
