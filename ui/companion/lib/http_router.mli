open Core

type request =
  { method_ : string
  ; target : string
  ; headers : (string * string) list
  ; body : string
  }

type response =
  { status : int
  ; headers : (string * string) list
  ; body : string
  }

type t

(** Exact host and origin, 256-bit launch capability. Checks happen before any
    bootstrap/API work. All API responses no-store; no CORS or GET mutation.
    The capability is a browser-instance defense, not actor authentication. *)
val create
  :  host:string
  -> origin:string
  -> capability:string
  -> profiles:Connection_profile.Store.t
  -> operations:Operation_store.t
  -> rpc:Rpc_bridge.t
  -> random:_ Eio.Flow.source
  -> t

(** Install bounded private configuration sources/preferences. These explicit
    local CAS routes perform no daemon I/O or shared publication. *)
val with_view_settings : t -> View_settings.t -> t

(** Install the one service-owned local startup helper. Existing profile/read
    routes remain independent of paired executable availability. *)
val with_launcher : t -> Daemon_launcher.t -> t

(** Install fixed offline migration/cleanup and read-only journal helpers. *)
val with_admin_jobs : t -> Admin_jobs.t -> t

(** Install the independent bounded reservation-acquisition helper. Its intention
    IDs occupy this service's namespace, not a global Operation_store namespace.
    Preparation is unsent; start and exact retry are explicit service-owned flights.
    No HTTP observer owns their admitted lifetime. *)
val with_wait_helper : t -> Wait_helper.t -> t

(** Install a foreground read-only request observer. The caller cancellation owns
    this bounded invocation; it does not create a journal or service-owned task. *)
val with_request_observer : t -> Request_observer.t -> t

(** Install private bounded staging and exact native Resource transfer helper.
    Local staging/prepare is offline; explicit start/retry/recover uses its
    captured-profile qualified client factory. No observer cancellation rolls back
    an admitted upload, and recovery inspects receipts only. *)
val with_transfer_helper : t -> Transfer_helper.t -> t

(** Fixed host-stage inspection, explicit endpoint association, native publication,
    exact retry/receipt recovery and exact-token cleanup. Never command execution.
    Admitted publication lifetime belongs to the service, not an HTTP observer. *)
val with_execution_helper : t -> Execution_helper.t -> t

(** JSON input bound 4MiB; static assets exact-manifest. API read routes enforce
    descriptor Read. GET /connections/:id/generations/:generation returns only
    the retained immutable profile; no daemon probe or current-profile fallback.
    The two template helper POSTs also perform only captures and
    return previews, never saved operations. Their captured immutable profile
    generation and helper schemas validate before read I/O. Ordinary operation
    preparation remains mandatory before execution. HTTP disconnect never owns/
    cancels an admitted write task. *)
val dispatch : t -> request -> response

(** Header-only boundary check before accepting a body. [Some] is the complete
    rejection response. [dispatch] repeats this check for direct callers. *)
val authorize : t -> request -> response option

(** Install the foreground combined planning/history long-poll observer. *)
val with_live_observer : t -> Live_observer.t -> t
