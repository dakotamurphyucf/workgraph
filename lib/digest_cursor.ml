open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

module Position = struct
  type t =
    | Before_first
    | After_revision of int
    | After_change of
        { revision : int
        ; change_index : int
        }

  let before_first = Before_first

  let after_revision revision =
    if revision < 0
    then Error (Problem.create Invalid_argument "negative digest position")
    else Ok (if revision = 0 then Before_first else After_revision revision)
  ;;

  let create ~revision ~change_index =
    if revision <= 0 || change_index < 0
    then Error (Problem.create Invalid_argument "invalid digest change position")
    else Ok (After_change { revision; change_index })
  ;;

  let revision = function
    | Before_first -> 0
    | After_revision n -> n
    | After_change p -> p.revision
  ;;

  let change_index = function
    | Before_first | After_revision _ -> -1
    | After_change p -> p.change_index
  ;;

  let complete t ~through =
    match t with
    | Before_first -> through = 0
    | After_revision n -> n = through
    | After_change _ -> false
  ;;

  let follows t ~revision ~change_index =
    match t with
    | Before_first -> true
    | After_revision n -> revision > n
    | After_change p ->
      revision > p.revision || (revision = p.revision && change_index > p.change_index)
  ;;

  let wrong () = Json.fail Invalid_argument "wrong digest cursor position"

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "begin"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "begin"))
                 ~decode:(fun () -> Before_first)
                 ~encode:(function
                   | Before_first -> ()
                   | _ -> wrong ())) )
        ; ( "revision"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "revision")
                  ++ F.required "revision" W.positive)
                 ~decode:(fun ((), n) -> After_revision n)
                 ~encode:(function
                   | After_revision n -> (), n
                   | _ -> wrong ())) )
        ; ( "change"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "change")
                  ++ F.required "revision" W.positive
                  ++ F.required "change_index" W.counter)
                 ~decode:(fun (((), revision), change_index) ->
                   After_change { revision; change_index })
                 ~encode:(function
                   | After_change p -> ((), p.revision), p.change_index
                   | _ -> wrong ())) )
        ]
      ~select:(function
        | Before_first -> "begin"
        | After_revision _ -> "revision"
        | After_change _ -> "change")
  ;;
end

type t =
  { workspace : Id.Workspace.t
  ; scope_hash : string
  ; through : int
  ; anchor : string
  ; position : Position.t
  }

let hash =
  W.checked (Api_codec.text ~max_bytes:64) (fun s ->
    if
      String.length s <> 64
      || not
           (String.for_all s ~f:(fun c -> Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid cursor digest")
;;

let codec =
  W.checked
    (Api_codec.object_
       (F.map
          (F.required "version" (Api_codec.literal "1")
           ++ F.required
                "workspace_id"
                (W.id Id.Workspace.of_string Id.Workspace.to_string)
           ++ F.required "scope_hash" hash
           ++ F.required "through" W.counter
           ++ F.required "anchor" hash
           ++ F.required "position" Position.codec)
          ~decode:(fun ((((((), workspace), scope_hash), through), anchor), position) ->
            { workspace; scope_hash; through; anchor; position })
          ~encode:(fun t ->
            (((((), t.workspace), t.scope_hash), t.through), t.anchor), t.position)))
    (fun t ->
       if Position.revision t.position > t.through
       then Json.fail Invalid_argument "cursor position exceeds capture")
;;

let scope_hash scope =
  W.encode_exn Resume_api.Scope.codec scope |> Json.canonical |> Json.hash
;;

let create ~workspace ~scope ~position ~lineage =
  Json.decode (fun () ->
    let t =
      { workspace
      ; scope_hash = scope_hash scope
      ; through = Planning_lineage.through lineage
      ; anchor = Planning_lineage.digest lineage
      ; position
      }
    in
    ignore (W.encode_exn codec t : Jsonaf.t);
    t)
;;

let encode t = W.encode_exn codec t |> Json.canonical |> Base64.encode_string

let decode encoded =
  Json.decode (fun () ->
    ignore (W.decode_exn (Api_codec.text ~max_bytes:2048) (Json.string encoded) : string);
    let bytes =
      match Base64.decode encoded with
      | Ok bytes when String.equal encoded (Base64.encode_string bytes) -> bytes
      | Ok _ | Error _ -> Json.fail Invalid_argument "invalid digest cursor encoding"
    in
    W.decode_exn
      codec
      (match Json.parse bytes with
       | Ok v -> v
       | Error p -> raise (Json.Decode_error p)))
;;

let validate t ~workspace ~scope ~activity =
  Json.decode (fun () ->
    if
      not
        (Id.Workspace.equal t.workspace workspace
         && String.equal t.scope_hash (scope_hash scope))
    then Json.fail Conflict "digest cursor workspace or scope changed";
    let lineage =
      match Planning_lineage.of_activity activity ~through:t.through with
      | Ok lineage -> lineage
      | Error _ -> Json.fail Conflict "digest capture prefix unavailable"
    in
    if not (String.equal t.anchor (Planning_lineage.digest lineage))
    then Json.fail Conflict "digest capture prefix changed";
    match t.position with
    | Position.Before_first | After_revision _ -> ()
    | After_change p ->
      let event =
        List.find activity ~f:(fun event ->
          Json.integer (Json.field event "revision") = p.revision)
      in
      if
        not
          (Option.exists event ~f:(fun event ->
             p.change_index < List.length (Json.list (Json.field event "changes"))))
      then Json.fail Conflict "digest change position unavailable")
;;

let through t = t.through
let position t = t.position
let lineage t = t.anchor
