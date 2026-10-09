open Core

let workspace =
  Api_codec.object_
    (Api_codec.Fields.required
       "workspace_id"
       (Api_codec.map
          (Api_codec.text ~max_bytes:96)
          ~decode:Id.Workspace.of_string
          ~encode:Id.Workspace.to_string
          ~description:"Workspace identity."))
;;

let scoped (Api_method.Packed.Pack method_) =
  let scope =
    match Api_method.mode method_ with
    | Api_method.Mode.Mutation -> Api_codec.as_json Mutation_request.codec
    | Read | Write -> Api_codec.as_json workspace
  in
  let request = Api_codec.merge_objects scope (Api_method.request_codec method_) in
  Api_method.Packed.Pack (Api_method.with_request method_ ~request)
;;

let facts_method name =
  let unwrap = function
    | Ok value -> value
    | Error problem -> raise (Json.Decode_error problem)
  in
  let mutation = List.mem Facts.mutation_methods name ~equal:String.equal in
  let request =
    if mutation
    then unwrap (Facts.Command.raw_codec name)
    else Api_codec.as_json (unwrap (Facts.query_codec name))
  in
  Api_method.Packed.Pack
    (Api_method.create
       ~name
       ~summary:("Read or update scoped working facts: " ^ name)
       ~mode:(if mutation then Mutation else Read)
       ~request
       ~response:(unwrap (Facts.response_codec name)))
  |> scoped
;;

let declared_methods names ~descriptor =
  List.map names ~f:(fun method_ ->
    match descriptor ~method_ with
    | Some descriptor -> scoped descriptor
    | None -> invalid_arg ("missing executable method descriptor: " ^ method_))
;;

(* Discovery remains on the executable descriptors, with one catalog composition
   point for the everyday tier and clearer purposes for older generic families. *)
let everyday =
  String.Set.of_list
    [ "initialize"
    ; "daemon.health"
    ; "workspace.overview"
    ; "project.brief"
    ; "project.create"
    ; "project.get"
    ; "project.list"
    ; "ticket.create"
    ; "ticket.list"
    ; "ticket.metadata"
    ; "ticket.context"
    ; "ticket.ready"
    ; "ticket.readiness"
    ; "ticket.blockers"
    ; "ticket.start"
    ; "ticket.claim_next"
    ; "ticket.progress"
    ; "ticket.finish"
    ; "ticket.release"
    ; "ticket.update"
    ; "ticket.resume"
    ; "transaction.apply"
    ; "run.register"
    ; "run.get"
    ; "run.observe"
    ; "attempt.get"
    ; "handoff.get"
    ; "handoff.set"
    ; "activity.digest"
    ; "fact.keys"
    ; "fact.get"
    ; "fact.put"
    ; "fact.multi_get"
    ; "resource.put_text"
    ; "resource.get"
    ; "resource.read"
    ; "resource.list"
    ; "message.send"
    ; "inbox.read"
    ; "inbox.wait"
    ; "inbox.ack"
    ; "request.create"
    ; "request.ask"
    ; "request.get"
    ; "request.list"
    ; "request.resolve"
    ; "contract.put"
    ; "manifest.publish"
    ; "review.submit"
    ; "review.record"
    ; "review.gate"
    ; "review.accept"
    ; "search.query"
    ; "workspace.metrics"
    ]
;;

