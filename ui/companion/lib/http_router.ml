open Core
open Workgraph

type request =
  { method_ : string
  ; target : string
  ; headers : (string * string) list
  ; body : string
  }

type response =
  { status : int
  ; headers : (string * string) list
  ; body : string
  }

type t =
  { host : string
  ; origin : string
  ; capability : string
  ; profiles : Connection_profile.Store.t
  ; operations : Operation_store.t
  ; rpc : Rpc_bridge.t
  ; launcher : Daemon_launcher.t option
  ; admin_jobs : Admin_jobs.t option
  ; request_observer : Request_observer.t option
  ; execution_helper : Execution_helper.t option
  ; transfer_helper : Transfer_helper.t option
  ; wait_helper : Wait_helper.t option
  ; view_settings : View_settings.t option
  ; request_id : unit -> string
  }

exception Declared_body_limit

let security_headers =
  [ "x-content-type-options", "nosniff"
  ; "referrer-policy", "no-referrer"
  ; "cross-origin-resource-policy", "same-origin"
  ; ( "content-security-policy"
    , "default-src 'none'; script-src 'self'; style-src-elem 'self'; style-src-attr \
       'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; \
       worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; \
       form-action 'none'" )
  ]
;;

let json_response ?(status = 200) ?(max_bytes = Framing.max_bytes) value =
  let body = Json.canonical value in
  if String.length body > max_bytes
  then
    Json.fail
      Invalid_argument
      "response exceeds endpoint budget; use a smaller bounded read";
  { status
  ; headers =
      ("content-type", "application/json; charset=utf-8")
      :: ("cache-control", "no-store")
      :: security_headers
  ; body
  }
;;

let status problem =
  match problem.Problem.kind with
  | Not_found -> 404
  | Conflict | Already_claimed | Stale_claim | Idempotency_conflict | Blocked -> 409
  | Storage_unavailable | Local_io | Corrupt_store | Outcome_unknown | Workspace_closed ->
    503
  | Invalid_argument | Dependency_cycle | Unsupported_version -> 400
;;

let error_response ?code problem =
  json_response
    ~status:(Option.value code ~default:(status problem))
    (Wire.failure problem)
;;

let create ~host ~origin ~capability ~profiles ~operations ~rpc ~random =
  if
    String.length capability <> 64
    || not
         (String.for_all capability ~f:(fun c ->
            Char.is_digit c || Char.between c ~low:'a' ~high:'f'))
  then invalid_arg "capability must be 256-bit lowercase hex";
  if not (String.equal origin ("http://" ^ host))
  then invalid_arg "origin must match exact loopback authority";
  let request_id () =
    let bytes = Cstruct.create 32 in
    Eio.Flow.read_exact random bytes;
    "ui-read-" ^ Json.hash (Cstruct.to_string bytes)
  in
  { host
  ; origin
  ; capability
  ; profiles
  ; operations
  ; rpc
  ; launcher = None
  ; admin_jobs = None
  ; request_observer = None
  ; execution_helper = None
  ; transfer_helper = None
  ; wait_helper = None
  ; view_settings = None
  ; request_id
  }
;;

let with_view_settings t settings = { t with view_settings = Some settings }
let with_launcher t launcher = { t with launcher = Some launcher }
let with_admin_jobs t jobs = { t with admin_jobs = Some jobs }
let with_wait_helper t service = { t with wait_helper = Some service }
let with_request_observer t service = { t with request_observer = Some service }
let with_transfer_helper t service = { t with transfer_helper = Some service }
let with_execution_helper t service = { t with execution_helper = Some service }

let execution_helper t =
  match t.execution_helper with
  | Some service -> service
  | None -> Json.fail Not_found "local execution evidence service is unavailable"
;;

let transfer_helper t =
  match t.transfer_helper with
  | Some service -> service
  | None -> Json.fail Not_found "resource transfer service is unavailable"
;;

let wait_helper t =
  match t.wait_helper with
  | Some service -> service
  | None -> Json.fail Not_found "reservation wait service is unavailable"
;;

let admin_jobs t =
  match t.admin_jobs with
  | Some jobs -> jobs
  | None -> Json.fail Storage_unavailable "offline administration helper is unavailable"
;;

let launcher t =
  match t.launcher with
  | Some launcher -> launcher
  | None -> Json.fail Storage_unavailable "local daemon startup helper is unavailable"
;;

let header (request : request) name =
  match
    List.filter_map request.headers ~f:(fun (key, value) ->
      if String.Caseless.equal key name then Some value else None)
  with
  | [] -> None
  | [ value ] -> Some value
  | _ -> Json.fail Invalid_argument ("duplicate boundary header: " ^ name)
;;

