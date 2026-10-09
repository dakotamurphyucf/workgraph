open Core

module Limit = struct
  type t =
    | Planning_commits
    | Planning_transaction_bytes
    | Planning_payload_bytes
    | History_commits
    | History_batch_bytes
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Referenced_resource_bytes
    | Fact_keys
    | Fact_version_bytes
    | Active_uploads
    | Reserved_upload_bytes
  [@@deriving sexp, compare, equal]

  let maximum = function
    | Planning_commits -> 100_000
    | Planning_transaction_bytes -> 128 * 1024 * 1024
    | Planning_payload_bytes | History_batch_bytes -> 64 * 1024 * 1024
    | History_commits -> 1_000_000
    | Tickets | Resources | Fact_keys -> 10_000
    | Projects | Milestones -> 1_000
    | Referenced_resource_bytes -> 512 * 1024 * 1024
    | Fact_version_bytes -> 16 * 1024 * 1024
    | Active_uploads -> 8
    | Reserved_upload_bytes -> 256 * 1024 * 1024
  ;;

  let entries =
    [ "planning_commits", Planning_commits
    ; "planning_transaction_bytes", Planning_transaction_bytes
    ; "planning_payload_bytes", Planning_payload_bytes
    ; "history_commits", History_commits
    ; "history_batch_bytes", History_batch_bytes
    ; "tickets", Tickets
    ; "projects", Projects
    ; "milestones", Milestones
    ; "resources", Resources
    ; "referenced_resource_bytes", Referenced_resource_bytes
    ; "fact_keys", Fact_keys
    ; "fact_version_bytes", Fact_version_bytes
    ; "active_uploads", Active_uploads
    ; "reserved_upload_bytes", Reserved_upload_bytes
    ]
  ;;

  let name t = List.find_exn entries ~f:(fun (_, limit) -> equal t limit) |> fst
  let codec = Api_codec.enum entries ~equal
  let all = List.map entries ~f:snd

  let unit_ = function
    | Planning_transaction_bytes
    | Planning_payload_bytes
    | History_batch_bytes
    | Referenced_resource_bytes
    | Fact_version_bytes
    | Reserved_upload_bytes -> "bytes"
    | Planning_commits
    | History_commits
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Fact_keys
    | Active_uploads -> "count"
  ;;
end

module Severity = struct
  type t =
    | Normal
    | Notice
    | Warning
    | Critical
  [@@deriving sexp, compare, equal]

  let codec =
    Api_codec.enum
      [ "normal", Normal; "notice", Notice; "warning", Warning; "critical", Critical ]
      ~equal
  ;;
end

module Lifetime = struct
  type t =
    | Cumulative
    | Temporary
  [@@deriving sexp, equal]

  let codec = Api_codec.enum [ "cumulative", Cumulative; "temporary", Temporary ] ~equal
end

type t =
  { limit : Limit.t
  ; used : int
  }
[@@deriving sexp, equal]

let create limit ~used =
  if used < 0 || used > Limit.maximum limit
  then
    Error
      (Problem.create Invalid_argument "Admission usage is outside its enforced limit")
  else Ok { limit; used }
;;

let limit t = t.limit
let used t = t.used
let remaining t = Limit.maximum t.limit - t.used

let percent_used t =
  Int64.(to_int_exn (of_int t.used * 100L / of_int (Limit.maximum t.limit)))
;;

let severity t =
  match percent_used t with
  | percent when percent >= 95 -> Severity.Critical
  | percent when percent >= 80 -> Warning
  | percent when percent >= 50 -> Notice
  | _ -> Normal
;;

let threshold_percent t =
  match severity t with
  | Normal -> 0
  | Notice -> 50
  | Warning -> 80
  | Critical -> 95
;;

let lifetime t =
  match t.limit with
  | Active_uploads | Reserved_upload_bytes -> Lifetime.Temporary
  | Planning_commits
  | Planning_transaction_bytes
  | Planning_payload_bytes
  | History_commits
  | History_batch_bytes
  | Tickets
  | Projects
  | Milestones
  | Resources
  | Referenced_resource_bytes
  | Fact_keys
  | Fact_version_bytes -> Cumulative
;;

let refusal limit ~used ~attempted ~kind =
  let maximum = Limit.maximum limit in
  if used < 0 || attempted <= maximum
  then
    invalid_arg "capacity refusal requires nonnegative usage and a binding proposed total";
  let meter = Limit.name limit in
  let operator_action =
    match limit with
    | Active_uploads | Reserved_upload_bytes ->
      "docs/agent/capacity-rollover.md#temporary-upload-occupancy"
    | Planning_commits
    | Planning_transaction_bytes
    | Planning_payload_bytes
    | History_commits
    | History_batch_bytes
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Referenced_resource_bytes
    | Fact_keys
    | Fact_version_bytes -> "docs/agent/capacity-rollover.md#roll-over-before-saturation"
  in
  Problem.create kind ("Admission limit " ^ meter ^ " exceeded; see " ^ operator_action)
  |> fun problem ->
  Problem.with_details
    problem
    (Capacity
       { meter
       ; used
       ; limit = maximum
       ; attempted
       ; unit = Limit.unit_ limit
       ; operator_action
       })
