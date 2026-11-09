open Core
open Workgraph

type flight =
  { admission : (Operation.t, Problem.t) Result.t Eio.Promise.t
  ; finished : unit Eio.Promise.t
  }

type t =
  { sw : Eio.Switch.t
  ; client : Connection_profile.t -> (Client.t, Problem.t) Result.t
  ; materialize : Operation.Preparation.t -> (Protocol.Request.t, Problem.t) Result.t
  ; store : Operation_store.t
  ; scheduler : Read_scheduler.t
  ; mutable flights : flight Operation.Id.Map.t
  }

let create ~sw ~net ~clock ~random ~store ~scheduler =
  let qualification = Daemon_qualification.create ~clock in
  let client profile =
    Result.bind
      (Client.create
         ~net
         ~clock
         ~socket:(Connection_profile.socket profile)
         ~timeout_seconds:60.)
      ~f:(fun client ->
        Result.map (Daemon_qualification.check qualification client) ~f:(fun () -> client))
  in
  let materialize preparation =
    Json.decode (fun () ->
      let bytes = Cstruct.create 32 in
      Eio.Flow.read_exact random bytes;
      let request =
        Protocol.Request.create
          ~id:("ui-" ^ Json.hash (Cstruct.to_string bytes))
          ~method_:(Operation.Preparation.method_ preparation)
          ~params:(Operation.Preparation.params preparation)
        |> Disk.unwrap
      in
      Cli_mutation_identity.ensure request ~random ~allow_generate:true |> Disk.unwrap)
  in
  { sw; client; materialize; store; scheduler; flights = Operation.Id.Map.empty }
;;

