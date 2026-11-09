open Core
open Workgraph

exception Header_limit
exception Body_limit
exception Peer_closed

let bounded_header_source ~clock flow =
  let origin = ref (Eio.Time.Mono.now clock) in
  let count = ref 0 in
  let delimiter = ref 0 in
  let next_request () =
    origin := Eio.Time.Mono.now clock;
    count := 0;
    delimiter := 0
  in
  let module Source = struct
    type t = unit

    let read_methods = []

    let single_read () destination =
      let length =
        if !delimiter >= 4
        then Eio.Flow.single_read flow destination
        else (
          let elapsed =
            Mtime.span !origin (Eio.Time.Mono.now clock)
            |> Mtime.Span.to_float_ns
            |> fun ns -> ns /. 1e9
          in
          let remaining = 90. -. elapsed in
          if Float.(remaining <= 0.) then raise Eio.Time.Timeout;
          Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds clock remaining) (fun () ->
            Eio.Flow.single_read flow destination))
      in
      for index = 0 to length - 1 do
        if !delimiter < 4
        then (
          incr count;
          if !count > 32 * 1024 then raise Header_limit;
          let c = Cstruct.get_char destination index in
          delimiter
          := match !delimiter, c with
             | 0, '\r' | 1, '\r' -> 1
             | 1, '\n' -> 2
             | 2, '\r' -> 3
             | 3, '\n' -> 4
             | _, _ -> 0)
      done;
      length
    ;;
  end
  in
  Eio.Resource.T ((), Eio.Flow.Pi.source (module Source)), next_request
;;

let read_body body =
  let buffer = Buffer.create 4096 in
  let chunk = Cstruct.create 16384 in
  let rec loop () =
    match Eio.Flow.single_read body chunk with
    | length ->
      if Buffer.length buffer + length > Framing.max_bytes then raise Body_limit;
      Buffer.add_string buffer (Cstruct.to_string ~len:length chunk);
      loop ()
    | exception End_of_file -> Buffer.contents buffer
  in
  loop ()
;;

let failure ?(kind = Problem.Invalid_argument) status message : Http_router.response =
  { status
  ; headers =
      [ "content-type", "application/json; charset=utf-8"
      ; "cache-control", "no-store"
      ; "x-content-type-options", "nosniff"
      ]
  ; body = Json.canonical (Wire.failure (Problem.create kind message))
  }
;;

let serve ~sw:_ ~clock ~listener ~router =
  let handle flow peer =
    Eio.Switch.run (fun connection_sw ->
      let source, next_request = bounded_header_source ~clock flow in
      let input = Eio.Buf_read.of_flow ~max_size:(64 * 1024) source in
      let callback _ request body =
        let keep_alive =
          ref
            (match Cohttp.Request.version request with
             | `HTTP_1_1 -> Cohttp.Request.is_keep_alive request
             | _ -> false)
        in
        let request : Http_router.request =
          { method_ = Cohttp.Code.string_of_method (Cohttp.Request.meth request)
          ; target = Cohttp.Request.resource request
          ; headers = Cohttp.Header.to_list (Cohttp.Request.headers request)
          ; body = ""
          }
        in
        let response =
          match Http_router.authorize router request with
          | Some rejection ->
            (* The body has not been consumed; it cannot become another request. *)
            keep_alive := false;
            rejection
          | None ->
            (try
               let body =
                 Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds clock 10.) (fun () ->
                   read_body body)
               in
               let declared =
                 Cohttp.Header.get
                   (Cohttp.Header.of_list request.headers)
                   "content-length"
                 |> Option.value_map ~default:0 ~f:Int.of_string
               in
               if String.length body <> declared
               then
                 Json.fail
                   Invalid_argument
                   "HTTP body ended before its declared Content-Length";
               if Eio.Buf_read.buffered_bytes input > 0
               then
                 Json.fail
                   Invalid_argument
                   "extra body or pipelined bytes are unsupported";
               (* Authorization already rejected noncanonical targets, and only
                  this exact method/path receives the bounded long observation.
                  Encoded aliases, queries and unauthorized requests do not. *)
               let dispatch_seconds =
                 if
                   String.equal request.method_ "POST"
                   && String.equal request.target "/ui-api/v1/request-waits"
                 then 310.
                 else 90.
               in
               try
                 Eio.Time.Timeout.run_exn
                   (Eio.Time.Timeout.seconds clock dispatch_seconds)
                   (fun () ->
                      Eio.Fiber.first
                        (fun () -> Http_router.dispatch router { request with body })
                        (fun () ->
                           (* Only this dispatch owns the disconnect observer. It is
                              canceled before writing the response, so it cannot
                              consume the next sequential request. Admitted writes
                              remain children of the service switch. *)
                           if Eio.Buf_read.buffered_bytes input > 0 then raise Peer_closed;
                           let byte = Cstruct.create 1 in
                           match Eio.Flow.single_read flow byte with
                           | _ -> raise Peer_closed
                           | exception End_of_file -> raise Peer_closed))
               with
               | Eio.Time.Timeout ->
                 failure
                   ~kind:Storage_unavailable
                   408
                   "HTTP observation deadline exceeded"
             with
             | Body_limit ->
               keep_alive := false;
               failure 413 "API body exceeds 4MiB"
             | Json.Decode_error problem ->
               keep_alive := false;
               failure 400 problem.message
             | Eio.Time.Timeout ->
               keep_alive := false;
               failure 400 "HTTP body deadline exceeded")
        in
        let send =
          Cohttp_eio.Server.respond_string
            ~status:(Cohttp.Code.status_of_code response.status)
            ~headers:
              (Cohttp.Header.of_list
                 (("connection", if !keep_alive then "keep-alive" else "close")
                  :: response.headers))
            ~body:response.body
            ()
        in
        fun writer ->
          Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds clock 10.) (fun () ->
            (* Pinned Cohttp-eio respond_string writes and flushes its output. *)
            send writer);
          if !keep_alive
          then next_request ()
          else (
            (* Cohttp loops according to the request headers, not the response.
               Stop its reader even when our rejection overrides client reuse. *)
            Eio.Buf_read.consume input (Eio.Buf_read.buffered_bytes input);
            Eio.Flow.shutdown flow `Receive)
      in
      let server = Cohttp_eio.Server.make ~callback () in
      try
        Eio.Buf_write.with_flow flow (fun output ->
          Cohttp_eio.Server.callback server (connection_sw, peer) input output)
      with
      | Header_limit
      | Body_limit
      | Peer_closed
      | Eio.Buf_read.Buffer_limit_exceeded
      | Eio.Time.Timeout
      | End_of_file -> ())
  in
  Eio.Net.run_server
    ~max_connections:64
    ~on_error:(function
      | Eio.Io _ -> ()
      | exn -> raise exn)
    listener
    handle
;;
