open Core

(** Inspect a complete single export and pin its manifest/capture for admission. *)
val inspect
  :  fs:_ Eio.Path.t
  -> source:string
  -> root:string
  -> (Restore_plan.Target.t, Problem.t) Result.t

(** Validate an export-all container and exact explicit ID-to-new-root mapping.
    Partial containers cannot be restored as complete backups. *)
val inspect_all
  :  fs:_ Eio.Path.t
  -> source:string
  -> roots:string String.Map.t
  -> (Restore_plan.Target.t list, Problem.t) Result.t

(** Persistence domain only. Copy, replay and validate each target, then publish
    with an exclusive rename. Installed roots are recognized only by the synced
    private intent marker and are replayed on retry. [attempt] is a fresh secure
    token for disposable staging directories; abandoned stages remain inspectable.
    Multi-root publication can be partial after failure; the durable intent must
    remain reserved until retry completes. Registration is the caller's final step. *)
val install
  :  Restore_plan.t
  -> sw:Eio.Switch.t
  -> fs:Eio.Fs.dir_ty Eio.Path.t
  -> attempt:string
  -> (unit, Problem.t) Result.t
