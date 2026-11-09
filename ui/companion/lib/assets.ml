open Core
open Workgraph

type asset =
  { path : string
  ; mime_type : string
  ; body : string
  ; digest : string
  }

let find path =
  Option.map (Workgraph_ui_assets.find path) ~f:(fun asset ->
    { path = asset.path
    ; mime_type = asset.content_type
    ; body = asset.body
    ; digest = asset.sha256
    })
;;

let manifest () = Json.parse Workgraph_ui_assets.manifest_json |> Disk.unwrap
