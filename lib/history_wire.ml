open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let encode codec value = unwrap (Api_codec.encode codec value)

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity; aliases are not accepted."
;;

let session_id = id Session_id.of_string Session_id.to_string
let actor_id = id Id.Actor.of_string Id.Actor.to_string
let run_id = id Id.Run.of_string Id.Run.to_string
let resource_id = id Id.Resource.of_string Id.Resource.to_string
let workspace_id = id Id.Workspace.of_string Id.Workspace.to_string

let positive max =
  Api_codec.map
    (Api_codec.decimal ~max)
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "counter must be positive"))
    ~encode:Fn.id
    ~description:"Positive canonical decimal counter."
;;

let event_ref =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "session_id" session_id
        ++ Fields.required "sequence" (positive 1_000_000)))
    ~decode:(fun (session, sequence) -> Session.Event_ref.create ~session ~sequence)
    ~encode:(fun ref_ -> ref_.Session.Event_ref.session, ref_.sequence)
    ~description:"Immutable committed session event reference."
;;

let blob_ref =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "digest" (Api_codec.text ~max_bytes:64)
        ++ Fields.required "size_bytes" (Api_codec.decimal ~max:(64 * 1024 * 1024))))
    ~decode:(fun (digest, size_bytes) ->
      Session_event.Blob_ref.create ~digest ~size_bytes)
    ~encode:(fun ref_ -> ref_.Session_event.Blob_ref.digest, ref_.size_bytes)
    ~description:"SHA-256 lowercase digest and byte length, at most 64MiB."
;;

let resource_ref =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "resource_id" resource_id
        ++ Fields.required "revision" (positive 100_000)))
    ~decode:(fun (id, revision) -> Session_event.Resource_ref.create ~id ~revision)
    ~encode:(fun ref_ -> ref_.Session_event.Resource_ref.id, ref_.revision)
    ~description:"Pinned immutable workspace resource version."
;;

let scope =
  Api_codec.map
    Planning_target.codec
    ~decode:Planning_target.to_ref
    ~encode:Planning_target.of_ref
    ~description:"Resolved local session scope; caller validates existence."
;;

let bytes =
  Api_codec.map
    (Api_codec.text ~max_bytes:22_369_624)
    ~decode:(fun encoded ->
      match Base64.decode encoded with
      | Error (`Msg message) -> Error (Problem.create Invalid_argument message)
      | Ok bytes ->
        if String.length bytes > 16 * 1024 * 1024
        then Error (Problem.create Invalid_argument "inline content exceeds 16MiB")
        else Ok bytes)
    ~encode:Base64.encode_string
    ~description:"Opaque bytes encoded as base64; at most 16MiB decoded."
;;

let content =
  let inline =
    Api_codec.map
      (Api_codec.object_
         (Fields.required "kind" (Api_codec.literal "inline")
          ++ Fields.required "bytes_base64" bytes))
      ~decode:(fun ((), bytes) -> Ok (Session_event.Content.Inline bytes))
      ~encode:(function
        | Session_event.Content.Inline bytes -> (), bytes
        | Blob _ -> Json.fail Invalid_argument "wrong content kind")
      ~description:"Opaque inline bytes."
  in
  let blob =
    Api_codec.map
      (Api_codec.object_
         (Fields.required "kind" (Api_codec.literal "blob")
          ++ Fields.required "blob" blob_ref))
      ~decode:(fun ((), ref_) -> Ok (Session_event.Content.Blob ref_))
      ~encode:(function
        | Session_event.Content.Blob ref_ -> (), ref_
        | Inline _ -> Json.fail Invalid_argument "wrong content kind")
      ~description:"Existing immutable blob."
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:[ "inline", inline; "blob", blob ]
    ~select:(function
      | Session_event.Content.Inline _ -> "inline"
      | Blob _ -> "blob")
;;

let nonempty max_bytes =
  Api_codec.map
    (Api_codec.text ~max_bytes)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "text must not be empty")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonempty UTF-8 text."
;;

module Input_fields = struct
  type t =
    { client_id : string
    ; role : string
    ; kind : string
    ; phase : string
    ; correlation : string option
    ; provenance : Jsonaf.t
    ; payload : Session_event.Content.t
    ; searchable_text : Session_event.Content.t option
    ; resource_versions : Session_event.Resource_ref.t list
    ; attachments : Session_event.Blob_ref.t list
    }

  let fields content =
    Fields.map
      (Fields.required "client_id" (nonempty 256)
       ++ Fields.required "role" (nonempty 256)
       ++ Fields.required "kind" (nonempty 256)
       ++ Fields.required "phase" (nonempty 256)
       ++ Fields.optional
            "correlation"
            (Api_codec.nullable (Api_codec.text ~max_bytes:256))
       ++ Fields.optional "provenance" (Api_codec.json ~max_bytes:4096 ~max_depth:32)
       ++ Fields.required "payload" content
       ++ Fields.optional "searchable_text" (Api_codec.nullable content)
       ++ Fields.optional "resource_versions" (Api_codec.list resource_ref ~max_items:100)
       ++ Fields.optional "attachments" (Api_codec.list blob_ref ~max_items:100))
      ~decode:
        (fun
          ( ( ( ((((((client_id, role), kind), phase), correlation), provenance), payload)
              , searchable_text )
            , resource_versions )
          , attachments ) ->
        { client_id
        ; role
        ; kind
        ; phase
        ; correlation = Option.join correlation
        ; provenance = Option.value provenance ~default:`Null
        ; payload
        ; searchable_text = Option.join searchable_text
        ; resource_versions = Option.value resource_versions ~default:[]
        ; attachments = Option.value attachments ~default:[]
        })
      ~encode:
        (fun
          { client_id
          ; role
          ; kind
          ; phase
          ; correlation
          ; provenance
          ; payload
          ; searchable_text
          ; resource_versions
          ; attachments
          } ->
        ( ( ( ( (((((client_id, role), kind), phase), Some correlation), Some provenance)
              , payload )
            , Some searchable_text )
          , Some resource_versions )
        , Some attachments ))
  ;;
