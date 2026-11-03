open Core
module F = Api_codec.Fields

let ( ++ ) = F.both
let count = Api_codec.decimal ~max:Int.max_value
let quantity = Api_codec.decimal64 ~max:Int64.max_value

let status_codec =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

let checked codec f =
  Api_codec.map
    codec
    ~decode:(fun value ->
      Result.map (Json.decode (fun () -> f value)) ~f:(fun () -> value))
    ~encode:Fn.id
    ~description:"Validated metrics observation."
;;

let require condition message = if not condition then Json.fail Invalid_argument message

let add a b =
  if Int64.(a > max_value - b) then Int64.max_value, true else Int64.(a + b), false
;;

module Status = struct
  type t =
    { status : Workflow.Category.t
    ; tickets : int
    ; elapsed_ms : int64
    ; closed_intervals : int
    ; open_intervals : int
    ; unknown_intervals : int
    ; overflow : bool
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "status" status_codec
          ++ F.required "tickets" count
          ++ F.required "elapsed_ms" quantity
          ++ F.required "closed_intervals" count
          ++ F.required "open_intervals" count
          ++ F.required "unknown_intervals" count
          ++ F.required "overflow" Api_codec.boolean)
         ~decode:
           (fun
             ( ( ((((status, tickets), elapsed_ms), closed_intervals), open_intervals)
               , unknown_intervals )
             , overflow ) ->
           { status
           ; tickets
           ; elapsed_ms
           ; closed_intervals
           ; open_intervals
           ; unknown_intervals
           ; overflow
           })
         ~encode:(fun t ->
           ( ( ( (((t.status, t.tickets), t.elapsed_ms), t.closed_intervals)
               , t.open_intervals )
             , t.unknown_intervals )
           , t.overflow )))
    |> fun c ->
    checked c (fun t ->
      require
        (t.open_intervals = t.tickets)
        "One open status interval per current ticket required";
      require
        (t.unknown_intervals <= t.closed_intervals
         || t.unknown_intervals - t.closed_intervals <= t.open_intervals)
        "Unknown duration count exceeds intervals";
      require
        ((not t.overflow) || Int64.equal t.elapsed_ms Int64.max_value)
        "Overflow must saturate duration")
  ;;
end

module Usage = struct
  type t =
    { observations : int
    ; tokens : int64
    ; elapsed_ms : int64
    ; overflow : bool
    ; metrics : Usage_record.Metric_total.t list
    ; metric_series : int
    ; omitted_metric_series : int
    ; metric_overflow : bool
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "observations" count
          ++ F.required "tokens" quantity
          ++ F.required "elapsed_ms" quantity
          ++ F.required "overflow" Api_codec.boolean
          ++ F.required
               "metrics"
               (Api_codec.list Usage_record.Metric_total.codec ~max_items:16)
          ++ F.required "metric_series" count
          ++ F.required "omitted_metric_series" count
          ++ F.required "metric_overflow" Api_codec.boolean)
         ~decode:
           (fun
             ( ( ( ((((observations, tokens), elapsed_ms), overflow), metrics)
                 , metric_series )
               , omitted_metric_series )
             , metric_overflow ) ->
           { observations
           ; tokens
           ; elapsed_ms
           ; overflow
           ; metrics
           ; metric_series
           ; omitted_metric_series
           ; metric_overflow
           })
         ~encode:(fun t ->
           ( ( ( ((((t.observations, t.tokens), t.elapsed_ms), t.overflow), t.metrics)
               , t.metric_series )
             , t.omitted_metric_series )
           , t.metric_overflow )))
    |> fun c ->
    checked c (fun t ->
      require
        (t.observations > 0
         || (Int64.equal t.tokens 0L
             && Int64.equal t.elapsed_ms 0L
             && (not t.overflow)
             && t.metric_series = 0))
        "Nonzero usage without observations";
      require
        ((not t.overflow)
         || Int64.equal t.tokens Int64.max_value
         || Int64.equal t.elapsed_ms Int64.max_value)
        "Overflow must saturate a reported quantity";
      require
        (t.metric_series = List.length t.metrics + t.omitted_metric_series)
        "Metric series count mismatch";
      require
        (List.is_sorted_strictly t.metrics ~compare:(fun a b ->
           match String.compare a.Usage_record.Metric_total.name b.name with
           | 0 -> String.compare a.unit_ b.unit_
           | n -> n))
        "Metric preview must contain distinct ordered series";
      require
        (List.for_all t.metrics ~f:(fun m ->
           m.Usage_record.Metric_total.samples <= t.observations))
        "Metric samples exceed distinct sources";
      require
        ((not t.metric_overflow) || t.observations > 0)
        "Metric overflow without sources";
      require
        (t.metric_overflow
         || not (List.exists t.metrics ~f:(fun m -> m.Usage_record.Metric_total.overflow))
        )
        "Undisclosed metric overflow";
      require
        (t.omitted_metric_series > 0
         || Bool.equal
              t.metric_overflow
              (List.exists t.metrics ~f:(fun m -> m.Usage_record.Metric_total.overflow)))
        "Metric overflow mismatch")
  ;;

  let of_records records =
    let unwrap = function
      | Ok x -> x
      | Error e -> raise (Json.Decode_error e)
    in
    let records = Usage_record.deduplicate records |> unwrap in
    let metrics = Usage_record.metric_totals records |> unwrap in
    let tokens, elapsed_ms, overflow =
      List.fold records ~init:(0L, 0L, false) ~f:(fun (tokens, elapsed_ms, overflow) r ->
        let tokens, a = add tokens r.Usage_record.tokens in
        let elapsed_ms, b = add elapsed_ms r.elapsed_ms in
        tokens, elapsed_ms, overflow || a || b)
    in
    { observations = List.length records
    ; tokens
    ; elapsed_ms
    ; overflow
    ; metrics = List.take metrics 16
    ; metric_series = List.length metrics
    ; omitted_metric_series = Int.max 0 (List.length metrics - 16)
    ; metric_overflow =
        List.exists metrics ~f:(fun m -> m.Usage_record.Metric_total.overflow)
    }
  ;;
