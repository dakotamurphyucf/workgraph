open Core
module F = Api_codec.Fields

let ( ++ ) = F.both

let unwrap = function
  | Ok value -> value
  | Error p -> raise (Json.Decode_error p)
;;

module Stop = struct
  type t =
    | Complete
    | Page_limit
    | Byte_limit
    | No_progress
    | Needs_larger_budget
    | Indexing_incomplete
    | Server_field_omissions
    | Server_item_omissions
    | Error
    | Metadata_limit
  [@@deriving equal, sexp]

  let names =
    [ "complete", Complete
    ; "page_limit", Page_limit
    ; "byte_limit", Byte_limit
    ; "no_progress", No_progress
    ; "needs_larger_budget", Needs_larger_budget
    ; "indexing_incomplete", Indexing_incomplete
    ; "server_field_omissions", Server_field_omissions
    ; "server_item_omissions", Server_item_omissions
    ; "error", Error
    ; "metadata_limit", Metadata_limit
    ]
  ;;

  let to_string t =
    List.find_map_exn names ~f:(fun (name, value) ->
      if equal t value then Some name else None)
  ;;

  let codec = Api_codec.enum names ~equal
end

let maximum = 65536
let count = Api_codec.decimal ~max:Int.max_value
let bounded_text maximum = Api_codec.text ~max_bytes:maximum

let nonblank maximum =
  Api_codec.map
    (bounded_text maximum)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "empty pagination request field")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonempty exact request field."
;;

let checked codec validate =
  Api_codec.map
    codec
    ~decode:(fun value ->
      Json.decode (fun () ->
        validate value;
        value))
    ~encode:Fn.id
    ~description:
      "Validated bounded client-added continuation metadata; daemon payload budget \
       remains separate."
;;

