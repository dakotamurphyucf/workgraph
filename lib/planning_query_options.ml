open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

type t =
  { offset : int
  ; limit : int
  ; at_revision : int option
  ; include_archived : bool
  ; max_bytes : int
  }

let offset t = t.offset
let limit t = t.limit
let at_revision t = t.at_revision
let include_archived t = t.include_archived
let max_bytes t = t.max_bytes

let minimum min max =
  Api_codec.map
    (Api_codec.decimal ~max)
    ~decode:(fun value ->
      if value >= min
      then Ok value
      else Error (Problem.create Invalid_argument "value below supported query bound"))
    ~encode:Fn.id
    ~description:(Printf.sprintf "Canonical decimal within %d..%d." min max)
;;

let capture =
  Fields.optional "at_revision" (Api_codec.decimal ~max:Int.max_value)
  ++ Fields.optional "max_bytes" (minimum 4096 1048576)
;;

let paging =
  Fields.optional "offset" (Api_codec.decimal ~max:Int.max_value)
  ++ Fields.optional "limit" (minimum 1 100)
;;

let make ~offset ~limit ~at_revision ~include_archived ~max_bytes =
  let offset = Option.value offset ~default:0 in
  if offset > 0 && Option.is_none at_revision
  then Json.fail Invalid_argument "pagination requires at_revision";
  { offset
  ; limit = Option.value limit ~default:50
  ; at_revision
  ; include_archived = Option.value include_archived ~default:false
  ; max_bytes = Option.value max_bytes ~default:65536
  }
;;

let scalar_fields =
  Fields.map
    capture
    ~decode:(fun (at_revision, max_bytes) ->
      make ~offset:None ~limit:None ~at_revision ~include_archived:None ~max_bytes)
    ~encode:(fun t -> t.at_revision, Some t.max_bytes)
;;

let page_fields =
  Fields.map
    (Fields.both paging capture)
    ~decode:(fun ((offset, limit), (at_revision, max_bytes)) ->
      make ~offset ~limit ~at_revision ~include_archived:None ~max_bytes)
    ~encode:(fun t -> (Some t.offset, Some t.limit), (t.at_revision, Some t.max_bytes))
;;

let fields =
  Fields.map
    (Fields.both
       (Fields.both paging capture)
       (Fields.optional "include_archived" Api_codec.boolean))
    ~decode:(fun (((offset, limit), (at_revision, max_bytes)), include_archived) ->
      make ~offset ~limit ~at_revision ~include_archived ~max_bytes)
    ~encode:(fun t ->
      ( ((Some t.offset, Some t.limit), (t.at_revision, Some t.max_bytes))
      , Some t.include_archived ))
;;

let codec = Api_codec.object_ fields
