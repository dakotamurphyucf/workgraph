open Core

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let unwrap = function
  | Ok v -> v
  | Error p -> raise (Json.Decode_error p)
;;

let invalid message = Error (Problem.create Invalid_argument message)
let require condition message = if not condition then Json.fail Invalid_argument message
let encode codec value = unwrap (Api_codec.encode codec value)

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated entity ID."
;;

let workspace = id Id.Workspace.of_string Id.Workspace.to_string
let count = Api_codec.decimal ~max:Int.max_value

let digest =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun s ->
      if
        String.length s = 64
        && String.for_all s ~f:(fun c ->
          Char.is_digit c || Char.between c ~low:'a' ~high:'f')
      then Ok s
      else invalid "digest must be 64 lowercase SHA256 hexadecimal characters")
    ~encode:Fn.id
    ~description:"64 lowercase hexadecimal SHA256 characters."
;;

let path =
  Api_codec.map
    (Api_codec.text ~max_bytes:65_536)
    ~decode:(fun s ->
      if Filename.is_absolute s && not (String.mem s '\000')
      then Ok s
      else invalid "path must be absolute and NUL-free")
    ~encode:Fn.id
    ~description:
      "Absolute UTF8 filesystem path, at most 64KiB; existence, ancestry and \
       disjointness are runtime checks."
;;

let flag expected =
  Api_codec.map
    Api_codec.boolean
    ~decode:(fun actual ->
      if Bool.equal actual expected
      then Ok ()
      else invalid "unexpected fixed response flag")
    ~encode:(fun () -> expected)
    ~description:(if expected then "Always true." else "Always false.")
;;

let validated codec validate description =
  Api_codec.map
    codec
    ~decode:(fun value ->
      match
        Json.decode (fun () ->
          validate value;
          value)
      with
      | Ok value -> Ok value
      | Error p -> invalid p.Problem.message)
    ~encode:Fn.id
    ~description
;;

let capture =
  validated
    (obj
       (req "workspace_id" workspace
        <*> req "revision" (Api_codec.decimal ~max:100_000)
        <*> req "head" (Api_codec.nullable digest)
        <*> req "history_head" (Api_codec.nullable digest))
       ~decode:(fun (((workspace, revision), head), history_head) ->
         { Export_job.Capture.workspace; revision; head; history_head })
       ~encode:(fun c ->
         ((c.Export_job.Capture.workspace, c.revision), c.head), c.history_head))
    Export_job.Capture.validate
    "Exact committed planning/history capture; revision 0 requires null planning head \
     and positive revision requires a head."
;;

let kind =
  Api_codec.enum
    [ "workspace", Export_job.Single; "all", All ]
    ~equal:Export_job.equal_kind
;;

let status =
  Api_codec.enum
    [ "running", Export_job.Running
    ; "completed", Completed
    ; "failed", Failed
    ; "canceled", Canceled
    ; "interrupted", Interrupted
    ]
    ~equal:Export_job.equal_status
;;

let job_id = id Id.Actor.of_string Id.Actor.to_string

let export_job =
  validated
    (obj
       (req "job_id" job_id
        <*> req "kind" kind
        <*> req "destination" path
        <*> req "captures" (Api_codec.list capture ~max_items:1000)
        <*> req "omitted" (Api_codec.list workspace ~max_items:1000)
        <*> req "status" status
        <*> req "attempt" (Api_codec.decimal ~max:1_000_000)
        <*> req "cancel_requested" Api_codec.boolean
        <*> req "error" (Api_codec.nullable (Api_codec.text ~max_bytes:4096)))
       ~decode:
         (fun
           ( ( ((((((id, kind), destination), captures), omitted), status), attempt)
             , cancel_requested )
           , error ) ->
         { Export_job.id = Id.Actor.to_string id
         ; kind
         ; destination
         ; captures
         ; omitted
         ; status
         ; attempt
         ; cancel_requested
         ; error
         })
       ~encode:(fun j ->
         ( ( ( ( ( ( ((unwrap (Id.Actor.of_string j.Export_job.id), j.kind), j.destination)
                   , j.captures )
                 , j.omitted )
               , j.status )
             , j.attempt )
           , j.cancel_requested )
         , j.error )))
    Export_job.validate
    "Complete durable job metadata; capture identity is immutable across retries and \
     statuses require consistent cancellation/error fields."
;;

let problem = Problem_wire.codec

