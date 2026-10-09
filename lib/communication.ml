open Core

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

module Recipient = Communication_event.Recipient
module Scope = Communication_event.Scope
module Board = Communication_event.Board
module Thread = Communication_event.Thread
module Team = Communication_event.Team
module Request = Communication_event.Request
module Message = Communication_event.Message
module Notification = Communication_event.Notification
module Subscription = Communication_event.Subscription
module Change = Communication_event
module Attribution = Communication_event.Attribution
module Update = Communication_event.Update

module Message_send = struct
  type t =
    { message_id : Communication_id.Message.t
    ; body : string
    ; ticket_id : Id.Ticket.t option
    ; recipients : Recipient.t list
    ; teams : Communication_id.Team.t list
    ; reply_to_message_id : Communication_id.Message.t option
    ; correlation_id : string option
    }
  [@@deriving sexp]

  module Fields = Api_codec.Fields

  let identifier decode encode =
    Api_codec.map
      (Api_codec.text ~max_bytes:96)
      ~decode
      ~encode
      ~description:"Opaque validated identity."
  ;;

  let message =
    identifier Communication_id.Message.of_string Communication_id.Message.to_string
  ;;

  let team = identifier Communication_id.Team.of_string Communication_id.Team.to_string
  let ticket = identifier Id.Ticket.of_string Id.Ticket.to_string
  let recipient = Communication_recipient.codec

  let nonblank max_bytes description =
    Api_codec.map
      (Api_codec.text ~max_bytes)
      ~decode:(fun text ->
        if String.is_empty (String.strip text)
        then Error (Problem.create Invalid_argument description)
        else Ok text)
      ~encode:Fn.id
      ~description
  ;;

  let codec =
    let identity =
      Fields.both
        (Fields.required "message_id" message)
        (Fields.required
           "body"
           (nonblank 65_536 "Message body must be nonblank UTF-8, up to 65536 bytes."))
    in
    let routing =
      Fields.both
        (Fields.optional "recipients" (Api_codec.list recipient ~max_items:256))
        (Fields.optional "teams" (Api_codec.list team ~max_items:256))
    in
    let linkage =
      Fields.both
        (Fields.optional "ticket_id" ticket)
        (Fields.optional "reply_to_message_id" message)
    in
    let fields =
      Fields.both
        (Fields.both identity routing)
        (Fields.both
           linkage
           (Fields.optional
              "correlation_id"
              (nonblank 512 "Correlation ID must be nonblank UTF-8, up to 512 bytes.")))
    in
    Api_codec.map
      (Api_codec.object_ fields)
      ~decode:
        (fun
          ( ((message_id, body), (recipients, teams))
          , ((ticket_id, reply_to_message_id), correlation_id) ) ->
        let recipients = Option.value recipients ~default:[] in
        let teams = Option.value teams ~default:[] in
        if List.is_empty recipients && List.is_empty teams
        then
          Error
            (Problem.create Invalid_argument "message.send requires recipients or teams")
        else
          Ok
            { message_id
            ; body
            ; ticket_id
            ; recipients
            ; teams
            ; reply_to_message_id
            ; correlation_id
            })
      ~encode:(fun t ->
        ( ((t.message_id, t.body), (Some t.recipients, Some t.teams))
        , ((t.ticket_id, t.reply_to_message_id), t.correlation_id) ))
      ~description:
        "An immutable-body informal exchange. Routing freezes actual actor/run \
         deliveries at commit; reply IDs name existing messages."
  ;;

  let receipt_codec =
    let revision =
      Api_codec.map
        (Api_codec.decimal ~max:1)
        ~decode:(fun value ->
          if value = 1
          then Ok value
          else Error (Problem.create Invalid_argument "message receipt pins revision 1"))
        ~encode:Fn.id
        ~description:"Pinned initial comment revision."
    in
    let positive_serial =
      Api_codec.map
        (Api_codec.decimal ~max:Int.max_value)
        ~decode:(fun value ->
          if value > 0
          then Ok value
          else Error (Problem.create Invalid_argument "notification ID must be positive"))
        ~encode:Fn.id
        ~description:"Workspace-local notification serial."
    in
    let notification_ids =
      Api_codec.map
        (Api_codec.list positive_serial ~max_items:1)
        ~decode:(fun ids ->
          if List.length ids = 1
          then Ok ids
          else
            Error
              (Problem.create
                 Invalid_argument
                 "message receipt requires one notification ID"))
        ~encode:Fn.id
        ~description:"Stable notification ID for the frozen delivery."
    in
    let fields =
      Fields.both
        (Fields.both
           (Fields.required "message_id" message)
           (Fields.required
              "comment_id"
              (identifier Id.Comment.of_string Id.Comment.to_string)))
        (Fields.both
           (Fields.required "comment_revision" revision)
           (Fields.both
              (Fields.required "recipients" (Api_codec.list recipient ~max_items:2048))
              (Fields.required "notification_ids" notification_ids)))
    in
    Api_codec.as_json (Api_codec.object_ fields)
  ;;
