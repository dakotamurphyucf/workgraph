open Core
module F = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = F.both

let digest_codec =
  W.checked (Api_codec.text ~max_bytes:64) (fun value ->
    if
      String.length value <> 64
      || not
           (String.for_all value ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid audit digest")
;;

let minimum min max =
  W.checked (Api_codec.decimal ~max) (fun value ->
    if value < min then Json.fail Invalid_argument "value below supported audit bound")
;;

module Request = struct
  type t =
    { after : int option
    ; cursor : string option
    ; target : Entity_ref.t option
    ; actor : Id.Actor.t option
    ; limit : int
    ; max_bytes : int
    }

  let codec =
    W.checked
      (Api_codec.object_
         (F.map
            (F.optional "after" W.counter
             ++ F.optional "cursor" (W.nonblank ~max_bytes:4096)
             ++ F.optional "target" Evidence_wire.entity_ref
             ++ F.optional "actor_id" (W.id Id.Actor.of_string Id.Actor.to_string)
             ++ F.optional "limit" (minimum 1 100)
             ++ F.optional "max_bytes" (minimum 4096 1048576))
            ~decode:(fun (((((after, cursor), target), actor), limit), max_bytes) ->
              { after
              ; cursor
              ; target
              ; actor
              ; limit = Option.value limit ~default:50
              ; max_bytes = Option.value max_bytes ~default:65536
              })
            ~encode:(fun t ->
              ((((t.after, t.cursor), t.target), t.actor), Some t.limit), Some t.max_bytes)))
      (fun t ->
         if Option.is_some t.after && Option.is_some t.cursor
         then Json.fail Invalid_argument "supply after or cursor, not both")
  ;;

  let after t = t.after
  let cursor t = t.cursor
  let target t = t.target
  let actor t = t.actor
  let limit t = t.limit
  let max_bytes t = t.max_bytes
end

module Row = struct
  type payload =
    | Change of Planning_activity_wire.Activity.t
    | Chunk of string

  type t =
    { revision : int
    ; change_index : int
    ; change_count : int
    ; byte_offset : int
    ; total_bytes : int
    ; digest : string
    ; payload : payload
    }

  let common =
    F.required "revision" W.positive
    ++ F.required "change_index" W.counter
    ++ F.required "change_count" W.positive
    ++ F.required "byte_offset" W.counter
    ++ F.required "total_bytes" W.positive
    ++ F.required "digest" digest_codec
  ;;

  let make kind codec create select =
    Api_codec.object_
      (F.map
         (F.required "kind" (Api_codec.literal kind) ++ common ++ F.required "value" codec)
         ~decode:
           (fun
             ( ( ()
               , ( ((((revision, change_index), change_count), byte_offset), total_bytes)
                 , digest ) )
             , value ) ->
           { revision
           ; change_index
           ; change_count
           ; byte_offset
           ; total_bytes
           ; digest
           ; payload = create value
           })
         ~encode:(fun t ->
           ( ( ()
             , ( ( (((t.revision, t.change_index), t.change_count), t.byte_offset)
                 , t.total_bytes )
               , t.digest ) )
           , select t.payload )))
  ;;

  let codec =
    W.checked
      (Api_codec.tagged
         ~discriminator:"kind"
         ~cases:
           [ ( "change"
             , make
                 "change"
                 Planning_activity_wire.Activity.codec
                 (fun v -> Change v)
                 (function
                   | Change v -> v
                   | Chunk _ -> Json.fail Invalid_argument "expected whole audit change")
             )
           ; ( "chunk"
             , make
                 "chunk"
                 (Api_codec.text ~max_bytes:1048576)
                 (fun v -> Chunk v)
                 (function
                   | Chunk v -> v
                   | Change _ -> Json.fail Invalid_argument "expected audit chunk") )
           ]
         ~select:(fun t ->
           match t.payload with
           | Change _ -> "change"
           | Chunk _ -> "chunk"))
      (fun t ->
         if t.change_index >= t.change_count || t.byte_offset >= t.total_bytes
         then Json.fail Invalid_argument "audit position outside source";
         match t.payload with
         | Change value ->
           let bytes =
             W.encode_exn Planning_activity_wire.Activity.codec value |> Json.canonical
           in
           if
             t.byte_offset <> 0
             || value.revision <> t.revision
             || List.length value.changes <> 1
             || String.length bytes <> t.total_bytes
             || not (String.equal (Json.hash bytes) t.digest)
           then
             Json.fail
               Invalid_argument
               "whole audit change differs from its source identity"
         | Chunk bytes ->
           if String.is_empty bytes
           then Json.fail Invalid_argument "audit chunk must be nonempty";
           if String.length bytes > t.total_bytes - t.byte_offset
           then Json.fail Invalid_argument "audit chunk exceeds exact source bytes";
           if
             t.byte_offset = 0
             && String.length bytes = t.total_bytes
             && not (String.equal (Json.hash bytes) t.digest)
           then Json.fail Invalid_argument "audit chunk digest differs from source")
  ;;
end

module Page = struct
  type t =
    { through : int
    ; lineage : string
    ; items : Row.t list
    ; cursor : string option
    ; remaining_changes : int
    }

  let codec =
    W.checked
      (Api_codec.object_
         (F.map
            (F.required "through" W.counter
             ++ F.required "lineage" digest_codec
             ++ F.required "items" (Api_codec.list Row.codec ~max_items:100)
             ++ F.required "cursor" (Api_codec.nullable (W.nonblank ~max_bytes:4096))
             ++ F.required "remaining_changes" W.counter)
            ~decode:(fun ((((through, lineage), items), cursor), remaining_changes) ->
              { through; lineage; items; cursor; remaining_changes })
            ~encode:(fun t ->
              (((t.through, t.lineage), t.items), t.cursor), t.remaining_changes)))
      (fun t ->
         if not (Bool.equal (Option.is_some t.cursor) (t.remaining_changes > 0))
         then
           Json.fail Invalid_argument "audit continuation differs from remaining changes";
         let returned_bytes (row : Row.t) =
           match row.payload with
           | Change _ -> row.total_bytes
           | Chunk bytes -> String.length bytes
         in
         let complete row = row.Row.byte_offset + returned_bytes row = row.total_bytes in
         let last =
           List.fold t.items ~init:None ~f:(fun previous row ->
             if row.Row.revision > t.through
             then Json.fail Invalid_argument "audit row exceeds capture";
             Option.iter previous ~f:(fun before ->
               let same =
                 before.Row.revision = row.revision
                 && before.change_index = row.change_index
               in
               if same
               then (
                 if
                   row.byte_offset <> before.byte_offset + returned_bytes before
                   || row.change_count <> before.change_count
                   || row.total_bytes <> before.total_bytes
                   || not (String.equal row.digest before.digest)
                 then Json.fail Invalid_argument "audit chunk source or range changed")
               else if
                 (not (complete before))
                 || row.byte_offset <> 0
                 || row.revision < before.revision
                 || (row.revision = before.revision
                     && row.change_index <> before.change_index + 1)
               then
                 Json.fail Invalid_argument "audit changes are not contiguous and ordered");
             Some row)
         in
         if
           Option.exists last ~f:(fun row -> not (complete row))
           && Option.is_none t.cursor
         then Json.fail Invalid_argument "partial audit change requires continuation";
         if List.is_empty t.items && Option.is_some t.cursor
         then Json.fail Invalid_argument "audit continuation requires progress")
  ;;
end

let descriptor =
  Api_method.Packed.Pack
    (Api_method.create
       ~name:"activity.read"
       ~summary:
         "Traverse exact captured audit changes with bounded canonical JSON chunks; use \
          activity.digest for semantic history or ticket.resume for focused recovery."
       ~mode:Read
       ~request:Request.codec
       ~response:Page.codec)
;;
