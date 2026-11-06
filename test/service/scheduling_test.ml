open Core
open Workgraph

let ok = Disk.unwrap
let request = Service_test.request

module Gate = struct
  type t =
    { armed : bool Atomic.t
    ; entered : unit Eio.Promise.t
    ; notify_entered : unit Eio.Promise.u
    ; released : bool Atomic.t
    ; release : unit Eio.Promise.t
    ; allow : unit Eio.Promise.u
    }

  let create () =
    let entered, notify_entered = Eio.Promise.create () in
    let release, allow = Eio.Promise.create () in
    { armed = Atomic.make false
    ; entered
    ; notify_entered
    ; released = Atomic.make false
    ; release
    ; allow
    }
  ;;

  let arm t = Atomic.set t.armed true

  let enter t =
    if Atomic.compare_and_set t.armed true false
    then (
      Eio.Promise.resolve t.notify_entered ();
      Eio.Promise.await t.release)
  ;;

  let await t = Eio.Promise.await t.entered

  let release t =
    Atomic.set t.released true;
    Eio.Promise.resolve t.allow ()
  ;;
end

let with_root f =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let nonce = Cstruct.create 16 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let root = "/tmp/workgraph-scheduling-" ^ Json.hash (Cstruct.to_string nonce) in
    Disk.ensure_directory Eio.Path.(fs / root);
    let root = Platform.realpath root in
    Exn.protect
      ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / root))
      ~f:(fun () ->
        Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 10. (fun () -> f env root)))
;;

let decorated_env (env : Eio_unix.Stdenv.base) fs : Eio_unix.Stdenv.base =
  object
    method stdin = env#stdin
    method stdout = env#stdout
    method stderr = env#stderr
    method net = env#net
    method domain_mgr = env#domain_mgr
    method process_mgr = env#process_mgr
    method clock = env#clock
    method mono_clock = env#mono_clock
    method fs = fs
    method cwd = env#cwd
    method secure_random = env#secure_random
    method debug = env#debug
    method backend_id = env#backend_id
  end
;;

module Harness = struct
  type t =
    { incoming : [ `Generic ] Eio.Net.stream_socket_ty Eio.Resource.t Eio.Stream.t
    ; finished : unit Eio.Promise.or_exn
    }

  let run env root f =
    Eio.Switch.run (fun sw ->
      let incoming = Eio.Stream.create 64 in
      let finished =
        Eio.Fiber.fork_promise ~sw (fun () ->
          Service.serve
            ~env
            ~registry:(root ^ "/registry")
            ~listener:(Memory_transport.listener incoming))
      in
      f { incoming; finished })
  ;;

  let submit t method_ params =
    let flow = Memory_transport.connect t.incoming in
    Framing.write flow (request method_ params);
    flow
  ;;

  let response flow =
    Exn.protect
      ~finally:(fun () -> Eio.Resource.close flow)
      ~f:(fun () -> Framing.read flow)
  ;;

  let data response =
    match Json.optional response "result" with
    | Some result -> Api_response.of_json result |> ok |> Api_response.data
    | None -> failwith (Json.canonical response)
  ;;

  let call t method_ params = submit t method_ params |> response
  let read t method_ params = call t method_ params |> data
  let scope = [ "workspace_id", Json.string "history" ]

  let mutate t method_ key params =
    let response =
      call
        t
        method_
        (scope
         @ [ "actor_id", Json.string "agent"; "mutation_id", Json.string key ]
         @ params)
    in
    let result = Api_response.of_json (Json.field response "result") |> ok in
    Api_response.require_durable result |> ok;
    Api_response.data result
  ;;

  let rejected t method_ key params =
    let response =
      call
        t
        method_
        (scope
         @ [ "actor_id", Json.string "agent"; "mutation_id", Json.string key ]
         @ params)
    in
    Json.field (Json.field (Json.field response "error") "data") "kind" |> Json.text
  ;;

  let create t root =
    ignore
      (mutate
         t
         "workspace.create"
         "workspace"
         [ "name", Json.string "History"; "root", Json.string (root ^ "/workspace") ]
       : Jsonaf.t);
    ignore
      (mutate
         t
         "session.create"
         "session"
         [ "session_id", Json.string "chat"; "title", Json.string "Chat" ]
       : Jsonaf.t)
  ;;

  let append t =
    let event =
      Session_event.Input.create
        ~client_id:"one"
        ~phase:"completed"
        ~attachments:[]
        ~role:"tool"
        ~kind:"result"
        ~payload:(Inline "opaque-body")
        ~searchable_text:(Inline "needle")
        ()
      |> ok
      |> Api_codec.encode History_wire.input
      |> ok
    in
    ignore
      (mutate
         t
         "session.append"
         "append"
         [ "session_id", Json.string "chat"; "events", `Array [ event ] ]
       : Jsonaf.t)
  ;;

  let search t = submit t "history.search" (scope @ [ "text", Json.string "needle" ])
  let barrier t = ignore (read t "daemon.health" [] : Jsonaf.t)

  let shutdown t =
    ignore (read t "daemon.shutdown" [] : Jsonaf.t);
    Eio.Promise.await_exn t.finished
  ;;