;;

let codec =
  let module F = Api_codec.Fields in
  let ( ++ ) = F.both in
  Api_codec.map
    (Api_codec.object_
       (F.required "name" Limit.codec
        ++ F.required "unit" (Api_codec.text ~max_bytes:5)
        ++ F.required "used" (Api_codec.decimal ~max:Int.max_value)
        ++ F.required "limit" (Api_codec.decimal ~max:Int.max_value)
        ++ F.required "remaining" (Api_codec.decimal ~max:Int.max_value)
        ++ F.required "severity" Severity.codec
        ++ F.required "threshold_percent" (Api_codec.decimal ~max:100)
        ++ F.required "percent_used" (Api_codec.decimal ~max:100)
        ++ F.required "lifetime" Lifetime.codec))
    ~decode:
      (fun
        ( ( ((((((limit, unit_), used), maximum), remaining), severity_), threshold)
          , percent )
        , lifetime_ ) ->
      Result.bind (create limit ~used) ~f:(fun t ->
        if
          String.equal unit_ (Limit.unit_ limit)
          && maximum = Limit.maximum limit
          && remaining = maximum - used
          && Severity.equal severity_ (severity t)
          && threshold = threshold_percent t
          && percent = percent_used t
          && Lifetime.equal lifetime_ (lifetime t)
        then Ok t
        else Error (Problem.create Invalid_argument "Admission units or headroom differ")))
    ~encode:(fun t ->
      ( ( ( ( ( (((t.limit, Limit.unit_ t.limit), t.used), Limit.maximum t.limit)
              , remaining t )
            , severity t )
          , threshold_percent t )
        , percent_used t )
      , lifetime t ))
    ~description:"Exact admission accounting using the same limits as the owning guards."
;;

module Summary = struct
  type meter = t

  type t =
    { highest_severity : Severity.t
    ; warning_count : int
    ; meters : meter list
    ; omitted_meters : int
    }

  let meters t = t.meters

  let most_used left right =
    let left_ratio = Int64.(of_int left.used * of_int (Limit.maximum right.limit)) in
    let right_ratio = Int64.(of_int right.used * of_int (Limit.maximum left.limit)) in
    let comparison = Int64.compare right_ratio left_ratio in
    if comparison = 0 then Limit.compare left.limit right.limit else comparison
  ;;

  let create meters =
    if
      List.length meters <> List.length Limit.all
      || List.contains_dup (List.map meters ~f:limit) ~compare:Limit.compare
    then
      Error
        (Problem.create
           Invalid_argument
           "capacity summary requires every current meter exactly once")
    else (
      let sorted = List.sort meters ~compare:most_used in
      let visible = List.take sorted 3 in
      Ok
        { highest_severity = severity (List.hd_exn sorted)
        ; warning_count =
            List.count meters ~f:(fun meter ->
              not (Severity.equal (severity meter) Normal))
        ; meters = visible
        ; omitted_meters = List.length meters - List.length visible
        })
  ;;

  let codec =
    let module F = Api_codec.Fields in
    let ( ++ ) = F.both in
    Api_codec.map
      (Api_codec.object_
         (F.required "highest_severity" Severity.codec
          ++ F.required "warning_count" (Api_codec.decimal ~max:14)
          ++ F.required "meters" (Api_codec.list codec ~max_items:3)
          ++ F.required "omitted_meters" (Api_codec.decimal ~max:14)))
      ~decode:(fun (((highest_severity, warning_count), meters), omitted_meters) ->
        let visible_warnings =
          List.count meters ~f:(fun meter -> not (Severity.equal (severity meter) Normal))
        in
        if
          List.length meters = 3
          && omitted_meters = 11
          && (not (List.contains_dup (List.map meters ~f:limit) ~compare:Limit.compare))
          && List.is_sorted meters ~compare:most_used
          && Severity.equal highest_severity (severity (List.hd_exn meters))
          && warning_count >= visible_warnings
          && (visible_warnings = 3 || warning_count = visible_warnings)
          && ((not (Severity.equal highest_severity Normal)) || warning_count = 0)
        then Ok { highest_severity; warning_count; meters; omitted_meters }
        else
          Error
            (Problem.create
               Invalid_argument
               "capacity summary counters or visible ordering disagree"))
      ~encode:(fun t ->
        ((t.highest_severity, t.warning_count), t.meters), t.omitted_meters)
      ~description:
        "Bounded cached advisory capacity: three most utilized meters of fourteen, \
         highest 0/50/80/95-percent band, and explicit omitted count."
  ;;
end

let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match create t.limit ~used:t.used with
  | Ok t -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
;;