end

let message_method =
  Api_method.create
    ~name:"message.send"
    ~summary:"Send an immutable-body informal message with frozen actor/run/team routing."
    ~mode:Mutation
    ~request:Message_send.codec
    ~response:Message_send.receipt_codec
;;

module Command = Communication_command

type t =
  { revision : int
  ; boards : Board.t Communication_id.Board.Map.t
  ; threads : Thread.t Communication_id.Thread.Map.t
  ; teams : Team.t Communication_id.Team.Map.t
  ; requests : Request.t Communication_id.Request.Map.t
  ; messages : Message.t Communication_id.Message.Map.t
  ; subscriptions : Subscription.t Communication_id.Subscription.Map.t
  ; acknowledgements : Int.Set.t Recipient.Map.t Communication_id.Consumer.Map.t
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
  ; messages = Communication_id.Message.Map.empty
  ; subscriptions = Communication_id.Subscription.Map.empty
  ; acknowledgements = Communication_id.Consumer.Map.empty
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

let acknowledged t consumer_id recipient =
  Map.find t.acknowledgements consumer_id
  |> Option.bind ~f:(fun recipients -> Map.find recipients recipient)
  |> Option.value ~default:Int.Set.empty
;;

let get_board t id = Map.find t.boards id
let get_thread t id = Map.find t.threads id
let get_request t id = Map.find t.requests id
let get_message t id = Map.find t.messages id
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
      | Thread_changed | Message_received | Request_created ->
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

let message_comment_id id =
  Id.Comment.of_string ("message-" ^ Json.hash (Communication_id.Message.to_string id))
  |> function
  | Ok id -> id
  | Error error -> raise (Json.Decode_error error)
;;

let message_recipients t direct teams =
  let members = List.concat_map teams ~f:(fun id -> (find t.teams id).Team.members) in
  let subscribed =
    Map.data t.subscriptions
    |> List.filter_map ~f:(fun subscription ->
      if
        subscription.Subscription.active
        && Option.value_map
             subscription.filter.scope
             ~default:true
             ~f:(Scope.equal Scope.Workspace)
        && Option.is_none subscription.filter.thread
        && (List.is_empty subscription.filter.kinds
            || List.mem
                 subscription.filter.kinds
                 Notification.Kind.Message_received
                 ~equal:Notification.Kind.equal)
      then Some subscription.recipient
      else None)
  in
  unique (direct @ members @ subscribed) ~compare:Recipient.compare
;;

let message_valid t attribution (message : Message.t) =
  require
    (not (Map.mem t.messages message.message_id))
    Conflict
    "message ID already exists";
  require
    (message.revision = 1 && message.comment_revision = 1)
    Corrupt_store
    "message references must pin the initial revision";
  require
    (Id.Comment.equal message.comment_id (message_comment_id message.message_id))
    Corrupt_store
    "message comment identity differs from its stable source";
  require
    (Attribution.equal message.created attribution)
    Corrupt_store
    "message creation attribution differs from event";
  require
    (not (List.is_empty message.direct_recipients && List.is_empty message.teams))
    Invalid_argument
    "message requires direct recipients or teams";
  require
    (List.equal
       Recipient.equal
       message.direct_recipients
       (unique message.direct_recipients ~compare:Recipient.compare))
    Corrupt_store
    "message direct recipients are not canonical";
  require
    (List.equal
       Communication_id.Team.equal
       message.teams
       (unique message.teams ~compare:Communication_id.Team.compare))
    Corrupt_store
    "message teams are not canonical";
  require
    ((not (List.is_empty message.recipients)) && List.length message.recipients <= 2048)
    Invalid_argument
    "message routing must resolve 1..2048 recipients";
  require
    (List.equal
       Recipient.equal
       message.recipients
       (message_recipients t message.direct_recipients message.teams))
    Corrupt_store
    "message routing differs from frozen deliveries";
  Option.iter message.reply_to_message_id ~f:(fun id ->
    let previous = find t.messages id in
    require
      (Option.equal Id.Ticket.equal previous.ticket_id message.ticket_id)
      Conflict
      "message reply targets another ticket");
  Option.iter message.correlation_id ~f:(fun id ->
    require
      ((not (String.is_empty (String.strip id))) && String.length id <= 512)
      Invalid_argument
      "invalid message correlation ID")
;;

let update t attribution = function
  | Update.Board_put board ->
    board_valid t board;
    { t with boards = Map.set t.boards ~key:board.id ~data:board }
  | Message_put message ->
    message_valid t attribution message;
    { t with messages = Map.set t.messages ~key:message.message_id ~data:message }
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
  | Inbox_ack { consumer_id; recipient; notification_ids } ->
    recipient_allowed attribution recipient;
    require
      ((not (List.is_empty notification_ids)) && List.length notification_ids <= 100)
      Invalid_argument
      "notification_ids must contain 1..100 IDs";
    List.iter notification_ids ~f:(fun id ->
      require
        (List.exists t.notifications ~f:(fun n ->
           Int.equal n.Notification.serial id
           && List.mem n.recipients recipient ~equal:Recipient.equal))
        Invalid_argument
        "notification ID was not addressed to recipient");
    let recipients =
      Option.value (Map.find t.acknowledgements consumer_id) ~default:Recipient.Map.empty
    in
    let ids =
      List.fold notification_ids ~init:(acknowledged t consumer_id recipient) ~f:Set.add
    in
    { t with
      acknowledgements =
        Map.set
          t.acknowledgements
          ~key:consumer_id
          ~data:(Map.set recipients ~key:recipient ~data:ids)
    }
;;

let notification t event_update ~sequence ~attribution =
  match event_update with
  | Update.Message_put message ->
    [ { Notification.serial = t.serial + 1
      ; sequence
      ; scope = Scope.Workspace
      ; source = Notification.Source.Message message.message_id
      ; source_revision = message.revision
      ; kind = Message_received
      ; attribution
      ; recipients = message.recipients
      }
    ]
  | Board_put _
  | Thread_put _
  | Team_put _
  | Request_put _
  | Subscription_put _
  | Inbox_ack _ ->
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
          , Recipient.Actor request.created.actor
            :: Recipient.Actor request.resolver
            :: List.map request.deliveries ~f:(fun d -> d.Request.Delivery.recipient) )
      | Board_put _ | Team_put _ | Subscription_put _ | Inbox_ack _ | Message_put _ ->
        None
    in
    (match info with
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
       ])
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
  | Inbox_ack ack ->
    Update.Inbox_ack
      { consumer_id = ack.consumer_id
      ; recipient = ack.recipient
      ; notification_ids = ack.notification_ids
      }