end

let is_index path =
  String.is_substring path ~substring:"/.local/history-index/"
  && String.is_suffix path ~suffix:".text"
;;

let%expect_test
    "slow-lane saturation isolates fast reads and writes and releases disconnected pins"
  =
  with_root (fun env root ->
    let gate = Gate.create () in
    let heads = Eio.Stream.create 32 in
    let observe = Atomic.make false in
    let fs =
      Scheduler_fs.wrap
        (Eio.Stdenv.fs env)
        ~before_open_in:(fun path ->
          if
            Atomic.get observe && String.equal path (root ^ "/workspace/history/HEAD.json")
          then Eio.Stream.add heads ();
          if is_index path then Gate.enter gate)
        ~after_input_scope:ignore
        ~before_close_output:ignore
    in
    Harness.run (decorated_env env fs) root (fun t ->
      Harness.create t root;
      Harness.append t;
      Atomic.set observe true;
      Gate.arm gate;
      let disconnected = Harness.search t in
      Gate.await gate;
      Eio.Stream.take heads;
      Eio.Resource.close disconnected;
      (* Each HEAD observation occurs during serialized capture preparation.
         The following health reply is a dispatcher barrier: it proves that
         request finished admission before the next request is submitted. *)
      let queued =
        List.init 15 ~f:(fun _ ->
          let flow = Harness.search t in
          Eio.Stream.take heads;
          Harness.barrier t;
          flow)
      in
      let rejected =
        Harness.call t "history.search" (Harness.scope @ [ "text", Json.string "needle" ])
      in
      printf
        "seventeenth=%s\n"
        (Json.field (Json.field (Json.field rejected "error") "data") "kind" |> Json.text);
      let payload =
        Harness.read
          t
          "history.payload"
          (Harness.scope
           @ [ ( "event_ref"
               , Session.Event_ref.to_json
                   (Session.Event_ref.create
                      ~session:(Session_id.of_string "chat" |> ok)
                      ~sequence:1
                    |> ok) )
             ])
      in
      printf
        "fast payload exact=%b\n"
        (String.equal
           (Json.field payload "bytes_base64" |> Json.text |> Base64.decode_exn)
           "opaque-body");
      let ticket =
        Harness.mutate
          t
          "ticket.create"
          "ticket"
          [ "ticket_id", Json.string "task"; "title", Json.string "Task" ]
      in
      printf "durable write=%s\n" (Json.field ticket "ticket_id" |> Json.text);
      printf
        "pinned close=%s unregister=%s\n"
        (Harness.rejected t "workspace.close" "close" [])
        (Harness.rejected t "workspace.unregister" "unregister" []);
      Atomic.set observe false;
      Gate.release gate;
      List.iter queued ~f:(fun flow ->
        let result = Harness.response flow |> Harness.data in
        match Json.field result "items" |> Json.list with
        | [ hit ] ->
          let reference =
            Api_codec.decode History_wire.event_ref (Json.field hit "event_ref") |> ok
          in
          if
            reference.sequence <> 1
            || (not (String.equal (Session_id.to_string reference.session) "chat"))
            || not (String.equal (Json.field hit "snippet" |> Json.text) "needle")
          then failwith "incorrect queued search hit"
        | _ -> failwith "missing hit");
      ignore (Harness.mutate t "workspace.close" "close" [] : Jsonaf.t);
      printf "all fifteen queued replies exact; disconnected pin released\n";
      ignore (Harness.mutate t "workspace.open" "open" [] : Jsonaf.t);
      Harness.shutdown t));
  [%expect
    {|
    seventeenth=Conflict
    fast payload exact=true
    durable write=task
    pinned close=Conflict unregister=Conflict
    all fifteen queued replies exact; disconnected pin released
    |}]
