open Core
open Workgraph

module Invocation = struct
  type t =
    { connection_id : Connection_profile.Id.t
    ; generation : Connection_profile.Generation.t
    ; method_ : string
    ; params : Jsonaf.t
    ; lane : Read_scheduler.Lane.t
    }

  let decode value =
    let params = Json.field value "params" in
    (match params with
     | `Object _ -> ()
     | _ -> Json.fail Invalid_argument "params must be an explicit object");
    let method_ = Json.field value "method" |> Json.bounded_text ~max_bytes:128 in
    if String.is_empty method_ then Json.fail Invalid_argument "method must be nonblank";
    { connection_id =
        Json.field value "connection_id"
        |> Json.text
        |> Connection_profile.Id.of_string
        |> Disk.unwrap
    ; generation =
        Json.field value "generation" |> Connection_profile.Generation.t_of_jsonaf
    ; method_
    ; params
    ; lane =
        Option.value_map
          (Json.optional value "lane")
          ~default:Read_scheduler.Lane.Visible
          ~f:(fun lane -> Json.text lane |> Read_scheduler.Lane.of_string |> Disk.unwrap)
    }
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:[ "connection_id"; "generation"; "method"; "params"; "lane" ];
      decode value)
  ;;
end

module Preparation = struct
  type t =
    { intention_id : string
    ; context : Operation.Context.t
    ; invocation : Invocation.t
    }

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:
          [ "intention_id"; "connection_id"; "generation"; "context"; "method"; "params" ];
      let intention_id = Json.field value "intention_id" |> Json.text in
      ignore (Id.Resource.of_string intention_id |> Disk.unwrap : Id.Resource.t);
      { intention_id
      ; context = Operation.Context.of_json (Json.field value "context") |> Disk.unwrap
      ; invocation = Invocation.decode value
      })
  ;;
end

let success value = Json.obj [ "ok", `True; "data", value ]
let failure problem = Json.obj [ "ok", `False; "error", Problem.to_json problem ]

let catalog () =
  let discovery = Discovery.catalog () in
  let entries = Json.field discovery "entries" |> Json.list in
  let kind wanted =
    `Array
      (List.filter entries ~f:(fun entry ->
         String.equal (Json.field entry "kind" |> Json.text) wanted))
  in
  let methods =
    List.map Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
      Json.obj
        [ "name", Json.string (Api_method.name method_)
        ; ( "mode"
          , Json.string
              (match Api_method.mode method_ with
               | Read -> "read"
               | Write -> "write"
               | Mutation -> "mutation") )
        ; ( "tier"
          , Json.string
              (match Api_method.tier method_ with
               | Core -> "core"
               | Advanced -> "advanced") )
        ; "summary", Json.string (Api_method.summary method_)
        ])
  in
  Json.obj
    [ "methods", `Array methods
    ; "helpers", kind "helper"
    ; "workflows", kind "workflow"
    ; "capabilities", Json.field discovery "capabilities"
    ]
;;

let method_contract name =
  Json.decode (fun () ->
    let (Api_method.Packed.Pack method_) =
      match Api_catalog.find name with
      | Some method_ -> method_
      | None -> Json.fail Not_found "method is absent from this executable catalog"
    in
    Json.obj
      [ "method", Api_method.describe method_
      ; "help", Json.string (Cli_reference.help ~method_name:(Some name) () |> Disk.unwrap)
      ; "fields", Cli_reference.field_descriptors ~method_name:name |> Disk.unwrap
      ])
;;
