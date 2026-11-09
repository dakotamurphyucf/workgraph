open Core
open Workgraph

type entry =
  { mutable operation : Operation.t
  ; mutable published : bool
  }

type t =
  { root : State_root.t
  ; random : unit -> string
  ; mutex : Eio.Mutex.t
  ; mutable operations : entry Operation.Id.Map.t
  ; mutable intentions : Operation.Id.t String.Map.t
  }

type prepared = Operation.t

let operation prepared = prepared

let name operation =
  "operation-" ^ Operation.Id.to_string (Operation.id operation) ^ ".json"
;;

let synchronized t f =
  Eio.Mutex.lock t.mutex;
  Exn.protect ~f ~finally:(fun () -> Eio.Mutex.unlock t.mutex)
;;

let find t id =
  match Map.find t.operations id with
  | Some entry -> entry
  | None -> Json.fail Not_found "operation is not present in this companion state root"
;;

let save t operation =
  State_root.save
    t.root
    ~name:(name operation)
    ~value:(Operation.to_storage_json operation)
;;

let sync_journal t operation =
  match Operation.journal_path operation with
  | None -> Ok ()
  | Some destination ->
    Request_journal.sync_existing
      (Operation.request operation)
      ~fs:(State_root.directory t.root)
      ~destination
;;

let create ~root ~random =
  let open Result.Let_syntax in
  let%bind names = State_root.names root in
  Json.decode (fun () ->
    let random () =
      let bytes = Cstruct.create 32 in
      Eio.Flow.read_exact random bytes;
      Json.hash (Cstruct.to_string bytes)
    in
    let t =
      { root
      ; random
      ; mutex = Eio.Mutex.create ()
      ; operations = Operation.Id.Map.empty
      ; intentions = String.Map.empty
      }
    in
    List.iter names ~f:(fun filename ->
      if String.is_prefix filename ~prefix:"operation-"
      then (
        let value = State_root.read root ~name:filename |> Disk.unwrap in
        let value =
          match value with
          | Some value -> value
          | None -> Json.fail Corrupt_store "operation disappeared during startup"
        in
        let operation = Operation.of_storage_json value |> Disk.unwrap in
        if not (String.equal filename (name operation))
        then Json.fail Corrupt_store "operation filename mismatch";
        let id = Operation.id operation in
        let intention =
          Operation.Preparation.intention_id (Operation.preparation operation)
        in
        if Map.mem t.operations id || Map.mem t.intentions intention
        then Json.fail Corrupt_store "duplicate operation or intention identity";
        (match Operation.journal_path operation with
         | None -> ()
         | Some destination ->
           let expected =
             Request_journal.path
               (Operation.request operation)
               ~directory:(State_root.journal_directory root)
             |> Disk.unwrap
           in
           if not (String.equal expected destination)
           then
             Json.fail Corrupt_store "operation journal escaped its original state root");
        sync_journal t operation |> Disk.unwrap;
        (* Readable metadata may be the installed winner of an interrupted
           parent sync. Re-publish and sync before any recovered preparation is
           acknowledged as durable. Sending is now conservatively Unknown. *)
        save t operation |> Disk.unwrap;
        t.operations <- Map.set t.operations ~key:id ~data:{ operation; published = true };
        t.intentions <- Map.set t.intentions ~key:intention ~data:id));
    t)
;;

let prepare t preparation ~materialize =
  synchronized t (fun () ->
    Json.decode (fun () ->
      let intention = Operation.Preparation.intention_id preparation in
      let publish entry =
        if not entry.published
        then (
          let operation = entry.operation in
          (match Operation.journal_path operation with
           | None -> ()
           | Some destination ->
             ignore
               (Request_journal.save
                  (Operation.request operation)
                  ~fs:(State_root.directory t.root)
                  ~random:(Eio.Flow.string_source (t.random ()))
                  ~destination
                |> Disk.unwrap
                : Request_journal.Saved.t));
          save t operation |> Disk.unwrap;
          entry.published <- true);
        entry.operation
      in
      match Map.find t.intentions intention with
      | Some id ->
        let entry = find t id in
        if
          not
            (String.equal
               (Json.canonical (Operation.Preparation.to_json preparation))
               (Json.canonical
                  (Operation.Preparation.to_json (Operation.preparation entry.operation))))
        then
          Json.fail
            Idempotency_conflict
            "intention was already prepared with different complete inputs";
        publish entry
      | None ->
        if Map.length t.operations >= 10000
        then
          Json.fail
            Conflict
            "companion operation limit reached; choose another private state root";
        let request = materialize () |> Disk.unwrap in
        let id = Operation.Id.of_string (t.random ()) |> Disk.unwrap in
        if Map.mem t.operations id
        then
          Json.fail
            Conflict
            "random operation identity collision; no operation was published";
        let journal_path =
          if Cli_mutation_identity.required request
          then
            Some
              (Request_journal.path
                 request
                 ~directory:(State_root.journal_directory t.root)
               |> Disk.unwrap)
          else None
        in
        let operation = Operation.create ~id ~preparation ~request ~journal_path in
        ignore
          (Operation.of_json (Operation.to_json operation) |> Disk.unwrap : Operation.t);
        let entry = { operation; published = false } in
        t.operations <- Map.set t.operations ~key:id ~data:entry;
        t.intentions <- Map.set t.intentions ~key:intention ~data:id;
        publish entry))
