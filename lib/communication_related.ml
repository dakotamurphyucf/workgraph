open Core

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

module Fields = Api_codec.Fields

module Query = struct
  type t =
    { id : string
    ; include_messages : bool
    ; message_offset : int
    ; message_limit : int
    ; revision : int option
    ; discussion_serial : int option
    ; max_bytes : int option
    }

  let id t = t.id
  let include_messages t = t.include_messages
  let decimal = Api_codec.decimal ~max:Int.max_value

  let bounded_positive ~max ~description =
    Api_codec.map
      (Api_codec.decimal ~max)
      ~decode:(fun value ->
        if value > 0
        then Ok value
        else Error (Problem.create Invalid_argument description))
      ~encode:Fn.id
      ~description
  ;;

  let budget =
    Api_codec.map
      (Api_codec.decimal ~max:1_048_576)
      ~decode:(fun value ->
        if value >= 4096
        then Ok value
        else Error (Problem.create Invalid_argument "max_bytes must be 4096..1048576"))
      ~encode:Fn.id
      ~description:"Public result byte budget, 4KiB..1MiB."
  ;;

  let codec ~id_field ~validate_id =
    let id_codec =
      Api_codec.map
        (Api_codec.text ~max_bytes:97)
        ~decode:validate_id
        ~encode:Fn.id
        ~description:"Opaque communication identity."
    in
    let identity =
      Fields.both
        (Fields.required id_field id_codec)
        (Fields.optional "include_messages" Api_codec.boolean)
    in
    let page =
      Fields.both
        (Fields.optional "message_offset" decimal)
        (Fields.optional
           "message_limit"
           (bounded_positive ~max:100 ~description:"message_limit must be 1..100"))
    in
    let capture =
      Fields.both
        (Fields.optional "revision" decimal)
        (Fields.optional "discussion_serial" decimal)
    in
    let fields =
      Fields.both
        (Fields.both identity page)
        (Fields.both capture (Fields.optional "max_bytes" budget))
    in
    Api_codec.map
      (Api_codec.object_ fields)
      ~decode:
        (fun
          ( ((id, include_messages), (message_offset, message_limit))
          , ((revision, discussion_serial), max_bytes) ) ->
        let included = Option.value include_messages ~default:false in
        if
          (not included)
          && List.exists
               [ message_offset; message_limit; revision; discussion_serial ]
               ~f:Option.is_some
        then
          Error
            (Problem.create
               Invalid_argument
               "message pagination fields require include_messages=true")
        else if
          Option.value message_offset ~default:0 > 0
          && (Option.is_none revision || Option.is_none discussion_serial)
        then
          Error
            (Problem.create
               Invalid_argument
               "message offsets require communication revision and discussion_serial")
        else
          Ok
            { id
            ; include_messages = included
            ; message_offset = Option.value message_offset ~default:0
            ; message_limit = Option.value message_limit ~default:20
            ; revision
            ; discussion_serial
            ; max_bytes
            })
      ~encode:(fun t ->
        ( ( (t.id, Some t.include_messages)
          , ( (if t.include_messages then Some t.message_offset else None)
            , if t.include_messages then Some t.message_limit else None ) )
        , ((t.revision, t.discussion_serial), t.max_bytes) ))
      ~description:
        "Optional bounded current message expansion. Later pages pin both communication \
         and discussion activity captures."
  ;;

  let thread_codec =
    codec ~id_field:"thread_id" ~validate_id:(fun id ->
      Result.map
        (Communication_id.Thread.of_string id)
        ~f:Communication_id.Thread.to_string)
  ;;

  let request_codec =
    codec ~id_field:"request_id" ~validate_id:(fun id ->
      Result.map
        (Communication_id.Request.of_string id)
        ~f:Communication_id.Request.to_string)
  ;;
end

let thread
      query
      ~communication_revision
      ~discussion
      (thread : Communication_event.Thread.t)
  =
  Json.decode (fun () ->
    let discussion_serial = Discussion.next_serial discussion - 1 in
    Option.iter query.Query.revision ~f:(fun observed ->
      if not (Int.equal observed communication_revision)
      then Json.fail Conflict "communication changed while paging related messages");
    Option.iter query.discussion_serial ~f:(fun observed ->
      if not (Int.equal observed discussion_serial)
      then Json.fail Conflict "discussion changed while paging related messages");
    let total = List.length thread.messages in
    if query.message_offset > total
    then Json.fail Invalid_argument "message_offset exceeds attached messages";
    let ids =
      List.take (List.drop thread.messages query.message_offset) query.message_limit
    in
    let items =
      List.map ids ~f:(fun id ->
        Discussion.get discussion id |> Discussion_wire.comment_json)
    in
    let next = query.message_offset + List.length ids in
    Json.obj
      [ "thread_id", Communication_id.Thread.jsonaf_of_t thread.id
      ; "thread_revision", Json.int thread.revision
      ; "discussion_serial", Json.int discussion_serial
      ; ( "messages"
        , Json.obj
            [ "items", `Array items
            ; "offset", Json.int query.message_offset
            ; "remaining", Json.int (total - next)
            ; ("next_offset", if next = total then `Null else Json.int next)
            ] )
      ])
;;

let request
      query
      ~communication_revision
      ~discussion
      ~thread:thread_record
      (request : Communication_event.Request.t)
  =
  Json.decode (fun () ->
    let related =
      thread query ~communication_revision ~discussion thread_record |> unwrap
    in
    let fields =
      match related with
      | `Object fields -> fields
      | _ -> assert false
    in
    Json.obj
      (fields
       @ [ "request_revision", Json.int request.revision
         ; ( "source_message"
           , Discussion.get discussion request.message |> Discussion_wire.comment_json )
         ; "source_message_version", Json.string "current"
         ; ( "source_message_reference"
           , Json.obj
               [ "comment_id", Id.Comment.jsonaf_of_t request.message; "revision", `Null ]
           )
         ]))
;;
