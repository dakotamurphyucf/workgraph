open Core
module Recipient = Communication_event.Recipient
module Scope = Communication_event.Scope
module Board = Communication_event.Board
module Thread = Communication_event.Thread
module Team = Communication_event.Team
module Request = Communication_event.Request
module Notification = Communication_event.Notification
module Subscription = Communication_event.Subscription
module Change = Communication_event

module Command = struct
  type t =
    | Board_put of
        { id : Communication_id.Board.t
        ; expected_revision : int
        ; scope : Scope.t
        ; title : string
        }
    | Thread_put of
        { id : Communication_id.Thread.t
        ; expected_revision : int
        ; board : Communication_id.Board.t
        ; title : string
        ; participants : Id.Actor.t list
        ; mentions : Id.Actor.t list
        ; links : Entity_ref.t list
        ; state : Thread.State.t
        ; pinned : bool
        }
    | Thread_attach of
        { id : Communication_id.Thread.t
        ; expected_revision : int
        ; message : Id.Comment.t
        }
    | Thread_pin_message of
        { id : Communication_id.Thread.t
        ; expected_revision : int
        ; message : Id.Comment.t
        ; pinned : bool
        }
    | Team_put of
        { id : Communication_id.Team.t
        ; expected_revision : int
        ; title : string
        ; members : Recipient.t list
        }
    | Request_create of
        { id : Communication_id.Request.t
        ; thread : Communication_id.Thread.t
        ; kind : Request.Kind.t
        ; message : Id.Comment.t
        ; recipients : Recipient.t list
        ; teams : Communication_id.Team.t list
        ; resolver : Id.Actor.t
        ; correlation_id : string option
        ; reply_to : Communication_id.Request.t option
        ; deadline_unix_ms : string option
        }
    | Request_acknowledge of
        { id : Communication_id.Request.t
        ; expected_revision : int
        ; recipient : Recipient.t
        }
    | Request_accept of
        { id : Communication_id.Request.t
        ; expected_revision : int
        ; recipient : Recipient.t
        }
    | Request_reassign of
        { id : Communication_id.Request.t
        ; expected_revision : int
        ; recipient : Recipient.t option
        }
    | Request_resolve of
        { id : Communication_id.Request.t
        ; expected_revision : int
        }
    | Request_cancel of
        { id : Communication_id.Request.t
        ; expected_revision : int
        }
    | Subscription_put of
        { id : Communication_id.Subscription.t
        ; expected_revision : int
        ; recipient : Recipient.t
        ; filter : Subscription.Filter.t
        ; active : bool
        }
    | Inbox_mark_read of
        { recipient : Recipient.t
        ; through : int
        }
  [@@deriving sexp]
end

module Attribution = Change.Attribution
module Update = Change.Update

type t =
  { revision : int
  ; boards : Board.t Communication_id.Board.Map.t
  ; threads : Thread.t Communication_id.Thread.Map.t
  ; teams : Team.t Communication_id.Team.Map.t
  ; requests : Request.t Communication_id.Request.Map.t
  ; subscriptions : Subscription.t Communication_id.Subscription.Map.t
  ; positions : int Recipient.Map.t
  ; notifications : Notification.t list
  ; history : Change.t list
  ; serial : int
  }

type prepared =
  { candidate : t
  ; changes : Change.t list
  ; result : Jsonaf.t
  }

let empty =
  { revision = 0
  ; boards = Communication_id.Board.Map.empty
  ; threads = Communication_id.Thread.Map.empty
  ; teams = Communication_id.Team.Map.empty
  ; requests = Communication_id.Request.Map.empty
  ; subscriptions = Communication_id.Subscription.Map.empty
  ; positions = Recipient.Map.empty
  ; notifications = []
  ; history = []
  ; serial = 0
  }
;;

let revision t = t.revision
let candidate p = p.candidate
let changes p = p.changes
let result p = p.result
let latest_serial t = t.serial
let inbox_position t recipient = Option.value (Map.find t.positions recipient) ~default:0
let get_board t id = Map.find t.boards id
let get_thread t id = Map.find t.threads id
let get_request t id = Map.find t.requests id
let require condition kind message = if not condition then Json.fail kind message

let find map id =
  match Map.find map id with
  | Some value -> value
  | None -> Json.fail Not_found "communication record not found"
;;

let unique values ~compare = List.dedup_and_sort values ~compare

let bounded text max =
  require
    (String.length text <= max)
    Invalid_argument
    "communication text exceeds byte limit"
;;

let title text =
  bounded text 512;
  require
    (not (String.is_empty (String.strip text)))
    Invalid_argument
    "communication title is empty"
;;

let expected current expected_revision =
  require (Int.equal current expected_revision) Conflict "communication revision conflict"
;;

let canonical values ~compare ~equal =
  require
    (List.equal equal values (unique values ~compare))
    Corrupt_store
    "communication collection is not canonical"
;;

let attribution_valid (a : Attribution.t) =
  bounded a.timestamp 128;
  require (not (String.is_empty a.timestamp)) Invalid_argument "timestamp is empty"
;;

let attribution_matches (a : Attribution.t) = function
  | Recipient.Actor actor -> Id.Actor.equal actor a.actor
  | Run run -> Option.value_map a.run ~default:false ~f:(Id.Run.equal run)
;;

let recipient_allowed attribution recipient =
  require
    (attribution_matches attribution recipient)
    Conflict
    "recipient attribution differs"
;;

let scope t thread = (find t.boards thread.Thread.board).Board.scope

let thread_target t id =
  Json.decode (fun () -> Scope.target (scope t (find t.threads id)))
;;

let next_revision map id ~revision_of =
  Option.value_map (Map.find map id) ~default:1 ~f:(fun x -> revision_of x + 1)
;;

let limit values max =
  require
    (List.length values <= max)
    Invalid_argument
    "communication collection exceeds item limit"
;;

let board_valid t (board : Board.t) =
  title board.title;
  expected
    board.revision
    (next_revision t.boards board.id ~revision_of:(fun b -> b.Board.revision));
  Option.iter (Map.find t.boards board.id) ~f:(fun old ->
    require (Scope.equal old.scope board.scope) Conflict "board scope is immutable")