;;

let inspect t ~id =
  Json.decode (fun () ->
    let entry = find t id in
    if not entry.published
    then Json.fail Conflict "operation preparation has not completed durable publication";
    entry.operation)
;;

let list t ~offset ~limit =
  Json.decode (fun () ->
    if offset < 0 || limit < 1 || limit > 100
    then
      Json.fail
        Invalid_argument
        "operation list requires nonnegative offset and limit 1..100";
    let operations =
      Map.data t.operations |> List.filter ~f:(fun entry -> entry.published)
    in
    let selected = List.take (List.drop operations offset) limit in
    let remaining = Int.max 0 (List.length operations - offset - List.length selected) in
    Json.obj
      [ ( "items"
        , `Array (List.map selected ~f:(fun entry -> Operation.summary entry.operation)) )
      ; "offset", Json.int offset
      ; "remaining", Json.int remaining
      ; ( "next_offset"
        , if remaining = 0 then `Null else Json.int (offset + List.length selected) )
      ])
;;

let admit t ~id ~retry =
  synchronized t (fun () ->
    Json.decode (fun () ->
      let entry = find t id in
      if not entry.published
      then Json.fail Conflict "preparation did not finish durable publication";
      let admitted =
        match Operation.state entry.operation with
        | Prepared_unsent -> not retry
        | Outcome_unknown _ -> retry
        | Observed _ ->
          retry
          && String.equal
               (Protocol.Request.method_ (Operation.request entry.operation))
               "ticket.claim_next"
        | Sending | Committed _ | Rejected _ -> false
      in
      if not admitted
      then
        Json.fail
          Conflict
          "operation state does not permit this execute or explicit retry";
      sync_journal t entry.operation |> Disk.unwrap;
      let sending = Operation.with_state entry.operation Sending in
      (* The volatile state changes before the first possible suspension. No second
     caller can restore Prepared_unsent after uncertain admission persistence. *)
      entry.operation <- sending;
      match save t sending with
      | Ok () -> sending
      | Error diagnostic ->
        entry.operation
        <- Operation.with_diagnostic
             (Operation.with_state
                sending
                (Outcome_unknown
                   (Problem.create
                      Outcome_unknown
                      "send admission persistence failed; no exchange was authorized")))
             diagnostic;
        raise (Json.Decode_error diagnostic)))
;;

let record t operation =
  synchronized t (fun () ->
    let entry = find t (Operation.id operation) in
    (match Operation.state operation with
     | Prepared_unsent | Sending ->
       invalid_arg "Operation_store.record requires an observed outcome"
     | Committed _ | Observed _ | Rejected _ | Outcome_unknown _ -> ());
    if
      not
        (String.equal
           (Json.canonical (Protocol.Request.to_json (Operation.request operation)))
           (Json.canonical (Protocol.Request.to_json (Operation.request entry.operation)))
         && String.equal
              (Operation.Preparation.input_hash (Operation.preparation operation))
              (Operation.Preparation.input_hash (Operation.preparation entry.operation)))
    then invalid_arg "Operation_store.record cannot replace immutable operation inputs";
    let operation =
      match Operation.state entry.operation, Operation.state operation with
      | Committed _, _ -> entry.operation
      | _, Committed response ->
        if Operation.revision operation <= Operation.revision entry.operation
        then Operation.with_state entry.operation (Committed response)
        else operation
      | (Observed _ | Rejected _), Outcome_unknown _ -> entry.operation
      | (Prepared_unsent | Sending | Outcome_unknown _), (Observed _ | Rejected _) ->
        if Operation.revision operation <= Operation.revision entry.operation
        then Operation.with_state entry.operation (Operation.state operation)
        else operation
      | _, _ when Operation.revision operation <= Operation.revision entry.operation ->
        entry.operation
      | ( (Prepared_unsent | Sending | Observed _ | Rejected _ | Outcome_unknown _)
        , (Prepared_unsent | Sending | Observed _ | Rejected _ | Outcome_unknown _) ) ->
        operation
    in
    entry.operation <- operation;
    match save t operation with
    | Ok () -> operation
    | Error diagnostic ->
      let operation = Operation.with_diagnostic operation diagnostic in
      entry.operation <- operation;
      operation)
;;

let journal_entry t operation =
  Request_journal.Entry.create
    (Operation.request operation)
    ~fs:(State_root.directory t.root)
;;
