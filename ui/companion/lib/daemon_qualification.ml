open Core
open Workgraph

type t = { check : timeout_seconds:float -> Client.t -> (unit, Problem.t) Result.t }

let required_version = Version.value

let mismatch ~observed message =
  Problem.with_details
    (Problem.create
       Unsupported_version
       (message
        ^ sprintf
            "; install and run the matching Workgraph %s core package. Local profiles, \
             saved drafts and operation inspection remain available; preserve any \
             uncertain saved request."
            required_version))
    (Problem.Details.Version
       { representation = "workgraph-package"; observed; supported = required_version })
;;

let create ~clock =
  let check ~timeout_seconds client =
    Json.decode (fun () ->
      if (not (Float.is_finite timeout_seconds)) || Float.(timeout_seconds <= 0.)
      then Json.fail Invalid_argument "qualification budget must be positive and finite";
      let request =
        Protocol.Request.create
          ~id:"ui-daemon-package-check"
          ~method_:(Api_method.name Daemon_methods.initialize)
          ~params:(Json.obj [])
        |> Disk.unwrap
      in
      let response =
        try
          Eio.Time.Timeout.run_exn
            (Eio.Time.Timeout.seconds clock (Float.min 2. timeout_seconds))
            (fun () -> Client.invoke client request |> Disk.unwrap)
        with
        | Eio.Time.Timeout ->
          Json.fail
            Storage_unavailable
            "daemon package qualification exceeded its remaining probe budget; no \
             semantic daemon request was authorized"
      in
      let initialization, _ =
        Api_codec.decode
          (Api_response.codec (Api_method.response_codec Daemon_methods.initialize))
          response
        |> Disk.unwrap
      in
      if not (String.equal initialization.name "workgraph")
      then
        raise
          (Json.Decode_error
             (mismatch
                ~observed:(Some initialization.version)
                (sprintf
                   "initialize reported unexpected daemon name %S"
                   initialization.name)));
      if not (String.equal initialization.version required_version)
      then
        raise
          (Json.Decode_error
             (mismatch
                ~observed:(Some initialization.version)
                (sprintf
                   "daemon package %S differs from companion package %S"
                   initialization.version
                   required_version))))
  in
  { check }
;;

let check t ?(timeout_seconds = 2.) client = t.check ~timeout_seconds client
