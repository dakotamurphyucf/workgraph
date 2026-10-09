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
    let commit =
      Client.mutate
        client
        ~run
        ~workspace
        ~actor
        ~mutation_id:(mutation_id "batch")
        commands
      |> Disk.unwrap
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
    in
    if
      not
        (Api_position.Workspace_revision.equal
           commit.workspace_revision
           duplicate.workspace_revision)
    then failwith "retry committed twice";
    let context =
      Client.query client ~workspace ~parameters:[] (Ticket_context ticket) |> Disk.unwrap
    in
    if
      not
        (Api_position.Workspace_revision.equal
           context.workspace_revision
           commit.workspace_revision)
    then failwith "query revision differs";
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
