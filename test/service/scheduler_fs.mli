(** Test-only filesystem capability decorator. It retains the provider's native
    resource representation and all other interfaces, including rename and fd
    access. Callbacks may run on any service domain and must synchronize shared
    state. Directory-opening semantics are unchanged; service paths in these tests
    remain rooted in the decorated [fs] capability. *)
val wrap
  :  Eio.Fs.dir_ty Eio.Path.t
  -> before_open_in:(string -> unit)
  -> after_input_scope:(string -> unit)
  -> before_close_output:(string -> unit)
  -> Eio.Fs.dir_ty Eio.Path.t
