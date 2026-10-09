open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity; aliases are not accepted."
;;

let board_id = id Communication_id.Board.of_string Communication_id.Board.to_string
let thread_id = id Communication_id.Thread.of_string Communication_id.Thread.to_string
let team_id = id Communication_id.Team.of_string Communication_id.Team.to_string
let request_id = id Communication_id.Request.of_string Communication_id.Request.to_string

let subscription_id =
  id Communication_id.Subscription.of_string Communication_id.Subscription.to_string
;;

let actor_id = id Id.Actor.of_string Id.Actor.to_string
let decimal = Api_codec.decimal ~max:Int.max_value

let bounded ~min ~max description =
  Api_codec.map
    (Api_codec.decimal ~max)
    ~decode:(fun value ->
      if value < min
      then Error (Problem.create Invalid_argument description)
      else Ok value)
    ~encode:Fn.id
    ~description
;;

let budget = bounded ~min:4096 ~max:1048576 "max_bytes must be 4096..1048576"
let limit = bounded ~min:1 ~max:100 "limit must be 1..100"
let unix_ms = Api_codec.decimal64 ~max:Int64.max_value

let required name codec =
  Fields.map
    (Fields.required name codec)
    ~decode:(fun value -> [ name, unwrap (Api_codec.encode codec value) ])
    ~encode:(fun fields ->
      unwrap (Api_codec.decode codec (Json.field (`Object fields) name)))
;;

let optional name codec =
  Fields.map
    (Fields.optional name codec)
    ~decode:(fun value ->
      Option.to_list
        (Option.map value ~f:(fun value -> name, unwrap (Api_codec.encode codec value))))
    ~encode:(fun fields ->
      Option.map
        (Json.optional (`Object fields) name)
        ~f:(fun value -> unwrap (Api_codec.decode codec value)))
;;

let record fields =
  List.fold
    fields
    ~init:(Fields.map Fields.empty ~decode:(fun () -> []) ~encode:(fun _ -> ()))
    ~f:(fun acc next ->
      Fields.map
        (acc ++ next)
        ~decode:(fun (a, b) -> a @ b)
        ~encode:(fun fields -> fields, fields))
  |> Api_codec.object_
  |> Api_codec.map
       ~decode:(fun fields -> Ok (`Object fields))
       ~encode:(function
         | `Object fields -> fields
         | _ -> Json.fail Invalid_argument "expected communication query object")
       ~description:"Closed communication query object."
;;

let page fields =
  record
    (fields
     @ [ optional "offset" decimal
       ; optional "limit" limit
       ; optional "revision" decimal
       ; optional "max_bytes" budget
       ])
  |> Api_codec.map
       ~decode:(fun params ->
         if
           Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer > 0
           && Option.is_none (Json.optional params "revision")
         then
           Error
             (Problem.create
                Invalid_argument
                "pagination requires communication revision")
         else Ok params)
       ~encode:Fn.id
       ~description:
         "Page at a captured communication revision; positive offset requires that \
          revision."
;;

let direct name codec = record [ required name codec; optional "max_bytes" budget ]

let thread_filters =
  [ optional "scope" Communication_wire.scope
  ; optional "board_id" board_id
  ; optional "actor_id" actor_id
  ; optional "state" Communication_wire.thread_state
  ; optional "unresolved" Api_codec.boolean
  ; optional "text" (Api_codec.text ~max_bytes:512)
  ]
;;

let request_filters =
  [ optional "scope" Communication_wire.scope
  ; optional "thread_id" thread_id
  ; optional "kind" Communication_wire.request_kind
  ; optional "recipient" Communication_recipient.codec
  ; optional "open_only" Api_codec.boolean
  ; optional "unanswered" Api_codec.boolean
  ; optional "responsible" Communication_recipient.codec
  ; optional "overdue_at_unix_ms" unix_ms
  ]
;;

let query_entries =
  [ "board.get", direct "board_id" board_id, Communication_wire.board
  ; ( "board.list"
    , page [ optional "scope" Communication_wire.scope ]
    , Communication_wire.page Communication_wire.board )
  ; "team.get", direct "team_id" team_id, Communication_wire.team
  ; "team.list", page [], Communication_wire.page Communication_wire.team
  ; ( "subscription.get"
    , direct "subscription_id" subscription_id
    , Communication_wire.subscription )
  ; ( "subscription.list"
    , page [ optional "recipient" Communication_recipient.codec ]
    , Communication_wire.page Communication_wire.subscription )
  ; ( "thread.get"
    , Api_codec.as_json Communication_related.Query.thread_codec
    , Communication_wire.thread )
  ; "thread.list", page thread_filters, Communication_wire.page Communication_wire.thread
  ; ( "thread.search"
    , page thread_filters
    , Communication_wire.page Communication_wire.thread )
  ; ( "thread.history"
    , page [ required "thread_id" thread_id ]
    , Communication_wire.page Communication_wire.thread )
  ; ( "request.get"
    , Api_codec.as_json Communication_related.Query.request_codec
    , Communication_wire.request )
  ; ( "request.list"
    , page request_filters
    , Communication_wire.page Communication_wire.request )
  ; ( "request.history"
    , page [ required "request_id" request_id ]
    , Communication_wire.page Communication_wire.request )
  ]
;;

let query_methods = List.map query_entries ~f:(fun (name, _, _) -> name)

let mutation_response = function
  | "board.put" -> Communication_wire.board
  | "team.put" -> Communication_wire.team
  | "subscription.put" -> Communication_wire.subscription
  | "thread.put" | "thread.attach" | "thread.pin_message" -> Communication_wire.thread
  | "request.create"
  | "request.acknowledge"
  | "request.accept"
  | "request.reassign"
  | "request.resolve"
  | "request.cancel" -> Communication_wire.request
  | _ -> invalid_arg "unknown communication mutation"
;;

let mutation_entries =
  Communication_command.methods
  |> List.filter ~f:(fun name -> not (String.equal name "inbox.ack"))
  |> List.map ~f:(fun name ->
    ( name
    , Option.value_exn (Communication_command.raw_request_codec ~method_:name)
    , mutation_response name ))
;;

let entries = mutation_entries @ query_entries
let find method_ = List.find entries ~f:(fun (name, _, _) -> String.equal name method_)
let request_codec ~method_ = Option.map (find method_) ~f:(fun (_, request, _) -> request)

let response_codec ~method_ =
  Option.map (find method_) ~f:(fun (_, _, response) -> response)
;;

let methods =
  List.map entries ~f:(fun (name, request, response) ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Communication state and accountable requests: " ^ name)
         ~mode:
           (if List.mem query_methods name ~equal:String.equal then Read else Mutation)
         ~request
         ~response))
;;

let validate_query ~method_ ~params =
  match List.find query_entries ~f:(fun (name, _, _) -> String.equal name method_) with
  | None -> Error (Problem.create Invalid_argument "unknown communication query")
  | Some (_, request, _) -> Result.map (Api_codec.decode request params) ~f:(fun _ -> ())
;;

let validate_result ~method_ result =
  match response_codec ~method_ with
  | None -> invalid_arg "unknown communication result"
  | Some codec ->
    (match Api_codec.decode codec result with
     | Ok _ -> ()
     | Error problem -> raise (Api_method.Invalid_response (method_, problem)))
;;