end

let input_codec content =
  Api_codec.map
    (Api_codec.object_ (Input_fields.fields content))
    ~decode:(fun (fields : Input_fields.t) ->
      Session_event.Input.create
        ~client_id:fields.client_id
        ~role:fields.role
        ~kind:fields.kind
        ~phase:fields.phase
        ?correlation:fields.correlation
        ~provenance:fields.provenance
        ~payload:fields.payload
        ?searchable_text:fields.searchable_text
        ~resource_versions:fields.resource_versions
        ~attachments:fields.attachments
        ())
    ~encode:(fun input ->
      { Input_fields.client_id = Session_event.Input.client_id input
      ; role = Session_event.Input.role input
      ; kind = Session_event.Input.kind input
      ; phase = Session_event.Input.phase input
      ; correlation = Session_event.Input.correlation input
      ; provenance = Session_event.Input.provenance input
      ; payload = Session_event.Input.payload input
      ; searchable_text = Session_event.Input.searchable_text input
      ; resource_versions = Session_event.Input.resource_versions input
      ; attachments = Session_event.Input.attachments input
      })
    ~description:
      "Exact adapter event metadata and opaque content; searchable text is complete \
       UTF-8."
;;

let input = input_codec content

let committed_content =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "kind" (Api_codec.literal "blob")
        ++ Fields.required "blob" blob_ref))
    ~decode:(fun ((), ref_) -> Ok (Session_event.Content.Blob ref_))
    ~encode:(function
      | Session_event.Content.Blob ref_ -> (), ref_
      | Inline _ -> Json.fail Invalid_argument "committed event requires blob references")
    ~description:
      "Committed content references an immutable blob; inline content is not accepted."
;;

let committed_input = input_codec committed_content

module Session_fields = struct
  type t =
    { workspace : Id.Workspace.t
    ; id : Session_id.t
    ; title : string
    ; actor : Id.Actor.t
    ; run : Id.Run.t option
    ; parent : Session.Event_ref.t option
    ; scopes : Entity_ref.t list
    ; archived : bool
    }

  let fields =
    Fields.map
      (Fields.required "workspace_id" workspace_id
       ++ Fields.required "session_id" session_id
       ++ Fields.required "title" (nonempty 512)
       ++ Fields.required "actor_id" actor_id
       ++ Fields.required "run_id" (Api_codec.nullable run_id)
       ++ Fields.required "parent_event" (Api_codec.nullable event_ref)
       ++ Fields.required "scopes" (Api_codec.list scope ~max_items:100)
       ++ Fields.required "archived" Api_codec.boolean)
      ~decode:
        (fun
          (((((((workspace, id), title), actor), run), parent), scopes), archived) ->
        { workspace; id; title; actor; run; parent; scopes; archived })
      ~encode:(fun { workspace; id; title; actor; run; parent; scopes; archived } ->
        ((((((workspace, id), title), actor), run), parent), scopes), archived)
  ;;
end

let session =
  Api_codec.map
    (Api_codec.object_ Session_fields.fields)
    ~decode:(fun (fields : Session_fields.t) ->
      Result.map
        (Session.create
           ~workspace:fields.workspace
           ~id:fields.id
           ~title:fields.title
           ~actor:fields.actor
           ?run:fields.run
           ?parent:fields.parent
           ~scopes:fields.scopes
           ())
        ~f:(fun session -> if fields.archived then Session.archive session else session))
    ~encode:(fun session ->
      { Session_fields.workspace = Session.workspace session
      ; id = Session.id session
      ; title = Session.title session
      ; actor = Session.actor session
      ; run = Session.run session
      ; parent = Session.parent session
      ; scopes = Session.scopes session
      ; archived = Session.archived session
      })
    ~description:
      "Immutable session metadata; archiving prohibits append and preserves access."
;;

let event =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "event_ref" event_ref
        ++ Fields.required "identity_hash" (Api_codec.text ~max_bytes:64)
        ++ Fields.required "actor_id" actor_id
        ++ Fields.required "run_id" (Api_codec.nullable run_id)
        ++ Fields.required "event" committed_input))
    ~decode:(fun ((((ref_, identity_hash), actor), run), input) ->
      if not (String.equal identity_hash (Session_event.Input.identity_hash input))
      then Error (Problem.create Invalid_argument "event identity mismatch")
      else if
        List.exists (Session_event.Input.contents input) ~f:(function
          | Session_event.Content.Inline _ -> true
          | Blob _ -> false)
      then
        Error (Problem.create Invalid_argument "committed event requires blob references")
      else
        Ok
          (Session_event.commit input ~ref_ ~actor ~run ~install:(function
             | Session_event.Content.Blob ref_ -> ref_
             | Inline _ -> assert false)))
    ~encode:(fun event ->
      ( ( ( (Session_event.ref_ event, Session_event.identity_hash event)
          , Session_event.actor event )
        , Session_event.run event )
      , Session_event.input event ))
    ~description:
      "Committed immutable event metadata and verified identity; opaque bytes retrieved \
       separately."
;;

let session_json value = encode session value
let event_json value = encode event value
