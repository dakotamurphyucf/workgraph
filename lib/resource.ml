open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Revision = struct
  type t = int [@@deriving sexp]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Version = struct
  type t =
    { revision : Revision.t
    ; digest : string
    ; size_bytes : Revision.t option
    ; actor : Id.Actor.t
    ; timestamp : string
    ; filename : string
    ; mime_type : string
    }
  [@@deriving sexp, jsonaf]
end

module Metadata = struct
  type t =
    { title : string
    ; filename : string
    ; mime_type : string
    ; description : string
    ; archived : bool
    ; targets : Entity_ref.t list
    }
  [@@deriving sexp, jsonaf]
end

type t =
  { id : Id.Resource.t
  ; revision : Revision.t
  ; metadata : Metadata.t
  ; versions : Version.t list
  }
[@@deriving sexp, jsonaf]

module Change = struct
  type t =
    | Published of
        { id : Id.Resource.t
        ; revision : Revision.t
        ; metadata : Metadata.t
        ; version : Version.t
        }
    | Metadata_changed of
        { id : Id.Resource.t
        ; revision : Revision.t
        ; metadata : Metadata.t
        }
  [@@deriving sexp, jsonaf]
end

let max_blob_bytes = 64 * 1024 * 1024
let require condition kind message = if not condition then Json.fail kind message

let validate_filename filename =
  require
    (String.length filename > 0
     && String.length filename <= 255
     && (not (List.mem [ "."; ".." ] filename ~equal:String.equal))
     && String.for_all filename ~f:(fun c ->
       not
         ((Char.to_int c < 32 || Char.to_int c = 127)
          || Char.equal c '/'
          || Char.equal c '\\')))
    Invalid_argument
    "filename must be a basename of 1..255 bytes"
;;

let validate_mime mime_type =
  require
    (String.length mime_type > 2
     && String.length mime_type <= 128
     && List.length (String.split mime_type ~on:'/') = 2
     && List.for_all (String.split mime_type ~on:'/') ~f:(fun part ->
       not (String.is_empty part))
     && String.for_all mime_type ~f:(fun c ->
       Char.is_alphanum c || String.mem "/!#$&^_.+-" c))
    Invalid_argument
    "invalid MIME type"
;;

let validate_metadata (m : Metadata.t) =
  require
    ((not (String.is_empty (String.strip m.title))) && String.length m.title <= 512)
    Invalid_argument
    "invalid resource title";
  require
    (String.length m.description <= 65_536)
    Invalid_argument
    "resource description exceeds 64KiB";
  validate_filename m.filename;
  validate_mime m.mime_type;
  require
    (List.length m.targets <= 100
     && List.length m.targets
        = List.length (List.dedup_and_sort m.targets ~compare:Entity_ref.compare))
    Invalid_argument
    "duplicate or excessive resource links"
;;

let validate_version (v : Version.t) =
  require
    (v.revision > 0 && String.length v.timestamp <= 128)
    Corrupt_store
    "invalid resource version";
  require
    (String.length v.digest = 64
     && String.for_all v.digest ~f:(fun c ->
       Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    Corrupt_store
    "invalid resource digest";
  Option.iter v.size_bytes ~f:(fun n ->
    require (n >= 0 && n <= max_blob_bytes) Invalid_argument "resource exceeds 64MiB");
  validate_filename v.filename;
  validate_mime v.mime_type
;;

let validate t =
  validate_metadata t.metadata;
  require
    (not (List.mem t.metadata.targets (Entity_ref.Resource t.id) ~equal:Entity_ref.equal))
    Invalid_argument
    "resource cannot attach to itself";
  require
    (t.revision > 0 && not (List.is_empty t.versions))
    Corrupt_store
    "resource without version";
  let count = List.length t.versions in
  require
    (t.revision >= count)
    Corrupt_store
    "resource revision precedes its published versions";
  List.iteri t.versions ~f:(fun index v ->
    validate_version v;
    require
      (Int.equal v.revision (count - index))
      Corrupt_store
      "nonconsecutive resource versions")
;;

let apply previous change =
  let id, revision, metadata =
    match change with
    | Change.Published { id; revision; metadata; _ }
    | Metadata_changed { id; revision; metadata } -> id, revision, metadata
  in
  let old_revision = Option.value_map previous ~default:0 ~f:(fun t -> t.revision) in
  require (revision = old_revision + 1) Conflict "resource revision conflict";
  Option.iter previous ~f:(fun t ->
    require (Id.Resource.equal id t.id) Corrupt_store "resource identity changed");
  let versions =
    match change with
    | Change.Published { version; _ } ->
      let previous = Option.value_map previous ~default:[] ~f:(fun t -> t.versions) in
      require
        (version.revision = List.length previous + 1)
        Conflict
        "resource version conflict";
      version :: previous
    | Metadata_changed _ ->
      (match previous with
       | Some t -> t.versions
       | None -> Json.fail Not_found "resource not found")
  in
  let t = { id; revision; metadata; versions } in
  validate t;
  t
;;

let get_version t ~revision =
  match revision with
  | None -> List.hd_exn t.versions
  | Some revision ->
    (match List.find t.versions ~f:(fun v -> Int.equal v.Version.revision revision) with
     | Some version -> version
     | None -> Json.fail Not_found "resource version not found")
;;
