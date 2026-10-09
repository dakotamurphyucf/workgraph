open Core
module Query_scope = Api_metadata.Query_scope

module Layout = struct
  type t =
    | Value
    | Planning_read
    | Planning_write
    | Registry_write
    | Snapshot_read
    | Domain_query of Query_scope.t
    | Domain_record of Query_scope.t
    | Workspace_view
    | Feed
    | History
  [@@deriving sexp, equal]
end

type t =
  { data : Jsonaf.t
  ; meta : Jsonaf.t
  }

exception Invalid_result of Problem.t

let data t = t.data
let meta t = t.meta
let to_json t = Json.obj [ "data", t.data; "meta", t.meta ]

let require_durable t =
  match Json.optional t.meta "durable" with
  | Some `True -> Ok ()
  | _ ->
    Error (Problem.create Outcome_unknown "response does not confirm durable publication")
;;

let codec data =
  Api_codec.Fields.both
    (Api_codec.Fields.required "data" data)
    (Api_codec.Fields.required "meta" Api_metadata.codec)
  |> Api_codec.object_
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields json ~allowed:[ "data"; "meta" ];
    let data = Json.field json "data" in
    let meta = Json.field json "meta" in
    (match Api_metadata.of_json meta with
     | Ok _ -> ()
     | Error problem -> raise (Json.Decode_error problem));
    { data; meta })
;;

let project_exn layout json =
  let optional_field name =
    match json with
    | `Object _ -> Json.optional json name
    | `Null | `True | `False | `String _ | `Number _ | `Array _ -> None
  in
  let field name = Json.field json name in
  let without names =
    match json with
    | `Object fields ->
      Json.obj
        (List.filter fields ~f:(fun (key, _) ->
           not (List.mem names key ~equal:String.equal)))
    | _ -> Json.fail Invalid_argument "internal response must be an object"
  in
  let optional name =
    Option.to_list (Option.map (optional_field name) ~f:(fun value -> name, value))
  in
  let budget =
    match layout with
    | Layout.Value
    | Planning_write
    | Registry_write
    | Domain_record _
    | Workspace_view
    | History -> []
    | Planning_read | Snapshot_read | Domain_query _ | Feed ->
      Option.to_list
        (Option.map (optional_field "budget") ~f:(fun budget ->
           let rebase path =
             match layout with
             | Layout.Planning_read | Snapshot_read -> path
             | Domain_query _ when Option.is_some (Json.optional json "record") ->
               (match String.chop_prefix path ~prefix:"/record" with
                | Some suffix -> "/data" ^ suffix
                | None -> path)
             | Domain_query _ | Feed -> "/data" ^ path
             | Value
             | Planning_write
             | Registry_write
             | Domain_record _
             | Workspace_view
             | History -> path
           in
           let details =
             Json.list (Json.field budget "details")
             |> List.map ~f:(fun detail ->
               match detail with
               | `Object fields ->
                 Json.obj
                   (List.map fields ~f:(fun (key, value) ->
                      ( key
                      , if String.equal key "path"
                        then Json.string (rebase (Json.text value))
                        else value )))
               | _ -> Json.fail Invalid_argument "invalid budget detail")
           in
           match budget with
           | `Object fields ->
             ( "budget"
             , Json.obj
                 (List.Assoc.add fields ~equal:String.equal "details" (`Array details)) )
           | _ -> Json.fail Invalid_argument "invalid budget"))
  in
  let data, meta =
    match layout with
    | Layout.Value -> json, []
    | Planning_read ->
      field "data", ("workspace_revision", field "workspace_revision") :: budget
    | Planning_write ->
      ( field "result"
      , [ "workspace_revision", field "workspace_revision"; "durable", field "durable" ] )
    | Registry_write -> json, [ "durable", `True ]
    | Snapshot_read -> field "data", ("snapshot", field "snapshot") :: budget
    | Domain_query scope ->
      let data =
        match Json.optional json "record" with
        | Some record -> record
        | None -> without [ "revision"; "budget" ]
      in
      ( data
      , ("query_scope", Json.string (Query_scope.name scope))
        :: ("query_revision", field "revision")
        :: budget )
    | Domain_record scope -> json, [ "query_scope", Json.string (Query_scope.name scope) ]
    | Workspace_view -> without [ "revision" ], [ "workspace_revision", field "revision" ]
    | Feed ->
      let position =
        match Json.text (field "source") with
        | "planning" -> "workspace_revision"
        | "history" -> "history_sequence"
        | _ -> Json.fail Invalid_argument "unknown feed source"
      in
      ( without [ "workspace_revision"; "budget" ]
      , (position, field "workspace_revision") :: budget )
    | History ->
      ( without [ "capture"; "durable" ]
      , optional "durable"
        @ Option.to_list
            (Option.map (Json.optional json "capture") ~f:(fun capture ->
               "history_capture", capture)) )
  in
  { data; meta = Json.obj meta }
;;

let project layout json =
  match Json.decode (fun () -> project_exn layout json) with
  | Ok result -> result
  | Error problem -> raise (Invalid_result problem)
;;

let encoded_size layout json =
  String.length (Json.canonical (to_json (project layout json)))
;;
