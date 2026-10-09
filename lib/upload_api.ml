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

module Identity = struct
  type t =
    { workspace : Id.Workspace.t
    ; actor : Id.Actor.t
    ; upload : Id.Upload.t
    }

  let workspace t = t.workspace
  let actor t = t.actor
  let upload t = t.upload

  let codec =
    Api_codec.map
      (Api_codec.object_
         (Fields.required
            "workspace_id"
            (id Id.Workspace.of_string Id.Workspace.to_string)
          ++ Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required "upload_id" (id Id.Upload.of_string Id.Upload.to_string)))
      ~decode:(fun ((workspace, actor), upload) -> Ok { workspace; actor; upload })
      ~encode:(fun { workspace; actor; upload } -> (workspace, actor), upload)
      ~description:"Private ephemeral staging ownership; mutation_id/run_id reject."
  ;;
end

module Begin_request = struct
  type t =
    { identity : Identity.t
    ; size_bytes : int
    ; digest : string
    }

  let identity t = t.identity
  let size_bytes t = t.size_bytes
  let digest t = t.digest

  let codec =
    Api_codec.map
      (Api_codec.merge_objects
         Identity.codec
         (Api_codec.object_
            (Fields.required "size_bytes" (Api_codec.decimal ~max:Resource.max_blob_bytes)
             ++ Fields.required "digest" Resource_wire.digest)))
      ~decode:(fun (identity, (size_bytes, digest)) ->
        Ok { identity; size_bytes; digest })
      ~encode:(fun { identity; size_bytes; digest } -> identity, (size_bytes, digest))
      ~description:"Declare an immutable byte identity for live staging; at most 64MiB."
  ;;
end

module Chunk_request = struct
  type t =
    { identity : Identity.t
    ; offset : int
    ; bytes : string
    }

  let identity t = t.identity
  let offset t = t.offset
  let bytes t = t.bytes

  let bytes_codec =
    Api_codec.map
      (Api_codec.text ~max_bytes:((Upload.max_chunk_bytes + 2) / 3 * 4))
      ~decode:(fun encoded ->
        match Base64.decode encoded with
        | Error (`Msg _) ->
          Error (Problem.create Invalid_argument "invalid canonical base64")
        | Ok bytes ->
          if not (String.equal encoded (Base64.encode_string bytes))
          then Error (Problem.create Invalid_argument "invalid canonical base64")
          else if String.is_empty bytes || String.length bytes > Upload.max_chunk_bytes
          then
            Error
              (Problem.create Invalid_argument "upload chunk requires 1..262144 bytes")
          else Ok bytes)
      ~encode:Base64.encode_string
      ~description:"Canonical padded Base64 of 1..262144 opaque bytes."
  ;;

  let codec =
    Api_codec.map
      (Api_codec.merge_objects
         Identity.codec
         (Api_codec.object_
            (Fields.required "offset" (Api_codec.decimal ~max:Resource.max_blob_bytes)
             ++ Fields.required "data_base64" bytes_codec)))
      ~decode:(fun (identity, (offset, bytes)) ->
        if offset > Resource.max_blob_bytes - String.length bytes
        then
          Error (Problem.create Invalid_argument "upload chunk exceeds 64MiB byte range")
        else Ok { identity; offset; bytes })
      ~encode:(fun { identity; offset; bytes } -> identity, (offset, bytes))
      ~description:
        "Exact bounded range; the live owner validates contiguous progress and retries."
  ;;
end

module Status = struct
  type t =
    { upload : Id.Upload.t
    ; received : int
    ; size_bytes : int
    ; digest : string
    }

  let upload t = t.upload
  let received t = t.received
  let size_bytes t = t.size_bytes
  let digest t = t.digest

  let codec =
    Api_codec.map
      (Api_codec.object_
         (Fields.required "upload_id" (id Id.Upload.of_string Id.Upload.to_string)
          ++ Fields.required "received" (Api_codec.decimal ~max:Resource.max_blob_bytes)
          ++ Fields.required "size_bytes" (Api_codec.decimal ~max:Resource.max_blob_bytes)
          ++ Fields.required "digest" Resource_wire.digest))
      ~decode:(fun (((upload, received), size_bytes), digest) ->
        if received > size_bytes
        then
          Error
            (Problem.create Invalid_argument "staged received bytes exceed declared size")
        else Ok { upload; received; size_bytes; digest })
      ~encode:(fun { upload; received; size_bytes; digest } ->
        ((upload, received), size_bytes), digest)
      ~description:
        "Live staging observation, never a durable publication acknowledgement."
  ;;

  let of_result identity ~method_ result =
    match Api_codec.decode codec result with
    | Error problem -> raise (Api_method.Invalid_response (method_, problem))
    | Ok status ->
      if not (Id.Upload.equal status.upload (Identity.upload identity))
      then
        raise
          (Api_method.Invalid_response
             (method_, Problem.create Invalid_argument "upload response identity mismatch"));
      status
  ;;
end

module Aborted = struct
  type t = Confirmed

  let confirmed = Confirmed

  let codec =
    Api_codec.map
      (Api_codec.object_ (Fields.required "aborted" Api_codec.boolean))
      ~decode:(fun aborted ->
        if aborted
        then Ok Confirmed
        else
          Error
            (Problem.create Invalid_argument "abort response must confirm aborted:true"))
      ~encode:(fun Confirmed -> true)
      ~description:
        "Ephemeral staging removal completed; existing immutable blobs remain retained."
  ;;
end

let begin_method =
  Api_method.create
    ~name:"upload.begin"
    ~summary:"Begin or resume actor-owned ephemeral byte staging."
    ~mode:Write
    ~request:Begin_request.codec
    ~response:Status.codec
;;

let chunk_method =
  Api_method.create
    ~name:"upload.chunk"
    ~summary:"Stage a contiguous opaque byte chunk or exact range retry."
    ~mode:Write
    ~request:Chunk_request.codec
    ~response:Status.codec
;;

let status_method =
  Api_method.create
    ~name:"upload.status"
    ~summary:"Read private live staging progress."
    ~mode:Write
    ~request:Identity.codec
    ~response:Status.codec
;;

let abort_method =
  Api_method.create
    ~name:"upload.abort"
    ~summary:"Discard private staging and free upload admission."
    ~mode:Write
    ~request:Identity.codec
    ~response:Aborted.codec
;;

let methods =
  [ Api_method.Packed.Pack begin_method
  ; Pack chunk_method
  ; Pack status_method
  ; Pack abort_method
  ]
;;
