open Core

module Path_kind = struct
  type t =
    | File
    | Subtree
  [@@deriving sexp, equal]
end

module Mode = struct
  type t =
    | Exclusive
    | Shared
  [@@deriving sexp, equal]
end

module Target = struct
  type t =
    | Named of string
    | Path of
        { worktree_id : string
        ; kind : Path_kind.t
        ; path : string
        }
  [@@deriving sexp, equal]

  let to_json = function
    | Named name -> `Object [ "kind", `String "named"; "reservation_id", `String name ]
    | Path { worktree_id; kind; path } ->
      `Object
        [ "kind", `String "path"
        ; ( "target"
          , `Object
              [ "worktree_id", `String worktree_id
              ; ( "kind"
                , `String
                    (match kind with
                     | Path_kind.File -> "file"
                     | Subtree -> "subtree") )
              ; "path", `String path
              ] )
        ]
  ;;
end

module Owner = struct
  type t =
    { target : Target.t
    ; actor_id : string
    ; run_id : string
    ; mode : Mode.t
    }
  [@@deriving sexp, equal]

  let to_json t =
    `Object
      [ "target", Target.to_json t.target
      ; "actor_id", `String t.actor_id
      ; "run_id", `String t.run_id
      ; ( "mode"
        , `String
            (match t.mode with
             | Mode.Exclusive -> "exclusive"
             | Shared -> "shared") )
      ]
  ;;
end

type t =
  { requested : Target.t
  ; owners : Owner.t list
  ; omitted_owners : int
  }
[@@deriving sexp, equal]

let to_json t =
  `Object
    [ "type", `String "reservation_conflict"
    ; "requested", Target.to_json t.requested
    ; "owners", `Array (List.map t.owners ~f:Owner.to_json)
    ; "omitted_owners", `String (Int.to_string t.omitted_owners)
    ]
;;