;;

let thread_valid t (thread : Thread.t) =
  ignore (find t.boards thread.board : Board.t);
  title thread.title;
  expected
    thread.revision
    (next_revision t.threads thread.id ~revision_of:(fun x -> x.Thread.revision));
  limit thread.participants 1000;
  limit thread.mentions 1000;
  limit thread.links 100;
  canonical thread.participants ~compare:Id.Actor.compare ~equal:Id.Actor.equal;
  canonical thread.mentions ~compare:Id.Actor.compare ~equal:Id.Actor.equal;
  canonical thread.links ~compare:Entity_ref.compare ~equal:Entity_ref.equal;
  canonical thread.pinned_messages ~compare:Id.Comment.compare ~equal:Id.Comment.equal;
  require
    (List.length thread.messages <= 100_000)
    Invalid_argument
    "thread message limit reached";
  require
    (Int.equal
       (List.length thread.messages)
       (List.length (unique thread.messages ~compare:Id.Comment.compare)))
    Conflict
    "thread message is duplicated";
  List.iter thread.pinned_messages ~f:(fun id ->
    require
      (List.mem thread.messages id ~equal:Id.Comment.equal)
      Conflict
      "pinned message is not in thread");
  match Map.find t.threads thread.id with
  | None ->
    require
      (List.is_empty thread.messages && List.is_empty thread.pinned_messages)
      Corrupt_store
      "new thread contains messages"
  | Some old ->
    require
      (Communication_id.Board.equal old.board thread.board)
      Conflict
      "thread board is immutable";
    let old_count = List.length old.messages in
    require
      (List.equal Id.Comment.equal old.messages (List.take thread.messages old_count))
      Corrupt_store
      "thread message history changed";
    require
      (List.length thread.messages <= old_count + 1)
      Corrupt_store
      "thread attach contains several messages";
    if List.length thread.messages > old_count
    then
      require
        (not (Thread.State.equal old.state Resolved))
        Conflict
        "cannot reply to resolved thread"
;;

let team_valid t (team : Team.t) =
  title team.title;
  limit team.members 1000;
  canonical team.members ~compare:Recipient.compare ~equal:Recipient.equal;
  expected
    team.revision
    (next_revision t.teams team.id ~revision_of:(fun x -> x.Team.revision))
;;

let open_request (request : Request.t) =
  match request.status with
  | Open -> ()
  | Resolved _ | Cancelled _ -> Json.fail Conflict "request is terminal"
;;

let delivery request recipient =
  match
    List.find request.Request.deliveries ~f:(fun d ->
      Recipient.equal d.Request.Delivery.recipient recipient)
  with
  | Some d -> d
  | None -> Json.fail Conflict "actor or run is not a request recipient"
;;

let resolver request attribution =
  require
    (Id.Actor.equal request.Request.resolver attribution.Attribution.actor)
    Conflict
    "only designated resolver may perform this transition"
;;

let acknowledge request attribution recipient =
  open_request request;
  recipient_allowed attribution recipient;
  let d = delivery request recipient in
  require
    (Option.is_none d.acknowledged)
    Conflict
    "recipient already acknowledged request";
  { request with
    Request.revision = request.revision + 1
  ; deliveries =
      List.map request.deliveries ~f:(fun d ->
        if Recipient.equal d.recipient recipient
        then { d with acknowledged = Some attribution }
        else d)
  }
;;

let accept request attribution recipient =
  open_request request;
  recipient_allowed attribution recipient;
  ignore (delivery request recipient : Request.Delivery.t);
  (match request.responsibility with
   | Unaccepted -> ()
   | Accepted _ -> Json.fail Conflict "request responsibility already accepted");
  { request with
    Request.revision = request.revision + 1
  ; responsibility = Accepted { recipient; attribution }
  }
;;

let reassign request attribution recipient =
  open_request request;
  resolver request attribution;
  let responsibility =
    match recipient with
    | None -> Request.Responsibility.Unaccepted
    | Some recipient ->
      ignore (delivery request recipient : Request.Delivery.t);
      Request.Responsibility.Accepted { recipient; attribution }
  in
  { request with Request.revision = request.revision + 1; responsibility }
;;

let resolve request attribution =
  open_request request;
  resolver request attribution;
  { request with Request.revision = request.revision + 1; status = Resolved attribution }
;;

let cancel request attribution =
  open_request request;
  require
    (Id.Actor.equal request.created.actor attribution.Attribution.actor
     || Id.Actor.equal request.resolver attribution.actor)
    Conflict
    "only creator or resolver may cancel request";
  { request with Request.revision = request.revision + 1; status = Cancelled attribution }
;;

