open Core

let wrap
      (Eio.Resource.T (directory, operations), prefix)
      ~before_open_in
      ~after_input_scope
      ~before_close_output
  =
  let module Original = (val Eio.Resource.get operations Eio.Fs.Pi.Dir) in
  let module Decorated = struct
    include Original

    let open_in directory ~sw path =
      before_open_in path;
      let file = Original.open_in directory ~sw path in
      Eio.Switch.on_release sw (fun () -> after_input_scope path);
      file
    ;;

    let open_out directory ~sw ~append ~create path =
      let (Eio.Resource.T (file, file_operations)) =
        Original.open_out directory ~sw ~append ~create path
      in
      let close file =
        before_close_output path;
        Eio.Resource.get file_operations Eio.Resource.Close file
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.Resource.Close, close)
             :: Eio.Resource.bindings file_operations) )
    ;;
  end
  in
  let wrapped : Eio.Fs.dir_ty Eio.Resource.t =
    Eio.Resource.T
      ( directory
      , Eio.Resource.handler
          (Eio.Resource.H (Eio.Fs.Pi.Dir, (module Decorated))
           :: Eio.Resource.bindings operations) )
  in
  wrapped, prefix
;;