module Health = struct
  module Workspace = struct
    type t =
      { workspace : Id.Workspace.t
      ; root : string
      ; archived : bool option
      ; is_open : bool
      ; open_intent : bool
      ; error : Problem.t option
      ; capacity : Admission.Summary.t option
      }

    let create
          ~workspace
          ~(registration : Registry.Registration.t)
          ~archived
          ~is_open
          ~error
          ~capacity
      =
      { workspace
      ; root = registration.root
      ; archived
      ; is_open
      ; open_intent = registration.is_open
      ; error
      ; capacity
      }
    ;;

    let codec =
      validated
        (obj
           (req "workspace_id" workspace
            <*> req "root" path
            <*> req "archived" (Api_codec.nullable Api_codec.boolean)
            <*> req "open" Api_codec.boolean
            <*> req "open_intent" Api_codec.boolean
            <*> req "error" (Api_codec.nullable problem)
            <*> req "capacity" (Api_codec.nullable Admission.Summary.codec))
           ~decode:
             (fun
               ((((((workspace, root), archived), is_open), open_intent), error), capacity) ->
             { workspace; root; archived; is_open; open_intent; error; capacity })
           ~encode:(fun w ->
             ( (((((w.workspace, w.root), w.archived), w.is_open), w.open_intent), w.error)
             , w.capacity )))
        (fun w ->
           require
             (Bool.equal w.is_open (Option.is_some w.archived))
             "loaded workspace archived state disagrees";
           require
             ((not w.is_open) || Option.is_none w.error)
             "open workspace cannot carry an unavailable error";
           require
             (w.is_open || Option.is_none w.capacity)
             "closed workspace cannot report current cached capacity")
        "Current local registration status; archived is known only when the workspace is \
         loaded."
    ;;
  end

  type t =
    { registry_requires_restart : bool
    ; pending_creates : int
    ; pending_restores : int
    ; active_exports : int
    ; workspaces : Workspace.t list
    }

  let capture registry ~registry_requires_restart ~active_exports ~workspace_status =
    let workspaces =
      Map.to_alist registry.Registry.registrations
      |> List.map ~f:(fun (id, registration) ->
        let workspace = unwrap (Id.Workspace.of_string id) in
        let archived, is_open, error, capacity = workspace_status workspace in
        Workspace.create ~workspace ~registration ~archived ~is_open ~error ~capacity)
    in
    { registry_requires_restart
    ; pending_creates = Map.length registry.creates
    ; pending_restores = Map.length registry.restores
    ; active_exports
    ; workspaces
    }
  ;;

  let codec =
    validated
      (obj
         (req "registry_requires_restart" Api_codec.boolean
          <*> req "pending_creates" count
          <*> req "pending_restores" count
          <*> req "active_exports" (Api_codec.decimal ~max:8)
          <*> req "workspaces" (Api_codec.list Workspace.codec ~max_items:Int.max_value))
         ~decode:
           (fun
             ( ( ((registry_requires_restart, pending_creates), pending_restores)
               , active_exports )
             , workspaces ) ->
           { registry_requires_restart
           ; pending_creates
           ; pending_restores
           ; active_exports
           ; workspaces
           })
         ~encode:(fun h ->
           ( ( ((h.registry_requires_restart, h.pending_creates), h.pending_restores)
             , h.active_exports )
           , h.workspaces )))
      (fun h ->
         require
           (not
              (List.contains_dup
                 (List.map h.workspaces ~f:(fun w -> w.Workspace.workspace))
                 ~compare:Id.Workspace.compare))
           "duplicate health workspace")
      "Immutable local registry health; counts are nonnegative, active export admission \
       is at most 8, and workspace IDs are unique."
  ;;
end

