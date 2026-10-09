open Core

(* An in-memory full-duplex transport. The service still uses its real framing,
   dispatcher, worker domains, filesystem persistence and shutdown path. *)
module Flow = struct
  type tag = [ `Generic ]

  type channel =
    { queue : string Eio.Stream.t
    ; mutable closed : bool
    ; changed : Eio.Condition.t
    }

  type t =
    { input : channel
    ; output : channel
    ; mutable pending : string
    ; before_write : unit -> unit
    }

  let channel () =
    { queue = Eio.Stream.create 1024; closed = false; changed = Eio.Condition.create () }
  ;;

  let read_methods = []

  let single_read t buffer =
    if String.is_empty t.pending
    then
      t.pending
      <- Eio.Condition.loop_no_mutex t.input.changed (fun () ->
           match Eio.Stream.take_nonblocking t.input.queue with
           | Some data -> Some data
           | None -> if t.input.closed then raise End_of_file else None);
    let length = Int.min (String.length t.pending) (Cstruct.length buffer) in
    Cstruct.blit_from_string t.pending 0 buffer 0 length;
    t.pending <- String.drop_prefix t.pending length;
    length
  ;;

  let single_write t buffers =
    t.before_write ();
    if t.output.closed then raise End_of_file;
    let bytes = Cstruct.concat buffers |> Cstruct.to_string in
    Eio.Stream.add t.output.queue bytes;
    Eio.Condition.broadcast t.output.changed;
    String.length bytes
  ;;

  let copy t ~src =
    let buffer = Cstruct.create 4096 in
    try
      while true do
        let length = Eio.Flow.single_read src buffer in
        ignore (single_write t [ Cstruct.sub buffer 0 length ] : int)
      done
    with
    | End_of_file -> ()
  ;;

  let close_channel channel =
    channel.closed <- true;
    Eio.Condition.broadcast channel.changed
  ;;

  let shutdown t = function
    | `Receive -> close_channel t.input
    | `Send -> close_channel t.output
    | `All ->
      close_channel t.input;
      close_channel t.output
  ;;

  let close t = shutdown t `All

  let handler =
    Eio.Net.Pi.stream_socket
      (module struct
        type nonrec tag = tag
        type nonrec t = t

        let read_methods = read_methods
        let single_read = single_read
        let single_write = single_write
        let copy = copy
        let shutdown = shutdown
        let close = close
      end)
  ;;

  let pair ?(before_server_write = fun () -> ()) () =
    let left = channel ()
    and right = channel () in
    ( Eio.Resource.T
        ( { input = left; output = right; pending = ""; before_write = (fun () -> ()) }
        , handler )
    , Eio.Resource.T
        ( { input = right
          ; output = left
          ; pending = ""
          ; before_write = before_server_write
          }
        , handler ) )
  ;;
end

module Listener = struct
  type tag = [ `Generic ]
  type t = tag Eio.Net.stream_socket_ty Eio.Resource.t Eio.Stream.t

  let accept t ~sw =
    let flow = Eio.Stream.take t in
    Eio.Switch.on_release sw (fun () -> Eio.Resource.close flow);
    flow, `Unix "in-memory-client"
  ;;

  let close _ = ()
  let listening_addr _ = `Unix "in-memory-service"
end

let connect incoming =
  let client, server = Flow.pair () in
  Eio.Stream.add incoming server;
  client
;;

let listener incoming =
  Eio.Resource.T (incoming, Eio.Net.Pi.listening_socket (module Listener))
;;