let request_valid t attribution (request : Request.t) kind =
  let thread = find t.threads request.thread in
  require
    (List.mem thread.messages request.message ~equal:Id.Comment.equal)
    Conflict
    "request message is not attached to thread";
  Option.iter request.correlation_id ~f:(fun id ->
    bounded id 128;
    require (not (String.is_empty id)) Invalid_argument "empty correlation ID");
  Option.iter request.deadline_unix_ms ~f:(fun ms ->
    ignore (Json.integer64 (Json.string ms) : int64));
  limit request.deliveries 1000;
  require
    (not (List.is_empty request.deliveries))
    Invalid_argument
    "request has no recipients";
  canonical
    (List.map request.deliveries ~f:(fun d -> d.Request.Delivery.recipient))
    ~compare:Recipient.compare
    ~equal:Recipient.equal;
  expected
    request.revision
    (next_revision t.requests request.id ~revision_of:(fun x -> x.Request.revision));
  match Map.find t.requests request.id with
  | None ->
    require
      (Notification.Kind.equal kind Request_created)
      Corrupt_store
      "invalid initial request notification";
    require
      (Attribution.equal request.created attribution)
      Corrupt_store
      "invalid request creator";
    require
      (Request.Status.equal request.status Open
       && Request.Responsibility.equal request.responsibility Unaccepted
       && List.for_all request.deliveries ~f:(fun d -> Option.is_none d.acknowledged))
      Corrupt_store
      "new request already acted upon";
    Option.iter request.reply_to ~f:(fun id ->
      let parent = find t.requests id in
      require
        (Communication_id.Thread.equal parent.thread request.thread)
        Conflict
        "request reply belongs to another thread")
  | Some old ->
    let wanted =
      match kind with
      | Request_acknowledged ->
        let changed =
          List.filter request.deliveries ~f:(fun d ->
            match
              List.find old.deliveries ~f:(fun previous ->
                Recipient.equal previous.recipient d.recipient)
            with
            | None -> true
            | Some previous -> not (Request.Delivery.equal previous d))
        in
        (match changed with
         | [ d ] -> acknowledge old attribution d.recipient
         | [] | _ :: _ ->
           Json.fail Corrupt_store "acknowledgement changes several recipients")
      | Request_accepted ->
        (match request.responsibility with
         | Accepted { recipient; _ } -> accept old attribution recipient
         | Unaccepted -> Json.fail Corrupt_store "acceptance has no recipient")
      | Request_reassigned ->
        reassign
          old
          attribution
          (match request.responsibility with
           | Unaccepted -> None
           | Accepted { recipient; _ } -> Some recipient)
      | Request_resolved -> resolve old attribution
      | Request_cancelled -> cancel old attribution
      | Thread_changed | Request_created ->
        Json.fail Corrupt_store "invalid request transition kind"
    in
    require
      (Request.equal request wanted)
      Corrupt_store
      "request transition changed immutable fields"
;;

let subscription_valid t attribution (subscription : Subscription.t) =
  recipient_allowed attribution subscription.recipient;
  expected
    subscription.revision
    (next_revision t.subscriptions subscription.id ~revision_of:(fun x ->
       x.Subscription.revision));
  Option.iter subscription.filter.thread ~f:(fun id ->
    ignore (find t.threads id : Thread.t));
  canonical
    subscription.filter.kinds
    ~compare:(fun a b ->
      String.compare
        (Sexp.to_string (Notification.Kind.sexp_of_t a))
        (Sexp.to_string (Notification.Kind.sexp_of_t b)))
    ~equal:Notification.Kind.equal;
  Option.iter (Map.find t.subscriptions subscription.id) ~f:(fun old ->
    require
      (Recipient.equal old.recipient subscription.recipient)
      Conflict
      "subscription recipient is immutable")
;;

let update t attribution = function
  | Update.Board_put board ->
    board_valid t board;
    { t with boards = Map.set t.boards ~key:board.id ~data:board }
  | Thread_put thread ->
    thread_valid t thread;
    { t with threads = Map.set t.threads ~key:thread.id ~data:thread }
  | Team_put team ->
    team_valid t team;
    { t with teams = Map.set t.teams ~key:team.id ~data:team }
  | Request_put { request; kind } ->
    request_valid t attribution request kind;
    { t with requests = Map.set t.requests ~key:request.id ~data:request }
  | Subscription_put subscription ->
    subscription_valid t attribution subscription;
    { t with
      subscriptions = Map.set t.subscriptions ~key:subscription.id ~data:subscription
    }
  | Cursor_advanced { recipient; through } ->
    recipient_allowed attribution recipient;
    require
      (through >= inbox_position t recipient && through <= t.serial)
      Conflict
      "inbox read cursor is outside retained activity";
    { t with positions = Map.set t.positions ~key:recipient ~data:through }
;;

let notification t event_update ~sequence ~attribution =
  let info =
    match event_update with
    | Update.Thread_put thread ->
      Some
        ( thread
        , Notification.Source.Thread thread.id
        , thread.revision
        , Notification.Kind.Thread_changed
        , List.map (thread.participants @ thread.mentions) ~f:(fun id ->
            Recipient.Actor id) )
    | Request_put { request; kind } ->
      Some
        ( find t.threads request.thread
        , Notification.Source.Request request.id
        , request.revision
        , kind
        , List.map request.deliveries ~f:(fun d -> d.Request.Delivery.recipient) )
    | Board_put _ | Team_put _ | Subscription_put _ | Cursor_advanced _ -> None
  in
  match info with
  | None -> []
  | Some (thread, source, source_revision, kind, direct) ->
    let scope = scope t thread in
    let recipients =
      Map.data t.subscriptions
      |> List.filter_map ~f:(fun s ->
        if
          s.Subscription.active
          && Option.value_map s.filter.scope ~default:true ~f:(Scope.equal scope)
          && Option.value_map
               s.filter.thread
               ~default:true
               ~f:(Communication_id.Thread.equal thread.id)
          && (List.is_empty s.filter.kinds
              || List.mem s.filter.kinds kind ~equal:Notification.Kind.equal)
        then Some s.recipient
        else None)
    in
    [ { Notification.serial = t.serial + 1
      ; sequence
      ; scope
      ; source
      ; source_revision
      ; kind
      ; attribution
      ; recipients = unique (direct @ recipients) ~compare:Recipient.compare
      }
    ]
;;

let apply_exn t (change : Change.t) =
  require
    (Int.equal change.version 1)
    Unsupported_version
    "unsupported communication event version";
  expected change.revision (t.revision + 1);
  require (change.sequence > 0) Corrupt_store "invalid workspace sequence";
  Option.iter (List.hd t.history) ~f:(fun previous ->
    require
      (change.sequence >= previous.sequence)
      Corrupt_store
      "communication workspace sequence moved backwards");
  attribution_valid change.attribution;
  let updated = update t change.attribution change.update in
  let notifications =
    notification
      updated
      change.update
      ~sequence:change.sequence
      ~attribution:change.attribution
  in
  require
    (List.equal Notification.equal notifications change.notifications)
    Corrupt_store
    "notification delivery differs from resolved event";
  { updated with
    revision = change.revision
  ; serial = t.serial + List.length notifications
  ; notifications = List.rev_append notifications t.notifications
  ; history = change :: t.history
  }
;;

let apply t change = Json.decode (fun () -> apply_exn t change)

