open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let opt = F.optional
let raw fields = Api_codec.as_json (Api_codec.object_ fields)

let bound low high =
  W.checked (Api_codec.decimal ~max:high) (fun n ->
    if n < low then Json.fail Invalid_argument "query bound too small")
;;

module Group = struct
  type t =
    | Workspace
    | Project
    | Milestone
    | Ticket
    | Run
    | Attempt
  [@@deriving sexp, compare, equal]

  let codec =
    Api_codec.enum
      [ "workspace", Workspace
      ; "project", Project
      ; "milestone", Milestone
      ; "ticket", Ticket
      ; "run", Run
      ; "attempt", Attempt
      ]
      ~equal
  ;;
end

module Metrics_layout = struct
  type t =
    | Rows
    | Nested
    | Totals_only
  [@@deriving sexp, compare, equal]

  let codec =
    Api_codec.enum [ "rows", Rows; "nested", Nested; "totals_only", Totals_only ] ~equal
  ;;
end

module Request = struct
  type t = Jsonaf.t

  let optional t key decode = Option.map (Json.optional t key) ~f:decode

  let group t =
    Option.value_map
      (Json.optional t "group_by")
      ~default:Group.Workspace
      ~f:(W.decode_exn Group.codec)
  ;;

  let metrics_layout t =
    Option.value_map
      (Json.optional t "metrics_layout")
      ~default:Metrics_layout.Rows
      ~f:(W.decode_exn Metrics_layout.codec)
  ;;

  let project t = optional t "project_id" Id.Project.t_of_jsonaf
  let milestone t = optional t "milestone_id" Id.Milestone.t_of_jsonaf
  let ticket t = optional t "ticket_id" Id.Ticket.t_of_jsonaf
  let run t = optional t "run_id" Id.Run.t_of_jsonaf
  let attempt t = optional t "attempt_id" Attempt.Id.t_of_jsonaf
  let actor t = optional t "actor_id" Id.Actor.t_of_jsonaf
  let at_revision t = optional t "at_revision" Json.integer
  let cursor t = optional t "cursor" Json.text
  let limit t = Option.value_map (Json.optional t "limit") ~default:50 ~f:Json.integer
  let max_bytes t = Query_budget.of_params t

  let codec =
    raw
      (opt "project_id" (W.id Id.Project.of_string Id.Project.to_string)
       ++ opt "milestone_id" (W.id Id.Milestone.of_string Id.Milestone.to_string)
       ++ opt "ticket_id" W.ticket
       ++ opt "run_id" W.run
       ++ opt "attempt_id" (W.id Attempt.Id.of_string Attempt.Id.to_string)
       ++ opt "actor_id" W.actor
       ++ opt "group_by" Group.codec
       ++ opt "metrics_layout" Metrics_layout.codec
       ++ opt "at_revision" W.counter
       ++ opt "cursor" (W.nonblank ~max_bytes:4096)
       ++ opt "limit" (bound 1 100)
       ++ opt "max_bytes" (bound 4096 1048576))
  ;;
end

let summary =
  raw
    (req "observations" W.counter
     ++ req "tokens" (Api_codec.decimal64 ~max:Int64.max_value)
     ++ req "elapsed_ms" (Api_codec.decimal64 ~max:Int64.max_value)
     ++ req "overflow" Api_codec.boolean
     ++ req "metric_series" W.counter
     ++ req "metric_overflow" Api_codec.boolean)
  |> fun codec ->
  W.checked codec (fun json ->
    let count key = Json.field json key |> Json.integer in
    let quantity key = Json.field json key |> Json.integer64 in
    let flag key =
      match Json.field json key with
      | `True -> true
      | `False -> false
      | _ -> Json.fail Invalid_argument "expected boolean"
    in
    if
      count "observations" = 0
      && ((not
             (Int64.equal (quantity "tokens") 0L && Int64.equal (quantity "elapsed_ms") 0L))
          || flag "overflow"
          || count "metric_series" <> 0
          || flag "metric_overflow")
    then Json.fail Invalid_argument "usage summary without sources";
    if
      flag "overflow"
      && not
           (Int64.equal (quantity "tokens") Int64.max_value
            || Int64.equal (quantity "elapsed_ms") Int64.max_value)
    then Json.fail Invalid_argument "usage summary overflow must saturate";
    if flag "metric_overflow" && count "metric_series" = 0
    then Json.fail Invalid_argument "metric overflow without series")
;;

