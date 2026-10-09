open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let opt = F.optional
let obj fields = Api_codec.as_json (Api_codec.object_ fields)
let checked = W.checked
let text n = Api_codec.text ~max_bytes:n

let bound min max =
  checked (Api_codec.decimal ~max) (fun n ->
    if n < min then Json.fail Invalid_argument "query bound too small")
;;

let id = W.id

module Scope = struct
  type t =
    | Workspace
    | Project of Id.Project.t
    | Ticket of Id.Ticket.t
  [@@deriving sexp_of, equal]

  let wrong () = Json.fail Invalid_argument "wrong digest scope"

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "workspace"
          , Api_codec.object_
              (F.map
                 (req "kind" (Api_codec.literal "workspace"))
                 ~decode:(fun () -> Workspace)
                 ~encode:(function
                   | Workspace -> ()
                   | _ -> wrong ())) )
        ; ( "project"
          , Api_codec.object_
              (F.map
                 (req "kind" (Api_codec.literal "project")
                  ++ req "project_id" (id Id.Project.of_string Id.Project.to_string))
                 ~decode:(fun ((), id) -> Project id)
                 ~encode:(function
                   | Project id -> (), id
                   | _ -> wrong ())) )
        ; ( "ticket"
          , Api_codec.object_
              (F.map
                 (req "kind" (Api_codec.literal "ticket") ++ req "ticket_id" W.ticket)
                 ~decode:(fun ((), id) -> Ticket id)
                 ~encode:(function
                   | Ticket id -> (), id
                   | _ -> wrong ())) )
        ]
      ~select:(function
        | Workspace -> "workspace"
        | Project _ -> "project"
        | Ticket _ -> "ticket")
  ;;
end

module Fact_selection = struct
  type t =
    { scope : Facts.Scope.t
    ; key : Facts.Key.t
    }
  [@@deriving sexp_of, equal]

  let codec =
    Api_codec.object_
      (F.map
         (req "scope" Facts.Scope.codec ++ req "key" Facts.Key.codec)
         ~decode:(fun (scope, key) -> { scope; key })
         ~encode:(fun t -> t.scope, t.key))
  ;;
end

module Resume_request = struct
  type t =
    { ticket : Id.Ticket.t
    ; run : Id.Run.t option
    ; at_revision : int option
    ; max_bytes : int
    ; change_limit : int
    ; facts : Fact_selection.t list
    ; fact_prefix : string option
    ; include_markdown : bool
    }

  let codec =
    checked
      (Api_codec.object_
         (F.map
            (req "ticket_id" W.ticket
             ++ opt "run_id" W.run
             ++ opt "at_revision" W.counter
             ++ opt "max_bytes" (bound 4096 1048576)
             ++ opt "change_limit" (bound 1 100)
             ++ opt "fact_selections" (Api_codec.list Fact_selection.codec ~max_items:16)
             ++ opt "fact_prefix" (text 128)
             ++ opt "include_markdown" Api_codec.boolean)
            ~decode:
              (fun
                ( ( (((((ticket, run), at_revision), max_bytes), change_limit), facts)
                  , fact_prefix )
                , include_markdown ) ->
              { ticket
              ; run
              ; at_revision
              ; max_bytes = Option.value max_bytes ~default:65536
              ; change_limit = Option.value change_limit ~default:10
              ; facts = Option.value facts ~default:[]
              ; fact_prefix
              ; include_markdown = Option.value include_markdown ~default:false
              })
            ~encode:(fun t ->
              ( ( ( ( (((t.ticket, t.run), t.at_revision), Some t.max_bytes)
                    , Some t.change_limit )
                  , Some t.facts )
                , t.fact_prefix )
              , Some t.include_markdown ))))
      (fun t ->
         if
           List.existsi t.facts ~f:(fun index x ->
             List.exists (List.take t.facts index) ~f:(Fact_selection.equal x))
         then Json.fail Invalid_argument "fact selections must be distinct")
  ;;

  let ticket t = t.ticket
  let run t = t.run
  let at_revision t = t.at_revision
  let max_bytes t = t.max_bytes
  let change_limit t = t.change_limit
  let facts t = t.facts
  let fact_prefix t = t.fact_prefix
  let include_markdown t = t.include_markdown
end

