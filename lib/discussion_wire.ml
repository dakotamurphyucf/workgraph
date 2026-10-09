open Core
module Fields = Api_codec.Fields

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let ( ++ ) = Fields.both

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity."
;;

let actor = id Id.Actor.of_string Id.Actor.to_string
let comment_id = id Id.Comment.of_string Id.Comment.to_string

let positive =
  Api_codec.map
    (Api_codec.decimal ~max:Int.max_value)
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "comment counters must be positive"))
    ~encode:Fn.id
    ~description:"Positive revision/activity counter."
;;

let target =
  Api_codec.map
    Planning_target.codec
    ~decode:Planning_target.to_ref
    ~encode:Planning_target.of_ref
    ~description:"Resolved tagged discussion target."
;;

let kind =
  Api_codec.enum
    [ "comment", Discussion.Kind.Comment
    ; "progress", Progress
    ; "decision", Decision
    ; "blocker", Blocker
    ; "evidence", Evidence
    ]
    ~equal:Discussion.Kind.equal
;;

let origin =
  Api_codec.enum
    [ "authored", Discussion.Origin.Authored; "completion", Completion ]
    ~equal:Discussion.Origin.equal
;;

let field name codec =
  Fields.map
    (Fields.required name codec)
    ~decode:(fun value -> [ name, unwrap (Api_codec.encode codec value) ])
    ~encode:(fun fields ->
      unwrap (Api_codec.decode codec (Json.field (`Object fields) name)))
;;

let record fields =
  List.fold
    fields
    ~init:(Fields.map Fields.empty ~decode:(fun () -> []) ~encode:(fun _ -> ()))
    ~f:(fun acc field ->
      Fields.map
        (acc ++ field)
        ~decode:(fun (a, b) -> a @ b)
        ~encode:(fun fields -> fields, fields))
  |> Api_codec.object_
  |> Api_codec.map
       ~decode:(fun fields -> Ok (`Object fields))
       ~encode:(function
         | `Object fields -> fields
         | _ -> Json.fail Invalid_argument "expected comment record")
       ~description:
         "Public comment/version view; complete provenance and explicitly budgeted prose."
;;

let comment =
  record
    [ field "comment_id" comment_id
    ; field "target" target
    ; field "author_id" actor
    ; field "created_at" (Api_codec.text ~max_bytes:128)
    ; field "reply_to_comment_id" (Api_codec.nullable comment_id)
    ; field "kind" kind
    ; field "origin" origin
    ; field "revision" positive
    ; field "serial" positive
    ; field "sequence" positive
    ; field "actor_id" actor
    ; field "timestamp" (Api_codec.text ~max_bytes:128)
    ; field "body" (Api_codec.text ~max_bytes:65536)
    ; field "tombstone" Api_codec.boolean
    ]
  |> Api_codec.map
       ~decode:(fun value ->
         if
           (match Json.field value "tombstone" with
            | `True -> true
            | _ -> false)
           && not (String.is_empty (Json.text (Json.field value "body")))
         then Error (Problem.create Invalid_argument "tombstone body must be empty")
         else Ok value)
       ~encode:Fn.id
       ~description:"A tombstone preserves provenance and an empty body."
;;

let comment_json source =
  let value =
    Json.obj
      (List.map
         [ "comment_id", "comment_id"
         ; "target", "target"
         ; "author_id", "author"
         ; "created_at", "created_at"
         ; "reply_to_comment_id", "reply_to"
         ; "kind", "kind"
         ; "origin", "origin"
         ; "revision", "revision"
         ; "serial", "serial"
         ; "sequence", "sequence"
         ; "actor_id", "actor"
         ; "timestamp", "timestamp"
         ; "body", "body"
         ; "tombstone", "tombstone"
         ]
         ~f:(fun (public, private_) -> public, Json.field source private_))
  in
  match Api_codec.decode comment value with
  | Ok value -> value
  | Error problem -> raise (Api_method.Invalid_response ("comment projection", problem))
;;
