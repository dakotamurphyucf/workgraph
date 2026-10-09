open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity; aliases are not accepted."
;;

let resource_id = id Id.Resource.of_string Id.Resource.to_string
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

module Finish_request = struct
  type t =
    { upload : Id.Upload.t
    ; resource : Id.Resource.t option
    ; expected_revision : int
    ; title : string
    ; filename : string
    ; mime_type : string
    }

  let upload t = t.upload
  let resource t = t.resource
  let expected_revision t = t.expected_revision
  let title t = t.title
  let filename t = t.filename
  let mime_type t = t.mime_type

  let codec =
    Api_codec.map
      (Api_codec.object_
         (Fields.required "upload_id" (id Id.Upload.of_string Id.Upload.to_string)
          ++ Fields.optional "resource_id" resource_id
          ++ Fields.required "expected_revision" decimal
          ++ Fields.required "title" (Api_codec.text ~max_bytes:512)
          ++ Fields.required "filename" (Api_codec.text ~max_bytes:255)
          ++ Fields.required "mime_type" (Api_codec.text ~max_bytes:128)))
      ~decode:
        (fun
          (((((upload, resource), expected_revision), title), filename), mime_type) ->
        Json.decode (fun () ->
          if Option.is_none resource && expected_revision <> 0
          then
            Json.fail
              Invalid_argument
              "resource_id is required when expected_revision is nonzero";
          Resource.validate_metadata
            { title
            ; filename
            ; mime_type
            ; description = ""
            ; archived = false
            ; targets = []
            };
          { upload; resource; expected_revision; title; filename; mime_type }))
      ~encode:(fun { upload; resource; expected_revision; title; filename; mime_type } ->
        ((((upload, resource), expected_revision), title), filename), mime_type)
      ~description:
        "Publish private staged bytes as a durable resource version; omitted ID is \
         creation-only."
  ;;
end

module Query = struct
  type t =
    | Get of Id.Resource.t
    | History of Id.Resource.t
    | List of Entity_ref.t option

  type request =
    { query : t
    ; offset : int
    ; limit : int
    ; at_revision : int option
    ; include_archived : bool
    ; max_bytes : int
    }

  let query t = t.query
  let offset t = t.offset
  let limit t = t.limit
  let at_revision t = t.at_revision
  let include_archived t = t.include_archived
  let max_bytes t = t.max_bytes

  let common =
    Api_codec.object_
      (Fields.optional "offset" decimal
       ++ Fields.optional "limit" (bounded ~min:1 ~max:100 "limit must be 1..100")
       ++ Fields.optional "at_revision" decimal
       ++ Fields.optional "include_archived" Api_codec.boolean
       ++ Fields.optional
            "max_bytes"
            (bounded ~min:4096 ~max:1048576 "max_bytes must be 4096..1048576"))
  ;;

  let wrap codec =
    Api_codec.map
      (Api_codec.merge_objects common codec)
      ~decode:
        (fun
          (((((offset, limit), at_revision), include_archived), max_bytes), query) ->
        let offset = Option.value offset ~default:0 in
        if offset > 0 && Option.is_none at_revision
        then Error (Problem.create Invalid_argument "pagination requires at_revision")
        else
          Ok
            { query
            ; offset
            ; limit = Option.value limit ~default:50
            ; at_revision
            ; include_archived = Option.value include_archived ~default:false
            ; max_bytes = Option.value max_bytes ~default:65536
            })
      ~encode:(fun { query; offset; limit; at_revision; include_archived; max_bytes } ->
        ( ( (((Some offset, Some limit), at_revision), Some include_archived)
          , Some max_bytes )
        , query ))
      ~description:
        "Planning query view; positive offset requires the exact current workspace \
         revision."
  ;;

  let identity constructor project =
    Api_codec.map
      (Api_codec.object_ (Fields.required "resource_id" resource_id))
      ~decode:(fun id -> Ok (constructor id))
      ~encode:project
      ~description:"Resolved resource selector."
  ;;

  let scope =
    Api_codec.map
      Planning_target.codec
      ~decode:Planning_target.to_ref
      ~encode:Planning_target.of_ref
      ~description:"Resolved tagged resource-link filter."
  ;;

  let entries =
    [ ( "resource.get"
      , wrap
          (identity
             (fun id -> Get id)
             (function
               | Get id -> id
               | History _ | List _ -> Json.fail Invalid_argument "wrong resource query"))
      )
    ; ( "resource.history"
      , wrap
          (identity
             (fun id -> History id)
             (function
               | History id -> id
               | Get _ | List _ -> Json.fail Invalid_argument "wrong resource query")) )
    ; ( "resource.list"
      , wrap
          (Api_codec.map
             (Api_codec.object_ (Fields.optional "target" scope))
             ~decode:(fun target -> Ok (List target))
             ~encode:(function
               | List target -> target
               | Get _ | History _ -> Json.fail Invalid_argument "wrong resource query")
             ~description:
               "List current resource summaries in ID order, optionally filtered by \
                resolved link.") )
    ]
  ;;

  let decode ~method_ ~params =
    match List.Assoc.find entries method_ ~equal:String.equal with
    | None -> Error (Problem.create Invalid_argument "unknown resource query")
    | Some codec -> Api_codec.decode codec params
  ;;
end

let page item =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "items" (Api_codec.list item ~max_items:100)
        ++ Fields.required "offset" decimal
        ++ Fields.required "remaining" decimal
        ++ Fields.required "next_offset" (Api_codec.nullable decimal)))
    ~decode:(fun (((items, offset), remaining), next_offset) ->
      if
        not
          (Option.equal
             Int.equal
             next_offset
             (if remaining > 0 then Some (offset + List.length items) else None))
      then Error (Problem.create Invalid_argument "inconsistent resource page cursor")
      else Ok (items, offset, remaining, next_offset))
    ~encode:(fun (items, offset, remaining, next_offset) ->
      ((items, offset), remaining), next_offset)
    ~description:
      "Offset page after byte fitting; omitted items remain reflected in remaining and \
       next_offset."
  |> Api_codec.as_json
;;

let request_codec ~method_ =
  if String.equal method_ "resource.finish_upload"
  then Some (Api_codec.as_json Finish_request.codec)
  else
    Option.map
      (List.Assoc.find Query.entries method_ ~equal:String.equal)
      ~f:Api_codec.as_json
;;

let response_codec ~method_ =
  match method_ with
  | "resource.finish_upload" -> Some Resource_wire.publication
  | "resource.get" -> Some Resource_wire.summary
  | "resource.list" -> Some (page Resource_wire.summary)
  | "resource.history" -> Some (page Resource_wire.version)
  | _ -> None
;;

let methods =
  List.map ("resource.finish_upload" :: List.map Query.entries ~f:fst) ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Retained resource publication/metadata: " ^ name)
         ~mode:(if String.equal name "resource.finish_upload" then Mutation else Read)
         ~request:(Option.value_exn (request_codec ~method_:name))
         ~response:(Option.value_exn (response_codec ~method_:name))))
;;

let validate_publication result =
  match Api_codec.decode Resource_wire.publication result with
  | Ok _ -> ()
  | Error problem ->
    raise (Api_method.Invalid_response ("resource.finish_upload", problem))
;;
