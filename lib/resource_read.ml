open Core

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

module Fields = Api_codec.Fields

let decimal = Api_codec.decimal ~max:Int.max_value

let positive ~max description =
  Api_codec.map
    (Api_codec.decimal ~max)
    ~decode:(fun value ->
      if value > 0 then Ok value else Error (Problem.create Invalid_argument description))
    ~encode:Fn.id
    ~description
;;

let workspace_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:97)
    ~decode:Id.Workspace.of_string
    ~encode:Id.Workspace.to_string
    ~description:"Workspace identity."
;;

let resource_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:97)
    ~decode:Id.Resource.of_string
    ~encode:Id.Resource.to_string
    ~description:"Resource identity."
;;

let digest_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun value ->
      if
        String.length value = 64
        && String.for_all value ~f:(fun c ->
          Char.is_digit c || Char.(c >= 'a' && c <= 'f'))
      then Ok value
      else Error (Problem.create Invalid_argument "expected lowercase SHA-256 digest"))
    ~encode:Fn.id
    ~description:"Lowercase SHA-256 digest."
;;

let version_codec = positive ~max:Int.max_value "content version must be positive"

let selector_fields =
  Fields.both
    (Fields.both
       (Fields.required "workspace_id" workspace_codec)
       (Fields.required "resource_id" resource_codec))
    (Fields.optional "version" version_codec)
;;

module Request = struct
  type t =
    { workspace : Id.Workspace.t
    ; resource : Id.Resource.t
    ; version : int option
    }

  let workspace t = t.workspace
  let resource t = t.resource
  let version t = t.version
  let of_fields ((workspace, resource), version) = { workspace; resource; version }
  let fields t = (t.workspace, t.resource), t.version

  let codec =
    Api_codec.object_ (Fields.map selector_fields ~decode:of_fields ~encode:fields)
  ;;
end

let require_selected_version request (version : Resource.Version.t) =
  Option.iter (Request.version request) ~f:(fun selected ->
    if not (Int.equal selected version.revision)
    then
      Json.fail
        Invalid_argument
        "selected resource version differs from supplied content version")
;;

module Chunk_request = struct
  type t =
    { request : Request.t
    ; byte_offset : int
    ; max_bytes : int
    }

  let request t = t.request
  let byte_offset t = t.byte_offset
  let max_bytes t = t.max_bytes

  let codec =
    let fields =
      Fields.both
        selector_fields
        (Fields.both
           (Fields.optional "offset" decimal)
           (Fields.optional
              "length"
              (positive ~max:262_144 "read length must be 1..262144 bytes")))
    in
    Api_codec.map
      (Api_codec.object_ fields)
      ~decode:(fun (request, (offset, length)) ->
        let byte_offset = Option.value offset ~default:0 in
        let max_bytes = Option.value length ~default:65_536 in
        if byte_offset > Int.max_value - max_bytes
        then Error (Problem.create Invalid_argument "resource byte range overflows")
        else Ok { request = Request.of_fields request; byte_offset; max_bytes })
      ~encode:(fun t -> Request.fields t.request, (Some t.byte_offset, Some t.max_bytes))
      ~description:"Nonnegative byte offset and a positive range of at most 256KiB."
  ;;
end

module Text = struct
  type t =
    { resource : Id.Resource.t
    ; version : int
    ; digest : string
    ; size_bytes : int
    ; text : string
    }

  let codec =
    let fields =
      Fields.both
        (Fields.both
           (Fields.both
              (Fields.required "resource_id" resource_codec)
              (Fields.required "version" version_codec))
           (Fields.required "digest" digest_codec))
        (Fields.both
           (Fields.required "size_bytes" (Api_codec.decimal ~max:65_536))
           (Fields.required "text" (Api_codec.text ~max_bytes:65_536)))
    in
    Api_codec.map
      (Api_codec.object_ fields)
      ~decode:(fun (((resource, version), digest), (size_bytes, text)) ->
        if
          (not (Int.equal size_bytes (String.length text)))
          || not (String.equal digest (Json.hash text))
        then Error (Problem.create Invalid_argument "resource text size/digest mismatch")
        else Ok { resource; version; digest; size_bytes; text })
      ~encode:(fun t -> ((t.resource, t.version), t.digest), (t.size_bytes, t.text))
      ~description:
        "Complete UTF-8 content up to 65536 bytes (64KiB), exact immutable content \
         version and verified digest. Larger text uses resource.read_text; binary uses \
         resource.read_chunk or CLI resource download."
  ;;

  let create request ~(version : Resource.Version.t) ~text =
    Json.decode (fun () ->
      require_selected_version request version;
      let size_bytes = String.length text in
      Option.iter version.size_bytes ~f:(fun expected ->
        if not (Int.equal expected size_bytes)
        then Json.fail Corrupt_store "blob size differs from resource version");
      if not (String.equal version.digest (Json.hash text))
      then Json.fail Corrupt_store "blob digest differs from resource version";
      let t =
        { resource = Request.resource request
        ; version = version.revision
        ; digest = version.digest
        ; size_bytes
        ; text
        }
      in
      Api_codec.encode codec t |> unwrap |> Api_codec.decode codec |> unwrap)
  ;;
