open Core
open Planning_state
module C = Communication

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let opt params key decode = Option.map (Json.optional params key) ~f:decode

let read t ~now_unix_ms ~params =
  Json.decode (fun () ->
    ignore (Api_codec.decode Attention_api.overview_request params |> unwrap : Jsonaf.t);
    let actor = Json.field params "actor_id" |> Id.Actor.t_of_jsonaf in
    let project = opt params "project_id" Id.Project.t_of_jsonaf in
    let run = opt params "run_id" Id.Run.t_of_jsonaf in
    Option.iter run ~f:(fun id ->
      match Agent_run.get_run t.agent_runs id with
      | Some record when Id.Actor.equal record.actor actor -> ()
      | Some _ -> Json.fail Conflict "overview run belongs to another actor"
      | None -> Json.fail Not_found "overview run not found");
    Option.iter project ~f:(fun id ->
      if not (Map.mem t.projects id) then Json.fail Not_found "overview project not found");
    let consumer = opt params "consumer_id" Communication_id.Consumer.t_of_jsonaf in
    let defaults =
      [ "claim"; "attempt"; "named_reservation"; "path_reservation"; "request" ]
      @ if Option.is_some consumer then [ "notification" ] else []
    in
    let kinds =
      Option.value
        (opt params "kinds" (fun json -> Json.list json |> List.map ~f:Json.text))
        ~default:[]
    in
    let kinds =
      List.sort (if List.is_empty kinds then defaults else kinds) ~compare:String.compare
    in
    let selected kind = List.mem kinds kind ~equal:String.equal in
    if selected "notification" && Option.is_none consumer
    then Json.fail Invalid_argument "notification overview requires consumer_id";
    let run_matches id = Option.for_all run ~f:(Id.Run.equal id) in
    let owned_run id =
      run_matches id
      && Option.exists (Agent_run.get_run t.agent_runs id) ~f:(fun record ->
        Id.Actor.equal record.actor actor)
    in
    let ticket_matches id =
      Option.for_all project ~f:(fun p ->
        Option.exists (Map.find t.tickets id) ~f:(fun ticket ->
          Option.exists ticket.project ~f:(Id.Project.equal p)))
    in
    let run_projects id =
      List.exists (Agent_run.attempts_for_run t.agent_runs id) ~f:(fun attempt ->
        (not (Attempt.State.terminal attempt.state)) && ticket_matches attempt.ticket)
      || Map.exists t.tickets ~f:(fun ticket ->
        ticket_matches ticket.id
        && Option.exists ticket.claim ~f:(fun claim ->
          Option.exists claim.run_id ~f:(Id.Run.equal id)))
    in
    let reservation_matches id =
      owned_run id && (Option.is_none project || run_projects id)
    in
    let recipient_matches = function
      | C.Recipient.Actor id -> Id.Actor.equal id actor
      | Run id -> owned_run id
    in
    let rows = ref [] in
    let add kind key fields =
      if selected kind
      then
        rows
        := (kind ^ ":" ^ key, Json.obj (("kind", Json.string kind) :: fields)) :: !rows
    in
    Map.iter t.tickets ~f:(fun ticket ->
      Option.iter ticket.claim ~f:(fun claim ->
        if
          Id.Actor.equal claim.actor actor
          && ticket_matches ticket.id
          && Option.for_all run ~f:(fun id ->
            Option.exists claim.run_id ~f:(Id.Run.equal id))
        then
          add
            "claim"
            (Id.Ticket.to_string ticket.id)
            [ "ticket_id", Id.Ticket.jsonaf_of_t ticket.id
            ; "ticket_revision", Json.int ticket.revision
            ; "ownership", Planning_state.ownership_view_json claim
            ]));
    List.iter (Agent_run.attempts t.agent_runs) ~f:(fun attempt ->
      if
        (not (Attempt.State.terminal attempt.state))
        && owned_run attempt.run
        && ticket_matches attempt.ticket
      then
        add
          "attempt"
          (Attempt.Id.to_string attempt.id)
          [ "attempt_id", Attempt.Id.jsonaf_of_t attempt.id
          ; "ticket_id", Id.Ticket.jsonaf_of_t attempt.ticket
          ; "run_id", Id.Run.jsonaf_of_t attempt.run
          ; "revision", Json.int attempt.revision
          ; "token", Json.int attempt.token
          ; ( "state"
            , Json.string
                (match attempt.state with
                 | Running -> "running"
                 | Waiting -> "waiting"
                 | Completed | Failed | Cancelled -> assert false) )
          ]);
    let holder_fields (holder : Reservation.Holder.t) =
      [ "run_id", Id.Run.jsonaf_of_t holder.run
      ; "token", Json.int holder.token
      ; ( "mode"
        , Json.string
            (match holder.mode with
             | Exclusive -> "exclusive"
             | Shared -> "shared") )
      ; ( "lease"
        , Coordination_wire.encode_exn
            Planning_ticket_wire.Lease.codec
            (Planning_ticket_wire.Lease.of_domain holder.lease) )
      ]
    in
    List.iter (Agent_run.reservations t.agent_runs) ~f:(fun reservation ->
      List.iter reservation.holders ~f:(fun holder ->
        if reservation_matches holder.run
        then
          add
            "named_reservation"
            (Reservation.Name.to_string reservation.name
             ^ ":"
             ^ Id.Run.to_string holder.run)
            (("name", Reservation.Name.jsonaf_of_t reservation.name)
             :: holder_fields holder)));
    List.iter (Agent_run.path_reservations t.agent_runs) ~f:(fun reservation ->
      List.iter reservation.holders ~f:(fun holder ->
        if reservation_matches holder.run
        then
          add
            "path_reservation"
            (Json.canonical (Path_scope.jsonaf_of_t reservation.target)
             ^ ":"
             ^ Id.Run.to_string holder.run)
            (("target", Coordination_wire.encode_exn Path_scope.codec reservation.target)
             :: holder_fields holder)));
    let target_matches = function
      | Entity_ref.Project id -> Option.for_all project ~f:(Id.Project.equal id)
      | Ticket id -> ticket_matches id
      | Workspace | Milestone _ | Resource _ -> Option.is_none project
    in
    let request_matches request =
      let thread =
        C.get_thread t.communication request.C.Request.thread |> Option.value_exn
      in
      Option.for_all project ~f:(fun p ->
        List.exists thread.links ~f:(function
          | Project id -> Id.Project.equal p id
          | Ticket id -> ticket_matches id
          | Workspace | Milestone _ | Resource _ -> false)
        || target_matches (C.thread_target t.communication thread.id |> unwrap))
    in
    List.iter (C.requests t.communication) ~f:(fun request ->
      if C.Request.Status.equal request.status Open && request_matches request
      then (
        let roles = [] in
        let roles =
          if Id.Actor.equal request.resolver actor
          then "incoming_resolver" :: roles
          else roles
        in
        let roles =
          if
            List.exists request.deliveries ~f:(fun delivery ->
              recipient_matches delivery.recipient)
          then "incoming_delivery" :: roles
          else roles
        in
        let roles =
          match request.responsibility with
          | Accepted r when recipient_matches r.recipient ->
            "incoming_responsible" :: roles
          | Accepted _ | Unaccepted -> roles
        in
        let roles =
          if
            Id.Actor.equal request.created.actor actor
            && Option.for_all run ~f:(fun id ->
              Option.exists request.created.run ~f:(Id.Run.equal id))
          then "outgoing" :: roles
          else roles
        in
        if not (List.is_empty roles)
        then
          add
            "request"
            (Communication_id.Request.to_string request.id)
            [ "record", Communication_wire.request_json request
            ; ( "roles"
              , `Array (List.map (List.sort roles ~compare:String.compare) ~f:Json.string)
              )
            ]));
    Option.iter consumer ~f:(fun consumer_id ->
      let recipients =
        C.Recipient.Actor actor
        :: List.filter_map (Agent_run.runs t.agent_runs) ~f:(fun record ->
          if owned_run record.id then Some (C.Recipient.Run record.id) else None)
      in
      List.iter recipients ~f:(fun recipient ->
        List.iter
          (C.inbox t.communication ~consumer_id ~recipient ~after:0 ~through:None)
          ~f:(fun notification ->
            let in_project =
              match notification.scope with
              | Project id -> Option.for_all project ~f:(Id.Project.equal id)
              | Workspace -> Option.is_none project
            in
            if in_project
            then
              add
                "notification"
                (Printf.sprintf
                   "%020d:%s"
                   notification.serial
                   (Json.canonical (C.Recipient.jsonaf_of_t recipient)))
                [ "consumer_id", Communication_id.Consumer.jsonaf_of_t consumer_id
                ; ( "recipient"
                  , Coordination_wire.encode_exn Communication_recipient.codec recipient )
                ; "record", Attention_api.notification_json notification
                ])));
    let rows =
      List.sort !rows ~compare:(fun (a, _) (b, _) -> String.compare a b)
      |> List.map ~f:snd
    in
    let optional value encode = Option.value_map value ~default:`Null ~f:encode in
    let filter =
      Json.obj
        [ "view", Json.string "actor.overview"
        ; "actor_id", Id.Actor.jsonaf_of_t actor
        ; "project_id", optional project Id.Project.jsonaf_of_t
        ; "run_id", optional run Id.Run.jsonaf_of_t
        ; "consumer_id", optional consumer Communication_id.Consumer.jsonaf_of_t
        ; "kinds", `Array (List.map kinds ~f:Json.string)
        ]
    in
    Attention_cursor.current_page
      ~workspace:t.workspace
      ~revision:t.revision
      ~activity:t.activity
      ~filter
      ~cursor:(opt params "cursor" Json.text)
      ~now_unix_ms
      ~rows
      ~limit:(Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer)
      ~max_bytes:(Query_budget.of_params params)
    |> unwrap)
;;