let request_codec =
  Api_codec.object_
    (F.map
       (F.required "jsonrpc" (Api_codec.literal "2.0")
        ++ F.required
             "workgraph_api"
             (Api_codec.literal (Current_format.value Application_api |> Json.text))
        ++ F.required "id" (nonblank 256)
        ++ F.required "method" (nonblank 128)
        ++ F.required
             "params"
             (checked
                (Api_codec.json ~max_bytes:(4 * 1024 * 1024) ~max_depth:64)
                (function
                  | `Object _ -> ()
                  | _ -> Json.fail Invalid_argument "continuation params require object"))
       )
       ~decode:(fun (((((), ()), id), method_), params) ->
         Json.obj
           [ "jsonrpc", Json.string "2.0"
           ; "workgraph_api", Current_format.value Application_api
           ; "id", Json.string id
           ; "method", Json.string method_
           ; "params", params
           ])
       ~encode:(fun value ->
         ( ( (((), ()), Json.text (Json.field value "id"))
           , Json.text (Json.field value "method") )
         , Json.field value "params" )))
;;

let consistency =
  Api_codec.enum
    (List.map
       [ "snapshot_guard"
       ; "current_revision_guard"
       ; "opaque_captured_cursor"
       ; "current_revision_cursor"
       ; "notification_through"
       ; "immutable_history_head"
       ]
       ~f:(fun value -> value, value))
    ~equal:String.equal
;;

let validate_capture kind capture =
  let counter name = ignore (Json.integer (Json.field capture name) : int) in
  let digest value =
    let text = Json.text value in
    if
      String.length text <> 64
      || not
           (String.for_all text ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid continuation capture digest"
  in
  match kind with
  | "snapshot_guard" ->
    Json.fields capture ~allowed:[ "snapshot" ];
    digest (Json.field capture "snapshot")
  | "current_revision_guard" ->
    if Option.is_some (Json.optional capture "workspace_revision")
    then (
      Json.fields capture ~allowed:[ "workspace_revision" ];
      counter "workspace_revision")
    else (
      Json.fields capture ~allowed:[ "query_revision"; "query_scope" ];
      counter "query_revision";
      let scope = Json.text (Json.field capture "query_scope") in
      if
        not
          (List.mem
             [ "communication"; "runs"; "evidence"; "policy" ]
             scope
             ~equal:String.equal)
      then Json.fail Invalid_argument "invalid continuation query scope")
  | "opaque_captured_cursor" ->
    if Option.is_some (Json.optional capture "captured_now_unix_ms")
    then (
      Json.fields capture ~allowed:[ "captured_now_unix_ms" ];
      counter "captured_now_unix_ms")
    else (
      Json.fields capture ~allowed:[ "through"; "lineage"; "source" ];
      counter "through";
      Option.iter (Json.optional capture "lineage") ~f:digest;
      Option.iter (Json.optional capture "source") ~f:(fun value ->
        if not (List.mem [ "planning"; "history" ] (Json.text value) ~equal:String.equal)
        then Json.fail Invalid_argument "invalid continuation feed source"))
  | "current_revision_cursor" ->
    Json.fields capture ~allowed:[ "workspace_revision"; "observed_unix_ms" ];
    counter "workspace_revision";
    Option.iter (Json.optional capture "observed_unix_ms") ~f:(fun value ->
      ignore (Json.integer value : int))
  | "notification_through" ->
    Json.fields capture ~allowed:[ "through" ];
    counter "through"
  | "immutable_history_head" ->
    Json.fields capture ~allowed:[ "head" ];
    (match Json.field capture "head" with
     | `Null -> ()
     | head -> digest head)
  | _ -> Json.fail Invalid_argument "unknown continuation consistency"
;;

type t =
  { complete : bool
  ; stop : Stop.t
  ; consistency : string
  ; capture : Jsonaf.t
  ; next_request : Jsonaf.t option
  ; retry_request : Jsonaf.t option
  ; required_bytes : int option
  ; returned_bytes : int
  }

let base =
  Api_codec.object_
    (F.map
       (F.required "complete" Api_codec.boolean
        ++ F.required "stop" Stop.codec
        ++ F.required "consistency" consistency
        ++ F.required "capture" (Api_codec.json ~max_bytes:4096 ~max_depth:4)
        ++ F.required "next_request" (Api_codec.nullable request_codec)
        ++ F.required "retry_request" (Api_codec.nullable request_codec)
        ++ F.required "required_bytes" (Api_codec.nullable count)
        ++ F.required "returned_bytes" count
        ++ F.required "max_bytes" (Api_codec.literal "65536"))
       ~decode:
         (fun
           ( ( ( ( ((((complete, stop), consistency), capture), next_request)
                 , retry_request )
               , required_bytes )
             , returned_bytes )
           , () ) ->
         { complete
         ; stop
         ; consistency
         ; capture
         ; next_request
         ; retry_request
         ; required_bytes
         ; returned_bytes
         })
       ~encode:(fun t ->
         ( ( ( ( ((((t.complete, t.stop), t.consistency), t.capture), t.next_request)
               , t.retry_request )
             , t.required_bytes )
           , t.returned_bytes )
         , () )))
;;

let codec =
  checked base (fun t ->
    validate_capture t.consistency t.capture;
    if not (Bool.equal t.complete (Stop.equal t.stop Complete))
    then Json.fail Invalid_argument "continuation completion differs from stop";
    if t.complete && (Option.is_some t.next_request || Option.is_some t.retry_request)
    then Json.fail Invalid_argument "complete continuation cannot carry requests";
    if Option.is_some t.next_request && Option.is_some t.retry_request
    then Json.fail Invalid_argument "continuation cannot advance and retry simultaneously";
    if not (Bool.equal (Stop.equal t.stop Page_limit) (Option.is_some t.next_request))
    then Json.fail Invalid_argument "next request differs from available-page stop";
    if Stop.equal t.stop Metadata_limit
    then (
      if
        Option.is_some t.next_request
        || Option.is_some t.retry_request
        || not (Option.exists t.required_bytes ~f:(fun n -> n > maximum))
      then
        Json.fail
          Invalid_argument
          "metadata limit marker requires an omitted exact continuation")
    else if Option.is_some t.required_bytes
    then Json.fail Invalid_argument "available continuation cannot declare omitted bytes";
    let bytes = Api_codec.encode base t |> unwrap |> Json.canonical |> String.length in
    if bytes <> t.returned_bytes || bytes > maximum
    then Json.fail Invalid_argument "continuation byte count or budget differs")
;;

let create ~complete ~stop ~consistency ~capture ~next_request ~retry_request =
  Json.decode (fun () ->
    let rec sized t =
      let bytes = Api_codec.encode base t |> unwrap |> Json.canonical |> String.length in
      if bytes = t.returned_bytes then t else sized { t with returned_bytes = bytes }
    in
    let t =
      sized
        { complete
        ; stop
        ; consistency
        ; capture
        ; next_request
        ; retry_request
        ; required_bytes = None
        ; returned_bytes = 0
        }
    in
    let t =
      if t.returned_bytes <= maximum
      then t
      else
        sized
          { t with
            complete = false
          ; stop = Metadata_limit
          ; next_request = None
          ; retry_request = None
          ; required_bytes = Some t.returned_bytes
          ; returned_bytes = 0
          }
    in
    ignore (Api_codec.encode codec t |> unwrap : Jsonaf.t);
    t)
;;

let complete t = t.complete
let stop t = t.stop
let next_request t = t.next_request
let retry_request t = t.retry_request
let to_json t = Api_codec.encode codec t |> unwrap
