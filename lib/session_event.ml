open Core

module Blob_ref = struct
  type t =
    { digest : string
    ; size_bytes : int
    }
  [@@deriving sexp, equal]

  let create ~digest ~size_bytes =
    if
      size_bytes < 0
      || size_bytes > 64 * 1024 * 1024
      || String.length digest <> 64
      || not
           (String.for_all digest ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then
      Error (Problem.create Invalid_argument "invalid blob digest/size (maximum 64MiB)")
    else Ok { digest; size_bytes }
  ;;

  let to_json t =
    Json.obj [ "digest", Json.string t.digest; "size_bytes", Json.int t.size_bytes ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "digest"; "size_bytes" ];
      Disk.unwrap
        (create
           ~digest:(Json.text (Json.field json "digest"))
           ~size_bytes:(Json.integer (Json.field json "size_bytes"))))
  ;;
end

module Resource_ref = struct
  type t =
    { id : Id.Resource.t
    ; revision : int
    }
  [@@deriving sexp, equal]

  let create ~id ~revision =
    if revision < 1 || revision > 100_000
    then Error (Problem.create Invalid_argument "resource version requires 1..100000")
    else Ok { id; revision }
  ;;

  let to_json t =
    Json.obj
      [ "resource_id", Id.Resource.jsonaf_of_t t.id; "revision", Json.int t.revision ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "resource_id"; "revision" ];
      create
        ~id:(Id.Resource.t_of_jsonaf (Json.field json "resource_id"))
        ~revision:(Json.integer (Json.field json "revision"))
      |> Disk.unwrap)
  ;;
end

