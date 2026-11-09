open Core

(** Cohttp-eio callback server, one initial Eio domain; max 64 connections.
    Sequential HTTP/1.1 requests reuse the connection after a fully consumed,
    authorized request and a flushed, fixed-length response. Client close requests,
    HTTP/1.0, authorization failures and invalid body framing end the connection.
    Each request has fresh 32KiB aggregate header accounting and a 90-second
    header deadline (including idle time between requests), exact fixed Content-Length bodies only,
    no Transfer-Encoding/streamed chunked requests, 4MiB body with 10-second read deadline,
    90-second ordinary dispatch or
    310-second dispatch only for authorized exact POST /ui-api/v1/request-waits,
    10-second response write. There is no cumulative connection-lifetime deadline;
    phase deadlines bound each request independently. The long
    route permits the native 300-second total observation plus bounded response
    preparation; encoded aliases/query variants do not extend dispatch. Oversized or
    malformed pre-parser headers close without dispatch. Browser receive EOF
    cancels its observation/read; callers keep the duplex connection open while
    awaiting the response. Send the next request only after the previous response;
    premature pipeline data is not dispatched. All mutable header accounting and
    disconnect observation belong to this connection on the serving domain;
    authorization and request state never carry over to the next request.
    Supplied switch owns service lifetime, not individual HTTP
    request fibers. The listener must be loopback-bound by the launcher. *)
val serve
  :  sw:Eio.Switch.t
  -> clock:_ Eio.Time.Mono.t
  -> listener:_ Eio.Net.listening_socket
  -> router:Http_router.t
  -> unit
