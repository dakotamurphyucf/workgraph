open Core

let () =
  let code =
    Eio_main.run (fun env ->
      Workgraph.Cli.run ~env (Array.to_list (Sys.get_argv ()) |> List.tl_exn))
  in
  if code <> 0 then Stdlib.exit code
;;
