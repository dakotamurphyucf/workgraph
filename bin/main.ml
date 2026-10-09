open Core

let () =
  let code =
    try
      Eio_main.run (fun env ->
        Workgraph.Cli.run ~env (Array.to_list (Sys.get_argv ()) |> List.tl_exn))
    with
    | Workgraph.Platform.Broken_pipe -> 0
  in
  if code <> 0 then Stdlib.exit code
;;
