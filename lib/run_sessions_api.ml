open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let opt = F.optional
let raw fields = Api_codec.as_json (Api_codec.object_ fields)
let session_id = W.id Session_id.of_string Session_id.to_string
let workspace_id = W.id Id.Workspace.of_string Id.Workspace.to_string

let checked codec ~description validate =
  Api_codec.map
    codec
    ~decode:(fun value ->
      Json.decode (fun () ->
        validate value;
        value))
    ~encode:Fn.id
    ~description
;;

let head_codec =
  checked
    (Api_codec.text ~max_bytes:64)
    ~description:"Lowercase SHA-256 journal head digest."
    (fun text ->
       if
         String.length text <> 64
         || not
              (String.for_all text ~f:(fun c ->
                 Char.is_digit c || Char.between c ~low:'a' ~high:'f'))
       then Json.fail Invalid_argument "invalid history head digest")
;;

let bounded min max description =
  checked (Api_codec.decimal ~max) ~description (fun value ->
    if value < min then Json.fail Invalid_argument description)
;;

let limit_codec = bounded 1 100 "limit must be 1..100"
let budget_codec = bounded 4096 1048576 "max_bytes must be 4096..1048576"

module Request = struct
  type t =
    { run : Id.Run.t
    ; head : string option option
    ; expected_run_revision : int option
    ; after : Session_id.t option
    ; limit : int
    ; max_bytes : int
    }

  let run t = t.run
  let head t = t.head
  let expected_run_revision t = t.expected_run_revision
  let after t = t.after
  let limit t = t.limit
  let max_bytes t = t.max_bytes

  let codec =
    Api_codec.object_
      (F.map
         (req "target_run_id" W.run
          ++ opt "head" (Api_codec.nullable head_codec)
          ++ opt "expected_run_revision" W.positive
          ++ opt "after_session_id" session_id
          ++ opt "limit" limit_codec
          ++ opt "max_bytes" budget_codec)
         ~decode:
           (fun
             (((((run, head), expected_run_revision), after), limit), max_bytes) ->
           { run
           ; head
           ; expected_run_revision
           ; after
           ; limit = Option.value limit ~default:50
           ; max_bytes = Option.value max_bytes ~default:65536
           })
         ~encode:(fun { run; head; expected_run_revision; after; limit; max_bytes } ->
           ((((run, head), expected_run_revision), after), Some limit), Some max_bytes))
    |> fun codec ->
    checked
      codec
      ~description:
        "Sorted run-session association page. Continuation pins the exact history head \
         and run revision."
      (fun t ->
         if
           Option.is_some t.after
           && (Option.is_none t.head || Option.is_none t.expected_run_revision)
         then
           Json.fail
             Invalid_argument
             "continuation requires head and expected_run_revision")
  ;;
end

let next_request_codec =
  let params =
    Api_codec.merge_objects
      Request.codec
      (Api_codec.object_ (req "workspace_id" workspace_id))
  in
  raw (req "method" (Api_codec.literal "run.sessions") ++ req "params" params)
  |> fun codec ->
  checked
    codec
    ~description:
      "Exact next request, preserving workspace, run revision, history head and stable \
       session-ID position."
    (fun value ->
       let params = Json.field value "params" in
       List.iter
         [ "head"; "expected_run_revision"; "after_session_id"; "limit"; "max_bytes" ]
         ~f:(fun field ->
           if Option.is_none (Json.optional params field)
           then Json.fail Invalid_argument ("next request requires " ^ field)))
;;

let association_codec =
  raw
    (req "basis" (Api_codec.literal "explicit_and_history_run")
     ++ req "history_head" (Api_codec.nullable head_codec)
     ++ req "explicit_session_ids" (Api_codec.list session_id ~max_items:100)
     ++ req "total" W.counter
     ++ req "omitted" W.counter
     ++ req "next_request" (Api_codec.nullable next_request_codec))
;;

