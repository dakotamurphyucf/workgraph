open Core

let layout method_ =
  if
    List.mem
      (Facts.query_methods @ Ticket_recovery.query_methods)
      method_
      ~equal:String.equal
  then Api_response.Layout.Planning_read
  else if List.mem Communication.query_methods method_ ~equal:String.equal
  then Api_response.Layout.Domain_query Communication
  else if List.mem Evidence.query_methods method_ ~equal:String.equal
  then Domain_query Evidence
  else if List.mem Agent_run.query_methods method_ ~equal:String.equal
  then (
    match method_ with
    | "run.get"
    | "attempt.get"
    | "reservation.get"
    | "reservation.path.get"
    | "ticket.paths.get"
    | "condition.get"
    | "recovery.get" -> Domain_record Runs
    | _ -> Domain_query Runs)
  else if List.mem Agent_run_policy.query_methods method_ ~equal:String.equal
  then Domain_query Policy
  else if
    List.mem
      (History_command.query_methods @ History_command.mutation_methods)
      method_
      ~equal:String.equal
  then History
  else (
    match method_ with
    | "coordinator.overview" -> Workspace_view
    | "workspace.create"
    | "workspace.register"
    | "workspace.open"
    | "workspace.close"
    | "workspace.unregister"
    | "workspace.export"
    | "daemon.export_all"
    | "workspace.restore"
    | "daemon.restore_all"
    | "restore.cancel"
    | "export.cancel"
    | "export.retry" -> Registry_write
    | "export.list" -> Snapshot_read
    | "changes.read" | "changes.wait" -> Feed
    | "workspace.get"
    | "workspace.metrics"
    | "ticket.resume"
    | "activity.digest"
    | "workspace.overview"
    | "actor.list"
    | "label.list"
    | "status.list"
    | "project.list"
    | "project.get"
    | "project.brief"
    | "milestone.list"
    | "milestone.get"
    | "ticket.list"
    | "ticket.ready"
    | "ticket.resolve"
    | "ticket.context"
    | "ticket.blockers"
    | "ticket.readiness"
    | "comment.list"
    | "comment.get"
    | "comment.history"
    | "handoff.get"
    | "handoff.history"
    | "activity.since"
    | "search.query"
    | "resource.list"
    | "resource.get"
    | "resource.history" -> Planning_read
    | "initialize"
    | "daemon.shutdown"
    | "daemon.health"
    | "workspace.list"
    | "export.verify"
    | "export.get"
    | "workspace.receipt"
    | "registry.receipt"
    | "upload.begin"
    | "upload.chunk"
    | "upload.abort"
    | "upload.status"
    | "resource.read"
    | "resource.read_chunk"
    | "run.heartbeat"
    | "run.heartbeat_get" -> Value
    | _ -> Planning_write)
;;
