open Core

(** Cohttp-eio callback server, one initial Eio domain; max 64 connections,
    32KiB aggregate request headers, exact fixed Content-Length bodies only,
    no Transfer-Encoding/streamed chunked requests, 4MiB body with 10-second read deadline,
    cumulative 90-second header deadline, 90-second ordinary dispatch or
    310-second dispatch only for authorized exact POST /ui-api/v1/request-waits,
    10-second response write and a final 420-second connection ceiling. The long
    route permits the native 300-second total observation plus bounded response
    preparation; encoded aliases/query variants do not extend dispatch. One
    request per connection. Oversized or
    malformed pre-parser headers close without dispatch. Browser receive EOF
    cancels its observation/read; callers keep the duplex connection open while
    awaiting the response. Additional pipeline data is not dispatched.
    Supplied switch owns service lifetime, not individual HTTP
    request fibers. The listener must be loopback-bound by the launcher. *)
val serve
  :  sw:Eio.Switch.t
  -> clock:_ Eio.Time.Mono.t
  -> listener:_ Eio.Net.listening_socket
  -> router:Http_router.t
  -> unit