let read t ~connection ~lane request =
  Json.decode (fun () ->
    let method_ = Protocol.Request.method_ request in
    let (Api_method.Packed.Pack descriptor) =
      match Api_catalog.find method_ with
      | Some descriptor -> descriptor
      | None -> Json.fail Not_found "method is absent from the executable catalog"
    in
    (match Api_method.mode descriptor with
     | Read -> ()
     | Write | Mutation ->
       Json.fail Invalid_argument "read route accepts descriptor Read methods only");
    ignore
      (Api_codec.decode
         (Api_method.request_codec descriptor)
         (Protocol.Request.params request)
       |> Disk.unwrap);
    Read_scheduler.run t.scheduler ~lane ~f:(fun () ->
      Json.decode (fun () ->
        let client = t.client connection |> Disk.unwrap in
        let response = Client.invoke client request |> Disk.unwrap in
        ignore
          (Api_codec.decode
             (Api_response.codec (Api_method.response_codec descriptor))
             response
           |> Disk.unwrap);
        let pagination =
          if Query_pagination.Continuation.supports request
          then
            Query_pagination.Continuation.of_response request ~response
            |> Disk.unwrap
            |> Query_pagination.Continuation.to_json
          else `Null
        in
        Json.obj [ "response", response; "pagination", pagination ]))
    |> Disk.unwrap)
;;

let prepare t preparation =
  Operation_store.prepare t.store preparation ~materialize:(fun () ->
    Result.bind
      (t.client (Operation.Preparation.connection preparation))
      ~f:(fun _ -> t.materialize preparation))
;;

let unknown error = Operation.Outcome_unknown error

let outcome client operation =
  let request = Operation.request operation in
  match Client.execute client request with
  | Error error -> unknown (Problem.create Outcome_unknown error.message)
  | Ok (Failure error) ->
    if Problem.equal_kind error.kind Outcome_unknown
    then unknown error
    else Rejected error
  | Ok (Success value) ->
    let acknowledgement =
      Result.bind (Api_response.of_json value) ~f:(fun response ->
        Acknowledgement.validate request ~response)
    in
    (match acknowledgement with
     | Ok (Committed response) -> Committed response
     | Ok (Observed response) -> Observed response
     | Error error ->
       unknown
         (Problem.create
            Outcome_unknown
            ("write acknowledgement could not be verified: " ^ error.message)))
;;

let rec execute t ~id ~retry =
  match Map.find t.flights id with
  | Some flight ->
    let open Result.Let_syntax in
    let%bind _ = Eio.Promise.await flight.admission in
    let%bind current = Operation_store.inspect t.store ~id in
    let retry_observed =
      match Operation.state current with
      | Outcome_unknown _ -> retry
      | Observed _ ->
        retry
        && String.equal
             (Protocol.Request.method_ (Operation.request current))
             "ticket.claim_next"
      | Prepared_unsent | Sending | Committed _ | Rejected _ -> false
    in
    if retry_observed
    then (
      (* A final observation can become visible before its status fsync ends.
         Explicit retry waits for that task to release ownership, then rechecks;
         an ordinary execute, or retry while Sending, still only coalesces. *)
      Eio.Promise.await flight.finished;
      execute t ~id ~retry)
    else Ok current
  | None ->
    let open Result.Let_syntax in
    let%bind current = Operation_store.inspect t.store ~id in
    let start =
      match Operation.state current, retry with
      | Prepared_unsent, false | Outcome_unknown _, true -> true
      | Observed _, true ->
        String.equal
          (Protocol.Request.method_ (Operation.request current))
          "ticket.claim_next"
      | ( ( Prepared_unsent
          | Sending
          | Committed _
          | Observed _
          | Rejected _
          | Outcome_unknown _ )
        , _ ) -> false
    in
    if not start
    then
      if retry
      then
        Error (Problem.create Conflict "this operation has no permitted explicit retry")
      else Ok current
    else if Map.length t.flights >= 64
    then
      Error
        (Problem.with_details
           (Problem.create Blocked "companion write flight capacity is full")
           (Problem.Details.Capacity
              { meter = "ui-write-flights"
              ; used = Map.length t.flights
              ; limit = 64
              ; attempted = Map.length t.flights + 1
              ; unit = "operations"
              ; operator_action =
                  "Wait for an admitted write to finish before explicitly executing this \
                   prepared operation."
              }))
    else (
      let admission, resolve = Eio.Promise.create () in
      let finished, finish = Eio.Promise.create () in
      t.flights <- Map.set t.flights ~key:id ~data:{ admission; finished };
      (* All I/O belongs to the service switch, including the admission barrier.
         HTTP caller cancellation can only detach from the promise below. *)
      Eio.Fiber.fork ~sw:t.sw (fun () ->
        Exn.protect
          ~finally:(fun () ->
            t.flights <- Map.remove t.flights id;
            Eio.Promise.resolve finish ())
          ~f:(fun () ->
            let client =
              t.client (Operation.Preparation.connection (Operation.preparation current))
            in
            let admitted =
              Result.bind client ~f:(fun _ -> Operation_store.admit t.store ~id ~retry)
            in
            Eio.Promise.resolve resolve admitted;
            match client, admitted with
            | Error _, _ | _, Error _ -> ()
            | Ok client, Ok operation ->
              let state = outcome client operation in
              ignore
                (Operation_store.record t.store (Operation.with_state operation state)
                 : Operation.t)));
      Result.bind (Eio.Promise.await admission) ~f:(fun _ ->
        Operation_store.inspect t.store ~id))
;;

let recover t ~id =
  let open Result.Let_syntax in
  let%bind operation = Operation_store.inspect t.store ~id in
  let%bind entry = Operation_store.journal_entry t.store operation in
  let%bind request = Acknowledgement.receipt_request entry in
  let connection = Operation.Preparation.connection (Operation.preparation operation) in
  let%bind response = read t ~connection ~lane:Visible request in
  let%bind response = Api_response.of_json (Json.field response "response") in
  match Acknowledgement.receipt (Operation.request operation) ~entry ~response with
  | Ok None -> Operation_store.inspect t.store ~id
  | Ok (Some acknowledgement) ->
    let state =
      match acknowledgement with
      | Committed response -> Operation.Committed response
      | Observed response -> Observed response
    in
    Ok (Operation_store.record t.store (Operation.with_state operation state))
  | Error diagnostic ->
    let unknown =
      Operation.with_state
        operation
        (Outcome_unknown
           (Problem.create
              Outcome_unknown
              "receipt lookup did not verify the original operation"))
    in
    ignore
      (Operation_store.record t.store (Operation.with_diagnostic unknown diagnostic)
       : Operation.t);
    Error diagnostic
;;
