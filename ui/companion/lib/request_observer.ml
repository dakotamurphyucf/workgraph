open Core
open Workgraph

module Plan = struct
  type t =
    { profile : Connection_profile.t
    ; workspace : Id.Workspace.t
    ; request : Communication_id.Request.t
    ; timeout_ms : int
    ; poll_interval_ms : int
    ; native : Request_wait.t
    }

  let create ~profile ~workspace ~request ~timeout_ms ~poll_interval_ms =
    Result.map
      (Request_wait.create ~workspace ~request ~timeout_ms ~poll_interval_ms)
      ~f:(fun native ->
        { profile; workspace; request; timeout_ms; poll_interval_ms; native })
  ;;

  let to_json t =
    Json.obj
      [ "profile", Connection_profile.to_json t.profile
      ; "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
      ; "request_id", Communication_id.Request.jsonaf_of_t t.request
      ; "timeout_ms", Json.string (Int.to_string t.timeout_ms)
      ; "poll_interval_ms", Json.string (Int.to_string t.poll_interval_ms)
      ]
  ;;
end

type observed =
  { plan : Plan.t
  ; outcome : Request_wait.Outcome.t
  }

type t = { observe : Plan.t -> (observed, Problem.t) Result.t }

let create ~net ~clock ~scheduler =
  let qualification = Daemon_qualification.create ~clock in
  let observe plan =
    let origin = Eio.Time.Mono.now clock in
    let now () =
      Mtime.span origin (Eio.Time.Mono.now clock)
      |> Mtime.Span.to_float_ns
      |> fun ns -> ns /. 1e9
    in
    let qualified = ref false in
    let exchange ~timeout_seconds request =
      Json.decode (fun () ->
        let deadline = now () +. timeout_seconds in
        let remaining () =
          let seconds = deadline -. now () in
          if Float.(seconds <= 0.)
          then
            Json.fail
              Storage_unavailable
              "request observation exhausted its remaining read budget";
          seconds
        in
        let client () =
          Client.create
            ~net
            ~clock
            ~socket:(Connection_profile.socket plan.Plan.profile)
            ~timeout_seconds:(remaining ())
          |> Disk.unwrap
        in
        try
          Eio.Time.Timeout.run_exn
            (Eio.Time.Timeout.seconds clock timeout_seconds)
            (fun () ->
               Read_scheduler.run scheduler ~lane:Wait ~f:(fun () ->
                 Json.decode (fun () ->
                   if not !qualified
                   then (
                     let probe = client () in
                     Daemon_qualification.check
                       qualification
                       ~timeout_seconds:(remaining ())
                       probe
                     |> Disk.unwrap;
                     qualified := true);
                   (* Qualification and lane admission consumed the same outer
                      read budget; a fresh transport timeout uses only its rest. *)
                   Client.invoke (client ()) request |> Disk.unwrap))
               |> Disk.unwrap)
        with
        | Eio.Time.Timeout ->
          Json.fail
            Storage_unavailable
            "request observation exhausted its remaining admission or transport budget")
    in
    Result.map
      (Request_wait.collect plan.native ~now ~sleep:(Eio.Time.Mono.sleep clock) ~exchange)
      ~f:(fun outcome -> { plan; outcome })
  in
  { observe }
;;

let observe t plan = t.observe plan

let to_json t =
  Json.obj
    [ "capture", Plan.to_json t.plan
    ; "observation", Request_wait.Outcome.to_json t.outcome
    ]
;;
