open Core
open Workgraph

type t =
  | Committed of Api_response.t
  | Observed of Api_response.t

let history request =
  List.mem
    History_api.mutation_methods
    (Protocol.Request.method_ request)
    ~equal:String.equal
;;

let receipt_lookup_supported request =
  Cli_mutation_identity.required request && not (history request)
;;

let validate request ~response =
  let method_ = Protocol.Request.method_ request in
  let result =
    Json.decode (fun () ->
      match Api_catalog.find method_ with
      | None -> Json.fail Invalid_argument "unknown method acknowledgement"
      | Some (Api_method.Packed.Pack definition) ->
        ignore
          (Api_codec.decode
             (Api_response.codec (Api_method.response_codec definition))
             (Api_response.to_json response)
           |> Disk.unwrap);
        (match Api_method.mode definition with
         | Read -> Json.fail Invalid_argument "a read is not an operation acknowledgement"
         | Write -> Observed response
         | Mutation ->
           let registry =
             List.exists
               Administration_api.methods
               ~f:(fun (Api_method.Packed.Pack descriptor) ->
                 String.equal method_ (Api_method.name descriptor))
           in
           if registry || history request
           then (
             Api_response.require_durable response |> Disk.unwrap;
             if registry
             then Json.fields (Api_response.meta response) ~allowed:[ "durable" ];
             if history request
             then (
               Json.fields
                 (Api_response.meta response)
                 ~allowed:[ "durable"; "history_capture" ];
               let workspace =
                 Json.field (Protocol.Request.params request) "workspace_id" |> Json.text
               in
               let session_id =
                 Json.field (Protocol.Request.params request) "session_id" |> Json.text
               in
               let matching_workspace value description =
                 if
                   not
                     (String.equal
                        (Json.field value "workspace_id" |> Json.text)
                        workspace)
                 then Json.fail Invalid_argument description
               in
               let matching_session value =
                 if
                   not
                     (String.equal
                        (Json.field value "session_id" |> Json.text)
                        session_id)
                 then
                   Json.fail
                     Invalid_argument
                     "history acknowledgement differs from original session"
               in
               (* Mutation results carry durable:true without a capture. Reads may
                  carry one; do not invent a required mutation metadata field. *)
               Option.iter
                 (Json.optional (Api_response.meta response) "history_capture")
                 ~f:(fun capture ->
                   matching_workspace
                     capture
                     "history acknowledgement capture differs from original workspace");
               Option.iter
                 (Json.optional (Api_response.data response) "session")
                 ~f:(fun session ->
                   matching_workspace
                     session
                     "history acknowledgement session differs from original workspace";
                   matching_session session);
               Option.iter
                 (Json.optional (Api_response.data response) "session_id")
                 ~f:(fun returned ->
                   if not (String.equal (Json.text returned) session_id)
                   then
                     Json.fail
                       Invalid_argument
                       "history append acknowledgement differs from original session");
               Option.iter
                 (Json.optional (Api_response.data response) "events")
                 ~f:(fun references ->
                   List.iter (Json.list references) ~f:matching_session));
             Committed response)
           else (
             match
               Mutation_acknowledgement.of_response response ~method_ |> Disk.unwrap
             with
             | Committed _ -> Committed response
             | Observed_empty _ -> Observed response)))
  in
  Result.map_error result ~f:(fun error ->
    Problem.create Outcome_unknown ("invalid operation acknowledgement: " ^ error.message))
;;

let receipt_request entry =
  Json.decode (fun () ->
    match Request_journal.Entry.mutation entry with
    | None -> Json.fail Invalid_argument "ephemeral writes have no durable receipt lookup"
    | Some mutation ->
      let common =
        [ "actor_id", Id.Actor.jsonaf_of_t mutation.actor
        ; "mutation_id", Id.Mutation.jsonaf_of_t mutation.mutation
        ]
      in
      let method_, fields =
        match mutation.namespace with
        | Registry -> "registry.receipt", common
        | Planning workspace ->
          ( "workspace.receipt"
          , ("workspace_id", Id.Workspace.jsonaf_of_t workspace)
            :: (common
                @ Option.to_list
                    (Option.map mutation.run ~f:(fun run ->
                       "run_id", Id.Run.jsonaf_of_t run))) )
        | History _ ->
          raise
            (Json.Decode_error
               (Problem.with_details
                  (Problem.create
                     Invalid_argument
                     "history has no public read-only receipt lookup; retain unknown or \
                      explicitly retry the exact saved request")
                  (Problem.Details.Field
                     { path = [ "operation_id" ]
                     ; expected = "operation with registry or planning receipt namespace"
                     ; suggestion =
                         Some
                           "Use explicit exact retry after reviewing the uncertain \
                            history operation."
                     })))
      in
      Protocol.Request.create ~id:"ui-receipt" ~method_ ~params:(Json.obj fields)
      |> Disk.unwrap)
;;

let receipt request ~entry ~response =
  Json.decode (fun () ->
    let expected_envelope =
      Json.hash (Json.canonical (Protocol.Request.to_json request))
    in
    let saved_envelope =
      Json.field (Request_journal.Entry.to_json entry) "envelope_hash" |> Json.text
    in
    if not (String.equal expected_envelope saved_envelope)
    then
      Json.fail
        Idempotency_conflict
        "receipt entry differs from original complete request";
    let lookup = receipt_request entry |> Disk.unwrap in
    let method_ = Protocol.Request.method_ lookup in
    (match Api_catalog.find method_ with
     | None -> Json.fail Invalid_argument "missing receipt method descriptor"
     | Some (Api_method.Packed.Pack descriptor) ->
       ignore
         (Api_codec.decode
            (Api_response.codec (Api_method.response_codec descriptor))
            (Api_response.to_json response)
          |> Disk.unwrap));
    let codec =
      if String.equal method_ "registry.receipt"
      then Administration_wire.Receipt.codec
      else Administration_wire.Receipt.planning_codec
    in
    match Api_codec.decode codec (Api_response.data response) |> Disk.unwrap with
    | Absent | Pending -> None
    | Committed { request_hash; response } ->
      let mutation = Request_journal.Entry.mutation entry |> Option.value_exn in
      if not (String.equal request_hash mutation.request_hash)
      then
        Json.fail
          Idempotency_conflict
          "receipt request_hash differs from the exact saved operation";
      Some (validate request ~response |> Disk.unwrap))
;;
