open Core

module Limits = struct
  type t =
    { timeout_ms : int
    ; max_attempts : int
    ; wait_slice_ms : int
    }

  let create ~timeout_ms ~max_attempts ~wait_slice_ms =
    Json.decode (fun () ->
      if
        timeout_ms < 1000
        || timeout_ms > 300000
        || max_attempts < 1
        || max_attempts > 100
        || wait_slice_ms < 1
        || wait_slice_ms > 25000
      then
        Json.fail
          Invalid_argument
          "reservation wait bounds: total 1000..300000ms, attempts 1..100, slice \
           1..25000ms";
      { timeout_ms; max_attempts; wait_slice_ms })
  ;;

  let default = { timeout_ms = 30000; max_attempts = 32; wait_slice_ms = 1000 }
end

type expected_grant =
  { target : Reservation_conflict.Target.t
  ; mode : Reservation.Mode.t
  ; lease_duration_ms : int64 option
  }

type t =
  { request : Protocol.Request.t
  ; limits : Limits.t
  ; workspace : Id.Workspace.t
  ; grants : expected_grant list
  ; actor : Id.Actor.t
  ; owner_run : Id.Run.t
  }

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let validate_request request =
  let method_ = Protocol.Request.method_ request in
  match Api_catalog.find method_ with
  | Some (Api_method.Packed.Pack definition) ->
    ignore
      (Api_codec.decode
         (Api_method.request_codec definition)
         (Protocol.Request.params request)
       |> unwrap)
  | None -> Json.fail Invalid_argument "unknown acquisition method"
;;

