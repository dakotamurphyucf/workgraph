open Core

type t =
  | Application_api
  | Registry
  | Workspace
  | Planning_transaction
  | Planning_events
  | Workspace_export
  | Registry_export
  | Planning_head
  | History_head
  | History_batch
  | Upload_plan
  | Heartbeat_cache
[@@deriving sexp, equal]

let identifier = function
  | Application_api -> "0.4"
  | Planning_head | History_head | History_batch | Upload_plan | Heartbeat_cache -> "1"
  | Registry
  | Workspace
  | Planning_transaction
  | Planning_events
  | Workspace_export
  | Registry_export -> "3"
;;

let field = function
  | Application_api -> "workgraph_api"
  | Upload_plan -> "transfer_version"
  | Planning_head | History_head | History_batch | Heartbeat_cache -> "version"
  | Registry
  | Workspace
  | Planning_transaction
  | Planning_events
  | Workspace_export
  | Registry_export -> "version"
;;

let name = function
  | Application_api -> "application API"
  | Registry -> "registry"
  | Workspace -> "workspace descriptor"
  | Planning_transaction -> "planning transaction"
  | Planning_events -> "planning events"
  | Workspace_export -> "workspace export"
  | Registry_export -> "workspace-set export"
  | Planning_head -> "planning head"
  | History_head -> "history head"
  | History_batch -> "history batch"
  | Upload_plan -> "upload plan"
  | Heartbeat_cache -> "heartbeat cache"
;;

let value t = Json.string (identifier t)

let validate t json =
  Json.decode (fun () ->
    let key = field t in
    let observed =
      match json with
      | `Object fields ->
        (match
           List.filter_map fields ~f:(fun (name, value) ->
             if String.equal name key then Some value else None)
         with
         | [] -> None
         | [ value ] -> Some (Json.text value)
         | _ -> Json.fail Invalid_argument ("duplicate format field: " ^ key))
      | _ -> Json.fail Invalid_argument "format root must be an object"
    in
    if not (Option.equal String.equal observed (Some (identifier t)))
    then (
      (* Diagnostic text is bounded independently of an untrusted marker. *)
      let observed =
        Option.map observed ~f:(fun value ->
          if String.length value <= 256
          then value
          else Query_budget.prefix value ~max_bytes:256 ^ " (truncated)")
      in
      raise
        (Json.Decode_error
           (Problem.with_details
              (Problem.create
                 Unsupported_version
                 (name t
                  ^ " requires format "
                  ^ identifier t
                  ^ "; observed "
                  ^ Option.value observed ~default:"missing"))
              (Version { representation = name t; observed; supported = identifier t })))))
;;