let purpose name mode original =
  let specific =
    [ ( "ticket.metadata"
      , "Update a ticket's priority, assignee, labels, acceptance criteria or status." )
    ; "ticket.start", "Claim a ready ticket and optionally start an attempt atomically."
    ; ( "ticket.finish"
      , "Record completion evidence and finish an active attempt atomically." )
    ; "ticket.progress", "Append an attributed progress comment under current ownership."
    ; "ticket.context", "Read captured ticket context, ownership, links and handoff."
    ; "ticket.resolve", "Resolve a human display key to its canonical ticket ID."
    ; ( "ticket.claim_next"
      , "Allocate eligible work and start an attempt under pool policy." )
    ; ( "ticket.ready"
      , "List eligible ready tickets with optional parent and capability filters." )
    ; ( "ticket.readiness"
      , "Explain whether a ticket can start and identify unmet prerequisites." )
    ; "ticket.blockers", "Read the captured reasons blocking a ticket."
    ; ( "ticket.resume"
      , "Recover bounded recorded task context with exact historical sources." )
    ; ( "run.register"
      , "Register an attributed agent invocation with an independent run revision." )
    ; "run.get", "Read one run's identity, state and entity revision."
    ; ( "resource.put_text"
      , "Publish immutable UTF-8 content with required title and retained metadata." )
    ; "review.submit", "Bind submitted outputs to an exact manifest and active attempt."
    ; ( "review.record"
      , "Record an immutable reviewer decision for an exact submission generation." )
    ; ( "review.accept"
      , "Accept the current submission after its configured review gates pass." )
    ; ( "review.gate"
      , "Inspect current submission requirements and recorded reviewer decisions." )
    ; ( "handoff.set"
      , "Publish a structured ownership-guarded handoff with explicit coverage." )
    ; "handoff.get", "Read the current structured handoff and its revision."
    ; "fact.keys", "Discover scoped fact keys without loading their values."
    ; "fact.put", "Write one bounded scoped JSON fact with an optional revision guard."
    ; ( "inbox.read"
      , "Read bounded recipient notifications with resumable visible-row pagination." )
    ; "inbox.wait", "Wait up to 25 seconds for recipient notifications."
    ; "inbox.ack", "Acknowledge only the selected delivered inbox entries."
    ; ( "request.create"
      , "Create an accountable request with explicit recipient and resolver." )
    ; ( "request.ask"
      , "Ask an accountable question and create its discussion and request atomically." )
    ; ( "request.resolve"
      , "Resolve an accountable request as its resolver, optionally attaching an answer."
      )
    ; ( "board.put"
      , "Create a discussion board at revision 0 or update its guarded metadata." )
    ; ( "thread.put"
      , "Create a discussion thread at revision 0 or update its guarded metadata." )
    ; "request.get", "Read one request with its request and current thread revisions."
    ; ( "request.list"
      , "List requests with recipient, ticket and resolver filters; reading acknowledges \
         nothing." )
    ; ( "search.query"
      , "Search captured planning entities and content with bounded results." )
    ; "activity.since", "Read bounded committed activity after a retained sequence."
    ; ( "allocation.pool_put"
      , "Create or update allocation limits with the pool's entity revision." )
    ; "workspace.overview", "Read a bounded captured workspace summary and open work."
    ; "project.brief", "Read a bounded captured project summary, tickets and milestones."
    ]
  in
  match List.Assoc.find specific name ~equal:String.equal with
  | Some summary -> summary
  | None ->
    let generic =
      List.exists
        [ "Apply "
        ; "Read canonical base"
        ; "Run coordination method"
        ; "Typed captured planning query"
        ; "Communication state"
        ; "Retained resource"
        ; "Read comment provenance"
        ; "Independent captured conversation"
        ; "Templates, allocation bounds"
        ; "Read or update scoped working facts"
        ; "Acceptance policy and exact evidence"
        ; "Local registry, complete exports"
        ]
        ~f:(fun prefix -> String.is_prefix original ~prefix)
    in
    if not generic
    then original
    else (
      let parts = String.split name ~on:'.' in
      let action = List.last_exn parts in
      let family = String.concat ~sep:" " (List.drop_last_exn parts) in
      let subject = String.substr_replace_all family ~pattern:"_" ~with_:" " in
      match action with
      | "get" -> "Read one " ^ subject ^ " record and its current revision."
      | "list" -> "List " ^ subject ^ " records matching the explicit filters."
      | "history" -> "Read retained attributed " ^ subject ^ " history."
      | "create" -> "Create a new " ^ subject ^ " with explicit identity and metadata."
      | "put" -> "Create or update " ^ subject ^ " metadata with revision guards."
      | "update" -> "Update selected " ^ subject ^ " fields with revision guards."
      | "archive" -> "Archive " ^ subject ^ " metadata while preserving retained history."
      | "search" -> "Search retained " ^ subject ^ " text with bounded results."
      | _ ->
        let action = String.substr_replace_all action ~pattern:"_" ~with_:" " in
        (match mode with
         | Api_method.Mode.Read -> "Read " ^ subject ^ " " ^ action ^ " data."
         | Write | Mutation -> String.capitalize action ^ " " ^ subject ^ " state."))