let command_update t command attribution =
  match command with
  | Command.Board_put { id; expected_revision; scope; title } ->
    expected
      (Option.value_map (Map.find t.boards id) ~default:0 ~f:(fun x -> x.Board.revision))
      expected_revision;
    Update.Board_put { id; revision = expected_revision + 1; scope; title }
  | Thread_put
      { id
      ; expected_revision
      ; board
      ; title
      ; participants
      ; mentions
      ; links
      ; state
      ; pinned
      } ->
    let old = Map.find t.threads id in
    expected
      (Option.value_map old ~default:0 ~f:(fun x -> x.Thread.revision))
      expected_revision;
    Update.Thread_put
      { id
      ; revision = expected_revision + 1
      ; board
      ; title
      ; participants = unique participants ~compare:Id.Actor.compare
      ; mentions = unique mentions ~compare:Id.Actor.compare
      ; links = unique links ~compare:Entity_ref.compare
      ; state
      ; pinned
      ; messages = Option.value_map old ~default:[] ~f:(fun x -> x.Thread.messages)
      ; pinned_messages =
          Option.value_map old ~default:[] ~f:(fun x -> x.Thread.pinned_messages)
      }
  | Thread_attach { id; expected_revision; message } ->
    let thread = find t.threads id in
    expected thread.revision expected_revision;
    Update.Thread_put
      { thread with
        revision = thread.revision + 1
      ; messages = thread.messages @ [ message ]
      }
  | Thread_pin_message { id; expected_revision; message; pinned } ->
    let thread = find t.threads id in
    expected thread.revision expected_revision;
    require
      (List.mem thread.messages message ~equal:Id.Comment.equal)
      Conflict
      "pinned message is not attached to thread";
    let pinned_messages =
      if pinned
      then unique (message :: thread.pinned_messages) ~compare:Id.Comment.compare
      else
        List.filter thread.pinned_messages ~f:(fun id ->
          not (Id.Comment.equal id message))
    in
    Update.Thread_put { thread with revision = thread.revision + 1; pinned_messages }
  | Team_put { id; expected_revision; title; members } ->
    expected
      (Option.value_map (Map.find t.teams id) ~default:0 ~f:(fun x -> x.Team.revision))
      expected_revision;
    Update.Team_put
      { id
      ; revision = expected_revision + 1
      ; title
      ; members = unique members ~compare:Recipient.compare
      }
  | Request_create
      { id
      ; thread
      ; kind
      ; message
      ; recipients
      ; teams
      ; resolver
      ; correlation_id
      ; reply_to
      ; deadline_unix_ms
      } ->
    require (not (Map.mem t.requests id)) Conflict "request already exists";
    let recipients =
      unique
        (recipients @ List.concat_map teams ~f:(fun id -> (find t.teams id).Team.members))
        ~compare:Recipient.compare
    in
    let request =
      { Request.id
      ; revision = 1
      ; thread
      ; kind
      ; message
      ; correlation_id
      ; reply_to
      ; deadline_unix_ms
      ; resolver
      ; created = attribution
      ; deliveries =
          List.map recipients ~f:(fun recipient ->
            { Request.Delivery.recipient; acknowledged = None })
      ; responsibility = Unaccepted
      ; status = Open
      }
    in
    Update.Request_put { request; kind = Request_created }
  | Request_acknowledge { id; expected_revision; recipient } ->
    let old = find t.requests id in
    expected old.revision expected_revision;
    Update.Request_put
      { request = acknowledge old attribution recipient; kind = Request_acknowledged }
  | Request_accept { id; expected_revision; recipient } ->
    let old = find t.requests id in
    expected old.revision expected_revision;
    Update.Request_put
      { request = accept old attribution recipient; kind = Request_accepted }
  | Request_reassign { id; expected_revision; recipient } ->
    let old = find t.requests id in
    expected old.revision expected_revision;
    Update.Request_put
      { request = reassign old attribution recipient; kind = Request_reassigned }
  | Request_resolve { id; expected_revision } ->
    let old = find t.requests id in
    expected old.revision expected_revision;
    Update.Request_put { request = resolve old attribution; kind = Request_resolved }
  | Request_cancel { id; expected_revision } ->
    let old = find t.requests id in
    expected old.revision expected_revision;
    Update.Request_put { request = cancel old attribution; kind = Request_cancelled }
  | Subscription_put { id; expected_revision; recipient; filter; active } ->
    expected
      (Option.value_map (Map.find t.subscriptions id) ~default:0 ~f:(fun x ->
         x.Subscription.revision))
      expected_revision;
    let kinds =
      unique filter.kinds ~compare:(fun a b ->
        String.compare
          (Sexp.to_string (Notification.Kind.sexp_of_t a))
          (Sexp.to_string (Notification.Kind.sexp_of_t b)))
    in
    Update.Subscription_put
      { id
      ; revision = expected_revision + 1
      ; recipient
      ; filter = { filter with kinds }
      ; active
      }
  | Inbox_mark_read { recipient; through } ->
    Update.Cursor_advanced { recipient; through }
;;

let update_json = function
  | Update.Board_put x -> Board.jsonaf_of_t x
  | Thread_put x -> Thread.jsonaf_of_t x
  | Team_put x -> Team.jsonaf_of_t x
  | Request_put { request; _ } -> Request.jsonaf_of_t request
  | Subscription_put x -> Subscription.jsonaf_of_t x
  | Cursor_advanced { recipient; through } ->
    Json.obj [ "recipient", Recipient.jsonaf_of_t recipient; "through", Json.int through ]
;;

let prepare t command ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let attribution = { Attribution.actor; run; timestamp } in
    attribution_valid attribution;
    let event_update = command_update t command attribution in
    let updated = update t attribution event_update in
    let change =
      { Change.version = 1
      ; revision = t.revision + 1
      ; sequence
      ; attribution
      ; update = event_update
      ; notifications = notification updated event_update ~sequence ~attribution
      }
    in
    let candidate = apply_exn t change in
    { candidate; changes = [ change ]; result = update_json event_update })
;;

