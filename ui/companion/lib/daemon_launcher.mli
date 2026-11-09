open Core

(** One service-switch/single-domain owner. A launch is a local process helper,
    never a daemon RPC mutation or proof of process liveness. *)
type t

module Context : sig
  type t

  val create
    :  workspace:Workgraph.Id.Workspace.t option
    -> project:Workgraph.Id.Project.t option
    -> writer:Writer.t option
    -> t

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Plan : sig
  type t

  (** Exact immutable profile generation, selected writer/scope and host paths.
      Reusing an identity with changed input is rejected before any startup. *)
  val create
    :  intention_id:Operation.Id.t
    -> connection:Connection_profile.t
    -> context:Context.t
    -> registry:string
    -> log:string
    -> timeout_seconds:int
    -> (t, Workgraph.Problem.t) Result.t

  val to_json : t -> Jsonaf.t
end

module Launch : sig
  type t

  val to_json : t -> Jsonaf.t
end

(** A missing or wrong-version paired executable disables startup only; attaching
    existing external daemons remains available. Never executes a browser-selected
    program. The exact matching core version is checked before invoking serve;
    every readiness listing separately qualifies the daemon package, including
    an already existing endpoint, within the original full startup deadline. *)
val create
  :  sw:Eio.Switch.t
  -> env:Eio_unix.Stdenv.base
  -> root:State_root.t
  -> executable:string
  -> (t, Workgraph.Problem.t) Result.t

(** Resolve the invocation directory first (including PATH), then the physical
    UI target directory for a symlink whose directory has no paired core. A
    missing candidate remains an unavailable startup capability, not a service
    startup failure. No executable name is accepted from HTTP. *)
val resolve_executable
  :  fs:Eio.Fs.dir_ty Eio.Path.t
  -> cwd:string
  -> invoked_as:string
  -> search_path:string option
  -> (string, Workgraph.Problem.t) Result.t

(** Bounded, cancellation-aware version probe; no daemon is started. *)
val capabilities : t -> Jsonaf.t

(** Saved plan publication precedes acknowledgement. Loaded Starting observations
    become Unknown durably before exposure; no automatic restart/retry. *)
val prepare : t -> Plan.t -> (Launch.t, Workgraph.Problem.t) Result.t

(** At most eight service-owned startup tasks. Repeated start coalesces; HTTP
    cancellation detaches its observer. Explicit retry uses only the saved plan.
    A timeout/error after the launch barrier remains Unknown with its diagnostic,
    never inferred process death. *)
val start
  :  t
  -> intention_id:Operation.Id.t
  -> retry:bool
  -> (Launch.t, Workgraph.Problem.t) Result.t

val inspect : t -> intention_id:Operation.Id.t -> (Launch.t, Workgraph.Problem.t) Result.t
val list : t -> Launch.t list