end

module Planning = struct
  type t =
    { revision : int
    ; statuses : Status.t list
    ; completion_transitions : int
    ; reopenings : int
    ; completed_tickets_with_evidence : int
    ; tickets_with_recorded_manifest : int
    ; stored_assertions : int
    ; stored_accepted_submissions : int
    ; reported_usage : Usage.t
    ; admission : Admission.t list
    }
end

type t =
  { planning : Planning.t
  ; observed_unix_ms : int64
  ; history_head : string option
  ; history_commits : int
  ; storage_admission : Admission.t list
  }

let all_limits =
  [ Admission.Limit.Planning_commits
  ; Planning_transaction_bytes
  ; Planning_payload_bytes
  ; History_commits
  ; History_batch_bytes
  ; Tickets
  ; Projects
  ; Milestones
  ; Resources
  ; Referenced_resource_bytes
  ; Fact_keys
  ; Fact_version_bytes
  ; Active_uploads
  ; Reserved_upload_bytes
  ]
;;

let validate t =
  let p = t.planning in
  require
    (Int64.(t.observed_unix_ms >= 0L)
     && List.for_all
          [ p.revision
          ; t.history_commits
          ; p.completion_transitions
          ; p.reopenings
          ; p.completed_tickets_with_evidence
          ; p.tickets_with_recorded_manifest
          ; p.stored_assertions
          ; p.stored_accepted_submissions
          ]
          ~f:(fun count -> count >= 0))
    "Negative metric observation";
  let validate_codec codec value =
    match Api_codec.encode codec value with
    | Ok _ -> ()
    | Error error -> raise (Json.Decode_error error)
  in
  List.iter p.statuses ~f:(validate_codec Status.codec);
  validate_codec Usage.codec p.reported_usage;
  let all = p.admission @ t.storage_admission in
  let planning_limit = function
    | Admission.Limit.Planning_payload_bytes
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Referenced_resource_bytes
    | Fact_keys
    | Fact_version_bytes -> true
    | Planning_commits
    | Planning_transaction_bytes
    | History_commits
    | History_batch_bytes
    | Active_uploads
    | Reserved_upload_bytes -> false
  in
  require
    (List.for_all p.admission ~f:(fun meter -> planning_limit (Admission.limit meter))
     && List.for_all t.storage_admission ~f:(fun meter ->
       not (planning_limit (Admission.limit meter))))
    "Admission meter has the wrong capture owner";
  require
    (List.length all = List.length all_limits)
    "Metrics require all admission meters";
  List.iter all_limits ~f:(fun limit ->
    require
      (List.count all ~f:(fun meter ->
         Admission.Limit.equal limit (Admission.limit meter))
       = 1)
      "Metrics admission names must be unique and complete");
  let used limit =
    Admission.used
      (List.find_exn all ~f:(fun m -> Admission.Limit.equal (Admission.limit m) limit))
  in
  require
    (used Planning_commits = p.revision && used History_commits = t.history_commits)
    "Commit counters disagree with admission capture";
  require
    (Bool.equal (t.history_commits = 0) (Option.is_none t.history_head))
    "History head and commit count disagree";
  Option.iter t.history_head ~f:(fun hash ->
    require
      (String.length hash = 64
       && String.for_all hash ~f:(fun c -> Char.is_digit c || Char.(c >= 'a' && c <= 'f'))
      )
      "Invalid history head");
  let statuses = [ Workflow.Category.Backlog; Todo; In_progress; Done; Canceled ] in
  require (List.length p.statuses = 5) "All status observations required";
  List.iter statuses ~f:(fun status ->
    require
      (List.count p.statuses ~f:(fun row ->
         Workflow.Category.equal row.Status.status status)
       = 1)
      "Duplicate status observation");
  List.iter p.statuses ~f:(fun row ->
    require (row.Status.tickets <= used Tickets) "Status count exceeds ticket count");
  let tickets = List.sum (module Int) p.statuses ~f:(fun s -> s.Status.tickets) in
  let done_ =
    List.find_exn p.statuses ~f:(fun s -> Workflow.Category.equal s.Status.status Done)
  in
  require (tickets = used Tickets) "Status counts disagree with ticket admission";
  require
    (p.completed_tickets_with_evidence <= done_.tickets
     && p.tickets_with_recorded_manifest <= tickets
     && p.stored_accepted_submissions <= tickets)
    "Evidence coverage exceeds relevant tickets"