let create request ~limits =
  Json.decode (fun () ->
    let method_ = Protocol.Request.method_ request in
    if
      not
        (List.mem
           [ "reservation.acquire"; "reservation.paths.acquire" ]
           method_
           ~equal:String.equal)
    then
      Json.fail
        Invalid_argument
        "reservation wait requires reservation.acquire or reservation.paths.acquire";
    validate_request request;
    let params = Protocol.Request.params request in
    ignore (Id.Mutation.t_of_jsonaf (Json.field params "mutation_id") : Id.Mutation.t);
    let domain_params =
      match params with
      | `Object fields ->
        Json.obj
          (List.filter fields ~f:(fun (key, _) ->
             not
               (List.mem
                  [ "workspace_id"; "actor_id"; "mutation_id"; "run_id" ]
                  key
                  ~equal:String.equal)))
      | _ -> assert false
    in
    let command = Agent_run_api.decode_command ~method_ ~params:domain_params |> unwrap in
    let path_target path =
      Reservation_conflict.Target.Path
        { worktree_id = Path_scope.Worktree_id.to_string (Path_scope.worktree_id path)
        ; kind =
            (match Path_scope.kind path with
             | File -> Reservation_conflict.Path_kind.File
             | Subtree -> Subtree)
        ; path = Path_scope.path path
        }
    in
    let owner_run, grants =
      match command with
      | Reservation_acquire { run; requests } ->
        ( run
        , List.map requests ~f:(fun request ->
            { target =
                Reservation_conflict.Target.Named
                  (Reservation.Name.to_string request.Reservation.name)
            ; mode = request.mode
            ; lease_duration_ms = request.lease_duration_ms
            }) )
      | Coordination (Paths_acquire { run; requests }) ->
        ( run
        , List.map requests ~f:(fun request ->
            { target = path_target request.Path_reservation.Request.target
            ; mode = request.mode
            ; lease_duration_ms = request.lease_duration_ms
            }) )
      | _ -> assert false
    in
    if List.is_empty grants
    then Json.fail Invalid_argument "reservation wait batch must not be empty";
    if
      List.existsi grants ~f:(fun index grant ->
        List.exists (List.take grants index) ~f:(fun previous ->
          Reservation_conflict.Target.equal grant.target previous.target))
    then Json.fail Invalid_argument "reservation wait batch contains duplicate targets";
    { request
    ; limits
    ; workspace = Id.Workspace.t_of_jsonaf (Json.field params "workspace_id")
    ; actor = Id.Actor.t_of_jsonaf (Json.field params "actor_id")
    ; owner_run
    ; grants
    })
;;

module Stop = struct
  type t =
    | Acquired
    | Deadline
    | Attempt_limit
    | Needs_larger_budget
    | No_progress
    | Failed
    | Uncertain
  [@@deriving equal, sexp]

  let to_string = function
    | Acquired -> "acquired"
    | Deadline -> "deadline"
    | Attempt_limit -> "attempt_limit"
    | Needs_larger_budget -> "needs_larger_budget"
    | No_progress -> "no_progress"
    | Failed -> "failed"
    | Uncertain -> "uncertain"
  ;;
end

module Journal = struct
  type t =
    { request : Protocol.Request.t
    ; path : string
    ; started : bool
    }

  let to_json t =
    Json.obj
      [ "mutation_id", Json.field (Protocol.Request.params t.request) "mutation_id"
      ; "saved_request", Json.string t.path
      ; ("started", if t.started then `True else `False)
      ]
  ;;
end

module Outcome = struct
  type t =
    { stop : Stop.t
    ; journals : Journal.t list
    ; daemon_response : Jsonaf.t option
    ; feed_response : Jsonaf.t option
    ; last_conflict : Problem.t option
    ; problem : Problem.t option
    }

  let completed t = Stop.equal t.stop Acquired
  let stop t = t.stop

  let to_json t =
    let optional value encode = Option.value_map value ~default:`Null ~f:encode in
    let latest = List.last t.journals in
    Json.obj
      [ ( "data"
        , Json.obj
            [ "daemon_response", optional t.daemon_response Fn.id
            ; ( "wait"
              , Json.obj
                  [ ("completed", if completed t then `True else `False)
                  ; "stop", Json.string (Stop.to_string t.stop)
                  ; ( "attempt_count"
                    , Json.int (List.count t.journals ~f:(fun j -> j.started)) )
                  ; "journals", `Array (List.map t.journals ~f:Journal.to_json)
                  ; "last_conflict", optional t.last_conflict Problem.to_json
                  ; "problem", optional t.problem Problem.to_json
                  ; "feed_response", optional t.feed_response Fn.id
                  ; "saved_request", optional latest (fun j -> Json.string j.path)
                  ; ( "retry_request"
                    , optional latest (fun j -> Protocol.Request.to_json j.request) )
                  ] )
            ] )
      ; "meta", Json.obj []
      ]
  ;;
end

let mutation request =
  Id.Mutation.t_of_jsonaf (Json.field (Protocol.Request.params request) "mutation_id")
;;

let fresh_request request mutation =
  let fields =
    match Protocol.Request.params request with
    | `Object fields -> fields
    | _ -> assert false
  in
  Protocol.Request.with_params
    request
    (Json.obj
       (List.Assoc.add
          fields
          ~equal:String.equal
          "mutation_id"
          (Id.Mutation.jsonaf_of_t mutation)))
  |> unwrap
;;

let validate_grants t json =
  Json.decode (fun () ->
    let response = Api_response.of_json json |> unwrap in
    Api_response.require_durable response |> unwrap;
    let data = Api_response.data response in
    (match Api_catalog.find (Protocol.Request.method_ t.request) with
     | None -> assert false
     | Some (Api_method.Packed.Pack definition) ->
       ignore (Api_codec.decode (Api_method.response_codec definition) data |> unwrap));
    let rows = Json.list (Json.field data "holds") in
    if List.length rows <> List.length t.grants
    then Json.fail Invalid_argument "acquisition grant count differs from original batch";
    List.iter rows ~f:(fun row ->
      let target =
        match Json.optional row "reservation_id" with
        | Some name -> Reservation_conflict.Target.Named (Json.text name)
        | None ->
          let path =
            Coordination_wire.decode_exn Path_scope.codec (Json.field row "target")
          in
          Reservation_conflict.Target.Path
            { worktree_id = Path_scope.Worktree_id.to_string (Path_scope.worktree_id path)
            ; kind =
                (match Path_scope.kind path with
                 | File -> Reservation_conflict.Path_kind.File
                 | Subtree -> Subtree)
            ; path = Path_scope.path path
            }
      in
      let expected =
        match
          List.find t.grants ~f:(fun expected ->
            Reservation_conflict.Target.equal expected.target target)
        with
        | Some grant -> grant
        | None ->
          Json.fail
            Invalid_argument
            "acquisition grant target differs from original batch"
      in
      let holder =
        Coordination_wire.decode_exn Agent_run_wire.holder (Json.field row "holder")
      in
      let duration =
        match Allocation_lease.policy holder.lease with
        | Indefinite -> None
        | Duration_ms ms -> Some ms
      in
      if
        not
          (Id.Actor.equal holder.actor t.actor
           && Id.Run.equal holder.run t.owner_run
           && Reservation.Mode.equal holder.mode expected.mode
           && Option.equal Int64.equal duration expected.lease_duration_ms)
      then
        Json.fail
          Invalid_argument
          "acquisition grant owner/mode/lease differs from original request"))
;;

let collect t ~now ~max_exchange_seconds ~fresh_mutation ~save ~exchange =
  Json.decode (fun () ->
    if (not (Float.is_finite max_exchange_seconds)) || Float.(max_exchange_seconds <= 0.)
    then
      Json.fail
        Invalid_argument
        "reservation wait transport timeout must be finite and positive";
    let previous = ref (now ()) in
    if not (Float.is_finite !previous)
    then Json.fail Invalid_argument "monotonic clock must be finite";
    let origin = !previous in
    let remaining () =
      let observed = now () in
      if (not (Float.is_finite observed)) || Float.(observed < !previous)
      then
        Json.fail Invalid_argument "monotonic clock moved backwards or became nonfinite";
      previous := observed;
      (Float.of_int t.limits.timeout_ms /. 1000.) -. (observed -. origin)
    in
    let journals = ref []
    and last_conflict = ref None
    and feed_response = ref None in
    let finish ?problem ?daemon_response stop =
      { Outcome.stop
      ; journals = List.rev !journals
      ; daemon_response
      ; feed_response = !feed_response
      ; last_conflict = !last_conflict
      ; problem
      }
    in
    let finish_read_error (problem : Problem.t) =
      let stop =
        if
          Problem.equal_kind problem.kind Storage_unavailable
          && Float.(remaining () <= 0.)
        then Stop.Deadline
        else Stop.Failed
      in
      finish ~problem stop
    in
    let budget () = Float.min max_exchange_seconds (remaining ()) in
    let rpc method_ params =
      Protocol.Request.create ~id:"reservation-wait-read" ~method_ ~params |> unwrap
    in
    let read request =
      let timeout_seconds = budget () in
      if Float.(timeout_seconds <= 0.)
      then `Deadline
      else (
        match exchange ~timeout_seconds request with
        | Error problem -> `Error problem
        | Ok json ->
          (match Api_response.of_json json with
           | Error problem -> `Error problem
           | Ok response -> `Ok (json, response)))
    in
    let feed_kind = Json.string "agent_run_changed" in
    let feed_params position timeout =
      Json.obj
        ([ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
         ; "source", Json.string "planning"
         ; "kinds", `Array [ feed_kind ]
         ; "limit", Json.int 100
         ; "max_bytes", Json.int 65536
         ; position
         ]
         @ Option.to_list (Option.map timeout ~f:(fun ms -> "timeout_ms", Json.int ms)))
    in
    let feed request =
      match read request with
      | `Deadline -> `Deadline
      | `Error problem -> `Error problem
      | `Ok (json, response) ->
        feed_response := Some json;
        (match
           Api_codec.decode Change_feed_api.Response.codec (Api_response.data response)
         with
         | Error problem -> `Error problem
         | Ok data ->
           let unsafe_omissions =
             match Json.optional (Api_response.meta response) "budget" with
             | None -> false
             | Some budget ->
               let count key =
                 Option.value_map (Json.optional budget key) ~default:0 ~f:Json.integer
               in
               count "omitted_fields" > 0
               || (count "omitted_items" > 0
                   && ((not data.has_more)
                       || (not
                             (match Json.field budget "details_complete" with
                              | `True -> true
                              | _ -> false))
                       || List.exists
                            (Json.list (Json.field budget "details"))
                            ~f:(fun detail ->
                              not
                                (List.mem
                                   [ "/items"; "/data/items" ]
                                   (Json.text (Json.field detail "path"))
                                   ~equal:String.equal))))
           in
           if data.needs_larger_budget || unsafe_omissions
           then `Stopped Stop.Needs_larger_budget
           else `Ok data)
    in
    let typed_contention problem =
      (Problem.equal_kind problem.Problem.kind Conflict
       || Problem.equal_kind problem.kind Already_claimed)
      &&
      match problem.details with
      | Some (Reservation_conflict conflict) ->
        List.exists t.grants ~f:(fun grant ->
          Reservation_conflict.Target.equal grant.target conflict.requested)
      | _ -> false
    in
    let unknown (problem : Problem.t) =
      { problem with
        Problem.kind = Outcome_unknown
      ; message =
          "Acquisition reply was not a valid durable grant: "
          ^ problem.message
          ^ "; retry the exact saved request"
      }
    in
    let seen = ref (Id.Mutation.Set.singleton (mutation t.request)) in
    let rec acquire request cursor =
      if List.length !journals >= t.limits.max_attempts
      then finish Stop.Attempt_limit
      else if Float.(remaining () <= 0.)
      then finish Stop.Deadline
      else (
        match save request with
        | Error problem -> finish ~problem Stop.Failed
        | Ok path ->
          Disk.absolute path;
          if String.length path > 4096
          then Json.fail Invalid_argument "saved request path exceeds 4096 bytes";
          let journal = { Journal.request; path; started = false } in
          journals := journal :: !journals;
          let timeout_seconds = budget () in
          if Float.(timeout_seconds <= 0.)
          then finish Stop.Deadline
          else (
            journals := { journal with started = true } :: List.tl_exn !journals;
            match exchange ~timeout_seconds request with
            | Ok json ->
              let validated = validate_grants t json in
              (match validated with
               | Ok () -> finish ~daemon_response:json Stop.Acquired
               | Error problem ->
                 finish ~daemon_response:json ~problem:(unknown problem) Stop.Uncertain)
            | Error problem when typed_contention problem ->
              last_conflict := Some problem;
              if List.length !journals >= t.limits.max_attempts
              then finish Stop.Attempt_limit
              else wait request cursor
            | Error problem ->
              finish
                ~problem
                (if Problem.equal_kind problem.kind Outcome_unknown
                 then Stop.Uncertain
                 else Stop.Failed)))
    and wait request cursor =
      let seconds = budget () in
      if Float.(seconds <= 0.)
      then finish Stop.Deadline
      else (
        let wait_ms = Int.min t.limits.wait_slice_ms (Float.to_int (seconds *. 500.)) in
        if wait_ms < 1
        then finish Stop.Deadline
        else (
          match
            feed
              (rpc
                 "changes.wait"
                 (feed_params ("cursor", Json.string cursor) (Some wait_ms)))
          with
          | `Deadline -> finish Stop.Deadline
          | `Error problem -> finish_read_error problem
          | `Stopped stop -> finish stop
          | `Ok response ->
            if response.has_more && String.equal response.cursor cursor
            then finish Stop.No_progress
            else if Float.(remaining () <= 0.)
            then finish Stop.Deadline
            else (
              let id = fresh_mutation () in
              if Set.mem !seen id
              then
                finish
                  ~problem:
                    (Problem.create
                       Invalid_argument
                       "fresh acquisition mutation identity was repeated")
                  Stop.Failed
              else (
                seen := Set.add !seen id;
                let next = fresh_request request id in
                validate_request next;
                acquire next response.cursor))))
    in
    let workspace =
      rpc
        "workspace.get"
        (Json.obj [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace ])
    in
    match read workspace with
    | `Deadline -> finish Stop.Deadline
    | `Error problem -> finish_read_error problem
    | `Ok (_, response) ->
      let after = Json.field (Api_response.meta response) "workspace_revision" in
      (match feed (rpc "changes.read" (feed_params ("after", after) None)) with
       | `Deadline -> finish Stop.Deadline
       | `Error problem -> finish_read_error problem
       | `Stopped stop -> finish stop
       | `Ok response -> acquire t.request response.cursor))
;;

let run
      t
      ~fs
      ~net
      ~clock
      ~random
      ~socket
      ~request_directory
      ~max_exchange_seconds
      ~on_saved
  =
  Json.decode (fun () ->
    Disk.absolute request_directory;
    Local_file.require_directory
      Eio.Path.(fs / request_directory)
      ~operation:"reservation wait journal";
    let origin = Eio.Time.Mono.now clock in
    let now () =
      Mtime.span origin (Eio.Time.Mono.now clock)
      |> Mtime.Span.to_float_ns
      |> fun ns -> ns /. 1e9
    in
    let fresh_mutation () =
      let bytes = Cstruct.create 32 in
      Eio.Flow.read_exact random bytes;
      Id.Mutation.of_string (Json.hash (Cstruct.to_string bytes)) |> unwrap
    in
    let save request =
      Json.decode (fun () ->
        let path =
          Filename.concat
            request_directory
            (Id.Mutation.to_string (mutation request) ^ ".json")
        in
        Local_file.write_new
          ~operation:"reservation wait journal"
          Eio.Path.(fs / path)
          (Json.canonical (Protocol.Request.to_json request));
        on_saved path;
        path)
    in
    let exchange ~timeout_seconds request =
      Result.bind (Client.create ~net ~clock ~socket ~timeout_seconds) ~f:(fun client ->
        Client.invoke client request)
    in
    collect t ~now ~max_exchange_seconds ~fresh_mutation ~save ~exchange |> unwrap)
;;