module Digest_request = struct
  type t =
    { scope : Scope.t
    ; after : int option
    ; cursor : string option
    ; limit : int
    ; max_bytes : int
    ; include_markdown : bool
    }

  let codec =
    checked
      (Api_codec.object_
         (F.map
            (opt "scope" Scope.codec
             ++ opt "after" W.counter
             ++ opt "cursor" (W.nonblank ~max_bytes:2048)
             ++ opt "limit" (bound 1 100)
             ++ opt "max_bytes" (bound 4096 1048576)
             ++ opt "include_markdown" Api_codec.boolean)
            ~decode:
              (fun
                (((((scope, after), cursor), limit), max_bytes), include_markdown) ->
              { scope = Option.value scope ~default:Scope.Workspace
              ; after
              ; cursor
              ; limit = Option.value limit ~default:50
              ; max_bytes = Option.value max_bytes ~default:65536
              ; include_markdown = Option.value include_markdown ~default:false
              })
            ~encode:(fun t ->
              ( ((((Some t.scope, t.after), t.cursor), Some t.limit), Some t.max_bytes)
              , Some t.include_markdown ))))
      (fun t ->
         if Option.is_some t.after && Option.is_some t.cursor
         then Json.fail Invalid_argument "supply after or cursor, not both")
  ;;

  let scope t = t.scope
  let after t = t.after
  let cursor t = t.cursor
  let limit t = t.limit
  let max_bytes t = t.max_bytes
  let include_markdown t = t.include_markdown
end

let required = function
  | Some x -> x
  | None -> invalid_arg "missing actual family result codec"
;;

let prose_fields = function
  | "task" -> [ "title"; "objective"; "acceptance_criteria" ]
  | "ticket" -> [ "title"; "description"; "acceptance_criteria" ]
  | "handoff" ->
    [ "summary"
    ; "next_steps"
    ; "evidence"
    ; "objective"
    ; "completed"
    ; "decisions"
    ; "blockers"
    ]
  | "comment" -> [ "body" ]
  | "run" -> [ "objective"; "evidence" ]
  | "attempt" -> [ "evidence" ]
  | "condition_declaration" -> [ "label" ]
  | "condition_signal" -> [ "summary" ]
  | "resource" -> [ "title"; "description" ]
  | "request"
  | "fact"
  | "fact_keys"
  | "paths"
  | "condition"
  | "ticket_recovery"
  | "reservation_recovery"
  | "effective_policy"
  | "readiness"
  | "completion" -> []
  | _ -> Json.fail Invalid_argument "unknown resume record kind"
;;

let clip =
  obj
    (req "field" (W.nonblank ~max_bytes:128)
     ++ req "original_bytes" W.counter
     ++ req "omitted_bytes" W.positive)
;;

let sources =
  checked (Api_codec.list Resume_source.codec ~max_items:100) (fun sources ->
    if List.is_empty sources
    then Json.fail Invalid_argument "resume item lacks provenance";
    if
      List.existsi sources ~f:(fun i source ->
        List.exists (List.take sources i) ~f:(Resume_source.equal source))
    then Json.fail Invalid_argument "resume sources must be distinct")
;;

