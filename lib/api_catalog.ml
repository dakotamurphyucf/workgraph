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

(* Executable descriptors retain their modes and tiers; curated discovery content
   supplies the shared offline and protocol descriptions. *)
let everyday =
  String.Set.of_list
    [ "initialize"
    ; "daemon.health"
    ; "workspace.overview"
    ; "project.brief"
    ; "project.create"
    ; "project.get"
    ; "project.readiness"
    ; "project.finish"
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

let purpose name =
  match Discovery_content.find_method name with
  | Some method_ -> method_.summary
  | None -> invalid_arg ("missing curated method discovery content: " ^ name)
;;

let discovery (Api_method.Packed.Pack method_) =
  let name = Api_method.name method_ in
  Api_method.Packed.Pack
    (Api_method.with_discovery
       method_
       ~tier:(if Set.mem everyday name then Core else Advanced)
       ~summary:(purpose name))
;;

let methods =
  Daemon_methods.methods
  @ Administration_api.methods
  @ List.map (Attention_api.overview_method :: Attention_api.methods) ~f:scoped
  @ Change_feed_api.methods
  @ List.map Coordinator_api.methods ~f:scoped
  @ [ scoped (Api_method.Packed.Pack Transaction_api.method_) ]
  @ [ scoped (Api_method.Packed.Pack Preflight_api.method_) ]
  @ [ scoped (Api_method.Packed.Pack Workspace_metrics.method_)
    ; scoped Usage_rollup_api.method_
    ; scoped Run_sessions_api.method_
    ]
  @ List.map Brief_api.methods ~f:scoped
  @ [ scoped (Api_method.Packed.Pack Ticket_read_api.method_) ]
  @ [ scoped (Api_method.Packed.Pack Hierarchy_api.get) ]
  @ List.map Planning_read_api.methods ~f:scoped
  @ (Project_completion_api.methods
     |> List.filter ~f:(fun (Api_method.Packed.Pack method_) ->
       Api_method.Mode.equal (Api_method.mode method_) Read)
     |> List.map ~f:scoped)
  @ [ scoped Reservation_contention_api.read_descriptor ]
  @ [ scoped Participant_api.descriptor ]
  @ [ scoped Activity_read_api.descriptor ]
  @ List.map Planning_context_api.methods ~f:scoped
  @ declared_methods Resume_api.query_methods ~descriptor:Resume_api.descriptor
  @ List.map Agent_run_policy_api.methods ~f:scoped
  @ Upload_api.methods
  @ List.map Resource_api.methods ~f:scoped
  @ List.map Ticket_amendment_api.methods ~f:scoped
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
  @ [ Api_method.Packed.Pack Resource_read.text_method
    ; Pack Resource_read.chunk_method
    ; Pack Resource_read.text_range_method
    ]
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
