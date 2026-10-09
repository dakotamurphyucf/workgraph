open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let opt = F.optional
let counter = W.counter
let text = Api_codec.text

let bound low high =
  W.checked (Api_codec.decimal ~max:high) (fun value ->
    if value < low then Json.fail Invalid_argument "query bound too small")
;;

let unique codec ~max_items ~compare =
  W.checked (Api_codec.list codec ~max_items) (fun values ->
    if List.contains_dup values ~compare
    then Json.fail Invalid_argument "duplicate feed selector")
;;

module Source = struct
  type t =
    | Planning
    | History
  [@@deriving sexp_of, equal]

  let codec = Api_codec.enum [ "planning", Planning; "history", History ] ~equal
end

module Request = struct
  type t =
    { workspace : Id.Workspace.t
    ; source : Source.t
    ; after : int option
    ; cursor : string option
    ; target : Entity_ref.t option
    ; project : Id.Project.t option
    ; actor : Id.Actor.t option
    ; kinds : string list
    ; limit : int
    ; max_bytes : int
    ; timeout_ms : int
    }

  let base =
    req "workspace_id" (W.id Id.Workspace.of_string Id.Workspace.to_string)
    ++ opt "source" Source.codec
    ++ opt "after" counter
    ++ opt "cursor" (W.nonblank ~max_bytes:2048)
    ++ opt "target" Evidence_wire.entity_ref
    ++ opt "project_id" (W.id Id.Project.of_string Id.Project.to_string)
    ++ opt "actor_id" W.actor
    ++ opt "kinds" (unique (text ~max_bytes:128) ~max_items:32 ~compare:String.compare)
    ++ opt "limit" (bound 1 100)
    ++ opt "max_bytes" (bound 4096 1048576)
  ;;

  let declaration timeout =
    W.checked
      (Api_codec.object_
         (F.map
            (base ++ timeout)
            ~decode:
              (fun
                ( ( ( ( ( (((((workspace, source), after), cursor), target), project)
                        , actor )
                      , kinds )
                    , limit )
                  , max_bytes )
                , timeout_ms ) ->
              { workspace
              ; source = Option.value source ~default:Source.Planning
              ; after
              ; cursor
              ; target
              ; project
              ; actor
              ; kinds = List.sort (Option.value kinds ~default:[]) ~compare:String.compare
              ; limit = Option.value limit ~default:50
              ; max_bytes = Option.value max_bytes ~default:65536
              ; timeout_ms = Option.value timeout_ms ~default:20000
              })
            ~encode:(fun t ->
              ( ( ( ( ( ( ((((t.workspace, Some t.source), t.after), t.cursor), t.target)
                        , t.project )
                      , t.actor )
                    , Some t.kinds )
                  , Some t.limit )
                , Some t.max_bytes )
              , Some t.timeout_ms ))))
      (fun t ->
         if Option.is_some t.after && Option.is_some t.cursor
         then Json.fail Invalid_argument "provide cursor or after, not both")
  ;;

  let read = declaration (F.map F.empty ~decode:(fun () -> None) ~encode:(fun _ -> ()))
  let wait = declaration (opt "timeout_ms" (bound 1 25000))

  let codec ~method_ =
    match method_ with
    | "changes.read" -> Some read
    | "changes.wait" -> Some wait
    | _ -> None
  ;;

  let workspace t = t.workspace
  let source t = t.source
  let after t = t.after
  let cursor t = t.cursor
  let target t = t.target
  let project t = t.project
  let actor t = t.actor
  let kinds t = t.kinds
  let limit t = t.limit
  let max_bytes t = t.max_bytes
  let timeout_ms t = t.timeout_ms
  let with_cursor t ~cursor = { t with cursor = Some cursor; after = None }
  let read_params t = Api_codec.encode read t
end

module Item = struct
  type t =
    { revision : int
    ; actor_id : Id.Actor.t
    ; timestamp : string
    ; targets : Entity_ref.t list
    ; kinds : string list
    ; run_id : Id.Run.t option
    }

  let codec =
    Api_codec.object_
      (F.map
         (req "revision" W.positive
          ++ req "actor_id" W.actor
          ++ req "timestamp" (text ~max_bytes:128)
          ++ req
               "targets"
               (unique
                  Evidence_wire.entity_ref
                  ~max_items:100000
                  ~compare:Entity_ref.compare)
          ++ req
               "kinds"
               (unique (text ~max_bytes:128) ~max_items:32 ~compare:String.compare)
          ++ req "run_id" (Api_codec.nullable W.run))
         ~decode:(fun (((((revision, actor_id), timestamp), targets), kinds), run_id) ->
           { revision; actor_id; timestamp; targets; kinds; run_id })
         ~encode:(fun t ->
           ((((t.revision, t.actor_id), t.timestamp), t.targets), t.kinds), t.run_id))
  ;;
end

module Response = struct
  type t =
    { source : Source.t
    ; through : int
    ; items : Item.t list
    ; cursor : string
    ; has_more : bool
    ; needs_larger_budget : bool
    }

  let codec =
    W.checked
      (Api_codec.object_
         (F.map
            (req "source" Source.codec
             ++ req "through" counter
             ++ req "items" (Api_codec.list Item.codec ~max_items:100)
             ++ req "cursor" (W.nonblank ~max_bytes:2048)
             ++ req "has_more" Api_codec.boolean
             ++ req "needs_larger_budget" Api_codec.boolean)
            ~decode:
              (fun
                (((((source, through), items), cursor), has_more), needs_larger_budget) ->
              { source; through; items; cursor; has_more; needs_larger_budget })
            ~encode:(fun t ->
              ( ((((t.source, t.through), t.items), t.cursor), t.has_more)
              , t.needs_larger_budget ))))
      (fun t ->
         ignore
           (List.fold t.items ~init:0 ~f:(fun previous item ->
              if item.Item.revision <= previous || item.revision > t.through
              then
                Json.fail
                  Invalid_argument
                  "feed metadata positions outside ordered capture";
              item.revision)
            : int);
         if t.needs_larger_budget && ((not t.has_more) || not (List.is_empty t.items))
         then Json.fail Invalid_argument "invalid oversized feed metadata disclosure";
         if t.has_more && List.is_empty t.items && not t.needs_larger_budget
         then
           Json.fail
             Invalid_argument
             "empty remaining feed must disclose an oversized item")
  ;;
end

let request_codec ~method_ = Option.map (Request.codec ~method_) ~f:Api_codec.as_json

let response_codec ~method_ =
  match method_ with
  | "changes.read" | "changes.wait" -> Some (Api_codec.as_json Response.codec)
  | _ -> None
;;

let methods =
  List.map [ "changes.read"; "changes.wait" ] ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:"Complete captured commit metadata with exact prefix continuation."
         ~mode:Read
         ~request:(Option.value_exn (Request.codec ~method_:name))
         ~response:Response.codec))
;;
