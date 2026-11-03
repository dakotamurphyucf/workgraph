open Core
open Workgraph

let () =
  Eio_main.run (fun env ->
    let socket, root =
      match Array.to_list (Sys.get_argv ()) with
      | [ _; socket; root ] -> socket, root
      | _ -> failwith "client fixture requires socket and root"
    in
    let client =
      Client.create
        ~net:(Eio.Stdenv.net env)
        ~clock:(Eio.Stdenv.mono_clock env)
        ~socket
        ~timeout_seconds:5.
      |> Disk.unwrap
    in
    let workspace = Id.Workspace.of_string "sdk" |> Disk.unwrap in
    let actor = Id.Actor.of_string "sdk-agent" |> Disk.unwrap in
    let mutation_id value = Id.Mutation.of_string value |> Disk.unwrap in
    let create =
      Client.Administration.Create { workspace; name = "Typed client"; root }
    in
    ignore
      (Client.administrate client ~actor ~mutation_id:(mutation_id "create") create
       |> Disk.unwrap
       : Jsonaf.t);
    let project = Id.Project.of_string "p" |> Disk.unwrap in
    let ticket = Id.Ticket.of_string "t" |> Disk.unwrap in
    let commands =
      Domain_command.Batch
        [ Project_create { id = project; title = "Project"; description = "" }
        ; Ticket_create
            { id = ticket
            ; title = "Ticket"
            ; description = ""
            ; project = Some project
            ; parent = None
            ; milestone = None
            }
        ; Comment_add
            { id = None
            ; target = Ticket ticket
            ; reply_to = None
            ; kind = Progress
            ; body = "Created with typed client"
            }
        ]
    in
    let run = Id.Run.of_string "sdk-run" |> Disk.unwrap in
    let committed = function
      | Mutation_acknowledgement.Committed commit -> commit
      | Observed_empty _ -> failwith "expected a committed write"
    in
    let commit =
      Client.mutate
        client
        ~run
        ~workspace
        ~actor
        ~mutation_id:(mutation_id "batch")
        commands
      |> Disk.unwrap
      |> committed
    in
    (* The SDK workflow is rerun after restart. This receipt may precede later
       committed setup writes, so pin the current capture before exact retry. *)
    let before_retry =
      Client.query client ~workspace ~parameters:[] Workspace_get |> Disk.unwrap
    in
    let duplicate =
      Client.mutate
        client
        ~run
        ~workspace
        ~actor
        ~mutation_id:(mutation_id "batch")
        commands
      |> Disk.unwrap
      |> committed
    in
    if
      not
        (Api_position.Workspace_revision.equal
           commit.workspace_revision
           duplicate.workspace_revision)
    then failwith "retry committed twice";
    if not (String.equal (Json.canonical commit.result) (Json.canonical duplicate.result))
    then failwith "retry changed the original result";
    let context =
      Client.query client ~workspace ~parameters:[] (Ticket_context ticket) |> Disk.unwrap
    in
    if
      not
        (Api_position.Workspace_revision.equal
           context.workspace_revision
           before_retry.workspace_revision)
    then failwith "exact retry advanced the current query capture";
    let audit =
      Client.query client ~workspace ~parameters:[] (Activity_since 0) |> Disk.unwrap
    in
    let event = Json.list (Json.field audit.data "items") |> List.hd_exn in
    if not (Id.Run.equal run (Id.Run.t_of_jsonaf (Json.field event "run_id")))
    then failwith "typed mutation lost run attribution";
    let id =
      Json.field (Json.field context.data "ticket") "ticket_id" |> Id.Ticket.t_of_jsonaf
    in
    if not (Id.Ticket.equal id ticket) then failwith "query selected wrong ticket";
    let mutate id method_ params =
      let command =
        Domain_command.decode ~method_ ~params:(Json.parse params |> Disk.unwrap)
        |> Disk.unwrap
      in
      Client.mutate client ~run ~workspace ~actor ~mutation_id:(mutation_id id) command
      |> Disk.unwrap
    in
    ignore
      (mutate
         "register-run"
         "run.register"
         {|{"target_run_id":"sdk-run","objective":"Typed work"}|}
       |> committed
       : Client.Commit.t);
    ignore
      (mutate
         "empty-project"
         "project.create"
         {|{"project_id":"empty","title":"Empty scope"}|}
       |> committed
       : Client.Commit.t);
    List.iter [ "observe"; "observe" ] ~f:(fun id ->
      match
        mutate
          id
          "ticket.claim_next"
          {|{"target_run_id":"sdk-run","attempt_id":"empty","project_id":"empty"}|}
      with
      | Mutation_acknowledgement.Observed_empty observation ->
        let capture =
          Client.query client ~workspace ~parameters:[] Workspace_get |> Disk.unwrap
        in
        if
          not
            (Api_position.Workspace_revision.equal
               capture.workspace_revision
               observation.workspace_revision)
        then failwith "typed observation advanced planning revision"
      | Committed _ -> failwith "typed empty allocation was committed");
    let context =
      Client.query client ~workspace ~parameters:[] (Ticket_context ticket) |> Disk.unwrap
    in
    let administer id command =
      Client.administrate client ~actor ~mutation_id:(mutation_id id) command
      |> Disk.unwrap
    in
    let exported =
      administer "export" (Export { workspace; destination = root ^ ".snapshot" })
    in
    let job_id = Json.text (Json.field (Json.field exported "data") "job_id") in
    let status =
      Protocol.Request.create
        ~id:"status"
        ~method_:"export.get"
        ~params:(Json.obj [ "job_id", Json.string job_id ])
      |> Disk.unwrap
    in
    let rec wait remaining =
      if remaining = 0 then failwith "export did not complete";
      let current =
        Client.invoke client status
        |> Disk.unwrap
        |> Api_response.of_json
        |> Disk.unwrap
        |> Api_response.data
      in
      match Json.text (Json.field current "status") with
      | "completed" -> ()
      | "running" ->
        Eio.Time.sleep (Eio.Stdenv.clock env) 0.01;
        wait (remaining - 1)
      | _ -> failwith "export failed"
    in
    wait 500;
    ignore (administer "unregister" (Unregister workspace) : Jsonaf.t);
    ignore
      (administer
         "restore"
         (Restore { directory = root ^ ".snapshot"; root = root ^ ".restored" })
       : Jsonaf.t);
    ignore (administer "open-restored" (Open workspace) : Jsonaf.t);
    let restored =
      Client.query client ~workspace ~parameters:[] (Ticket_context ticket) |> Disk.unwrap
    in
    if not (String.equal (Json.canonical context.data) (Json.canonical restored.data))
    then failwith "restored typed client context differs";
    Eio.Flow.copy_string "typed workflow passed\n" (Eio.Stdenv.stdout env))
;;
