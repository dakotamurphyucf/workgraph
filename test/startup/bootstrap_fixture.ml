open Core
open Workgraph

(* Exercise the real bootstrap supervisor without production timing hooks. Its
   child re-executes this fixture, which delays or fails only the serve branch. *)
let () =
  let code =
    Eio_main.run (fun env ->
      let args = Array.to_list (Sys.get_argv ()) |> List.tl_exn in
      let serving =
        match args with
        | [ "serve"; _; _ ] -> true
        | _ -> false
      in
      if serving
      then
        Option.iter (Sys.getenv "WORKGRAPH_STARTUP_FIXTURE_DELAY") ~f:(fun seconds ->
          Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) (Float.of_string seconds));
      if serving && Option.is_some (Sys.getenv "WORKGRAPH_STARTUP_FIXTURE_OWNER")
      then (
        let problem =
          match Sys.getenv "WORKGRAPH_STARTUP_FIXTURE_OWNER" with
          | Some "typed" ->
            Problem.with_details
              (Problem.create Conflict "competing launcher holds this path")
              (Socket_owner { socket_path = List.last_exn args })
          | _ ->
            Problem.create Conflict "socket path already has an active Workgraph owner"
        in
        Platform.write_string
          (Eio.Stdenv.stderr env)
          (Json.canonical (Problem.to_json problem) ^ "\n");
        18)
      else if serving && Option.is_some (Sys.getenv "WORKGRAPH_STARTUP_FIXTURE_FAIL")
      then (
        Platform.write_string
          (Eio.Stdenv.stderr env)
          (Json.canonical
             (Problem.to_json (Problem.create Corrupt_store "fixture recovery failed"))
           ^ "\n");
        17)
      else Cli.run ~env args)
  in
  if code <> 0 then Stdlib.exit code
;;