module Receipt = struct
  type t =
    | Absent
    | Pending
    | Committed of
        { request_hash : string
        ; response : Api_response.t
        }

  let registry registry ~key =
    match Map.find registry.Registry.receipts key with
    | Some r ->
      Committed
        { request_hash = r.request_hash
        ; response = Api_response.project Registry_write r.response
        }
    | None ->
      if Map.mem registry.creates key || Map.mem registry.restores key
      then Pending
      else Absent
  ;;

  let planning ~request_hash ~response =
    Committed { request_hash; response = Api_response.project Planning_write response }
  ;;

  let envelope =
    Api_codec.map
      (Api_codec.as_json
         (Api_response.codec (Api_codec.json ~max_bytes:Framing.max_bytes ~max_depth:64)))
      ~decode:(fun json ->
        Result.bind (Api_response.of_json json) ~f:(fun value ->
          Result.map (Api_response.require_durable value) ~f:(fun () -> value)))
      ~encode:Api_response.to_json
      ~description:
        "Complete original public receipt response confirming durable publication."
  ;;

  let cases =
    [ ( "absent"
      , obj
          (req "status" (Api_codec.literal "absent"))
          ~decode:(fun () -> Absent)
          ~encode:(function
            | Absent -> ()
            | Pending | Committed _ ->
              Json.fail Invalid_argument "absent receipt expected") )
    ; ( "pending"
      , obj
          (req "status" (Api_codec.literal "pending"))
          ~decode:(fun () -> Pending)
          ~encode:(function
            | Pending -> ()
            | Absent | Committed _ ->
              Json.fail Invalid_argument "pending receipt expected") )
    ; ( "committed"
      , obj
          (req "status" (Api_codec.literal "committed")
           <*> req "request_hash" digest
           <*> req "response" envelope)
          ~decode:(fun (((), request_hash), response) ->
            Committed { request_hash; response })
          ~encode:(function
            | Committed { request_hash; response } -> ((), request_hash), response
            | Absent | Pending -> Json.fail Invalid_argument "committed receipt expected")
      )
    ]
  ;;

  let select = function
    | Absent -> "absent"
    | Pending -> "pending"
    | Committed _ -> "committed"
  ;;

  let codec = Api_codec.tagged ~discriminator:"status" ~cases ~select

  let planning_codec =
    Api_codec.tagged
      ~discriminator:"status"
      ~cases:(List.filter cases ~f:(fun (name, _) -> not (String.equal name "pending")))
      ~select
  ;;
end

module Restore = struct
  module Target = struct
    type t =
      { root : string
      ; capture : Export_job.Capture.t
      }

    let codec =
      obj
        (req "root" path <*> req "capture" capture)
        ~decode:(fun (root, capture) -> { root; capture })
        ~encode:(fun t -> t.root, t.capture)
    ;;
  end

  type t =
    | Installed of Target.t list
    | Canceled

  let of_plan plan =
    Installed
      (List.map plan.Restore_plan.targets ~f:(fun t ->
         { Target.root = t.root; capture = t.capture }))
  ;;

  let targets =
    validated
      (Api_codec.list Target.codec ~max_items:1000)
      (fun targets ->
         require (not (List.is_empty targets)) "restore requires installed workspaces";
         require
           (not
              (List.contains_dup
                 (List.map targets ~f:(fun t -> t.Target.root))
                 ~compare:String.compare))
           "duplicate restore root";
         require
           (not
              (List.contains_dup
                 (List.map targets ~f:(fun t -> t.Target.capture.workspace))
                 ~compare:Id.Workspace.compare))
           "duplicate restore workspace")
      "Published verified workspace captures registered closed, preserving source \
       identities."
  ;;

  let installed =
    Api_codec.map
      (obj
         (req "kind" (Api_codec.literal "installed")
          <*> req "open" (flag false)
          <*> req "workspaces" targets)
         ~decode:(fun (((), ()), targets) -> targets)
         ~encode:(fun targets -> ((), ()), targets))
      ~decode:(fun values -> Ok (Installed values))
      ~encode:(function
        | Installed targets -> targets
        | Canceled -> Json.fail Invalid_argument "installed restore expected")
      ~description:"Published verified workspace captures registered closed."
  ;;

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ "installed", installed
        ; ( "canceled"
          , obj
              (req "kind" (Api_codec.literal "canceled"))
              ~decode:(fun () -> Canceled)
              ~encode:(function
                | Canceled -> ()
                | Installed _ -> Json.fail Invalid_argument "canceled restore expected") )
        ]
      ~select:(function
        | Installed _ -> "installed"
        | Canceled -> "canceled")
  ;;
end

module Verification = struct
  type t =
    { workspace : Id.Workspace.t
    ; revision : int
    ; head : string option
    }

  let of_verified v =
    { workspace = Snapshot.Verified.workspace v
    ; revision = Snapshot.Verified.revision v
    ; head = Snapshot.Verified.head v
    }
  ;;

  let codec =
    validated
      (obj
         (req "workspace_id" workspace
          <*> req "revision" (Api_codec.decimal ~max:100_000)
          <*> req "head" (Api_codec.nullable digest)
          <*> req "verified" (flag true)
          <*> req "canonical_state_validated" (flag false))
         ~decode:(fun ((((workspace, revision), head), ()), ()) ->
           { workspace; revision; head })
         ~encode:(fun v -> (((v.workspace, v.revision), v.head), ()), ()))
      (fun v ->
         Export_job.Capture.validate
           { workspace = v.workspace
           ; revision = v.revision
           ; head = v.head
           ; history_head = None
           })
      "Inventory/hash verification; full canonical replay is separately required on \
       restore/register."
  ;;