let readiness =
  checked
    (obj
       (req "ready" Api_codec.boolean
        ++ req "reason_count" W.counter
        ++ req
             "reasons"
             (Api_codec.list Planning_ticket_wire.Readiness.Reason.codec ~max_items:100)))
    (fun record ->
       let count = Json.integer (Json.field record "reason_count") in
       let shown = List.length (Json.list (Json.field record "reasons")) in
       let ready =
         match Json.field record "ready" with
         | `True -> true
         | _ -> false
       in
       if shown > count || not (Bool.equal ready (count = 0))
       then Json.fail Invalid_argument "inconsistent readiness excerpt")
;;

let records =
  [ "task", Resume_task.codec
  ; "resource", Resource_wire.summary
  ; "ticket", Planning_result.ticket
  ; "handoff", Api_codec.as_json Planning_ticket_wire.Handoff.codec
  ; "comment", Discussion_wire.comment
  ; "request", Api_codec.as_json Communication_wire.request
  ; "run", required (Agent_run_api.response_codec ~method_:"run.get")
  ; "attempt", required (Agent_run_api.response_codec ~method_:"attempt.get")
  ; ( "fact"
    , match Facts.response_codec "fact.get" with
      | Ok c -> c
      | Error e -> raise (Json.Decode_error e) )
  ; ( "fact_keys"
    , match Facts.response_codec "fact.keys" with
      | Ok c -> c
      | Error e -> raise (Json.Decode_error e) )
  ; "paths", Api_codec.as_json Ticket_paths.codec
  ; "condition", required (Agent_coordination_api.response_codec ~method_:"condition.get")
  ; "condition_declaration", Api_codec.as_json External_condition.Declaration.codec
  ; "condition_signal", Api_codec.as_json External_condition.Signal.codec
  ; "ticket_recovery", Api_codec.as_json Ticket_recovery.codec
  ; "reservation_recovery", Api_codec.as_json Ownership_recovery.codec
  ; "effective_policy", Api_codec.as_json Acceptance_policy.Effective.codec
  ; "readiness", readiness
  ; "completion", Api_codec.as_json Planning_ticket_wire.Completion.codec
  ]
;;

let item_codec =
  checked
    (Api_codec.tagged
       ~discriminator:"kind"
       ~cases:
         (List.map records ~f:(fun (kind, record) ->
            ( kind
            , obj
                (req "kind" (Api_codec.literal kind)
                 ++ req "summary" (text 1024)
                 ++ req "sources" sources
                 ++ req "record" record
                 ++ req "clipped_fields" (Api_codec.list clip ~max_items:16)) )))
       ~select:(fun json -> Json.field json "kind" |> Json.text))
    (fun item ->
       let kind = Json.field item "kind" |> Json.text in
       let record = Json.field item "record" in
       let clips = Json.list (Json.field item "clipped_fields") in
       let fields =
         List.map clips ~f:(fun clip -> Json.field clip "field" |> Json.text)
       in
       if List.contains_dup fields ~compare:String.compare
       then Json.fail Invalid_argument "duplicate clipped field";
       List.iter clips ~f:(fun clip ->
         let field = Json.field clip "field" |> Json.text in
         if not (List.mem (prose_fields kind) field ~equal:String.equal)
         then Json.fail Invalid_argument "non-prose field cannot be clipped";
         let original = Json.field clip "original_bytes" |> Json.integer in
         let omitted = Json.field clip "omitted_bytes" |> Json.integer in
         let shown = Json.field record field |> Json.text |> String.length in
         if omitted > original || shown <> original - omitted
         then Json.fail Invalid_argument "inconsistent clipped byte counts"))
;;

let category =
  Api_codec.enum
    (List.map
       [ "completion"
       ; "reopening"
       ; "decision"
       ; "blocker"
       ; "request"
       ; "condition"
       ; "recovery"
       ; "ownership"
       ; "progress"
       ; "fact"
       ; "task_changed"
       ; "resource"
       ]
       ~f:(fun n -> n, n))
    ~equal:String.equal
;;

let entry_codec =
  checked
    (obj
       (req "workspace_revision" W.positive
        ++ req "change_index" W.counter
        ++ req "category" category
        ++ req "item" item_codec))
    (fun row ->
       let revision = Json.integer (Json.field row "workspace_revision") in
       let index = Json.integer (Json.field row "change_index") in
       let sources =
         Json.field row "item" |> fun item -> Json.field item "sources" |> Json.list
       in
       if
         not
           (List.exists sources ~f:(fun raw ->
              match W.decode_exn Resume_source.codec raw with
              | Resume_source.Planning_change pin ->
                pin.workspace_revision = revision && pin.change_index = index
              | _ -> false))
       then Json.fail Invalid_argument "digest row lacks its exact planning change source")
;;

let count_codec =
  checked
    (obj
       (req "section" (W.nonblank ~max_bytes:96)
        ++ req "total" W.counter
        ++ req "returned" W.counter
        ++ req "omitted" W.counter))
    (fun count ->
       let total = Json.field count "total" |> Json.integer in
       let returned = Json.field count "returned" |> Json.integer in
       let omitted = Json.field count "omitted" |> Json.integer in
       if returned > total || omitted <> total - returned
       then Json.fail Invalid_argument "inconsistent section counts")
;;

let warning_codec =
  obj
    (req
       "code"
       (Api_codec.enum
          (List.map
             [ "handoff_missing"
             ; "handoff_coverage_missing"
             ; "handoff_claim_changed"
             ; "handoff_new_activity"
             ; "handoff_bookkeeping_activity"
             ; "associated_run_missing"
             ; "fact_missing"
             ; "fact_deleted"
             ; "observation_time_required"
             ; "section_omitted"
             ; "source_clipped"
             ]
             ~f:(fun n -> n, n))
          ~equal:String.equal)
     ++ req "detail" (text 1024)
     ++ req "sources" (Api_codec.list Resume_source.codec ~max_items:100))
;;

let hash =
  checked (text 64) (fun s ->
    if
      String.length s <> 64
      || not
           (String.for_all s ~f:(fun c -> Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid capture lineage digest")
;;

let capture =
  checked
    (obj
       (req "after" W.counter
        ++ req "after_change_index" (Api_codec.nullable W.counter)
        ++ req "through" W.counter
        ++ req "lineage" hash))
    (fun capture ->
       let after = Json.field capture "after" |> Json.integer in
       let through = Json.field capture "through" |> Json.integer in
       if after > through then Json.fail Invalid_argument "capture bounds reversed";
       if
         after = 0
         &&
         match Json.field capture "after_change_index" with
         | `Null -> false
         | _ -> true
       then Json.fail Invalid_argument "zero revision cannot have a change ordinal")