let validate_references t ~entity_exists ~discussion =
  Json.decode (fun () ->
    let check entity =
      require (entity_exists entity) Not_found "communication entity reference not found"
    in
    Map.iter t.boards ~f:(fun board -> check (Scope.target board.Board.scope));
    Map.iter t.threads ~f:(fun thread ->
      List.iter thread.Thread.links ~f:check;
      let target = Scope.target (scope t thread) in
      List.iter thread.messages ~f:(fun comment ->
        require
          (Entity_ref.equal target (Discussion.target discussion comment))
          Conflict
          "thread comment targets another scope"));
    Map.iter t.subscriptions ~f:(fun s ->
      Option.iter s.Subscription.filter.scope ~f:(fun scope -> check (Scope.target scope))))
;;

let thread_history t id =
  List.rev t.history
  |> List.filter_map ~f:(fun change ->
    match change.Change.update with
    | Thread_put thread when Communication_id.Thread.equal thread.id id -> Some thread
    | Board_put _
    | Thread_put _
    | Team_put _
    | Request_put _
    | Subscription_put _
    | Cursor_advanced _ -> None)
;;

let request_history t id =
  List.rev t.history
  |> List.filter_map ~f:(fun change ->
    match change.Change.update with
    | Request_put { request; _ } when Communication_id.Request.equal request.id id ->
      Some request
    | Board_put _
    | Thread_put _
    | Team_put _
    | Request_put _
    | Subscription_put _
    | Cursor_advanced _ -> None)
;;

let inbox t ~recipient ~after ~through =
  let through = Option.value through ~default:t.serial in
  List.rev t.notifications
  |> List.filter ~f:(fun n ->
    n.Notification.serial > after
    && n.serial <= through
    && List.mem n.recipients recipient ~equal:Recipient.equal)
;;