end

let range_fields payload =
  let identity =
    Fields.both
      (Fields.both
         (Fields.required "resource_id" resource_codec)
         (Fields.required "version" version_codec))
      (Fields.required "digest" digest_codec)
  in
  let content =
    Fields.both
      (Fields.both
         (Fields.required "size_bytes" (Api_codec.decimal ~max:Resource.max_blob_bytes))
         (Fields.required "offset" decimal))
      payload
  in
  let position =
    Fields.both
      (Fields.both
         (Fields.required "chunk_digest" digest_codec)
         (Fields.required "next_offset" (Api_codec.nullable decimal)))
      (Fields.required "eof" Api_codec.boolean)
  in
  Fields.both (Fields.both identity content) position
;;

module Chunk = struct
  type t =
    { resource : Id.Resource.t
    ; version : int
    ; digest : string
    ; size_bytes : int
    ; offset : int
    ; bytes : string
    ; next_offset : int option
    }

  let validate t =
    Json.decode (fun () ->
      if
        t.offset > t.size_bytes
        || String.length t.bytes > Int.min 262_144 (t.size_bytes - t.offset)
      then Json.fail Invalid_argument "resource chunk range outside content";
      let next = t.offset + String.length t.bytes in
      if
        not
          (Option.equal
             Int.equal
             t.next_offset
             (if next = t.size_bytes then None else Some next))
      then Json.fail Invalid_argument "resource chunk next offset mismatch";
      if String.is_empty t.bytes && t.offset < t.size_bytes
      then Json.fail Invalid_argument "resource chunk did not advance";
      if
        t.offset = 0
        && Int.equal (String.length t.bytes) t.size_bytes
        && not (String.equal t.digest (Json.hash t.bytes))
      then Json.fail Invalid_argument "complete resource chunk digest mismatch";
      t)
  ;;

  let codec =
    Api_codec.map
      (Api_codec.object_
         (range_fields
            (Fields.required "data_base64" (Api_codec.text ~max_bytes:349_528))))
      ~decode:
        (fun
          ( (((resource, version), digest), ((size_bytes, offset), encoded))
          , ((chunk_digest, next_offset), eof) ) ->
        match Base64.decode encoded with
        | Error _ -> Error (Problem.create Invalid_argument "invalid resource base64")
        | Ok bytes ->
          if
            (not (String.equal encoded (Base64.encode_string bytes)))
            || (not (String.equal chunk_digest (Json.hash bytes)))
            || not (Bool.equal eof (Option.is_none next_offset))
          then
            Error
              (Problem.create
                 Invalid_argument
                 "resource chunk encoding/hash/EOF mismatch")
          else
            validate { resource; version; digest; size_bytes; offset; bytes; next_offset })
      ~encode:(fun t ->
        ( ( ((t.resource, t.version), t.digest)
          , ((t.size_bytes, t.offset), Base64.encode_string t.bytes) )
        , ((Json.hash t.bytes, t.next_offset), Option.is_none t.next_offset) ))
      ~description:
        "Verified binary range with canonical base64 and exact version/digest/byte \
         offsets."
  ;;

  let create request ~(version : Resource.Version.t) ~bytes ~total_bytes =
    Json.decode (fun () ->
      require_selected_version (Chunk_request.request request) version;
      Option.iter version.size_bytes ~f:(fun expected ->
        if not (Int.equal expected total_bytes)
        then Json.fail Corrupt_store "blob size differs from resource version");
      let offset = Chunk_request.byte_offset request in
      if total_bytes < 0 || total_bytes > Resource.max_blob_bytes || offset > total_bytes
      then Json.fail Corrupt_store "resource range outside declared content size";
      if
        String.length bytes
        <> Int.min (Chunk_request.max_bytes request) (total_bytes - offset)
      then Json.fail Corrupt_store "resource returned a short chunk";
      if
        offset = 0
        && Int.equal (String.length bytes) total_bytes
        && not (String.equal version.digest (Json.hash bytes))
      then Json.fail Corrupt_store "complete blob digest differs from resource version";
      let next = offset + String.length bytes in
      let t =
        { resource = Request.resource (Chunk_request.request request)
        ; version = version.revision
        ; digest = version.digest
        ; size_bytes = total_bytes
        ; offset
        ; bytes
        ; next_offset = (if next = total_bytes then None else Some next)
        }
      in
      validate t |> unwrap)
  ;;