;;

let create planning ~observed_unix_ms ~history_head ~storage_admission =
  Json.decode (fun () ->
    require Int64.(observed_unix_ms >= 0L) "Observation time must be nonnegative";
    let history_commits =
      match
        List.find storage_admission ~f:(fun m ->
          Admission.Limit.equal (Admission.limit m) History_commits)
      with
      | Some meter -> Admission.used meter
      | None -> Json.fail Invalid_argument "History admission capture missing"
    in
    let t =
      { planning; observed_unix_ms; history_head; history_commits; storage_admission }
    in
    validate t;
    t)
;;

let codec =
  Api_codec.object_
    (F.map
       (F.required "planning_commits" count
        ++ F.required "history_commits" count
        ++ F.required "history_head" (Api_codec.nullable (Api_codec.text ~max_bytes:64))
        ++ F.required "observed_unix_ms" quantity
        ++ F.required "statuses" (Api_codec.list Status.codec ~max_items:5)
        ++ F.required "completion_transitions" count
        ++ F.required "reopenings" count
        ++ F.required "completed_tickets_with_evidence" count
        ++ F.required "tickets_with_recorded_manifest" count
        ++ F.required "stored_assertions" count
        ++ F.required "stored_accepted_submissions" count
        ++ F.required "reported_usage" Usage.codec
        ++ F.required "planning_admission" (Api_codec.list Admission.codec ~max_items:8)
        ++ F.required "storage_admission" (Api_codec.list Admission.codec ~max_items:6))
       ~decode:
         (fun
           ( ( ( ( ( ( ( ( ( ( ( ((revision, history_commits), history_head)
                               , observed_unix_ms )
                             , statuses )
                           , completion_transitions )
                         , reopenings )
                       , completed_tickets_with_evidence )
                     , tickets_with_recorded_manifest )
                   , stored_assertions )
                 , stored_accepted_submissions )
               , reported_usage )
             , admission )
           , storage_admission ) ->
         { planning =
             { Planning.revision
             ; statuses
             ; completion_transitions
             ; reopenings
             ; completed_tickets_with_evidence
             ; tickets_with_recorded_manifest
             ; stored_assertions
             ; stored_accepted_submissions
             ; reported_usage
             ; admission
             }
         ; observed_unix_ms
         ; history_head
         ; history_commits
         ; storage_admission
         })
       ~encode:(fun t ->
         let p = t.planning in
         ( ( ( ( ( ( ( ( ( ( ( ((p.revision, t.history_commits), t.history_head)
                             , t.observed_unix_ms )
                           , p.statuses )
                         , p.completion_transitions )
                       , p.reopenings )
                     , p.completed_tickets_with_evidence )
                   , p.tickets_with_recorded_manifest )
                 , p.stored_assertions )
               , p.stored_accepted_submissions )
             , p.reported_usage )
           , p.admission )
         , t.storage_admission )))
  |> fun c -> checked c validate
;;

module Request = struct
  type t =
    { at_revision : int option
    ; max_bytes : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.optional "at_revision" count
          ++ F.optional "max_bytes" (Api_codec.decimal ~max:1_048_576))
         ~decode:(fun (at_revision, max_bytes) ->
           { at_revision; max_bytes = Option.value max_bytes ~default:65_536 })
         ~encode:(fun t -> t.at_revision, Some t.max_bytes))
    |> fun c ->
    checked c (fun t -> require (t.max_bytes >= 4096) "max_bytes must be at least4096")
  ;;
end

let method_ =
  Api_method.create
    ~name:"workspace.metrics"
    ~summary:
      "Observe committed activity, reported usage and exact admission accounting; no \
       inferred client calls."
    ~mode:Read
    ~request:Request.codec
    ~response:codec
;;

let response t ~max_bytes =
  Json.decode (fun () ->
    require (max_bytes >= 4096 && max_bytes <= 1_048_576) "Invalid metrics byte budget";
    let rec fit count =
      let usage = t.planning.reported_usage in
      let preview =
        { usage with
          Usage.metrics = List.take usage.metrics count
        ; omitted_metric_series = usage.metric_series - count
        }
      in
      let value = { t with planning = { t.planning with reported_usage = preview } } in
      let data =
        match Api_codec.encode codec value with
        | Ok x -> x
        | Error e -> raise (Json.Decode_error e)
      in
      let result =
        Json.obj [ "workspace_revision", Json.int t.planning.revision; "data", data ]
      in
      if Api_response.encoded_size Planning_read result <= max_bytes
      then result
      else if count > 0
      then fit (count - 1)
      else Json.fail Invalid_argument "Metrics cannot fit; increase max_bytes"
    in
    fit (List.length t.planning.reported_usage.metrics))
;;