;;

let discovery (Api_method.Packed.Pack method_) =
  let name = Api_method.name method_ in
  Api_method.Packed.Pack
    (Api_method.with_discovery
       method_
       ~tier:(if Set.mem everyday name then Core else Advanced)
       ~summary:(purpose name (Api_method.mode method_) (Api_method.summary method_)))
;;

let methods =
  Daemon_methods.methods
  @ Administration_api.methods
  @ Change_feed_api.methods
  @ List.map Coordinator_api.methods ~f:scoped
  @ [ scoped (Api_method.Packed.Pack Transaction_api.method_) ]
  @ [ scoped (Api_method.Packed.Pack Workspace_metrics.method_) ]
  @ List.map Planning_read_api.methods ~f:scoped
  @ List.map Planning_context_api.methods ~f:scoped
  @ declared_methods Resume_api.query_methods ~descriptor:Resume_api.descriptor
  @ List.map Agent_run_policy_api.methods ~f:scoped
  @ Upload_api.methods
  @ List.map Resource_api.methods ~f:scoped
  @ List.map Evidence.api_methods ~f:scoped
  @ List.map Communication_api.methods ~f:scoped
  @ List.map Discussion_api.methods ~f:scoped
  @ declared_methods Ticket_recovery.query_methods ~descriptor:Ticket_recovery.descriptor
  @ Heartbeat_api.methods
  @ List.map History_api.methods ~f:scoped
  @ [ scoped (Api_method.Packed.Pack Communication.message_method) ]
  @ List.map
      [ Api_method.Packed.Pack Communication_inbox.read_method
      ; Pack Communication_inbox.wait_method
      ; Pack Communication_inbox.ack_method
      ]
      ~f:scoped
  @ [ Api_method.Packed.Pack Resource_read.text_method; Pack Resource_read.chunk_method ]
  @ declared_methods Planning_api.methods ~descriptor:Planning_api.descriptor
  @ declared_methods
      (Agent_run_api.mutation_methods @ Agent_run_api.query_methods)
      ~descriptor:Agent_run_api.descriptor
  @ List.map (Facts.mutation_methods @ Facts.query_methods) ~f:facts_method
  |> List.map ~f:discovery
  |> List.sort
       ~compare:(fun (Api_method.Packed.Pack left) (Api_method.Packed.Pack right) ->
         String.compare (Api_method.name left) (Api_method.name right))
;;

let by_name =
  List.fold
    methods
    ~init:String.Map.empty
    ~f:(fun methods (Api_method.Packed.Pack method_ as packed) ->
      let name = Api_method.name method_ in
      if Map.mem methods name then invalid_arg ("duplicate method descriptor: " ^ name);
      Map.set methods ~key:name ~data:packed)
;;

let find name = Map.find by_name name

let request_fields name =
  Option.bind (find name) ~f:(fun (Api_method.Packed.Pack method_) ->
    Api_codec.field_names (Api_method.request_codec method_))
;;

let validate_request ~method_ ~params =
  Option.map (find method_) ~f:(fun (Api_method.Packed.Pack method_) ->
    Result.map
      (Api_codec.decode (Api_method.request_codec method_) params)
      ~f:(fun _ -> ()))
;;

let validate_response ~method_ response =
  Option.map (find method_) ~f:(fun (Api_method.Packed.Pack descriptor) ->
    let codec = Api_response.codec (Api_method.response_codec descriptor) in
    match Api_codec.decode codec (Api_response.to_json response) with
    | Ok _ -> ()
    | Error problem -> raise (Api_method.Invalid_response (method_, problem)))
;;

let describe () =
  Json.obj
    [ "schema_dialect", Json.string "https://json-schema.org/draft/2020-12/schema"
    ; ( "methods"
      , `Array
          (List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
             Api_method.describe method_)) )
    ]
;;