let split_target target =
  if
    (not (String.is_prefix target ~prefix:"/"))
    || String.is_prefix target ~prefix:"//"
    || String.exists target ~f:(fun c ->
      Char.equal c '%' || Char.equal c '\\' || Char.equal c '#' || Char.to_int c < 32)
  then Json.fail Invalid_argument "request target must be an exact local path";
  let path, query =
    match String.lsplit2 target ~on:'?' with
    | None -> target, None
    | Some (path, query) -> path, Some query
  in
  let parts = String.split path ~on:'/' |> List.tl_exn in
  if
    List.exists parts ~f:(fun part -> String.equal part "." || String.equal part "..")
    || ((not (String.equal path "/")) && List.exists parts ~f:String.is_empty)
  then Json.fail Invalid_argument "request path contains an invalid segment";
  path, query
;;

let api path =
  String.equal path "/ui-api/v1" || String.is_prefix path ~prefix:"/ui-api/v1/"
;;

let write_method request =
  String.equal request.method_ "POST" || String.equal request.method_ "PUT"
;;

let authorize t (request : request) =
  match
    Json.decode (fun () ->
      if not (Option.equal String.equal (header request "host") (Some t.host))
      then Json.fail Invalid_argument "Host does not match this companion listener";
      (match header request "origin" with
       | None -> ()
       | Some origin ->
         if not (String.equal origin t.origin)
         then Json.fail Invalid_argument "Origin does not match this companion");
      (match header request "sec-fetch-site" with
       | None | Some "same-origin" | Some "none" -> ()
       | Some _ -> Json.fail Invalid_argument "cross-site browser request rejected");
      let path, _ = split_target request.target in
      let length = header request "content-length" in
      let transfer = header request "transfer-encoding" in
      if Option.is_some transfer
      then
        Json.fail
          Invalid_argument
          "browser transport requires fixed Content-Length; Transfer-Encoding is \
           unsupported";
      let length =
        Option.map length ~f:(fun value ->
          let count = Json.integer (Json.string value) in
          if count > Framing.max_bytes then raise Declared_body_limit;
          count)
      in
      if write_method request && Option.is_none length
      then Json.fail Invalid_argument "POST and PUT require exact Content-Length";
      if
        String.equal request.method_ "GET"
        && Option.exists length ~f:(fun length -> length <> 0)
      then Json.fail Invalid_argument "GET must have no request body";
      if api path
      then (
        if
          not
            (Option.equal
               String.equal
               (header request "x-workgraph-ui-capability")
               (Some t.capability))
        then Json.fail Invalid_argument "missing or incorrect launch capability";
        if write_method request
        then (
          if not (Option.equal String.equal (header request "origin") (Some t.origin))
          then
            Json.fail
              Invalid_argument
              "state-changing API requests require the exact Origin";
          let content_type =
            header request "content-type"
            |> Option.value ~default:""
            |> String.lowercase
            |> String.split ~on:';'
            |> List.map ~f:String.strip
          in
          if
            not
              (List.equal String.equal content_type [ "application/json" ]
               || List.equal
                    String.equal
                    content_type
                    [ "application/json"; "charset=utf-8" ])
          then
            Json.fail
              Invalid_argument
              "API body requires application/json with optional UTF-8 charset")))
  with
  | Ok () -> None
  | Error problem -> Some (error_response ~code:403 problem)
  | exception Declared_body_limit ->
    Some
      (error_response
         ~code:413
         (Problem.create Invalid_argument "declared API body exceeds 4MiB"))
;;

let body (request : request) =
  if String.length request.body > Framing.max_bytes
  then Json.fail Invalid_argument "API body exceeds 4MiB";
  Json.parse_with_limit ~max_bytes:Framing.max_bytes request.body |> Disk.unwrap
;;

let fields request allowed =
  let value = body request in
  Json.fields value ~allowed;
  value
;;

let generation value =
  Json.field value "generation" |> Connection_profile.Generation.t_of_jsonaf
;;

let profile t id generation =
  match Connection_profile.Store.find t.profiles ~id ~generation with
  | Some profile -> profile
  | None ->
    Json.fail
      Not_found
      "connection generation is absent; refresh profiles without retargeting saved \
       operations"
;;

let invocation_profile t (invocation : Wire.Invocation.t) =
  profile t invocation.connection_id invocation.generation
;;

let native_request t method_ params =
  Protocol.Request.create ~id:(t.request_id ()) ~method_ ~params |> Disk.unwrap
;;

