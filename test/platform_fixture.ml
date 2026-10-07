open Core
open Workgraph

let () =
  Eio_main.run (fun env ->
    let root =
      match Array.to_list (Sys.get_argv ()) with
      | [ _; root ] -> root
      | _ -> failwith "root required"
    in
    let fs = Eio.Stdenv.fs env in
    let src = Eio.Path.(fs / root / "source")
    and dst = Eio.Path.(fs / root / "destination") in
    let rejected = Disk.protect (fun () -> Platform.rename_exclusive ~src ~dst) in
    (match rejected with
     | Error error when Problem.equal_kind error.kind Conflict -> ()
     | _ -> failwith "existing directory was not rejected");
    Eio.Path.rmdir dst;
    Platform.rename_exclusive ~src ~dst;
    if not (String.equal (Disk.read Eio.Path.(dst / "marker")) "source data")
    then failwith "rename lost source";
    let missing =
      Disk.protect (fun () ->
        Platform.rename_exclusive
          ~src
          ~dst:Eio.Path.(fs / root / "missing-parent" / "target"))
    in
    (match missing with
     | Error error when Problem.equal_kind error.kind Storage_unavailable -> ()
     | _ -> failwith "missing source did not produce typed storage error");
    Eio.Flow.copy_string
      "exclusive directory publication passed\n"
      (Eio.Stdenv.stdout env))
;;