let to_json t =
  Json.obj
    [ "version", Json.int 1
    ; "revision", Json.int t.revision
    ; "events", `Array (List.rev_map t.history ~f:Change.jsonaf_of_t)
    ]
;;

let mutation_methods =
  [ "board.put"
  ; "thread.put"
  ; "thread.attach"
  ; "thread.pin_message"
  ; "team.put"
  ; "request.create"
  ; "request.acknowledge"
  ; "request.accept"
  ; "request.reassign"
  ; "request.resolve"
  ; "request.cancel"
  ; "subscription.put"
  ; "inbox.mark_read"
  ]
;;

let query_methods =
  [ "board.get"
  ; "board.list"
  ; "thread.get"
  ; "thread.list"
  ; "thread.history"
  ; "thread.search"
  ; "team.get"
  ; "team.list"
  ; "request.get"
  ; "request.list"
  ; "request.history"
  ; "subscription.get"
  ; "subscription.list"
  ; "inbox.read"
  ]
;;

let boolean = function
  | `True -> true
  | `False -> false
  | _ -> Json.fail Invalid_argument "expected boolean"
;;

let optional params key f =
  match Json.optional params key with
  | None | Some `Null -> None
  | Some json -> Some (f json)
;;

let list_field params key f =
  Option.value_map (Json.optional params key) ~default:[] ~f:(fun json ->
    List.map (Json.list json) ~f)
;;

let filter_decode json =
  Json.fields json ~allowed:[ "scope"; "thread_id"; "kinds" ];
  let kind = function
    | "thread_changed" -> Notification.Kind.Thread_changed
    | "request_created" -> Request_created
    | "request_acknowledged" -> Request_acknowledged
    | "request_accepted" -> Request_accepted
    | "request_reassigned" -> Request_reassigned
    | "request_resolved" -> Request_resolved
    | "request_cancelled" -> Request_cancelled
    | _ -> Json.fail Invalid_argument "unknown notification kind"
  in
  { Subscription.Filter.scope = optional json "scope" Scope.t_of_jsonaf
  ; thread = optional json "thread_id" Communication_id.Thread.t_of_jsonaf
  ; kinds = list_field json "kinds" (fun value -> kind (Json.text value))
  }
;;

let decode ~method_ ~params =
  Json.decode (fun () ->
    let get key = Json.field params key in
    let expected_revision () = Json.integer (get "expected_revision") in
    let thread () = Communication_id.Thread.t_of_jsonaf (get "thread_id") in
    let request () = Communication_id.Request.t_of_jsonaf (get "request_id") in
    let recipient () = Recipient.t_of_jsonaf (get "recipient") in
    let allow fields = Json.fields params ~allowed:fields in
    match method_ with
    | "board.put" ->
      allow [ "board_id"; "expected_revision"; "scope"; "title" ];
      Command.Board_put
        { id = Communication_id.Board.t_of_jsonaf (get "board_id")
        ; expected_revision = expected_revision ()
        ; scope = Scope.t_of_jsonaf (get "scope")
        ; title = Json.text (get "title")
        }
    | "thread.put" ->
      allow
        [ "thread_id"
        ; "expected_revision"
        ; "board_id"
        ; "title"
        ; "participants"
        ; "mentions"
        ; "links"
        ; "state"
        ; "pinned"
        ];
      Command.Thread_put
        { id = thread ()
        ; expected_revision = expected_revision ()
        ; board = Communication_id.Board.t_of_jsonaf (get "board_id")
        ; title = Json.text (get "title")
        ; participants = list_field params "participants" Id.Actor.t_of_jsonaf
        ; mentions = list_field params "mentions" Id.Actor.t_of_jsonaf
        ; links = list_field params "links" Entity_ref.t_of_jsonaf
        ; state = Thread.State.t_of_jsonaf (get "state")
        ; pinned = Option.value (optional params "pinned" boolean) ~default:false
        }
    | "thread.attach" ->
      allow [ "thread_id"; "expected_revision"; "comment_id" ];
      Command.Thread_attach
        { id = thread ()
        ; expected_revision = expected_revision ()
        ; message = Id.Comment.t_of_jsonaf (get "comment_id")
        }
    | "thread.pin_message" ->
      allow [ "thread_id"; "expected_revision"; "comment_id"; "pinned" ];
      Command.Thread_pin_message
        { id = thread ()
        ; expected_revision = expected_revision ()
        ; message = Id.Comment.t_of_jsonaf (get "comment_id")
        ; pinned = boolean (get "pinned")
        }
    | "team.put" ->
      allow [ "team_id"; "expected_revision"; "title"; "members" ];
      Command.Team_put
        { id = Communication_id.Team.t_of_jsonaf (get "team_id")
        ; expected_revision = expected_revision ()
        ; title = Json.text (get "title")
        ; members = list_field params "members" Recipient.t_of_jsonaf
        }
    | "request.create" ->
      allow
        [ "request_id"
        ; "thread_id"
        ; "kind"
        ; "comment_id"
        ; "recipients"
        ; "teams"
        ; "resolver_id"
        ; "correlation_id"
        ; "reply_to"
        ; "deadline_unix_ms"
        ];
      Command.Request_create
        { id = request ()
        ; thread = thread ()
        ; kind = Request.Kind.t_of_jsonaf (get "kind")
        ; message = Id.Comment.t_of_jsonaf (get "comment_id")
        ; recipients = list_field params "recipients" Recipient.t_of_jsonaf
        ; teams = list_field params "teams" Communication_id.Team.t_of_jsonaf
        ; resolver = Id.Actor.t_of_jsonaf (get "resolver_id")
        ; correlation_id = optional params "correlation_id" Json.text
        ; reply_to = optional params "reply_to" Communication_id.Request.t_of_jsonaf
        ; deadline_unix_ms =
            optional params "deadline_unix_ms" (fun json ->
              ignore (Json.integer64 json : int64);
              Json.text json)
        }
    | "request.acknowledge" | "request.accept" ->
      allow [ "request_id"; "expected_revision"; "recipient" ];
      let id = request ()
      and expected_revision = expected_revision ()
      and recipient = recipient () in
      if String.equal method_ "request.acknowledge"
      then Command.Request_acknowledge { id; expected_revision; recipient }
      else Request_accept { id; expected_revision; recipient }
    | "request.reassign" ->
      allow [ "request_id"; "expected_revision"; "recipient" ];
      Command.Request_reassign
        { id = request ()
        ; expected_revision = expected_revision ()
        ; recipient = optional params "recipient" Recipient.t_of_jsonaf
        }
    | "request.resolve" | "request.cancel" ->
      allow [ "request_id"; "expected_revision" ];
      let id = request ()
      and expected_revision = expected_revision () in
      if String.equal method_ "request.resolve"
      then Command.Request_resolve { id; expected_revision }
      else Request_cancel { id; expected_revision }
    | "subscription.put" ->
      allow [ "subscription_id"; "expected_revision"; "recipient"; "filter"; "active" ];
      Command.Subscription_put
        { id = Communication_id.Subscription.t_of_jsonaf (get "subscription_id")
        ; expected_revision = expected_revision ()
        ; recipient = recipient ()
        ; filter = filter_decode (get "filter")
        ; active = boolean (get "active")
        }
    | "inbox.mark_read" ->
      allow [ "recipient"; "through" ];
      Command.Inbox_mark_read
        { recipient = recipient (); through = Json.integer (get "through") }
    | _ -> Json.fail Invalid_argument "unknown communication mutation")
;;

let query t ~method_ ~params =
  Json.decode (fun () ->
    let get key = Json.field params key in
    let allowed fields = Json.fields params ~allowed:("max_bytes" :: fields) in
    let scope_filter = optional params "scope" Scope.t_of_jsonaf in
    let scope_matches scope =
      Option.value_map scope_filter ~default:true ~f:(Scope.equal scope)
    in
    let recipient = optional params "recipient" Recipient.t_of_jsonaf in
    let page fields records =
      allowed (fields @ [ "offset"; "limit"; "revision" ]);
      let offset = Option.value (optional params "offset" Json.integer) ~default:0 in
      let limit = Option.value (optional params "limit" Json.integer) ~default:50 in
      require
        (limit > 0 && limit <= 100)
        Invalid_argument
        "communication query limit must be 1..100";
      if offset > 0 then expected t.revision (Json.integer (get "revision"));
      let items = List.take (List.drop records offset) limit in
      let remaining = Int.max 0 (List.length records - offset - List.length items) in
      Json.obj
        [ "revision", Json.int t.revision
        ; "items", `Array items
        ; "offset", Json.int offset
        ; "remaining", Json.int remaining
        ; ( "next_offset"
          , if remaining > 0 then Json.int (offset + List.length items) else `Null )
        ]
    in
    let direct fields json =
      allowed fields;
      Json.obj [ "revision", Json.int t.revision; "record", json ]
    in
    let output =
      match method_ with
      | "board.get" ->
        direct
          [ "board_id" ]
          (Board.jsonaf_of_t
             (find t.boards (Communication_id.Board.t_of_jsonaf (get "board_id"))))
      | "board.list" ->
        Map.data t.boards
        |> List.filter ~f:(fun b -> scope_matches b.Board.scope)
        |> List.map ~f:Board.jsonaf_of_t
        |> page [ "scope" ]
      | "team.get" ->
        direct
          [ "team_id" ]
          (Team.jsonaf_of_t
             (find t.teams (Communication_id.Team.t_of_jsonaf (get "team_id"))))
      | "team.list" -> page [] (List.map (Map.data t.teams) ~f:Team.jsonaf_of_t)
      | "thread.get" ->
        direct
          [ "thread_id" ]
          (Thread.jsonaf_of_t
             (find t.threads (Communication_id.Thread.t_of_jsonaf (get "thread_id"))))
      | "thread.history" ->
        let id = Communication_id.Thread.t_of_jsonaf (get "thread_id") in
        ignore (find t.threads id : Thread.t);
        page [ "thread_id" ] (List.map (thread_history t id) ~f:Thread.jsonaf_of_t)
      | "thread.list" | "thread.search" ->
        let board = optional params "board_id" Communication_id.Board.t_of_jsonaf in
        let actor = optional params "actor_id" Id.Actor.t_of_jsonaf in
        let state = optional params "state" Thread.State.t_of_jsonaf in
        let unresolved =
          Option.value (optional params "unresolved" boolean) ~default:false
        in
        let text =
          optional params "text" (fun x ->
            String.lowercase (Json.bounded_text x ~max_bytes:512))
        in
        Map.data t.threads
        |> List.filter ~f:(fun thread ->
          scope_matches (scope t thread)
          && Option.value_map
               board
               ~default:true
               ~f:(Communication_id.Board.equal thread.board)
          && Option.value_map actor ~default:true ~f:(fun actor ->
            List.mem thread.participants actor ~equal:Id.Actor.equal
            || List.mem thread.mentions actor ~equal:Id.Actor.equal)
          && Option.value_map state ~default:true ~f:(Thread.State.equal thread.state)
          && ((not unresolved) || not (Thread.State.equal thread.state Resolved))
          && Option.value_map text ~default:true ~f:(fun text ->
            String.is_substring (String.lowercase thread.title) ~substring:text))
        |> List.map ~f:Thread.jsonaf_of_t
        |> page [ "scope"; "board_id"; "actor_id"; "state"; "unresolved"; "text" ]
      | "request.get" ->
        direct
          [ "request_id" ]
          (Request.jsonaf_of_t
             (find t.requests (Communication_id.Request.t_of_jsonaf (get "request_id"))))
      | "request.history" ->
        let id = Communication_id.Request.t_of_jsonaf (get "request_id") in
        ignore (find t.requests id : Request.t);
        page [ "request_id" ] (List.map (request_history t id) ~f:Request.jsonaf_of_t)
      | "request.list" ->
        let thread = optional params "thread_id" Communication_id.Thread.t_of_jsonaf in
        let kind = optional params "kind" Request.Kind.t_of_jsonaf in
        let open_only =
          Option.value (optional params "open_only" boolean) ~default:false
        in
        let unanswered =
          Option.value (optional params "unanswered" boolean) ~default:false
        in
        let responsible = optional params "responsible" Recipient.t_of_jsonaf in
        let overdue_at = optional params "overdue_at_unix_ms" Json.integer64 in
        Map.data t.requests
        |> List.filter ~f:(fun request ->
          scope_matches (scope t (find t.threads request.thread))
          && Option.value_map
               thread
               ~default:true
               ~f:(Communication_id.Thread.equal request.thread)
          && Option.value_map kind ~default:true ~f:(Request.Kind.equal request.kind)
          && Option.value_map recipient ~default:true ~f:(fun recipient ->
            List.exists request.deliveries ~f:(fun d ->
              Recipient.equal d.recipient recipient))
          && ((not open_only) || Request.Status.equal request.status Open)
          && ((not unanswered)
              || (Request.Status.equal request.status Open
                  && List.exists request.deliveries ~f:(fun d ->
                    Option.is_none d.acknowledged)))
          && Option.value_map responsible ~default:true ~f:(fun recipient ->
            match request.responsibility with
            | Unaccepted -> false
            | Accepted responsibility ->
              Recipient.equal recipient responsibility.recipient)
          && Option.value_map overdue_at ~default:true ~f:(fun now ->
            Request.Status.equal request.status Open
            && Option.value_map request.deadline_unix_ms ~default:false ~f:(fun ms ->
              Int64.(Json.integer64 (Json.string ms) < now))))
        |> List.map ~f:Request.jsonaf_of_t
        |> page
             [ "scope"
             ; "thread_id"
             ; "kind"
             ; "recipient"
             ; "open_only"
             ; "unanswered"
             ; "responsible"
             ; "overdue_at_unix_ms"
             ]
      | "subscription.get" ->
        direct
          [ "subscription_id" ]
          (Subscription.jsonaf_of_t
             (find
                t.subscriptions
                (Communication_id.Subscription.t_of_jsonaf (get "subscription_id"))))
      | "subscription.list" ->
        Map.data t.subscriptions
        |> List.filter ~f:(fun s ->
          Option.value_map
            recipient
            ~default:true
            ~f:(Recipient.equal s.Subscription.recipient))
        |> List.map ~f:Subscription.jsonaf_of_t
        |> page [ "recipient" ]
      | "inbox.read" ->
        allowed [ "recipient"; "after"; "through"; "limit" ];
        let recipient = Recipient.t_of_jsonaf (get "recipient") in
        let after =
          Option.value
            (optional params "after" Json.integer)
            ~default:(inbox_position t recipient)
        in
        let through =
          Option.value (optional params "through" Json.integer) ~default:t.serial
        in
        require
          (after <= through && through <= t.serial)
          Invalid_argument
          "inbox cursor outside retained activity";
        let limit = Option.value (optional params "limit" Json.integer) ~default:50 in
        require (limit > 0 && limit <= 100) Invalid_argument "inbox limit must be 1..100";
        let records = inbox t ~recipient ~after ~through:(Some through) in
        let items = List.take records limit in
        let remaining = List.length records - List.length items in
        let last =
          Option.value_map (List.last items) ~default:after ~f:(fun n ->
            n.Notification.serial)
        in
        let max_bytes = Query_budget.of_params params in
        let rec fit items =
          let remaining = List.length records - List.length items in
          let last =
            Option.value_map (List.last items) ~default:after ~f:(fun n ->
              n.Notification.serial)
          in
          let value =
            Json.obj
              [ "revision", Json.int t.revision
              ; "items", `Array (List.map items ~f:Notification.jsonaf_of_t)
              ; "through", Json.int through
              ; "next_after", Json.int (if remaining > 0 then last else through)
              ; "remaining", Json.int remaining
              ; "read_position", Json.int (inbox_position t recipient)
              ; "max_bytes", Json.int max_bytes
              ]
          in
          if String.length (Json.canonical value) <= max_bytes
          then value
          else (
            match List.drop_last items with
            | Some rest when not (List.is_empty rest) -> fit rest
            | None | Some _ ->
              Json.fail
                Invalid_argument
                "inbox notification exceeds byte budget; increase max_bytes")
        in
        ignore ((remaining, last) : int * int);
        fit items
      | _ -> Json.fail Invalid_argument "unknown communication query"
    in
    if String.equal method_ "inbox.read"
    then output
    else Query_budget.fit ~max_bytes:(Query_budget.of_params params) output)
;;

let kind_wire = function
  | Notification.Kind.Thread_changed -> "thread_changed"
  | Request_created -> "request_created"
  | Request_acknowledged -> "request_acknowledged"
  | Request_accepted -> "request_accepted"
  | Request_reassigned -> "request_reassigned"
  | Request_resolved -> "request_resolved"
  | Request_cancelled -> "request_cancelled"
;;

let encode command =
  let optional f = Option.value_map ~default:`Null ~f in
  let array f xs = `Array (List.map xs ~f) in
  let bool b = if b then `True else `False in
  let common id expected_revision =
    [ "request_id", Communication_id.Request.jsonaf_of_t id
    ; "expected_revision", Json.int expected_revision
    ]
  in
  let method_, fields =
    match command with
    | Command.Board_put { id; expected_revision; scope; title } ->
      ( "board.put"
      , [ "board_id", Communication_id.Board.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "scope", Scope.jsonaf_of_t scope
        ; "title", Json.string title
        ] )
    | Thread_put
        { id
        ; expected_revision
        ; board
        ; title
        ; participants
        ; mentions
        ; links
        ; state
        ; pinned
        } ->
      ( "thread.put"
      , [ "thread_id", Communication_id.Thread.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "board_id", Communication_id.Board.jsonaf_of_t board
        ; "title", Json.string title
        ; "participants", array Id.Actor.jsonaf_of_t participants
        ; "mentions", array Id.Actor.jsonaf_of_t mentions
        ; "links", array Entity_ref.jsonaf_of_t links
        ; "state", Thread.State.jsonaf_of_t state
        ; "pinned", bool pinned
        ] )
    | Thread_attach { id; expected_revision; message } ->
      ( "thread.attach"
      , [ "thread_id", Communication_id.Thread.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "comment_id", Id.Comment.jsonaf_of_t message
        ] )
    | Thread_pin_message { id; expected_revision; message; pinned } ->
      ( "thread.pin_message"
      , [ "thread_id", Communication_id.Thread.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "comment_id", Id.Comment.jsonaf_of_t message
        ; "pinned", bool pinned
        ] )
    | Team_put { id; expected_revision; title; members } ->
      ( "team.put"
      , [ "team_id", Communication_id.Team.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "title", Json.string title
        ; "members", array Recipient.jsonaf_of_t members
        ] )
    | Request_create
        { id
        ; thread
        ; kind
        ; message
        ; recipients
        ; teams
        ; resolver
        ; correlation_id
        ; reply_to
        ; deadline_unix_ms
        } ->
      ( "request.create"
      , [ "request_id", Communication_id.Request.jsonaf_of_t id
        ; "thread_id", Communication_id.Thread.jsonaf_of_t thread
        ; "kind", Request.Kind.jsonaf_of_t kind
        ; "comment_id", Id.Comment.jsonaf_of_t message
        ; "recipients", array Recipient.jsonaf_of_t recipients
        ; "teams", array Communication_id.Team.jsonaf_of_t teams
        ; "resolver_id", Id.Actor.jsonaf_of_t resolver
        ; "correlation_id", optional Json.string correlation_id
        ; "reply_to", optional Communication_id.Request.jsonaf_of_t reply_to
        ; "deadline_unix_ms", optional Json.string deadline_unix_ms
        ] )
    | Request_acknowledge { id; expected_revision; recipient } ->
      ( "request.acknowledge"
      , common id expected_revision @ [ "recipient", Recipient.jsonaf_of_t recipient ] )
    | Request_accept { id; expected_revision; recipient } ->
      ( "request.accept"
      , common id expected_revision @ [ "recipient", Recipient.jsonaf_of_t recipient ] )
    | Request_reassign { id; expected_revision; recipient } ->
      ( "request.reassign"
      , common id expected_revision
        @ [ "recipient", optional Recipient.jsonaf_of_t recipient ] )
    | Request_resolve { id; expected_revision } ->
      "request.resolve", common id expected_revision
    | Request_cancel { id; expected_revision } ->
      "request.cancel", common id expected_revision
    | Subscription_put { id; expected_revision; recipient; filter; active } ->
      ( "subscription.put"
      , [ "subscription_id", Communication_id.Subscription.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "recipient", Recipient.jsonaf_of_t recipient
        ; ( "filter"
          , Json.obj
              [ "scope", optional Scope.jsonaf_of_t filter.scope
              ; "thread_id", optional Communication_id.Thread.jsonaf_of_t filter.thread
              ; "kinds", array (fun kind -> Json.string (kind_wire kind)) filter.kinds
              ] )
        ; "active", bool active
        ] )
    | Inbox_mark_read { recipient; through } ->
      ( "inbox.mark_read"
      , [ "recipient", Recipient.jsonaf_of_t recipient; "through", Json.int through ] )
  in
  let params = Json.obj fields in
  Result.map (decode ~method_ ~params) ~f:(fun _ -> method_, params)
;;

let change_targets t (change : Change.t) =
  let thread_targets (thread : Thread.t) =
    Scope.target (scope t thread) :: thread.links
  in
  let subscription_targets (subscription : Subscription.t) =
    Option.to_list (Option.map subscription.filter.scope ~f:Scope.target)
    @ Option.value_map subscription.filter.thread ~default:[] ~f:(fun id ->
      thread_targets (find t.threads id))
  in
  let targets =
    match change.update with
    | Update.Board_put board -> [ Scope.target board.scope ]
    | Thread_put thread ->
      thread_targets thread
      @ Option.value_map (get_thread t thread.id) ~default:[] ~f:thread_targets
    | Request_put { request; _ } -> thread_targets (find t.threads request.thread)
    | Subscription_put subscription ->
      Entity_ref.Workspace
      :: (subscription_targets subscription
          @ Option.value_map
              (Map.find t.subscriptions subscription.id)
              ~default:[]
              ~f:subscription_targets)
    | Team_put _ | Cursor_advanced _ -> [ Entity_ref.Workspace ]
  in
  unique targets ~compare:Entity_ref.compare
;;

let boards t = Map.data t.boards
let threads t = Map.data t.threads
let requests t = Map.data t.requests