;;

let update_json = function
  | Update.Board_put x -> Communication_wire.board_json x
  | Message_put x -> Message.jsonaf_of_t x
  | Thread_put x -> Communication_wire.thread_json x
  | Team_put x -> Communication_wire.team_json x
  | Request_put { request; _ } -> Communication_wire.request_json request
  | Subscription_put x -> Communication_wire.subscription_json x
  | Inbox_ack { consumer_id; recipient; notification_ids } ->
    unwrap
      (Api_codec.encode
         Communication_inbox.Ack.codec
         { consumer_id; recipient; notification_ids })
;;

let prepare t command ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let method_, _ = Communication_command.encode command |> unwrap in
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
    let result = update_json event_update in
    if not (String.equal method_ "inbox.ack")
    then Communication_wire.validate_result ~method_ result;
    { candidate; changes = [ change ]; result })
;;

module Message_prepared = struct
  type state = t

  type change =
    | Discussion_change of Discussion.Change.t
    | Communication_change of Change.t

  type nonrec t =
    { candidate : t
    ; discussion : Discussion.t
    ; changes : change list
    ; result : Jsonaf.t
    }

  let candidate t = t.candidate
  let discussion t = t.discussion
  let changes t = t.changes
  let result t = t.result
end

let prepare_message
      t
      (command : Message_send.t)
      ~discussion
      ~actor
      ~run
      ~timestamp
      ~sequence
  =
  Json.decode (fun () ->
    let unwrap = function
      | Ok value -> value
      | Error error -> raise (Json.Decode_error error)
    in
    let command =
      Api_codec.encode Message_send.codec command
      |> unwrap
      |> Api_codec.decode Message_send.codec
      |> unwrap
    in
    let attribution = { Attribution.actor; run; timestamp } in
    attribution_valid attribution;
    let comment_id = message_comment_id command.message_id in
    let target =
      Option.value_map command.ticket_id ~default:Entity_ref.Workspace ~f:(fun id ->
        Entity_ref.Ticket id)
    in
    let reply_to =
      Option.map command.reply_to_message_id ~f:(fun id ->
        (find t.messages id).Message.comment_id)
    in
    let discussion_change =
      Discussion.Change.Create
        { id = comment_id
        ; target
        ; reply_to
        ; kind = Comment
        ; origin = Authored
        ; version =
            { revision = 1
            ; serial = Discussion.next_serial discussion
            ; sequence
            ; actor
            ; timestamp
            ; body = command.body
            ; tombstone = false
            }
        }
    in
    let discussion = Discussion.apply discussion discussion_change ~sequence in
    let direct_recipients = unique command.recipients ~compare:Recipient.compare in
    let teams = unique command.teams ~compare:Communication_id.Team.compare in
    let message =
      { Message.message_id = command.message_id
      ; revision = 1
      ; comment_id
      ; comment_revision = 1
      ; ticket_id = command.ticket_id
      ; direct_recipients
      ; teams
      ; recipients = message_recipients t direct_recipients teams
      ; reply_to_message_id = command.reply_to_message_id
      ; correlation_id = command.correlation_id
      ; created = attribution
      }
    in
    let event_update = Update.Message_put message in
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
    { Message_prepared.candidate
    ; discussion
    ; changes = [ Discussion_change discussion_change; Communication_change change ]
    ; result =
        Json.obj
          [ "message_id", Communication_id.Message.jsonaf_of_t message.message_id
          ; "comment_id", Id.Comment.jsonaf_of_t message.comment_id
          ; "comment_revision", Json.int message.comment_revision
          ; "recipients", `Array (List.map message.recipients ~f:Recipient.jsonaf_of_t)
          ; ( "notification_ids"
            , `Array
                (List.map change.notifications ~f:(fun n ->
                   Json.int n.Notification.serial)) )
          ]
        |> Api_codec.decode Message_send.receipt_codec
        |> unwrap
    })
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
    Map.iter t.messages ~f:(fun message ->
      let target =
        Option.value_map
          message.Message.ticket_id
          ~default:Entity_ref.Workspace
          ~f:(fun id -> Entity_ref.Ticket id)
      in
      check target;
      require
        (Entity_ref.equal target (Discussion.target discussion message.comment_id))
        Conflict
        "message body targets another entity";
      let initial =
        Discussion.history discussion message.comment_id
        |> List.find ~f:(fun value ->
          Int.equal (Json.integer (Json.field value "revision")) message.comment_revision)
      in
      let initial =
        match initial with
        | Some value -> value
        | None -> Json.fail Corrupt_store "pinned message comment version missing"
      in
      require
        (Id.Actor.equal
           (Id.Actor.t_of_jsonaf (Json.field initial "actor"))
           message.created.actor)
        Corrupt_store
        "message author differs from pinned comment";
      require
        (String.equal
           (Json.text (Json.field initial "timestamp"))
           message.created.timestamp)
        Corrupt_store
        "message timestamp differs from pinned comment");
    Map.iter t.subscriptions ~f:(fun s ->
      Option.iter s.Subscription.filter.scope ~f:(fun scope -> check (Scope.target scope))))
