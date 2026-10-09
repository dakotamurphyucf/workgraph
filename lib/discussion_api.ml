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

let comment_id = id Id.Comment.of_string Id.Comment.to_string
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
         | _ -> Json.fail Invalid_argument "expected comment query object")
       ~description:"Closed comment query object."
;;

let page fields =
  record
    (fields
     @ [ optional "offset" decimal
       ; optional "limit" limit
       ; optional "at_revision" decimal
       ; optional "max_bytes" budget
       ])
  |> Api_codec.map
       ~decode:(fun params ->
         if
           Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer > 0
           && Option.is_none (Json.optional params "at_revision")
         then
           Error
             (Problem.create Invalid_argument "pagination requires workspace revision")
         else Ok params)
       ~encode:Fn.id
       ~description:
         "Page at a captured workspace revision; positive offset requires that revision."
;;

let target =
  Api_codec.map
    Planning_target.codec
    ~decode:Planning_target.to_ref
    ~encode:Planning_target.of_ref
    ~description:"Resolved tagged comment target."
;;

let common = [ optional "include_archived" Api_codec.boolean ]

let entries =
  [ ( "comment.get"
    , page (required "comment_id" comment_id :: common)
    , Discussion_wire.comment )
  ; ( "comment.history"
    , page (required "comment_id" comment_id :: common)
    , Communication_wire.page Discussion_wire.comment )
  ; ( "comment.list"
    , page
        (common
         @ [ optional "target" target; optional "include_tombstones" Api_codec.boolean ])
    , Communication_wire.page Discussion_wire.comment )
  ]
;;

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
         ~summary:("Read comment provenance and content: " ^ name)
         ~mode:Read
         ~request
         ~response))
;;

let validate_request ~method_ params =
  match request_codec ~method_ with
  | None -> Error (Problem.create Invalid_argument "unknown comment query")
  | Some codec -> Result.map (Api_codec.decode codec params) ~f:(fun _ -> ())
;;

let validate_result ~method_ result =
  match response_codec ~method_ with
  | None -> invalid_arg "unknown comment result"
  | Some codec ->
    (match Api_codec.decode codec result with
     | Ok _ -> ()
     | Error problem -> raise (Api_method.Invalid_response (method_, problem)))
;;