;;

let cursor = Api_codec.nullable (W.nonblank ~max_bytes:2048)

let validate_rows data field =
  let capture = Json.field data "capture" in
  let after = Json.integer (Json.field capture "after") in
  let after_index =
    match Json.field capture "after_change_index" with
    | `Null -> Int.max_value
    | value -> Json.integer value
  in
  let through = Json.integer (Json.field capture "through") in
  let rows = Json.field data field |> Json.list in
  ignore
    (List.fold
       rows
       ~init:(after, after_index)
       ~f:(fun (previous_revision, previous_index) row ->
         let revision = Json.integer (Json.field row "workspace_revision") in
         let index = Json.integer (Json.field row "change_index") in
         if
           revision > through
           || revision < previous_revision
           || (revision = previous_revision && index <= previous_index)
         then Json.fail Invalid_argument "digest rows outside ordered capture";
         revision, index)
     : int * int);
  let counts = Json.field data "counts" |> Json.list in
  let sections =
    List.map counts ~f:(fun count -> Json.field count "section" |> Json.text)
  in
  if List.contains_dup sections ~compare:String.compare
  then Json.fail Invalid_argument "duplicate section counts";
  let row_count =
    List.find counts ~f:(fun count ->
      String.equal (Json.field count "section" |> Json.text) field)
  in
  match row_count with
  | None -> Json.fail Invalid_argument "missing row section count"
  | Some count ->
    if Json.integer (Json.field count "returned") <> List.length rows
    then Json.fail Invalid_argument "row returned count differs from records"
;;

let resume_codec =
  checked
    (obj
       (req "ticket_id" W.ticket
        ++ req "capture" capture
        ++ req
             "observed_unix_ms"
             (Api_codec.nullable (Api_codec.decimal64 ~max:Int64.max_value))
        ++ req "items" (Api_codec.list item_codec ~max_items:300)
        ++ req "changes" (Api_codec.list entry_codec ~max_items:100)
        ++ req "warnings" (Api_codec.list warning_codec ~max_items:100)
        ++ req "counts" (Api_codec.list count_codec ~max_items:32)
        ++ req "cursor" cursor
        ++ req "has_more" Api_codec.boolean
        ++ opt "markdown" (text 1048576)))
    (fun data -> validate_rows data "changes")
;;

let digest_codec =
  checked
    (obj
       (req "capture" capture
        ++ req "entries" (Api_codec.list entry_codec ~max_items:100)
        ++ req "outstanding_requests" (Api_codec.list item_codec ~max_items:100)
        ++ req "counts" (Api_codec.list count_codec ~max_items:32)
        ++ req "cursor" (W.nonblank ~max_bytes:2048)
        ++ req "has_more" Api_codec.boolean
        ++ opt "markdown" (text 1048576)))
    (fun data -> validate_rows data "entries")
;;

let query_methods = [ "ticket.resume"; "activity.digest" ]

let request_codec ~method_ =
  match method_ with
  | "ticket.resume" -> Some (Api_codec.as_json Resume_request.codec)
  | "activity.digest" -> Some (Api_codec.as_json Digest_request.codec)
  | _ -> None
;;

let response_codec ~method_ =
  match method_ with
  | "ticket.resume" -> Some resume_codec
  | "activity.digest" -> Some digest_codec
  | _ -> None
;;

let descriptor ~method_ =
  match request_codec ~method_, response_codec ~method_ with
  | Some request, Some response ->
    Some
      (Api_method.Packed.Pack
         (Api_method.create
            ~name:method_
            ~summary:"Deterministic bounded recorded resume or captured digest."
            ~mode:Read
            ~request
            ~response))
  | _ -> None
;;