let group_key =
  let branch kind fields = raw (req "kind" (Api_codec.literal kind) ++ fields) in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ "workspace", raw (req "kind" (Api_codec.literal "workspace"))
      ; ( "project"
        , branch
            "project"
            (req "project_id" (W.id Id.Project.of_string Id.Project.to_string)) )
      ; ( "milestone"
        , branch
            "milestone"
            (req "milestone_id" (W.id Id.Milestone.of_string Id.Milestone.to_string)) )
      ; "ticket", branch "ticket" (req "ticket_id" W.ticket)
      ; "run", branch "run" (req "run_id" W.run)
      ; ( "attempt"
        , branch
            "attempt"
            (req "attempt_id" (W.id Attempt.Id.of_string Attempt.Id.to_string)) )
      ; ( "unassigned"
        , branch
            "unassigned"
            (req
               "reason"
               (Api_codec.enum
                  (List.map
                     [ "run_scope_has_no_attempt"
                     ; "ticket_has_no_project"
                     ; "ticket_has_no_milestone"
                     ]
                     ~f:(fun s -> s, s))
                  ~equal:String.equal)) )
      ]
    ~select:(fun json -> Json.field json "kind" |> Json.text)
;;

let row =
  let branch kind fields =
    raw (req "kind" (Api_codec.literal kind) ++ req "group" group_key ++ fields)
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "usage"
        , branch
            "usage"
            (req "totals" summary
             ++ opt
                  "metrics"
                  (Api_codec.list
                     Usage_record.Metric_total.codec
                     ~max_items:Int.max_value)) )
      ; "metric", branch "metric" (req "metric" Usage_record.Metric_total.codec)
      ]
    ~select:(fun json -> Json.field json "kind" |> Json.text)
;;

let response_codec =
  raw
    (req "basis" (Api_codec.literal "externally_reported")
     ++ req "membership_basis" (Api_codec.literal "current_capture")
     ++ req "group_by" Group.codec
     ++ req "metrics_layout" Metrics_layout.codec
     ++ req "totals" summary
     ++ req "unassigned_run_usage" summary
     ++ req "unassigned_in_totals" Api_codec.boolean
     ++ req "unassigned_scope" (Api_codec.literal "run_and_actor_filters")
     ++ req "items" (Api_codec.list row ~max_items:100)
     ++ req "cursor" (Api_codec.nullable (W.nonblank ~max_bytes:4096))
     ++ req "has_more" Api_codec.boolean
     ++ req "needs_larger_budget" Api_codec.boolean
     ++ req "required_bytes" (Api_codec.nullable W.counter))
  |> fun codec ->
  W.checked codec (fun json ->
    let layout = W.decode_exn Metrics_layout.codec (Json.field json "metrics_layout") in
    List.iter
      (Json.field json "items" |> Json.list)
      ~f:(fun item ->
        match layout with
        | Rows | Totals_only ->
          if Option.is_some (Json.optional item "metrics")
          then Json.fail Invalid_argument "metric arrays require nested layout";
          if
            Metrics_layout.equal layout Totals_only
            && not (String.equal (Json.field item "kind" |> Json.text) "usage")
          then Json.fail Invalid_argument "totals-only layout requires usage groups"
        | Nested ->
          if not (String.equal (Json.field item "kind" |> Json.text) "usage")
          then Json.fail Invalid_argument "nested layout requires usage groups";
          let metrics = Json.field item "metrics" |> Json.list in
          let totals = Json.field item "totals" in
          if List.length metrics <> (Json.field totals "metric_series" |> Json.integer)
          then Json.fail Invalid_argument "nested metric array must contain every series";
          let keys =
            List.map metrics ~f:(fun metric ->
              Json.field metric "name" |> Json.text, Json.field metric "unit" |> Json.text)
          in
          if
            not
              (List.is_sorted_strictly
                 keys
                 ~compare:(Tuple2.compare ~cmp1:String.compare ~cmp2:String.compare))
          then
            Json.fail Invalid_argument "nested metric series must be distinct and ordered";
          let any_overflow =
            List.exists metrics ~f:(fun metric ->
              match Json.field metric "overflow" with
              | `True -> true
              | `False -> false
              | _ -> assert false)
          in
          let metric_overflow =
            match Json.field totals "metric_overflow" with
            | `True -> true
            | `False -> false
            | _ -> assert false
          in
          if Bool.(any_overflow <> metric_overflow)
          then Json.fail Invalid_argument "nested metric overflow must match summary"))
;;

let method_ =
  Api_method.Packed.Pack
    (Api_method.create
       ~name:"usage.aggregate"
       ~summary:
         "Aggregate immutable caller-reported usage and named integer samples in one \
          current capture."
       ~mode:Read
       ~request:Request.codec
       ~response:response_codec)
;;
