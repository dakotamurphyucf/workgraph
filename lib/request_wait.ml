open Core

type t =
  { workspace : Id.Workspace.t
  ; request : Communication_id.Request.t
  ; timeout_ms : int
  ; poll_interval_ms : int
  }

let create ~workspace ~request ~timeout_ms ~poll_interval_ms =
  Json.decode (fun () ->
    if
      timeout_ms < 1000
      || timeout_ms > 300000
      || poll_interval_ms < 250
      || poll_interval_ms > 25000
    then
      Json.fail
        Invalid_argument
        "request wait: total 1000..300000ms, interval 250..25000ms";
    { workspace; request; timeout_ms; poll_interval_ms })
;;

module Stop = struct
  type t =
    | Resolved
    | Cancelled
    | Deadline
    | Incomplete
  [@@deriving equal]

  let name = function
    | Resolved -> "resolved"
    | Cancelled -> "cancelled"
    | Deadline -> "deadline"
    | Incomplete -> "incomplete"
  ;;
end

module Outcome = struct
  type t =
    { response : Api_response.t
    ; stop : Stop.t
    ; poll_count : int
    }

  let resolved t = Stop.equal t.stop Resolved

  let to_json t =
    let meta =
      match Api_response.meta t.response with
      | `Object fields -> fields
      | _ -> assert false
    in
    Json.obj
      [ "data", Api_response.data t.response
      ; ( "meta"
        , Json.obj
            (meta
             @ [ ( "wait"
                 , Json.obj
                     [ "stop", Json.string (Stop.name t.stop)
                     ; ("resolved", if resolved t then `True else `False)
                     ; "poll_count", Json.int t.poll_count
                     ] )
               ]) )
      ]
  ;;
end

let collect t ~now ~sleep ~exchange =
  Json.decode (fun () ->
    let previous = ref (now ()) in
    if not (Float.is_finite !previous)
    then Json.fail Invalid_argument "monotonic clock must be finite";
    let origin = !previous in
    let remaining () =
      let observed = now () in
      if (not (Float.is_finite observed)) || Float.(observed < !previous)
      then
        Json.fail Invalid_argument "monotonic clock moved backwards or became nonfinite";
      previous := observed;
      (Float.of_int t.timeout_ms /. 1000.) -. (observed -. origin)
    in
    let request =
      Protocol.Request.create
        ~id:"request-wait"
        ~method_:"request.get"
        ~params:
          (Json.obj
             [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
             ; "request_id", Communication_id.Request.jsonaf_of_t t.request
             ; "max_bytes", Json.int 1048576
             ])
      |> Disk.unwrap
    in
    let rec poll last poll_count =
      let timeout_seconds = remaining () in
      if Float.(timeout_seconds <= 0.)
      then (
        match last with
        | Some response -> { Outcome.response; stop = Deadline; poll_count }
        | None ->
          Json.fail Local_io "request wait deadline elapsed before the first observation")
      else (
        let response =
          exchange ~timeout_seconds request
          |> Disk.unwrap
          |> Api_response.of_json
          |> Disk.unwrap
        in
        let data = Api_response.data response in
        ignore
          (Api_codec.decode Communication_wire.request_current data |> Disk.unwrap
           : Jsonaf.t);
        if
          not
            (Communication_id.Request.equal
               t.request
               (Communication_id.Request.t_of_jsonaf (Json.field data "request_id")))
        then
          Json.fail Invalid_argument "request wait received a different request identity";
        let poll_count = poll_count + 1 in
        let finish stop = { Outcome.response; stop; poll_count } in
        let budget = Json.field (Api_response.meta response) "budget" in
        let truncated =
          match Json.field budget "truncated" with
          | `True -> true
          | `False -> false
          | _ -> assert false
        in
        if truncated
        then finish Incomplete
        else (
          match Json.field (Json.field data "status") "kind" |> Json.text with
          | "resolved" -> finish Resolved
          | "cancelled" -> finish Cancelled
          | "open" ->
            let seconds =
              Float.min (remaining ()) (Float.of_int t.poll_interval_ms /. 1000.)
            in
            if Float.(seconds > 0.) then sleep seconds;
            poll (Some response) poll_count
          | _ -> assert false))
    in
    poll None 0)
;;

let run t ~net ~clock ~socket ~max_exchange_seconds =
  Json.decode (fun () ->
    if (not (Float.is_finite max_exchange_seconds)) || Float.(max_exchange_seconds <= 0.)
    then
      Json.fail
        Invalid_argument
        "request wait transport timeout must be finite and positive";
    let origin = Eio.Time.Mono.now clock in
    let now () =
      Mtime.span origin (Eio.Time.Mono.now clock)
      |> Mtime.Span.to_float_ns
      |> fun ns -> ns /. 1e9
    in
    let exchange ~timeout_seconds request =
      Result.bind
        (Client.create
           ~net
           ~clock
           ~socket
           ~timeout_seconds:(Float.min timeout_seconds max_exchange_seconds))
        ~f:(fun client -> Client.invoke client request)
    in
    collect t ~now ~sleep:(Eio.Time.Mono.sleep clock) ~exchange |> Disk.unwrap)
;;
