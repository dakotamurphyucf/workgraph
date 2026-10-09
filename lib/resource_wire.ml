open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity; aliases are not accepted."
;;

let resource_id = id Id.Resource.of_string Id.Resource.to_string
let actor_id = id Id.Actor.of_string Id.Actor.to_string
let decimal = Api_codec.decimal ~max:Int.max_value

let positive =
  Api_codec.map
    decimal
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else
        Error (Problem.create Invalid_argument "resource revision/count must be positive"))
    ~encode:Fn.id
    ~description:"Positive canonical decimal revision or count."
;;

let digest =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun value ->
      if
        String.length value = 64
        && String.for_all value ~f:(fun c ->
          Char.is_digit c || Char.(c >= 'a' && c <= 'f'))
      then Ok value
      else Error (Problem.create Invalid_argument "invalid SHA-256 digest"))
    ~encode:Fn.id
    ~description:"Exactly 64 lowercase hexadecimal SHA-256 characters."
;;

let scope =
  Api_codec.map
    Planning_target.codec
    ~decode:Planning_target.to_ref
    ~encode:Planning_target.of_ref
    ~description:"Resolved local resource target; aliases are not accepted."
;;

let targets =
  Api_codec.map
    (Api_codec.list scope ~max_items:100)
    ~decode:(fun targets ->
      if List.contains_dup targets ~compare:Entity_ref.compare
      then Error (Problem.create Invalid_argument "duplicate resource target")
      else Ok targets)
    ~encode:Fn.id
    ~description:"At most 100 distinct resolved tagged targets."
;;

let validate_file_metadata ~filename ~mime_type =
  Resource.validate_metadata
    { title = "Resource"
    ; filename
    ; mime_type
    ; description = ""
    ; archived = false
    ; targets = []
    }
;;

let version =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "revision" positive
        ++ Fields.required "digest" digest
        ++ Fields.required
             "size_bytes"
             (Api_codec.nullable (Api_codec.decimal ~max:Resource.max_blob_bytes))
        ++ Fields.required "actor_id" actor_id
        ++ Fields.required "timestamp" (Api_codec.text ~max_bytes:128)
        ++ Fields.required "filename" (Api_codec.text ~max_bytes:255)
        ++ Fields.required "mime_type" (Api_codec.text ~max_bytes:128)))
    ~decode:
      (fun
        ((((((revision, digest), size_bytes), actor), timestamp), filename), mime_type) ->
      Json.decode (fun () ->
        validate_file_metadata ~filename ~mime_type;
        { Resource.Version.revision
        ; digest
        ; size_bytes
        ; actor
        ; timestamp
        ; filename
        ; mime_type
        }))
    ~encode:
      (fun
        ({ revision; digest; size_bytes; actor; timestamp; filename; mime_type } :
          Resource.Version.t) ->
      (((((revision, digest), size_bytes), actor), timestamp), filename), mime_type)
    ~description:
      "Immutable content version, independent of resource metadata revision; filename \
       and MIME validated."
;;

module Metadata_view = struct
  type t =
    { title : string
    ; filename : string
    ; mime_type : string
    ; description : string
    ; archived : bool
    ; targets : Entity_ref.t list
    }

  let codec =
    Api_codec.map
      (Api_codec.object_
         (Fields.required "title" (Api_codec.text ~max_bytes:512)
          ++ Fields.required "filename" (Api_codec.text ~max_bytes:255)
          ++ Fields.required "mime_type" (Api_codec.text ~max_bytes:128)
          ++ Fields.required "description" (Api_codec.text ~max_bytes:65536)
          ++ Fields.required "archived" Api_codec.boolean
          ++ Fields.required "targets" targets))
      ~decode:(fun (((((title, filename), mime_type), description), archived), targets) ->
        Json.decode (fun () ->
          validate_file_metadata ~filename ~mime_type;
          { title; filename; mime_type; description; archived; targets }))
      ~encode:(fun { title; filename; mime_type; description; archived; targets } ->
        ((((title, filename), mime_type), description), archived), targets)
      ~description:
        "Public metadata view: prose and target arrays may be prefix-clipped with \
         explicit meta.budget omissions."
  ;;

  let of_domain
        ({ title; filename; mime_type; description; archived; targets } :
          Resource.Metadata.t)
    =
    { title; filename; mime_type; description; archived; targets }
  ;;
end

let metadata =
  Api_codec.map
    Metadata_view.codec
    ~decode:(fun (value : Metadata_view.t) ->
      Json.decode (fun () ->
        let metadata : Resource.Metadata.t =
          { title = value.title
          ; filename = value.filename
          ; mime_type = value.mime_type
          ; description = value.description
          ; archived = value.archived
          ; targets = value.targets
          }
        in
        Resource.validate_metadata metadata;
        metadata))
    ~encode:Metadata_view.of_domain
    ~description:
      "Complete immutable historical metadata, validated by actual Resource metadata \
       invariants."
;;

let summary_typed =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "resource_id" resource_id
        ++ Fields.required "revision" positive
        ++ Fields.required "metadata" Metadata_view.codec
        ++ Fields.required "current_version" version
        ++ Fields.required "version_count" positive))
    ~decode:(fun ((((id, revision), metadata), current_version), version_count) ->
      if
        revision < version_count
        || current_version.Resource.Version.revision <> version_count
      then
        Error
          (Problem.create
             Invalid_argument
             "inconsistent resource metadata/content revisions")
      else if
        List.mem
          metadata.Metadata_view.targets
          (Entity_ref.Resource id)
          ~equal:Entity_ref.equal
      then Error (Problem.create Invalid_argument "resource cannot attach to itself")
      else Ok (id, revision, metadata, current_version, version_count))
    ~encode:(fun (id, revision, metadata, current_version, version_count) ->
      (((id, revision), metadata), current_version), version_count)
    ~description:
      "Current resource summary; identity, version, digest and counts remain complete \
       under byte fitting."
;;

let summary = Api_codec.as_json summary_typed

let summary_json resource =
  Resource.validate resource;
  unwrap
    (Api_codec.encode
       summary_typed
       ( resource.Resource.id
       , resource.revision
       , Metadata_view.of_domain resource.metadata
       , Resource.get_version resource ~revision:None
       , List.length resource.versions ))
;;

let version_json value = unwrap (Api_codec.encode version value)

let publication =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "resource_id" resource_id
        ++ Fields.required "revision" positive
        ++ Fields.required "version" version))
    ~decode:(fun ((id, revision), version) ->
      if version.Resource.Version.revision > revision || Option.is_none version.size_bytes
      then
        Error
          (Problem.create
             Invalid_argument
             "publication requires bounded size and consistent revisions")
      else Ok (id, revision, version))
    ~encode:(fun (id, revision, version) -> (id, revision), version)
    ~description:
      "A published content version with complete byte identity; durability lives in meta."
  |> Api_codec.as_json
;;