let template_invocation request ~method_ =
  let value = fields request [ "connection_id"; "generation"; "params"; "lane" ] in
  match value with
  | `Object fields ->
    Wire.Invocation.of_json (Json.obj (("method", Json.string method_) :: fields))
    |> Disk.unwrap
  | _ -> assert false
;;

let template_fetch t (invocation : Wire.Invocation.t) =
  let connection = invocation_profile t invocation in
  fun request ->
    Rpc_bridge.read t.rpc ~connection ~lane:invocation.lane request
    |> Result.map ~f:(fun value -> Json.field value "response")
;;

let public_read t connection method_ =
  Rpc_bridge.read t.rpc ~connection ~lane:Visible (native_request t method_ (Json.obj []))
  |> Disk.unwrap
  |> fun value -> Json.field value "response"
;;

let operation_response operation =
  let status =
    match Operation.state operation with
    | Sending -> 202
    | Prepared_unsent | Committed _ | Observed _ | Rejected _ | Outcome_unknown _ -> 200
  in
  json_response
    ~status
    ~max_bytes:(16 * 1024 * 1024)
    (Wire.success (Operation.to_json operation))
;;

let query_page = function
  | None -> 0, 100
  | Some query ->
    let pairs =
      String.split query ~on:'&'
      |> List.map ~f:(fun pair ->
        match String.lsplit2 pair ~on:'=' with
        | Some (key, value) when String.equal key "offset" || String.equal key "limit" ->
          key, Json.string value
        | Some _ | None ->
          Json.fail
            Invalid_argument
            "operation list accepts only offset and limit query fields")
    in
    let value = Json.obj pairs in
    Json.fields value ~allowed:[ "offset"; "limit" ];
    let decimal name default =
      Option.value_map (Json.optional value name) ~default ~f:Json.integer
    in
    decimal "offset" 0, decimal "limit" 100
;;

let route t (request : request) =
  let path, query = split_target request.target in
  let parts = String.split path ~on:'/' |> List.tl_exn in
  let method_ = request.method_ in
  if not (api path)
  then (
    if not (String.equal method_ "GET")
    then Json.fail Invalid_argument "static assets accept GET only";
    if Option.is_some query || not (String.is_empty request.body)
    then Json.fail Invalid_argument "static asset target must be exact and body-free";
    let path = if String.equal path "/" then "/index.html" else path in
    let asset =
      Assets.find path
      |> Option.value_or_thunk ~default:(fun () ->
        Json.fail Not_found "asset is absent from embedded manifest")
    in
    let bootstrap = String.equal path "/index.html" in
    let body =
      if bootstrap
      then (
        let marker = Workgraph_ui_assets.capability_marker in
        if
          List.length
            (String.substr_index_all asset.body ~pattern:marker ~may_overlap:false)
          <> 1
        then invalid_arg "embedded bootstrap capability marker is not unique";
        String.substr_replace_all asset.body ~pattern:marker ~with_:t.capability)
      else asset.body
    in
    { status = 200
    ; body
    ; headers =
        ("content-type", asset.mime_type)
        :: ( "cache-control"
           , if String.is_prefix path ~prefix:"/assets/"
             then "public, max-age=31536000, immutable"
             else "no-store" )
        :: security_headers
    })
  else (
    if String.equal method_ "GET" && not (String.is_empty request.body)
    then Json.fail Invalid_argument "GET API requests must be body-free";
    if
      Option.is_some query
      && not
           ((String.equal path "/ui-api/v1/operations"
             || String.equal path "/ui-api/v1/daemon-launches"
             || String.equal path "/ui-api/v1/admin-jobs"
             || String.equal path "/ui-api/v1/reservation-waits"
             || String.equal path "/ui-api/v1/resource-stages"
             || String.equal path "/ui-api/v1/resource-uploads"
             || String.equal path "/ui-api/v1/execution-publications")
            && String.equal method_ "GET")
    then Json.fail Invalid_argument "query fields are not admitted on this route";
    match method_, parts with
    | "POST", [ "ui-api"; "v1"; "view-settings"; "list" ] ->
      ignore (fields request [] : Jsonaf.t);
      let service =
        match t.view_settings with
        | Some settings -> settings
        | None -> Json.fail Not_found "private view settings service is unavailable"
      in
      json_response (Wire.success (View_settings.list service |> Disk.unwrap))
    | "POST", [ "ui-api"; "v1"; "view-settings"; (("inspect" | "replace") as action) ] ->
      let allowed = [ "connection_id"; "generation"; "workspace_id" ] in
      let allowed =
        if String.equal action "inspect"
        then allowed
        else allowed @ [ "expected_revision"; "documents"; "selected_id" ]
      in
      let value = fields request allowed in
      let connection =
        profile
          t
          (Connection_profile.Id.of_string (Json.text (Json.field value "connection_id"))
           |> Disk.unwrap)
          (generation value)
      in
      let target =
        View_settings.Target.create
          ~connection
          ~workspace:(Id.Workspace.t_of_jsonaf (Json.field value "workspace_id"))
      in
      let service =
        match t.view_settings with
        | Some settings -> settings
        | None -> Json.fail Not_found "private view settings service is unavailable"
      in
      let result =
        if String.equal action "inspect"
        then View_settings.read service target
        else
          View_settings.replace
            service
            target
            ~expected_revision:(Json.integer (Json.field value "expected_revision"))
            ~documents:
              (Json.list (Json.field value "documents")
               |> List.map ~f:(fun document ->
                 View_settings.Document.of_json document |> Disk.unwrap))
            ~selected_id:
              (match Json.field value "selected_id" with
               | `Null -> None
               | value -> Some (Id.Resource.t_of_jsonaf value))
      in
      json_response
        (Wire.success (View_settings.Snapshot.to_json (result |> Disk.unwrap)))
    | "GET", [ "ui-api"; "v1"; "catalog" ] ->
      json_response (Wire.success (Wire.catalog ()))
    | "GET", [ "ui-api"; "v1"; "methods"; name ] ->
      json_response (Wire.success (Wire.method_contract name |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "connections" ] ->
      json_response
        (Wire.success
           (Json.obj
              [ ( "items"
                , `Array
                    (List.map
                       (Connection_profile.Store.list t.profiles)
                       ~f:Connection_profile.to_json) )
              ]))
    | "GET", [ "ui-api"; "v1"; "connections"; id; "generations"; generation ] ->
      let id = Connection_profile.Id.of_string id |> Disk.unwrap in
      let generation =
        Connection_profile.Generation.t_of_jsonaf (Json.string generation)
      in
      json_response (Wire.success (Connection_profile.to_json (profile t id generation)))
    | "POST", [ "ui-api"; "v1"; "connections" ] ->
      let value = fields request [ "id"; "label"; "socket" ] in
      let connection =
        Connection_profile.create
          ~id:
            (Json.field value "id"
             |> Json.text
             |> Connection_profile.Id.of_string
             |> Disk.unwrap)
          ~generation:Connection_profile.Generation.initial
          ~label:(Json.field value "label" |> Json.text)
          ~socket:(Json.field value "socket" |> Json.text)
        |> Disk.unwrap
      in
      Connection_profile.Store.put t.profiles connection ~expected_generation:None
      |> Disk.unwrap;
      json_response (Wire.success (Connection_profile.to_json connection))
    | "PUT", [ "ui-api"; "v1"; "connections"; id ] ->
      let value = fields request [ "expected_generation"; "label"; "socket" ] in
      let expected =
        Json.field value "expected_generation"
        |> Connection_profile.Generation.t_of_jsonaf
      in
      let connection =
        Connection_profile.create
          ~id:(Connection_profile.Id.of_string id |> Disk.unwrap)
          ~generation:(Connection_profile.Generation.next expected |> Disk.unwrap)
          ~label:(Json.field value "label" |> Json.text)
          ~socket:(Json.field value "socket" |> Json.text)
        |> Disk.unwrap
      in
      Connection_profile.Store.put
        t.profiles
        connection
        ~expected_generation:(Some expected)
      |> Disk.unwrap;
      json_response (Wire.success (Connection_profile.to_json connection))
    | "POST", [ "ui-api"; "v1"; "connections"; id; "attach" ] ->
      let value = fields request [ "generation" ] in
      let connection =
        profile t (Connection_profile.Id.of_string id |> Disk.unwrap) (generation value)
      in
      let initialize = public_read t connection "initialize" in
      let health = public_read t connection "daemon.health" in
      json_response
        (Wire.success
           (Json.obj
              [ "connection", Connection_profile.to_json connection
              ; "initialize", initialize
              ; "health", health
              ]))
    | "GET", [ "ui-api"; "v1"; "daemon-capabilities" ] ->
      json_response (Wire.success (Daemon_launcher.capabilities (launcher t)))
    | "POST", [ "ui-api"; "v1"; "daemon-launches"; "prepare" ] ->
      let value =
        fields
          request
          [ "intention_id"
          ; "connection_id"
          ; "generation"
          ; "context"
          ; "registry"
          ; "log"
          ; "timeout_seconds"
          ]
      in
      let plan =
        Daemon_launcher.Plan.create
          ~intention_id:(Operation.Id.t_of_jsonaf (Json.field value "intention_id"))
          ~connection:
            (profile
               t
               (Connection_profile.Id.t_of_jsonaf (Json.field value "connection_id"))
               (generation value))
          ~context:
            (Daemon_launcher.Context.of_json (Json.field value "context") |> Disk.unwrap)
          ~registry:(Json.field value "registry" |> Json.text)
          ~log:(Json.field value "log" |> Json.text)
          ~timeout_seconds:(Json.field value "timeout_seconds" |> Json.integer)
        |> Disk.unwrap
      in
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Daemon_launcher.prepare (launcher t) plan
            |> Disk.unwrap
            |> Daemon_launcher.Launch.to_json))
    | "GET", [ "ui-api"; "v1"; "daemon-launches" ] ->
      let offset, limit = query_page query in
      if limit < 1 || limit > 100
      then Json.fail Invalid_argument "launch list requires limit 1..100";
      let all = Daemon_launcher.list (launcher t) in
      let selected = List.take (List.drop all offset) limit in
      let remaining = Int.max 0 (List.length all - offset - List.length selected) in
      let summary launch =
        let value = Daemon_launcher.Launch.to_json launch in
        let plan = Json.field value "plan" in
        Json.obj
          [ "intention_id", Json.field plan "intention_id"
          ; "connection", Json.field plan "connection"
          ; "registry", Json.field plan "registry"
          ; "log", Json.field plan "log"
          ; "revision", Json.field value "revision"
          ; "status", Json.field (Json.field value "state") "status"
          ]
      in
      json_response
        (Wire.success
           (Json.obj
              [ "items", `Array (List.map selected ~f:summary)
              ; "offset", Json.int offset
              ; "remaining", Json.int remaining
              ; ( "next_offset"
                , if remaining = 0 then `Null else Json.int (offset + List.length selected)
                )
              ]))
    | "GET", [ "ui-api"; "v1"; "daemon-launches"; id ] ->
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Daemon_launcher.inspect
              (launcher t)
              ~intention_id:(Operation.Id.of_string id |> Disk.unwrap)
            |> Disk.unwrap
            |> Daemon_launcher.Launch.to_json))
    | "POST", [ "ui-api"; "v1"; "daemon-launches"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let retry =
        match action with
        | "start" -> false
        | "retry" -> true
        | _ -> Json.fail Not_found "unknown local launch action"
      in
      json_response
        ~status:202
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Daemon_launcher.start
              (launcher t)
              ~intention_id:(Operation.Id.of_string id |> Disk.unwrap)
              ~retry
            |> Disk.unwrap
            |> Daemon_launcher.Launch.to_json))
    | "POST", [ "ui-api"; "v1"; "admin-jobs"; "prepare" ] ->
      let plan = Admin_jobs.Plan.of_json (body request) |> Disk.unwrap in
      json_response
        (Wire.success
           (Admin_jobs.prepare (admin_jobs t) plan
            |> Disk.unwrap
            |> Admin_jobs.Job.to_json))
    | "GET", [ "ui-api"; "v1"; "admin-jobs" ] ->
      let offset, limit = query_page query in
      json_response
        (Wire.success (Admin_jobs.list (admin_jobs t) ~offset ~limit |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "admin-jobs"; id ] ->
      json_response
        (Wire.success
           (Admin_jobs.inspect
              (admin_jobs t)
              ~intention_id:(Operation.Id.of_string id |> Disk.unwrap)
            |> Disk.unwrap
            |> Admin_jobs.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "admin-jobs"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let intention_id = Operation.Id.of_string id |> Disk.unwrap in
      let result =
        match action with
        | "start" -> Admin_jobs.start (admin_jobs t) ~intention_id
        | "cancel" -> Admin_jobs.cancel (admin_jobs t) ~intention_id
        | _ -> Error (Problem.create Not_found "unknown offline administration action")
      in
      json_response
        ~status:(if String.equal action "start" then 202 else 200)
        (Wire.success (result |> Disk.unwrap |> Admin_jobs.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "journals"; "list" ] ->
      let value = fields request [ "directory"; "after"; "limit"; "max_bytes" ] in
      let nullable name =
        match Json.field value name with
        | `Null -> None
        | text -> Some (Json.text text)
      in
      json_response
        (Wire.success
           (Admin_jobs.journal_list
              (admin_jobs t)
              ~directory:(nullable "directory")
              ~after:(nullable "after")
              ~limit:(Json.field value "limit" |> Json.integer)
              ~max_bytes:(Json.field value "max_bytes" |> Json.integer)
            |> Disk.unwrap))
    | "POST", [ "ui-api"; "v1"; "journals"; "inspect" ] ->
      let value = fields request [ "path" ] in
      json_response
        (Wire.success
           (Admin_jobs.journal_inspect
              (admin_jobs t)
              ~path:(Json.field value "path" |> Json.text)
            |> Disk.unwrap))
    | "POST", [ "ui-api"; "v1"; "template-publications"; "prepare" ] ->
      let invocation = template_invocation request ~method_:"transaction.apply" in
      let input =
        Template_helper.Publication.of_params invocation.params |> Disk.unwrap
      in
      let prepared =
        Template_helper.Publication.prepare input ~fetch:(template_fetch t invocation)
        |> Disk.unwrap
      in
      json_response (Wire.success (Protocol.Request.to_json prepared))
    | "POST", [ "ui-api"; "v1"; "template-instances"; "preview" ] ->
      let invocation = template_invocation request ~method_:"template.instantiate" in
      let input =
        Template_helper.Instance_preview.of_params invocation.params |> Disk.unwrap
      in
      let prepared =
        Template_helper.Instance_preview.prepare
          input
          ~fetch:(template_fetch t invocation)
        |> Disk.unwrap
      in
      json_response (Wire.success (Template_helper.Instance_preview.to_json prepared))
    | "POST", [ "ui-api"; "v1"; "reservation-waits"; "prepare" ] ->
      let value =
        fields request [ "preparation"; "timeout_ms"; "max_attempts"; "wait_slice_ms" ]
      in
      let draft =
        Wire.Preparation.of_json (Json.field value "preparation") |> Disk.unwrap
      in
      let preparation =
        Operation.Preparation.create
          ~intention_id:draft.intention_id
          ~connection:(invocation_profile t draft.invocation)
          ~context:draft.context
          ~method_:draft.invocation.method_
          ~params:draft.invocation.params
        |> Disk.unwrap
      in
      let plan =
        Wait_helper.Plan.create
          ~preparation
          ~timeout_ms:(Json.integer (Json.field value "timeout_ms"))
          ~max_attempts:(Json.integer (Json.field value "max_attempts"))
          ~wait_slice_ms:(Json.integer (Json.field value "wait_slice_ms"))
        |> Disk.unwrap
      in
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Wait_helper.prepare (wait_helper t) plan
            |> Disk.unwrap
            |> Wait_helper.Job.to_json))
    | "GET", [ "ui-api"; "v1"; "reservation-waits" ] ->
      let offset, limit = query_page query in
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success (Wait_helper.list (wait_helper t) ~offset ~limit |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "reservation-waits"; id ] ->
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Wait_helper.inspect
              (wait_helper t)
              ~id:(Operation.Id.of_string id |> Disk.unwrap)
            |> Disk.unwrap
            |> Wait_helper.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "reservation-waits"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let id = Operation.Id.of_string id |> Disk.unwrap in
      let result =
        match action with
        | "start" -> Wait_helper.start (wait_helper t) ~id
        | "cancel" -> Wait_helper.cancel (wait_helper t) ~id
        | "retry-exact" -> Wait_helper.retry_exact (wait_helper t) ~id
        | _ -> Error (Problem.create Not_found "unknown reservation wait action")
      in
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success (result |> Disk.unwrap |> Wait_helper.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "request-waits" ] ->
      let service =
        match t.request_observer with
        | Some service -> service
        | None -> Json.fail Not_found "foreground request observer is unavailable"
      in
      let value =
        fields
          request
          [ "connection_id"
          ; "generation"
          ; "workspace_id"
          ; "request_id"
          ; "timeout_ms"
          ; "poll_interval_ms"
          ]
      in
      let profile =
        profile
          t
          (Connection_profile.Id.t_of_jsonaf (Json.field value "connection_id"))
          (generation value)
      in
      let plan =
        Request_observer.Plan.create
          ~profile
          ~workspace:(Id.Workspace.t_of_jsonaf (Json.field value "workspace_id"))
          ~request:(Communication_id.Request.t_of_jsonaf (Json.field value "request_id"))
          ~timeout_ms:(Json.integer (Json.field value "timeout_ms"))
          ~poll_interval_ms:(Json.integer (Json.field value "poll_interval_ms"))
        |> Disk.unwrap
      in
      json_response
        (Wire.success
           (Request_observer.observe service plan
            |> Disk.unwrap
            |> Request_observer.to_json))
    | "POST", [ "ui-api"; "v1"; "execution-stages"; "inspect" ] ->
      let value = fields request [ "directory" ] in
      let result =
        Execution_helper.inspect_stage
          (execution_helper t)
          ~directory:(Json.text (Json.field value "directory"))
        |> Disk.unwrap
      in
      json_response (Wire.success (Execution_helper.Inspection.to_json result))
    | "POST", [ "ui-api"; "v1"; "execution-stages"; "intent" ] ->
      let value = fields request [ "directory" ] in
      json_response
        (Wire.success
           (Execution_helper.inspect_intent
              (execution_helper t)
              ~directory:(Json.text (Json.field value "directory"))
            |> Disk.unwrap))
    | "POST", [ "ui-api"; "v1"; "execution-stages"; "output" ] ->
      let value =
        fields request [ "directory"; "capture_digest"; "stream"; "selection" ]
      in
      let stream =
        match Json.text (Json.field value "stream") with
        | "stdout" -> Execution_inspect.Stream.Stdout
        | "stderr" -> Stderr
        | _ -> Json.fail Invalid_argument "output stream must be stdout or stderr"
      in
      let selection = Json.field value "selection" in
      let length = Json.integer (Json.field selection "length") in
      let selection =
        match Json.text (Json.field selection "kind") with
        | "range" ->
          Json.fields selection ~allowed:[ "kind"; "offset"; "length" ];
          Execution_inspect.Selection.range
            ~offset:(Json.integer (Json.field selection "offset"))
            ~length
          |> Disk.unwrap
        | "retained_tail" ->
          Json.fields selection ~allowed:[ "kind"; "length" ];
          Execution_inspect.Selection.tail ~length |> Disk.unwrap
        | _ -> Json.fail Invalid_argument "unknown output selection"
      in
      json_response
        (Wire.success
           (Execution_helper.inspect_output
              (execution_helper t)
              ~directory:(Json.text (Json.field value "directory"))
              ~capture_digest:(Json.text (Json.field value "capture_digest"))
              ~stream
              ~selection
            |> Disk.unwrap))
    | "POST", [ "ui-api"; "v1"; "execution-stages"; "cleanup" ] ->
      let value = fields request [ "directory"; "owner_token" ] in
      let directory = Json.text (Json.field value "directory") in
      Execution_helper.cleanup
        (execution_helper t)
        ~directory
        ~owner_token:(Json.text (Json.field value "owner_token"))
      |> Disk.unwrap;
      json_response
        (Wire.success (Json.obj [ "directory", Json.string directory; "cleaned", `True ]))
    | "POST", [ "ui-api"; "v1"; "execution-publications"; "prepare" ] ->
      let value = body request in
      let plan = Execution_helper.Plan.of_json value |> Disk.unwrap in
      let captured =
        Connection_profile.of_json (Json.field value "connection") |> Disk.unwrap
      in
      let retained =
        profile
          t
          (Connection_profile.id captured)
          (Connection_profile.generation captured)
      in
      if
        not
          (String.equal
             (Json.canonical (Connection_profile.to_json captured))
             (Json.canonical (Connection_profile.to_json retained)))
      then Json.fail Conflict "publication profile differs from the retained generation";
      json_response
        (Wire.success
           (Execution_helper.prepare (execution_helper t) plan
            |> Disk.unwrap
            |> Execution_helper.Job.to_json))
    | "GET", [ "ui-api"; "v1"; "execution-publications" ] ->
      let offset, limit = query_page query in
      json_response
        (Wire.success
           (Execution_helper.list (execution_helper t) ~offset ~limit |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "execution-publications"; id ] ->
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Execution_helper.inspect
              (execution_helper t)
              ~id:(Operation.Id.of_string id |> Disk.unwrap)
            |> Disk.unwrap
            |> Execution_helper.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "execution-publications"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let id = Operation.Id.of_string id |> Disk.unwrap in
      let result =
        match action with
        | "start" -> Execution_helper.start (execution_helper t) ~id
        | "retry-exact" -> Execution_helper.retry_exact (execution_helper t) ~id
        | "recover" -> Execution_helper.recover (execution_helper t) ~id
        | _ -> Error (Problem.create Not_found "unknown execution publication action")
      in
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success (result |> Disk.unwrap |> Execution_helper.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "resource-stages"; "prepare" ] ->
      let value = fields request [ "stage_id"; "digest"; "size_bytes" ] in
      let result =
        Transfer_helper.begin_stage
          (transfer_helper t)
          ~id:(Transfer_helper.Stage.Id.t_of_jsonaf (Json.field value "stage_id"))
          ~digest:(Json.text (Json.field value "digest"))
          ~size_bytes:(Json.integer (Json.field value "size_bytes"))
        |> Disk.unwrap
      in
      json_response (Wire.success (Transfer_helper.Stage.to_json result))
    | "GET", [ "ui-api"; "v1"; "resource-stages" ] ->
      let offset, limit = query_page query in
      json_response
        (Wire.success
           (Transfer_helper.list_stages (transfer_helper t) ~offset ~limit |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "resource-stages"; id ] ->
      json_response
        (Wire.success
           (Transfer_helper.inspect_stage
              (transfer_helper t)
              ~id:(Transfer_helper.Stage.Id.of_string id |> Disk.unwrap)
            |> Disk.unwrap
            |> Transfer_helper.Stage.to_json))
    | "POST", [ "ui-api"; "v1"; "resource-stages"; id; "chunks" ] ->
      let value = fields request [ "offset"; "data_base64" ] in
      let encoded =
        Json.bounded_text
          ~max_bytes:((Upload.max_chunk_bytes + 2) / 3 * 4)
          (Json.field value "data_base64")
      in
      let bytes =
        match Base64.decode encoded with
        | Ok bytes when String.equal (Base64.encode_string bytes) encoded -> bytes
        | Ok _ | Error _ ->
          Json.fail Invalid_argument "stage chunk requires canonical padded Base64"
      in
      json_response
        (Wire.success
           (Transfer_helper.append_stage
              (transfer_helper t)
              ~id:(Transfer_helper.Stage.Id.of_string id |> Disk.unwrap)
              ~byte_offset:(Json.integer (Json.field value "offset"))
              ~bytes
            |> Disk.unwrap
            |> Transfer_helper.Stage.to_json))
    | "POST", [ "ui-api"; "v1"; "resource-stages"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let id = Transfer_helper.Stage.Id.of_string id |> Disk.unwrap in
      (match action with
       | "seal" ->
         json_response
           (Wire.success
              (Transfer_helper.seal_stage (transfer_helper t) ~id
               |> Disk.unwrap
               |> Transfer_helper.Stage.to_json))
       | "abandon" ->
         Transfer_helper.abandon_stage (transfer_helper t) ~id |> Disk.unwrap;
         json_response (Wire.success (Json.obj [ "abandoned", `True ]))
       | _ -> Json.fail Not_found "unknown local resource staging action")
    | "POST", [ "ui-api"; "v1"; "resource-uploads"; "prepare" ] ->
      let value = fields request [ "preparation"; "stage_id" ] in
      let draft =
        Wire.Preparation.of_json (Json.field value "preparation") |> Disk.unwrap
      in
      if not (String.equal draft.invocation.method_ "resource.upload")
      then
        Json.fail
          Invalid_argument
          "resource upload preparation requires resource.upload local helper";
      let plan =
        Transfer_helper.Plan.create
          ~intention_id:(Operation.Id.of_string draft.intention_id |> Disk.unwrap)
          ~connection:(invocation_profile t draft.invocation)
          ~context:draft.context
          ~stage_id:(Transfer_helper.Stage.Id.t_of_jsonaf (Json.field value "stage_id"))
          ~params:draft.invocation.params
        |> Disk.unwrap
      in
      json_response
        (Wire.success
           (Transfer_helper.prepare (transfer_helper t) plan
            |> Disk.unwrap
            |> Transfer_helper.Job.to_json))
    | "GET", [ "ui-api"; "v1"; "resource-uploads" ] ->
      let offset, limit = query_page query in
      json_response
        ~max_bytes:(16 * 1024 * 1024)
        (Wire.success
           (Transfer_helper.list (transfer_helper t) ~offset ~limit |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "resource-uploads"; id ] ->
      json_response
        (Wire.success
           (Transfer_helper.inspect
              (transfer_helper t)
              ~id:(Operation.Id.of_string id |> Disk.unwrap)
            |> Disk.unwrap
            |> Transfer_helper.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "resource-uploads"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let id = Operation.Id.of_string id |> Disk.unwrap in
      let result =
        match action with
        | "start" -> Transfer_helper.start (transfer_helper t) ~id
        | "retry-exact" -> Transfer_helper.retry_exact (transfer_helper t) ~id
        | "recover" -> Transfer_helper.recover (transfer_helper t) ~id
        | _ -> Error (Problem.create Not_found "unknown resource upload action")
      in
      json_response (Wire.success (result |> Disk.unwrap |> Transfer_helper.Job.to_json))
    | "POST", [ "ui-api"; "v1"; "read" ] ->
      let invocation = Wire.Invocation.of_json (body request) |> Disk.unwrap in
      let response =
        Rpc_bridge.read
          t.rpc
          ~connection:(invocation_profile t invocation)
          ~lane:invocation.lane
          (native_request t invocation.method_ invocation.params)
        |> Disk.unwrap
      in
      json_response (Wire.success response)
    | "POST", [ "ui-api"; "v1"; "operations"; "prepare" ] ->
      let draft = Wire.Preparation.of_json (body request) |> Disk.unwrap in
      let input =
        Operation.Preparation.create
          ~intention_id:draft.intention_id
          ~connection:(invocation_profile t draft.invocation)
          ~context:draft.context
          ~method_:draft.invocation.method_
          ~params:draft.invocation.params
        |> Disk.unwrap
      in
      operation_response
        (Rpc_bridge.prepare t.rpc input |> Disk.unwrap |> Operation_store.operation)
    | "GET", [ "ui-api"; "v1"; "operations" ] ->
      let offset, limit = query_page query in
      json_response
        (Wire.success (Operation_store.list t.operations ~offset ~limit |> Disk.unwrap))
    | "GET", [ "ui-api"; "v1"; "operations"; id ] ->
      operation_response
        (Operation_store.inspect
           t.operations
           ~id:(Operation.Id.of_string id |> Disk.unwrap)
         |> Disk.unwrap)
    | "POST", [ "ui-api"; "v1"; "operations"; id; action ] ->
      ignore (fields request [] : Jsonaf.t);
      let id = Operation.Id.of_string id |> Disk.unwrap in
      let operation =
        match action with
        | "execute" -> Rpc_bridge.execute t.rpc ~id ~retry:false
        | "retry" -> Rpc_bridge.execute t.rpc ~id ~retry:true
        | "recover" -> Rpc_bridge.recover t.rpc ~id
        | _ -> Error (Problem.create Not_found "unknown operation action")
      in
      operation_response (operation |> Disk.unwrap)
    | _ -> Json.fail Not_found "unknown companion route or unsupported HTTP method")
;;

let dispatch t (request : request) =
  match authorize t request with
  | Some response -> response
  | None ->
    if String.length request.body > Framing.max_bytes
    then
      error_response ~code:413 (Problem.create Invalid_argument "API body exceeds 4MiB")
    else (
      match Json.decode (fun () -> route t request) with
      | Ok response -> response
      | Error problem -> error_response problem)
;;