;;

let thread_history t id =
  List.rev t.history
  |> List.filter_map ~f:(fun change ->
    match change.Change.update with
    | Thread_put thread when Communication_id.Thread.equal thread.id id -> Some thread
    | Board_put _
    | Message_put _
    | Thread_put _
    | Team_put _
    | Request_put _
    | Subscription_put _
    | Inbox_ack _ -> None)
;;

let request_history t id =
  List.rev t.history
  |> List.filter_map ~f:(fun change ->
    match change.Change.update with
    | Request_put { request; _ } when Communication_id.Request.equal request.id id ->
      Some request
    | Board_put _
    | Message_put _
    | Thread_put _
    | Team_put _
    | Request_put _
    | Subscription_put _
    | Inbox_ack _ -> None)
;;

let inbox t ~consumer_id ~recipient ~after ~through =
  let through = Option.value through ~default:t.serial in
  List.rev t.notifications
  |> List.filter ~f:(fun n ->
    n.Notification.serial > after
    && (not (Set.mem (acknowledged t consumer_id recipient) n.serial))
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

let mutation_methods = Communication_command.methods
let query_methods = Communication_api.query_methods @ [ "inbox.read"; "inbox.wait" ]

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

let decode = Communication_command.decode

let notification_ticket_ids t (notification : Notification.t) =
  let links =
    match notification.source with
    | Message id ->
      Option.to_list (find t.messages id).Message.ticket_id
      |> List.map ~f:(fun id -> Entity_ref.Ticket id)
    | Thread id -> (find t.threads id).Thread.links
    | Request id -> (find t.threads (find t.requests id).Request.thread).Thread.links
  in
  List.filter_map links ~f:(function
    | Entity_ref.Ticket id -> Some id
    | _ -> None)
  |> List.dedup_and_sort ~compare:Id.Ticket.compare
;;

let notification_packet t ~discussion (notification : Notification.t) =
  let source, current_revision, body =
    match notification.source with
    | Message id ->
      let message = find t.messages id in
      let version =
        List.find_exn
          (Discussion.history discussion message.comment_id)
          ~f:(fun version ->
            Int.equal
              (Json.integer (Json.field version "revision"))
              message.comment_revision)
      in
      "message", message.revision, Some (version, "initial")
    | Request id ->
      let request = find t.requests id in
      ( "request"
      , request.revision
      , Some (Discussion.get discussion request.message, "current") )
    | Thread id ->
      let thread = find t.threads id in
      ( "thread"
      , thread.revision
      , Option.map (List.last thread.messages) ~f:(fun id ->
          Discussion.get discussion id, "current") )
  in
  let id =
    match notification.source with
    | Message id -> Communication_id.Message.jsonaf_of_t id
    | Request id -> Communication_id.Request.jsonaf_of_t id
    | Thread id -> Communication_id.Thread.jsonaf_of_t id
  in
  let kind =
    match notification.kind with
    | Message_received -> "message_received"
    | Thread_changed -> "thread_changed"
    | Request_created -> "request_created"
    | Request_acknowledged -> "request_acknowledged"
    | Request_accepted -> "request_accepted"
    | Request_reassigned -> "request_reassigned"
    | Request_resolved -> "request_resolved"
    | Request_cancelled -> "request_cancelled"
  in
  let scope =
    match notification.scope with
    | Scope.Workspace -> Json.obj [ "kind", Json.string "workspace" ]
    | Project id ->
      Json.obj [ "kind", Json.string "project"; "id", Id.Project.jsonaf_of_t id ]
  in
  let body_source =
    Option.value_map body ~default:`Null ~f:(fun (version, version_kind) ->
      Json.obj
        (List.map
           [ "comment_id"; "revision"; "serial"; "timestamp"; "body"; "tombstone" ]
           ~f:(fun key -> key, Json.field version key)
         @ [ "actor_id", Json.field version "actor"
           ; "version_kind", Json.string version_kind
           ]))
  in
  let attribution = notification.attribution in
  let packet =
    Json.obj
      [ "notification_id", Json.int notification.serial
      ; "sequence", Json.int notification.sequence
      ; "kind", Json.string kind
      ; "scope", scope
      ; "source", Json.obj [ "kind", Json.string source; "id", id ]
      ; "source_revision", Json.int notification.source_revision
      ; "source_current_revision", Json.int current_revision
      ; ( "ticket_ids"
        , `Array
            (List.map (notification_ticket_ids t notification) ~f:Id.Ticket.jsonaf_of_t) )
      ; ( "attribution"
        , Json.obj
            [ "actor_id", Id.Actor.jsonaf_of_t attribution.actor
            ; ( "run_id"
              , Option.value_map attribution.run ~default:`Null ~f:Id.Run.jsonaf_of_t )
            ; "timestamp", Json.string attribution.timestamp
            ] )
      ; "body_source", body_source
      ]
  in
  unwrap (Api_codec.decode Communication_inbox.item_codec packet)
;;

let read_inbox t ~discussion ~method_ ~params =
  let module Q = Communication_inbox.Query in
  let query =
    unwrap
      (Api_codec.decode
         (if String.equal method_ "inbox.wait" then Q.wait_codec else Q.read_codec)
         params)
  in
  let after = Q.after query in
  let through = Option.value (Q.through query) ~default:t.serial in
  require
    (after <= through && through <= t.serial)
    Invalid_argument
    "inbox cursor outside retained activity";
  let records =
    inbox
      t
      ~consumer_id:(Q.consumer_id query)
      ~recipient:(Q.recipient query)
      ~after
      ~through:(Some through)
    |> List.filter ~f:(fun notification ->
      let self =
        match Q.recipient query with
        | Recipient.Actor actor ->
          Id.Actor.equal notification.Notification.attribution.actor actor
        | Run run ->
          Option.exists notification.Notification.attribution.run ~f:(Id.Run.equal run)
      in
      ((not (Q.exclude_self query)) || not self)
      && Option.value_map (Q.kinds query) ~default:true ~f:(fun kinds ->
        List.mem kinds notification.Notification.kind ~equal:Notification.Kind.equal)
      && Option.value_map (Q.ticket_id query) ~default:true ~f:(fun id ->
        List.mem (notification_ticket_ids t notification) id ~equal:Id.Ticket.equal))
  in
  let selected = List.take records (Q.limit query) in
  let next_after =
    Option.value_map (List.last selected) ~default:after ~f:(fun n ->
      n.Notification.serial)
  in
  Json.obj
    [ "revision", Json.int t.revision
    ; "consumer_id", Communication_id.Consumer.jsonaf_of_t (Q.consumer_id query)
    ; ( "recipient"
      , unwrap (Api_codec.encode Communication_recipient.codec (Q.recipient query)) )
    ; "after", Json.int after
    ; "through", Json.int through
    ; "next_after", Json.int next_after
    ; "remaining", Json.int (List.length records - List.length selected)
    ; ("exclude_self", if Q.exclude_self query then `True else `False)
    ; "items", `Array (List.map selected ~f:(notification_packet t ~discussion))
    ]
;;

let query t ~discussion ~method_ ~params =
  Json.decode (fun () ->
    let get key = Json.field params key in
    if List.mem Communication_api.query_methods method_ ~equal:String.equal
    then Communication_api.validate_query ~method_ ~params |> unwrap;
    let scope_filter = optional params "scope" Scope.t_of_jsonaf in
    let scope_matches scope =
      Option.value_map scope_filter ~default:true ~f:(Scope.equal scope)
    in
    let recipient = optional params "recipient" Recipient.t_of_jsonaf in
    let page records =
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
    let direct json = Json.obj [ "revision", Json.int t.revision; "record", json ] in
    let output =
      match method_ with
      | "board.get" ->
        direct
          (Communication_wire.board_json
             (find t.boards (Communication_id.Board.t_of_jsonaf (get "board_id"))))
      | "board.list" ->
        Map.data t.boards
        |> List.filter ~f:(fun b -> scope_matches b.Board.scope)
        |> List.map ~f:Communication_wire.board_json
        |> page
      | "team.get" ->
        direct
          (Communication_wire.team_json
             (find t.teams (Communication_id.Team.t_of_jsonaf (get "team_id"))))
      | "team.list" -> page (List.map (Map.data t.teams) ~f:Communication_wire.team_json)
      | "thread.get" ->
        let query =
          Api_codec.decode Communication_related.Query.thread_codec params |> Disk.unwrap
        in
        let thread =
          find
            t.threads
            (Communication_id.Thread.of_string (Communication_related.Query.id query)
             |> Disk.unwrap)
        in
        let record = Communication_wire.thread_json thread in
        let record =
          if Communication_related.Query.include_messages query
          then (
            let related =
              Communication_related.thread
                query
                ~communication_revision:t.revision
                ~discussion
                thread
              |> Disk.unwrap
            in
            match record with
            | `Object fields -> Json.obj (fields @ [ "related", related ])
            | _ -> assert false)
          else record
        in
        Json.obj [ "revision", Json.int t.revision; "record", record ]
      | "thread.history" ->
        let id = Communication_id.Thread.t_of_jsonaf (get "thread_id") in
        ignore (find t.threads id : Thread.t);
        page (List.map (thread_history t id) ~f:Communication_wire.thread_json)
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
        |> List.map ~f:Communication_wire.thread_json
        |> page
      | "request.get" ->
        let query =
          Api_codec.decode Communication_related.Query.request_codec params |> Disk.unwrap
        in
        let request =
          find
            t.requests
            (Communication_id.Request.of_string (Communication_related.Query.id query)
             |> Disk.unwrap)
        in
        let record = Communication_wire.request_json request in
        let record =
          if Communication_related.Query.include_messages query
          then (
            let related =
              Communication_related.request
                query
                ~communication_revision:t.revision
                ~discussion
                ~thread:(find t.threads request.thread)
                request
              |> Disk.unwrap
            in
            match record with
            | `Object fields -> Json.obj (fields @ [ "related", related ])
            | _ -> assert false)
          else record
        in
        Json.obj [ "revision", Json.int t.revision; "record", record ]
      | "request.history" ->
        let id = Communication_id.Request.t_of_jsonaf (get "request_id") in
        ignore (find t.requests id : Request.t);
        page (List.map (request_history t id) ~f:Communication_wire.request_json)
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
        |> List.map ~f:Communication_wire.request_json
        |> page
      | "subscription.get" ->
        direct
          (Communication_wire.subscription_json
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
        |> List.map ~f:Communication_wire.subscription_json
        |> page
      | "inbox.read" | "inbox.wait" -> read_inbox t ~discussion ~method_ ~params
      | _ -> Json.fail Invalid_argument "unknown communication query"
    in
    let fitted =
      Query_budget.fit
        ~measure:(Api_response.encoded_size (Domain_query Communication))
        ~max_bytes:(Query_budget.of_params params)
        output
    in
    if List.mem Communication_api.query_methods method_ ~equal:String.equal
    then
      Communication_api.validate_result
        ~method_
        (Api_response.project (Domain_query Communication) fitted |> Api_response.data);
    fitted)
;;

let encode = Communication_command.encode

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
    | Message_put message ->
      Option.value_map message.ticket_id ~default:[ Entity_ref.Workspace ] ~f:(fun id ->
        [ Entity_ref.Ticket id ])
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
    | Team_put _ | Inbox_ack _ -> [ Entity_ref.Workspace ]
  in
  unique targets ~compare:Entity_ref.compare
;;

let boards t = Map.data t.boards
let threads t = Map.data t.threads
let requests t = Map.data t.requests