end

module Export_page = struct
  type t =
    { items : Export_job.t list
    ; offset : int
    ; remaining : int
    ; next_offset : int option
    }

  let codec =
    validated
      (obj
         (req "items" (Api_codec.list export_job ~max_items:100)
          <*> req "offset" count
          <*> req "remaining" count
          <*> req "next_offset" (Api_codec.nullable count))
         ~decode:(fun (((items, offset), remaining), next_offset) ->
           { items; offset; remaining; next_offset })
         ~encode:(fun p -> ((p.items, p.offset), p.remaining), p.next_offset))
      (fun p ->
         let returned = List.length p.items in
         require
           (p.offset <= Int.max_value - returned)
           "export page offset and returned count overflow";
         let position = p.offset + returned in
         require
           (p.remaining <= Int.max_value - position)
           "export page total count overflows";
         require
           (p.remaining = 0 || returned > 0)
           "export page cannot leave a nonadvancing remainder";
         require
           (not
              (List.contains_dup
                 (List.map p.items ~f:(fun j -> j.Export_job.id))
                 ~compare:String.compare))
           "duplicate export page identity";
         require
           (Option.equal
              Int.equal
              p.next_offset
              (if p.remaining > 0 then Some position else None))
           "export cursor disagrees with complete items")
      "Whole export jobs with accurate next offset and remaining count; snapshot is in \
       public metadata."
  ;;

  let response registry ~offset ~limit ~max_bytes ~at_snapshot =
    Json.decode (fun () ->
      require
        (offset >= 0
         && limit > 0
         && limit <= 100
         && max_bytes >= 4096
         && max_bytes <= 1_048_576)
        "invalid export page bounds";
      let snapshot =
        Json.hash
          (Json.canonical
             (Json.obj
                (Map.to_alist registry.Registry.exports
                 |> List.map ~f:(fun (id, job) -> id, Export_job.to_json job))))
      in
      (match at_snapshot with
       | None -> require (offset = 0) "export pagination requires at_snapshot"
       | Some expected ->
         if not (String.equal snapshot expected)
         then Json.fail Conflict "export listing changed; restart pagination");
      let jobs = List.drop (Map.data registry.exports) offset in
      let selected = List.take jobs limit in
      let result items =
        let returned = List.length items in
        let removed = List.length selected - returned in
        let remaining = List.length jobs - returned in
        let data =
          encode
            codec
            { items
            ; offset
            ; remaining
            ; next_offset = (if remaining > 0 then Some (offset + returned) else None)
            }
        in
        let make returned_bytes =
          Json.obj
            [ "snapshot", Json.string snapshot
            ; "data", data
            ; ( "budget"
              , Json.obj
                  [ "max_bytes", Json.int max_bytes
                  ; "returned_bytes", Json.int returned_bytes
                  ; ("truncated", if removed > 0 then `True else `False)
                  ; "omitted_fields", Json.int 0
                  ; "omitted_items", Json.int removed
                  ; ( "details"
                    , `Array
                        (if removed = 0
                         then []
                         else
                           [ Json.obj
                               [ "path", Json.string "/data/items"
                               ; "kind", Json.string "items"
                               ; "omitted", Json.int removed
                               ]
                           ]) )
                  ; "details_complete", `True
                  ] )
            ]
        in
        let rec stable previous fuel =
          let current = make previous in
          let measured = Api_response.encoded_size Snapshot_read current in
          if measured = previous
          then current
          else (
            require (fuel > 0) "export budget size did not converge";
            stable measured (fuel - 1))
        in
        stable 0 8
      in
      let rec fit reversed = function
        | [] -> List.rev reversed
        | item :: rest ->
          let candidate = List.rev (item :: reversed) in
          if Api_response.encoded_size Snapshot_read (result candidate) > max_bytes
          then List.rev reversed
          else fit (item :: reversed) rest
      in
      let items = fit [] selected in
      require
        (List.is_empty selected || not (List.is_empty items))
        "one complete export job cannot fit; increase max_bytes";
      let result = result items in
      require
        (Api_response.encoded_size Snapshot_read result <= max_bytes)
        "export page metadata cannot fit; increase max_bytes";
      result)
  ;;
end