;;

let%expect_test
    "shutdown drains held and queued history before closing workspace ownership"
  =
  with_root (fun env root ->
    let gate = Gate.create () in
    let heads = Eio.Stream.create 8 in
    let observe = Atomic.make false in
    let completed_reads = Atomic.make 0 in
    let closed = Atomic.make false in
    let fs =
      Scheduler_fs.wrap
        (Eio.Stdenv.fs env)
        ~before_open_in:(fun path ->
          if
            Atomic.get observe && String.equal path (root ^ "/workspace/history/HEAD.json")
          then Eio.Stream.add heads ();
          if is_index path then Gate.enter gate)
        ~after_input_scope:(fun path ->
          if is_index path then ignore (Atomic.fetch_and_add completed_reads 1 : int))
        ~before_close_output:(fun path ->
          (* This intercepts the actual Store.close resource operation, so the
             assertion establishes ownership lifetime without a timing probe. *)
          if String.equal path (root ^ "/workspace/.local/writer.lock")
          then (
            if (not (Atomic.get gate.released)) || Atomic.get completed_reads < 2
            then failwith "workspace ownership closed before admitted read drain";
            Atomic.set closed true))
    in
    Harness.run (decorated_env env fs) root (fun t ->
      Harness.create t root;
      Harness.append t;
      Atomic.set observe true;
      Gate.arm gate;
      let first = Harness.search t in
      Gate.await gate;
      Eio.Stream.take heads;
      let second = Harness.search t in
      Eio.Stream.take heads;
      Harness.barrier t;
      ignore (Harness.read t "daemon.shutdown" [] : Jsonaf.t);
      printf "shutdown acknowledged while read held=%b\n" (not (Atomic.get closed));
      Atomic.set observe false;
      Gate.release gate;
      Eio.Promise.await_exn t.finished;
      Eio.Resource.close first;
      Eio.Resource.close second;
      printf
        "both admitted reads finished=%b ownership closed=%b\n"
        (Atomic.get completed_reads = 2)
        (Atomic.get closed)));
  [%expect
    {|
    shutdown acknowledged while read held=true
    both admitted reads finished=true ownership closed=true
    |}]
;;

let%expect_test "close and reopen invalidate a warmed ancestor capture before reuse" =
  with_root (fun env root ->
    let gate = Gate.create () in
    let selected = Atomic.make "" in
    let fs =
      Scheduler_fs.wrap
        (Eio.Stdenv.fs env)
        ~before_open_in:(fun path ->
          if String.equal path (Atomic.get selected) then Gate.enter gate)
        ~after_input_scope:ignore
        ~before_close_output:ignore
    in
    Harness.run (decorated_env env fs) root (fun t ->
      Harness.create t root;
      let current =
        Harness.call t "session.get" (Harness.scope @ [ "session_id", Json.string "chat" ])
      in
      let head =
        Json.field (Json.field (Json.field current "result") "meta") "history_capture"
        |> fun capture -> Json.field capture "head"
      in
      Harness.append t;
      let params = Harness.scope @ [ "session_id", Json.string "chat"; "head", head ] in
      let warm = Harness.read t "session.get" params in
      let warm_again = Harness.read t "session.get" params in
      if not (String.equal (Json.canonical warm) (Json.canonical warm_again))
      then failwith "warm ancestor changed";
      ignore (Harness.mutate t "workspace.close" "close" [] : Jsonaf.t);
      ignore (Harness.mutate t "workspace.open" "open" [] : Jsonaf.t);
      (* Arm after reopening so ordinary recovery cannot satisfy this gate.
         Reusing a previous generation's warmed ancestor would skip the read. *)
      Atomic.set selected (root ^ "/workspace/history/batches/" ^ Json.text head ^ ".json");
      Gate.arm gate;
      let reopened = Harness.submit t "session.get" params in
      Gate.await gate;
      printf "reopened generation reverified ancestor batch\n";
      Gate.release gate;
      let result = Harness.response reopened |> Harness.data in
      printf
        "same immutable ancestor=%b through=%s\n"
        (String.equal (Json.canonical result) (Json.canonical warm))
        (Json.field result "through" |> Json.text);
      Harness.shutdown t));
  [%expect
    {|
    reopened generation reverified ancestor batch
    same immutable ancestor=true through=0
    |}]
;;