end

module Text_range = struct
  type t = Chunk.t

  let codec =
    Api_codec.map
      (Api_codec.object_
         (range_fields (Fields.required "text" (Api_codec.text ~max_bytes:262_144))))
      ~decode:
        (fun
          ( (((resource, version), digest), ((size_bytes, offset), text))
          , ((chunk_digest, next_offset), eof) ) ->
        if
          (not (String.equal chunk_digest (Json.hash text)))
          || not (Bool.equal eof (Option.is_none next_offset))
        then
          Error (Problem.create Invalid_argument "resource text range hash/EOF mismatch")
        else
          Chunk.validate
            { resource; version; digest; size_bytes; offset; bytes = text; next_offset })
      ~encode:(fun (t : t) ->
        ( (((t.resource, t.version), t.digest), ((t.size_bytes, t.offset), t.bytes))
        , ((Json.hash t.bytes, t.next_offset), Option.is_none t.next_offset) ))
      ~description:
        "Valid UTF-8 text range up to 262144 bytes, exact immutable version/digest, \
         chunk digest and byte offsets. No replacement characters."
  ;;

  (* Uutf validates complete scalars. A final malformed span may be retained only
     when its bytes can still become exactly one valid scalar after more input. *)
  let incomplete_scalar_prefix suffix =
    let length = String.length suffix in
    if length = 0 || length > 3
    then false
    else (
      let byte index = Char.to_int suffix.[index] in
      let first = byte 0 in
      let width =
        if first >= 0xc2 && first <= 0xdf
        then 2
        else if first >= 0xe0 && first <= 0xef
        then 3
        else if first >= 0xf0 && first <= 0xf4
        then 4
        else 0
      in
      length < width
      && String.for_alli suffix ~f:(fun index char ->
        if index = 0
        then true
        else (
          let value = Char.to_int char in
          value >= 0x80
          && value <= 0xbf
          && (index <> 1
              || ((first <> 0xe0 || value >= 0xa0)
                  && (first <> 0xed || value <= 0x9f)
                  && (first <> 0xf0 || value >= 0x90)
                  && (first <> 0xf4 || value <= 0x8f))))))
  ;;

  let create request ~version ~bytes ~total_bytes =
    Json.decode (fun () ->
      let range = Chunk.create request ~version ~bytes ~total_bytes |> unwrap in
      let malformed =
        Uutf.String.fold_utf_8
          (fun first offset -> function
             | `Uchar _ -> first
             | `Malformed _ -> Option.first_some first (Some offset))
          None
          bytes
      in
      let length =
        match malformed with
        | None -> String.length bytes
        | Some boundary ->
          if
            Option.is_none range.next_offset
            || not (incomplete_scalar_prefix (String.drop_prefix bytes boundary))
          then
            Json.fail
              Invalid_argument
              "resource range is not UTF-8 or offset is not a scalar boundary; use \
               resource.read_chunk for binary";
          if boundary = 0
          then
            Json.fail
              Invalid_argument
              "resource text length is too small for the next UTF-8 scalar; use length \
               at least 4";
          boundary
      in
      let next = range.offset + length in
      let result =
        { range with
          bytes = String.prefix bytes length
        ; next_offset = (if next = total_bytes then None else Some next)
        }
      in
      Chunk.validate result |> unwrap)
  ;;
end

let text_method =
  Api_method.create
    ~name:"resource.read"
    ~summary:
      "Read complete UTF-8 content up to 65536 bytes (64KiB); use resource.read_text for \
       larger text ranges or resource.read_chunk/download for binary."
    ~mode:Read
    ~request:Request.codec
    ~response:Text.codec
;;

let chunk_method =
  Api_method.create
    ~name:"resource.read_chunk"
    ~summary:"Read a verified binary byte range by resource ID and immutable version."
    ~mode:Read
    ~request:Chunk_request.codec
    ~response:Chunk.codec
;;

let text_range_method =
  Api_method.create
    ~name:"resource.read_text"
    ~summary:
      "Read a bounded UTF-8 text range with byte-correct continuation and immutable \
       version/digest."
    ~mode:Read
    ~request:Chunk_request.codec
    ~response:Text_range.codec
;;