module Content = struct
  type t =
    | Inline of string
    | Blob of Blob_ref.t

  let to_json = function
    | Inline bytes ->
      Json.obj [ "bytes_base64", Json.string (Base64.encode_string bytes) ]
    | Blob ref_ -> Json.obj [ "blob", Blob_ref.to_json ref_ ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "bytes_base64"; "blob" ];
      match Json.optional json "bytes_base64", Json.optional json "blob" with
      | Some value, None ->
        (match Base64.decode (Json.text value) with
         | Ok bytes -> Inline bytes
         | Error (`Msg message) -> Json.fail Invalid_argument message)
      | None, Some value -> Blob (Disk.unwrap (Blob_ref.of_json value))
      | Some _, Some _ | None, None ->
        Json.fail Invalid_argument "content requires exactly one bytes_base64/blob")
  ;;
end

module Input = struct
  type t =
    { client_id : string
    ; role : string
    ; kind : string
    ; phase : string
    ; correlation : string option
    ; provenance : Jsonaf.t
    ; payload : Content.t
    ; searchable_text : Content.t option
    ; attachments : Blob_ref.t list
    ; resource_versions : Resource_ref.t list
    }

  let create
        ~client_id
        ~role
        ~kind
        ~phase
        ?correlation
        ?(provenance = `Null)
        ~payload
        ?searchable_text
        ?(resource_versions = [])
        ~attachments
        ()
    =
    Json.decode (fun () ->
      List.iter [ client_id; role; kind; phase ] ~f:(fun text ->
        ignore (Json.canonical (Json.string text) : string);
        if String.is_empty text || String.length text > 256
        then
          Json.fail
            Invalid_argument
            "event identifiers/role/kind/phase require 1..256 UTF-8 bytes");
      Option.iter correlation ~f:(fun text ->
        ignore (Json.canonical (Json.string text) : string);
        if String.length text > 256
        then Json.fail Invalid_argument "correlation exceeds 256 bytes");
      if String.length (Json.canonical provenance) > 4096
      then Json.fail Invalid_argument "provenance exceeds 4KiB";
      if List.length resource_versions > 100
      then Json.fail Invalid_argument "at most 100 resource version references";
      if List.length attachments > 100
      then Json.fail Invalid_argument "at most 100 attachments";
      let check_inline = function
        | Content.Inline bytes when String.length bytes > 16 * 1024 * 1024 ->
          Json.fail Invalid_argument "inline content exceeds 16MiB"
        | Content.Inline _ | Content.Blob _ -> ()
      in
      check_inline payload;
      Option.iter searchable_text ~f:(fun content ->
        check_inline content;
        match content with
        | Content.Inline text -> ignore (Json.canonical (Json.string text) : string)
        | Content.Blob _ -> ());
      { client_id
      ; role
      ; kind
      ; phase
      ; correlation
      ; provenance
      ; payload
      ; searchable_text
      ; attachments
      ; resource_versions
      })
  ;;

  let client_id t = t.client_id
  let resource_versions t = t.resource_versions
  let contents t = t.payload :: Option.to_list t.searchable_text

  let to_json t =
    Json.obj
      [ "client_id", Json.string t.client_id
      ; "role", Json.string t.role
      ; "kind", Json.string t.kind
      ; "phase", Json.string t.phase
      ; "correlation", Option.value_map t.correlation ~default:`Null ~f:Json.string
      ; "provenance", t.provenance
      ; "payload", Content.to_json t.payload
      ; ( "searchable_text"
        , Option.value_map t.searchable_text ~default:`Null ~f:Content.to_json )
      ; "resource_versions", `Array (List.map t.resource_versions ~f:Resource_ref.to_json)
      ; "attachments", `Array (List.map t.attachments ~f:Blob_ref.to_json)
      ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields
        json
        ~allowed:
          [ "client_id"
          ; "role"
          ; "kind"
          ; "phase"
          ; "correlation"
          ; "provenance"
          ; "payload"
          ; "searchable_text"
          ; "resource_versions"
          ; "attachments"
          ];
      let optional key f =
        match Json.field json key with
        | `Null -> None
        | value -> Some (f value)
      in
      Disk.unwrap
        (create
           ~client_id:(Json.text (Json.field json "client_id"))
           ~role:(Json.text (Json.field json "role"))
           ~kind:(Json.text (Json.field json "kind"))
           ~phase:(Json.text (Json.field json "phase"))
           ?correlation:(optional "correlation" Json.text)
           ~provenance:(Json.field json "provenance")
           ~payload:(Disk.unwrap (Content.of_json (Json.field json "payload")))
           ?searchable_text:
             (optional "searchable_text" (fun json -> Disk.unwrap (Content.of_json json)))
           ~resource_versions:
             (Option.value_map
                (Json.optional json "resource_versions")
                ~default:[]
                ~f:(fun json ->
                  List.map (Json.list json) ~f:(fun json ->
                    Resource_ref.of_json json |> Disk.unwrap)))
           ~attachments:
             (List.map
                (Json.list (Json.field json "attachments"))
                ~f:(fun json -> Disk.unwrap (Blob_ref.of_json json)))
           ()))
  ;;

  let content_identity = function
    | Content.Blob ref_ -> Blob_ref.to_json ref_
    | Content.Inline bytes ->
      Blob_ref.to_json
        (Disk.unwrap
           (Blob_ref.create ~digest:(Json.hash bytes) ~size_bytes:(String.length bytes)))
  ;;

  let identity_hash t =
    let json = to_json t in
    match json with
    | `Object fields ->
      let fields =
        List.Assoc.add fields "payload" (content_identity t.payload) ~equal:String.equal
      in
      let fields =
        List.Assoc.add
          fields
          "searchable_text"
          (Option.value_map t.searchable_text ~default:`Null ~f:content_identity)
          ~equal:String.equal
      in
      Json.hash (Json.canonical (Json.obj fields))
    | _ -> assert false
  ;;
end

type t =
  { ref_ : Session.Event_ref.t
  ; identity_hash : string
  ; input : Input.t
  ; actor : Id.Actor.t
  ; run : Id.Run.t option
  }

let commit input ~ref_ ~actor ~run ~install =
  let payload = Content.Blob (install input.Input.payload) in
  let searchable_text =
    Option.map input.searchable_text ~f:(fun content -> Content.Blob (install content))
  in
  { ref_
  ; identity_hash = Input.identity_hash input
  ; actor
  ; run
  ; input = { input with payload; searchable_text }
  }
;;

let ref_ t = t.ref_
let actor t = t.actor
let run t = t.run
let client_id t = t.input.client_id
let identity_hash t = t.identity_hash

let payload t =
  match t.input.payload with
  | Content.Blob ref_ -> ref_
  | Content.Inline _ -> assert false
;;

let searchable_text t =
  Option.map t.input.searchable_text ~f:(function
    | Content.Blob ref_ -> ref_
    | Content.Inline _ -> assert false)
;;

let attachments t = t.input.attachments
let resource_versions t = t.input.resource_versions
let kind t = t.input.kind
let role t = t.input.role
let blob_references t = (payload t :: Option.to_list (searchable_text t)) @ attachments t

let to_json t =
  Json.obj
    [ "ref", Session.Event_ref.to_json t.ref_
    ; "identity_hash", Json.string t.identity_hash
    ; "actor", Id.Actor.jsonaf_of_t t.actor
    ; "run", Option.value_map t.run ~default:`Null ~f:Id.Run.jsonaf_of_t
    ; "event", Input.to_json t.input
    ]
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields json ~allowed:[ "ref"; "identity_hash"; "actor"; "run"; "event" ];
    let ref_ = Disk.unwrap (Session.Event_ref.of_json (Json.field json "ref")) in
    let identity_hash = Json.text (Json.field json "identity_hash") in
    let input = Disk.unwrap (Input.of_json (Json.field json "event")) in
    List.iter (Input.contents input) ~f:(function
      | Content.Inline _ ->
        Json.fail Corrupt_store "committed event requires blob references"
      | Content.Blob _ -> ());
    if not (String.equal identity_hash (Input.identity_hash input))
    then Json.fail Corrupt_store "event identity mismatch";
    let actor = Id.Actor.t_of_jsonaf (Json.field json "actor") in
    let run =
      match Json.field json "run" with
      | `Null -> None
      | json -> Some (Id.Run.t_of_jsonaf json)
    in
    { ref_; identity_hash; input; actor; run })
;;