let run_view_codec =
  Api_codec.merge_objects
    Agent_run_wire.run
    (Api_codec.object_ (req "session_associations" association_codec))
  |> fun codec ->
  checked
    codec
    ~description:
      "Derived run read view. Session IDs are the bounded sorted union of explicit links \
       and immutable session run attribution; revision remains the stored run revision."
    (fun (record, association) ->
       let sessions = record.Agent_run_event.Record.sessions in
       if not (List.is_sorted_strictly sessions ~compare:Session_id.compare)
       then
         Json.fail Invalid_argument "associated session IDs must be distinct and ordered";
       let explicit =
         Json.field association "explicit_session_ids"
         |> Json.list
         |> List.map ~f:Session_id.t_of_jsonaf
       in
       if List.contains_dup explicit ~compare:Session_id.compare
       then Json.fail Invalid_argument "explicit session links must be distinct";
       let total = Json.field association "total" |> Json.integer in
       let omitted = Json.field association "omitted" |> Json.integer in
       if total < List.length explicit || total - List.length sessions <> omitted
       then Json.fail Invalid_argument "associated session counts disagree";
       let last = List.last sessions in
       if
         List.exists explicit ~f:(fun id ->
           (omitted = 0
            || Option.exists last ~f:(fun last -> Session_id.compare id last <= 0))
           && not (List.mem sessions id ~equal:Session_id.equal))
       then Json.fail Invalid_argument "association preview omits an explicit prefix link";
       match Json.field association "next_request" with
       | `Null ->
         if omitted <> 0
         then Json.fail Invalid_argument "omitted associations require a continuation"
       | next ->
         if omitted = 0
         then Json.fail Invalid_argument "complete associations cannot continue";
         let params = Json.field next "params" in
         if
           (not
              (Id.Run.equal
                 record.id
                 (Json.field params "target_run_id" |> Id.Run.t_of_jsonaf)))
           || record.revision
              <> (Json.field params "expected_run_revision" |> Json.integer)
           || (not
                 (String.equal
                    (Json.canonical (Json.field association "history_head"))
                    (Json.canonical (Json.field params "head"))))
           || not
                (Option.equal
                   Session_id.equal
                   (List.last sessions)
                   (Some (Json.field params "after_session_id" |> Session_id.t_of_jsonaf)))
         then Json.fail Invalid_argument "association continuation scope disagrees")
  |> Api_codec.as_json
;;

let response_codec =
  raw
    (req "run_id" W.run
     ++ req "run_revision" W.positive
     ++ req "history_head" (Api_codec.nullable head_codec)
     ++ req "session_ids" (Api_codec.list session_id ~max_items:100)
     ++ req "total" W.counter
     ++ req "remaining" W.counter
     ++ req "next_after_session_id" (Api_codec.nullable session_id)
     ++ req "next_request" (Api_codec.nullable next_request_codec)
     ++ req "has_more" Api_codec.boolean)
  |> fun codec ->
  checked
    codec
    ~description:
      "Whole session IDs in stable ascending order at one explicit history head and run \
       revision."
    (fun value ->
       let sessions =
         Json.field value "session_ids" |> Json.list |> List.map ~f:Session_id.t_of_jsonaf
       in
       if not (List.is_sorted_strictly sessions ~compare:Session_id.compare)
       then Json.fail Invalid_argument "session page IDs must be distinct and ordered";
       let remaining = Json.field value "remaining" |> Json.integer in
       let total = Json.field value "total" |> Json.integer in
       if remaining > total || List.length sessions > total - remaining
       then Json.fail Invalid_argument "session page counts disagree";
       let has_more =
         match Json.field value "has_more" with
         | `True -> true
         | `False -> false
         | _ -> assert false
       in
       if not (Bool.equal has_more (remaining > 0))
       then Json.fail Invalid_argument "session page continuation disagrees";
       match
         Json.field value "next_request", Json.field value "next_after_session_id"
       with
       | `Null, `Null ->
         if has_more then Json.fail Invalid_argument "session page needs continuation"
       | `Null, _ | _, `Null ->
         Json.fail Invalid_argument "session page continuation incomplete"
       | next, after ->
         let params = Json.field next "params" in
         if
           (not has_more)
           || (not
                 (Option.equal
                    Session_id.equal
                    (List.last sessions)
                    (Some (Session_id.t_of_jsonaf after))))
           || (not
                 (String.equal
                    (Json.canonical after)
                    (Json.canonical (Json.field params "after_session_id"))))
           || (not
                 (String.equal
                    (Json.canonical (Json.field value "run_id"))
                    (Json.canonical (Json.field params "target_run_id"))))
           || (not
                 (String.equal
                    (Json.canonical (Json.field value "run_revision"))
                    (Json.canonical (Json.field params "expected_run_revision"))))
           || not
                (String.equal
                   (Json.canonical (Json.field value "history_head"))
                   (Json.canonical (Json.field params "head")))
         then Json.fail Invalid_argument "session page continuation scope disagrees")
;;

let method_ =
  Api_method.Packed.Pack
    (Api_method.create
       ~name:"run.sessions"
       ~summary:
         "List the captured union of explicit run links and sessions attributed to this \
          run."
       ~mode:Read
       ~request:Request.codec
       ~response:response_codec)
;;
