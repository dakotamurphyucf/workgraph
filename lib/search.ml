open Core

module Source = struct
  type t =
    | Workspace of Id.Workspace.t
    | Project of Id.Project.t
    | Milestone of Id.Milestone.t
    | Ticket of Id.Ticket.t
    | Comment of Id.Comment.t
    | Handoff of Id.Ticket.t
    | Resource of Id.Resource.t
    | Resource_text of Id.Resource.t
    | Fact of
        { scope : Entity_ref.t
        ; key : string
        }
  [@@deriving sexp, compare]

  let kind = function
    | Workspace _ -> "workspace"
    | Project _ -> "project"
    | Milestone _ -> "milestone"
    | Ticket _ -> "ticket"
    | Comment _ -> "comment"
    | Handoff _ -> "handoff"
    | Resource _ -> "resource"
    | Resource_text _ -> "resource_text"
    | Fact _ -> "fact"
  ;;

  let json t ~revision =
    let id =
      match t with
      | Workspace id -> Id.Workspace.to_string id
      | Project id -> Id.Project.to_string id
      | Milestone id -> Id.Milestone.to_string id
      | Ticket id | Handoff id -> Id.Ticket.to_string id
      | Comment id -> Id.Comment.to_string id
      | Resource id | Resource_text id -> Id.Resource.to_string id
      | Fact { scope; key } -> Json.canonical (Entity_ref.jsonaf_of_t scope) ^ ":" ^ key
    in
    match t with
    | Fact { scope; key } ->
      Json.obj
        [ "kind", Json.string "fact"
        ; "scope", Entity_ref.jsonaf_of_t scope
        ; "key", Json.string key
        ; "revision", Json.int revision
        ]
    | Workspace _
    | Project _
    | Milestone _
    | Ticket _
    | Comment _
    | Handoff _
    | Resource _
    | Resource_text _ ->
      Json.obj
        [ "kind", Json.string (kind t)
        ; "id", Json.string id
        ; "revision", Json.int revision
        ]
  ;;
end

module Document = struct
  type t =
    { source : Source.t
    ; target : Entity_ref.t
    ; revision : int
    ; fields : (string * string) list
    }
end

module Text = struct
  type outcome =
    | Content of
        { text : string
        ; total_bytes : int
        }
    | Invalid_utf8

  type t =
    { id : Id.Resource.t
    ; version : int
    ; digest : string
    ; outcome : outcome
    }
end

let kinds =
  [ "workspace"
  ; "project"
  ; "milestone"
  ; "ticket"
  ; "comment"
  ; "handoff"
  ; "resource"
  ; "resource_text"
  ; "fact"
  ]
;;

type results =
  { items : Jsonaf.t list
  ; total : int
  }

module Match = struct
  type t =
    { field : string
    ; match_offset : int
    ; match_bytes : int
    ; snippet_offset : int
    ; snippet : string
    }
end

module Item = struct
  type t =
    { source : Source.t
    ; target : Entity_ref.t
    ; revision : int
    ; matches : Match.t list
    }
end

module Results = struct
  type t =
    { items : Item.t list
    ; total : int
    }
end

let typed_matches documents ~text ~kinds ~offset ~limit : Results.t =
  let needle = String.lowercase text in
  if String.is_empty (String.strip text) || String.length text > 256
  then Json.fail Invalid_argument "search text requires 1..256 bytes";
  if offset < 0 || limit < 1 || limit > 100
  then Json.fail Invalid_argument "invalid search page";
  let items, total =
    List.sort documents ~compare:(fun a b -> Source.compare a.Document.source b.source)
    |> List.fold ~init:([], 0) ~f:(fun (items, total) document ->
      if
        not
          (Option.for_all kinds ~f:(fun kinds ->
             List.mem kinds (Source.kind document.Document.source) ~equal:String.equal))
      then items, total
      else (
        let matches =
          List.filter_map document.fields ~f:(fun (field, text) ->
            Option.map
              (String.substr_index (String.lowercase text) ~pattern:needle)
              ~f:(fun position -> field, text, position))
        in
        if List.is_empty matches
        then items, total
        else if total < offset || total - offset >= limit
        then items, total + 1
        else (
          let matches =
            List.map matches ~f:(fun (field, text, position) ->
              let start =
                String.length
                  (Query_budget.prefix text ~max_bytes:(Int.max 0 (position - 80)))
              in
              let snippet =
                Query_budget.prefix (String.drop_prefix text start) ~max_bytes:512
              in
              { Match.field
              ; match_offset = position
              ; match_bytes = String.length needle
              ; snippet_offset = start
              ; snippet
              })
          in
          let result : Item.t =
            { source = document.source
            ; target = document.target
            ; revision = document.revision
            ; matches
            }
          in
          result :: items, total + 1)))
  in
  { items = List.rev items; total }
;;

let matches documents ~text ~kinds ~offset ~limit : results =
  let results = typed_matches documents ~text ~kinds ~offset ~limit in
  let items =
    List.map results.items ~f:(fun item ->
      let matches =
        List.map item.Item.matches ~f:(fun value ->
          Json.obj
            [ "field", Json.string value.Match.field
            ; "match_offset", Json.int value.match_offset
            ; "match_bytes", Json.int value.match_bytes
            ; "snippet_offset", Json.int value.snippet_offset
            ; "snippet", Json.string value.snippet
            ])
      in
      Json.obj
        [ "source", Source.json item.source ~revision:item.revision
        ; "target", Entity_ref.jsonaf_of_t item.target
        ; "matches", `Array matches
        ])
  in
  { items; total = results.total }
;;
