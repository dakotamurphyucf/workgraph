open Core
module P = Project_completion
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let project_id = W.id Id.Project.of_string Id.Project.to_string

module Command = P.Command

let request =
  Api_codec.as_json
    (Api_codec.object_
       (F.required "project_id" project_id
        ++ F.optional "at_revision" W.counter
        ++ F.optional "offset" W.counter
        ++ F.optional
             "limit"
             (W.checked (Api_codec.decimal ~max:100) (fun n ->
                if n = 0 then Json.fail Invalid_argument "limit must be 1..100"))
        ++ F.optional
             "max_bytes"
             (W.checked (Api_codec.decimal ~max:1048576) (fun n ->
                if n < 4096
                then Json.fail Invalid_argument "max_bytes must be 4096..1048576"))))
;;

let status =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

let response =
  Api_codec.as_json
    (Api_codec.object_
       (F.required "project_id" project_id
        ++ F.required "project_revision" W.positive
        ++ F.required "status" status
        ++ F.required "can_complete" Api_codec.boolean
        ++ F.required "counts" P.Counts.codec
        ++ F.required "items" (Api_codec.list P.Blocker.codec ~max_items:100)
        ++ F.required "offset" W.counter
        ++ F.required "remaining" W.counter
        ++ F.required "next_offset" (Api_codec.nullable W.counter)
        ++ F.required "needs_larger_budget" Api_codec.boolean
        ++ F.required "required_bytes" (Api_codec.nullable W.positive)))
  |> fun codec ->
  W.checked codec (fun data ->
    let counts = Json.field data "counts" |> Api_codec.decode P.Counts.codec |> unwrap in
    let expected_ready =
      counts.unfinished_tickets = 0
      && counts.claimed_tickets = 0
      && counts.active_attempts = 0
      && counts.gated_tickets = 0
      && counts.unfinished_milestones = 0
    in
    let flag key =
      match Json.field data key with
      | `True -> true
      | `False -> false
      | _ -> assert false
    in
    let integer key = Json.field data key |> Json.integer in
    let optional key =
      match Json.field data key with
      | `Null -> None
      | value -> Some (Json.integer value)
    in
    let count = Json.field data "items" |> Json.list |> List.length in
    let keys =
      Json.field data "items"
      |> Json.list
      |> List.map ~f:(fun item ->
        match Api_codec.decode P.Blocker.codec item |> unwrap with
        | Ticket { ticket_id; _ } -> 0, Id.Ticket.to_string ticket_id
        | Milestone { milestone_id; _ } -> 1, Id.Milestone.to_string milestone_id)
    in
    let ordered =
      List.is_sorted_strictly keys ~compare:(fun (kind, id) (other_kind, other_id) ->
        match Int.compare kind other_kind with
        | 0 -> String.compare id other_id
        | order -> order)
    in
    let offset = integer "offset"
    and remaining = integer "remaining" in
    if
      (not (Bool.equal (flag "can_complete") expected_ready))
      || (not ordered)
      || Option.exists (optional "required_bytes") ~f:(fun bytes ->
        bytes < 4096 || bytes > 1048576)
      || (expected_ready && (count > 0 || remaining > 0))
      || ((not expected_ready) && offset = 0 && count = 0 && remaining = 0)
      || count > Int.max_value - offset
      || (not
            (Option.equal
               Int.equal
               (optional "next_offset")
               (if remaining = 0 then None else Some (offset + count))))
      || (not (Bool.equal (flag "needs_larger_budget") (count = 0 && remaining > 0)))
      || not
           (Bool.equal
              (flag "needs_larger_budget")
              (Option.is_some (optional "required_bytes")))
    then
      Json.fail
        Invalid_argument
        "project readiness counts or continuation are inconsistent")
;;

let methods =
  [ Api_method.Packed.Pack
      (Api_method.create
         ~name:"project.readiness"
         ~summary:
           "Check captured project completion, ownership and gates without changing work."
         ~mode:Read
         ~request
         ~response)
  ; Api_method.Packed.Pack
      (Api_method.create
         ~name:"project.finish"
         ~summary:
           "Finish a ready project and record its attributed structured handoff \
            atomically."
         ~mode:Mutation
         ~request:Command.codec
         ~response:(Api_codec.as_json Planning_wire.Project.codec))
  ]
;;

let query t ~params =
  Json.decode (fun () ->
    ignore (Api_codec.decode request params |> unwrap : Jsonaf.t);
    let project = Json.field params "project_id" |> Id.Project.t_of_jsonaf in
    if not (Id.Project.equal project (P.project t))
    then Json.fail Invalid_argument "project capture differs";
    let integer key = Json.optional params key |> Option.map ~f:Json.integer in
    let guard = integer "at_revision" in
    Option.iter guard ~f:(fun revision ->
      if revision <> P.workspace_revision t
      then Json.fail Conflict "project readiness capture changed");
    let offset = Option.value (integer "offset") ~default:0
    and limit = Option.value (integer "limit") ~default:50 in
    if offset > 0 && Option.is_none guard
    then Json.fail Invalid_argument "project readiness pagination requires at_revision";
    let remaining = List.drop (P.blockers t) offset in
    let selected_count = Int.min limit (List.length remaining) in
    let encode codec value = Api_codec.encode codec value |> unwrap in
    let measure = Api_response.encoded_size Planning_read in
    let page ~budget count ~required_bytes =
      let left = List.length remaining - count in
      let data =
        Json.obj
          [ "project_id", Id.Project.jsonaf_of_t project
          ; "project_revision", Json.int (P.project_revision t)
          ; "status", encode status (P.status t)
          ; ("can_complete", if P.can_complete t then `True else `False)
          ; "counts", encode P.Counts.codec (P.counts t)
          ; ( "items"
            , `Array (List.take remaining count |> List.map ~f:(encode P.Blocker.codec)) )
          ; "offset", Json.int offset
          ; "remaining", Json.int left
          ; ("next_offset", if left = 0 then `Null else Json.int (offset + count))
          ; ("needs_larger_budget", if count = 0 && left > 0 then `True else `False)
          ; "required_bytes", Option.value_map required_bytes ~default:`Null ~f:Json.int
          ]
      in
      Json.obj [ "workspace_revision", Json.int (P.workspace_revision t); "data", data ]
      |> Query_budget.annotate_whole_items_exn
           ~measure
           ~max_bytes:budget
           ~omitted_items:(selected_count - count)
    in
    let required =
      if List.is_empty remaining
      then None
      else (
        let rec minimum budget =
          let needed = Int.max 4096 (page ~budget 1 ~required_bytes:None |> measure) in
          if needed > 1048576
          then
            Json.fail
              Invalid_argument
              "project readiness blocker exceeds the 1048576-byte query limit; inspect \
               the member ticket's readiness separately";
          if needed = budget then needed else minimum needed
        in
        Some (minimum 4096))
    in
    let max_bytes = Query_budget.of_params params in
    let rec fit count =
      let result =
        page
          ~budget:max_bytes
          count
          ~required_bytes:(if count = 0 then required else None)
      in
      if measure result <= max_bytes
      then result
      else if count > 0
      then fit (count - 1)
      else Json.fail Invalid_argument "project readiness metadata exceeds query budget"
    in
    let result = fit selected_count in
    ignore (Api_codec.decode response (Json.field result "data") |> unwrap : Jsonaf.t);
    result)
;;
