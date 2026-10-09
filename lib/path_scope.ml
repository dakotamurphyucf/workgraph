open Core
module Worktree_id = Coordination_id.Worktree

module Kind = struct
  type t =
    | File
    | Subtree
  [@@deriving sexp, compare, equal]
end

module T = struct
  type t =
    { worktree_id : Worktree_id.t
    ; kind : Kind.t
    ; path : string
    }
  [@@deriving sexp, compare, equal]
end

include T
include Comparable.Make (T)

let create ~worktree_id ~kind ~path =
  Json.decode (fun () ->
    (match Api_codec.decode (Api_codec.text ~max_bytes:4096) (Json.string path) with
     | Ok _ -> ()
     | Error e -> raise (Json.Decode_error e));
    if String.is_empty path
    then Json.fail Invalid_argument "path must be nonempty UTF8 and at most 4096 bytes";
    if
      String.is_prefix path ~prefix:"/"
      || String.exists path ~f:(fun c ->
        Int.(Char.to_int c < 32 || Char.to_int c = 127)
        || List.mem [ '\\'; '*'; '?'; '['; ']' ] c ~equal:Char.equal)
    then
      Json.fail
        Invalid_argument
        "path must be relative without escapes or glob metacharacters";
    let components = String.split path ~on:'/' in
    if List.mem components ".." ~equal:String.equal
    then Json.fail Invalid_argument "parent path components are forbidden";
    let components =
      List.filter components ~f:(fun s -> not (String.is_empty s || String.equal s "."))
    in
    let path = String.concat components ~sep:"/" in
    if String.is_empty path && Kind.equal kind File
    then Json.fail Invalid_argument "exact-file path cannot be worktree root";
    { worktree_id; kind; path = (if String.is_empty path then "." else path) })
;;

let worktree_id t = t.worktree_id
let kind t = t.kind
let path t = t.path

let ancestor a b =
  String.equal a "." || String.equal a b || String.is_prefix b ~prefix:(a ^ "/")
;;

let covers a b =
  Worktree_id.equal a.worktree_id b.worktree_id
  &&
  match a.kind with
  | Kind.File -> Kind.equal b.kind File && String.equal a.path b.path
  | Subtree -> ancestor a.path b.path
;;

let overlaps a b = covers a b || covers b a

module Fields = Api_codec.Fields

let worktree_codec =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:Worktree_id.of_string
    ~encode:Worktree_id.to_string
    ~description:"Explicit logical worktree identity."
;;

let codec =
  Api_codec.map
    (Api_codec.object_
       (Fields.both
          (Fields.required "worktree_id" worktree_codec)
          (Fields.both
             (Fields.required
                "kind"
                (Api_codec.enum
                   [ "file", Kind.File; "subtree", Subtree ]
                   ~equal:Kind.equal))
             (Fields.required "path" (Api_codec.text ~max_bytes:4096)))))
    ~decode:(fun (worktree_id, (kind, path)) -> create ~worktree_id ~kind ~path)
    ~encode:(fun t -> t.worktree_id, (t.kind, t.path))
    ~description:
      "Normalized lexical file or subtree in an explicit worktree; no physical \
       filesystem enforcement."
;;

let t_of_sexp sexp =
  let wire = T.t_of_sexp sexp in
  match create ~worktree_id:wire.worktree_id ~kind:wire.kind ~path:wire.path with
  | Ok t when String.equal t.path wire.path -> t
  | Ok _ -> Sexplib.Conv.of_sexp_error "Noncanonical path scope" sexp
  | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
;;

let jsonaf_of_t t =
  match Api_codec.encode codec t with
  | Ok json -> json
  | Error e -> raise (Json.Decode_error e)
;;

let t_of_jsonaf json =
  let t =
    match Api_codec.decode codec json with
    | Ok t -> t
    | Error e -> raise (Json.Decode_error e)
  in
  if not (String.equal (Json.text (Json.field json "path")) t.path)
  then Json.fail Invalid_argument "Persisted path scope must be canonical";
  t
;;
