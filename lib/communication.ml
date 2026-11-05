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
  if not (Int.equal current expected_revision)
  then
    raise
      (Json.Decode_error
         (Problem.with_details
            (Problem.create
               Conflict
               (sprintf
                  "communication revision conflict: expected %d, actual %d"
                  expected_revision
                  current))
            (Revision { expected = expected_revision; actual = current })))
;;

let expected_entity entity id current expected_revision =
  if not (Int.equal current expected_revision)
  then
    raise
      (Json.Decode_error
         (Problem.entity_revision entity ~id ~expected:expected_revision ~actual:current))
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
  if Thread.State.equal thread.state Resolved
  then
    require
      (not
         (Map.exists t.requests ~f:(fun request ->
            Communication_id.Thread.equal request.Request.thread thread.id
            && Request.Status.equal request.status Open)))
      Conflict
      "cannot close thread with open requests";
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

let resolve request attribution answer =
  open_request request;
  resolver request attribution;
  { request with
    Request.revision = request.revision + 1
  ; status = Resolved { attribution; answer }
  }
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

let metadata request attribution ~priority ~deadline_unix_ms ~related ~supersedes =
  open_request request;
  require
    (Id.Actor.equal request.Request.created.actor attribution.Attribution.actor
     || Id.Actor.equal request.resolver attribution.actor)
    Conflict
    "only creator or resolver may edit request metadata";
  { request with
    revision = request.revision + 1
  ; priority = Option.value priority ~default:request.priority
  ; deadline_unix_ms = Option.value deadline_unix_ms ~default:request.deadline_unix_ms
  ; related =
      Option.value related ~default:request.related
      |> unique ~compare:Communication_id.Request.compare
  ; supersedes =
      Option.value supersedes ~default:request.supersedes
      |> unique ~compare:Communication_id.Request.compare
  }
;;

let request_links_valid t (request : Request.t) =
  require
    (request.priority >= 0 && request.priority <= 4)
    Invalid_argument
    "request priority must be 0..4";
  List.iter [ request.related; request.supersedes ] ~f:(fun links ->
    limit links 32;
    canonical
      links
      ~compare:Communication_id.Request.compare
      ~equal:Communication_id.Request.equal;
    List.iter links ~f:(fun id ->
      require
        (not (Communication_id.Request.equal request.id id))
        Conflict
        "request cannot link to itself";
      ignore (find t.requests id : Request.t)));
  let rec visit pending seen =
    match pending with
    | [] -> ()
    | id :: rest ->
      require
        (not (Communication_id.Request.equal id request.id))
        Conflict
        "request supersedes cycle";
      if Set.mem seen id
      then visit rest seen
      else (
        let previous = find t.requests id in
        visit (previous.Request.supersedes @ rest) (Set.add seen id))
  in
  visit request.supersedes Communication_id.Request.Set.empty
;;

let request_valid t attribution (request : Request.t) kind =
  let thread = find t.threads request.thread in
  request_links_valid t request;
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
      (not (Thread.State.equal thread.state Resolved))
      Conflict
      "cannot create request on resolved thread";
    require (request.message_revision > 0) Corrupt_store "invalid question revision";
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
      | Request_resolved ->
        let answer =
          match request.status with
          | Resolved { answer; _ } -> answer
          | Open | Cancelled _ ->
            Json.fail Corrupt_store "resolution has no resolved status"
        in
        resolve old attribution answer
      | Request_cancelled -> cancel old attribution
      | Request_updated ->
        metadata
          old
          attribution
          ~priority:(Some request.priority)
          ~deadline_unix_ms:(Some request.deadline_unix_ms)
          ~related:(Some request.related)
          ~supersedes:(Some request.supersedes)
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
  if Map.mem t.messages message.message_id
  then
    raise
      (Json.Decode_error
         (Problem.identity_collision
            Message
            ~id:(Communication_id.Message.to_string message.message_id)));
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

let current_comment_ref discussion comment_id =
  match discussion with
  | None -> Json.fail Invalid_argument "causal body requires discussion capture"
  | Some discussion ->
    let revision = Discussion.revision discussion comment_id in
    require (revision > 0) Corrupt_store "causal body does not exist";
    { Communication_event.Comment_ref.comment_id; revision }
;;

let pinned_version discussion (pin : Communication_event.Comment_ref.t) =
  require (pin.revision > 0) Corrupt_store "invalid comment pin revision";
  match
    List.find (Discussion.history discussion pin.comment_id) ~f:(fun version ->
      Int.equal (Json.integer (Json.field version "revision")) pin.revision)
  with
  | Some version -> version
  | None -> Json.fail Corrupt_store "pinned comment version missing"
;;

let notification before ?discussion t event_update ~sequence ~attribution =
  match event_update with
  | Update.Message_put message ->
    [ { Notification.serial = t.serial + 1
      ; sequence
      ; scope = Scope.Workspace
      ; source = Notification.Source.Message message.message_id
      ; source_revision = message.revision
      ; causal_body =
          Some { comment_id = message.comment_id; revision = message.comment_revision }
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
       let causal_body =
         match event_update with
         | Update.Thread_put thread ->
           let old_count =
             Option.value_map
               (Map.find before.threads thread.id)
               ~default:0
               ~f:(fun old -> List.length old.Thread.messages)
           in
           if List.length thread.messages > old_count
           then Option.map (List.last thread.messages) ~f:(current_comment_ref discussion)
           else None
         | Request_put { request; kind = Request_created } ->
           Some
             { Communication_event.Comment_ref.comment_id = request.message
             ; revision = request.message_revision
             }
         | Request_put { request; kind = Request_resolved } ->
           (match request.status with
            | Resolved { answer; _ } -> answer
            | Open | Cancelled _ ->
              Json.fail Corrupt_store "invalid resolved notification")
         | Request_put _
         | Board_put _
         | Team_put _
         | Subscription_put _
         | Inbox_ack _
         | Message_put _ -> None
       in
       [ { Notification.serial = t.serial + 1
         ; sequence
         ; scope
         ; source
         ; source_revision
         ; causal_body
         ; kind
         ; attribution
         ; recipients = unique (direct @ recipients) ~compare:Recipient.compare
         }
       ])
;;

let apply_exn t ?discussion (change : Change.t) =
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
  (match change.update with
   | Update.Request_put { request; kind = Request_created } ->
     let pin = current_comment_ref discussion request.message in
     require
       (Int.equal pin.revision request.message_revision)
       Corrupt_store
       "question pin differs from publication capture";
     let discussion = Option.value_exn discussion in
     require
       (Entity_ref.equal
          (Discussion.target discussion request.message)
          (Scope.target (scope t (find t.threads request.thread))))
       Conflict
       "question targets another scope"
   | Request_put { request; kind = Request_resolved } ->
     (match request.status with
      | Resolved { attribution; answer = Some pin } ->
        let current = current_comment_ref discussion pin.comment_id in
        require
          (Communication_event.Comment_ref.equal pin current)
          Corrupt_store
          "answer pin differs from publication capture";
        let discussion = Option.value_exn discussion in
        let version = pinned_version discussion pin in
        require
          (Int.equal (Json.integer (Json.field version "sequence")) change.sequence
           && String.equal
                (Json.text (Json.field version "timestamp"))
                attribution.timestamp
           && Int.equal pin.revision 1)
          Corrupt_store
          "answer was not authored in resolution";
        require
          (Entity_ref.equal
             (Discussion.target discussion pin.comment_id)
             (Scope.target (scope t (find t.threads request.thread))))
          Corrupt_store
          "answer targets another scope";
        require
          (List.mem
             (find t.threads request.thread).messages
             pin.comment_id
             ~equal:Id.Comment.equal)
          Corrupt_store
          "answer is not attached to request thread";
        require
          (Option.value_map
             (Json.optional version "reply_to")
             ~default:false
             ~f:(fun reply ->
               match reply with
               | `Null -> false
               | value -> Id.Comment.equal (Id.Comment.t_of_jsonaf value) request.message))
          Corrupt_store
          "answer does not reply to question";
        require
          (Id.Actor.equal
             (Id.Actor.t_of_jsonaf (Json.field version "actor"))
             attribution.actor)
          Corrupt_store
          "answer author differs from resolver"
      | Resolved { answer = None; _ } -> ()
      | Open | Cancelled _ -> Json.fail Corrupt_store "invalid resolution status")
   | Thread_put thread ->
     let old_count =
       Option.value_map (Map.find t.threads thread.id) ~default:0 ~f:(fun old ->
         List.length old.Thread.messages)
     in
     if List.length thread.messages > old_count
     then (
       let pin = current_comment_ref discussion (List.last_exn thread.messages) in
       let discussion = Option.value_exn discussion in
       require
         (Entity_ref.equal
            (Discussion.target discussion pin.comment_id)
            (Scope.target (scope t thread)))
         Conflict
         "attached comment targets another scope")
   | Board_put _
   | Team_put _
   | Request_put _
   | Subscription_put _
   | Inbox_ack _
   | Message_put _ -> ());
  let updated = update t change.attribution change.update in
  let notifications =
    notification
      t
      ?discussion
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

let apply t ?discussion change = Json.decode (fun () -> apply_exn t ?discussion change)

let command_update t ?discussion command attribution =
  match command with
  | Command.Board_put { id; expected_revision; scope; title } ->
    expected_entity
      Board
      (Communication_id.Board.to_string id)
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
      ; closure_policy
      ; pinned
      } ->
    let old = Map.find t.threads id in
    expected_entity
      Thread
      (Communication_id.Thread.to_string id)
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
      ; closure_policy =
          Option.value
            closure_policy
            ~default:
              (Option.value_map old ~default:Thread.Closure_policy.Manual ~f:(fun t ->
                 t.Thread.closure_policy))
      ; pinned
      ; messages = Option.value_map old ~default:[] ~f:(fun x -> x.Thread.messages)
      ; pinned_messages =
          Option.value_map old ~default:[] ~f:(fun x -> x.Thread.pinned_messages)
      }
  | Thread_attach { id; expected_revision; message } ->
    let thread = find t.threads id in
    expected_entity
      Thread
      (Communication_id.Thread.to_string id)
      thread.revision
      expected_revision;
    Update.Thread_put
      { thread with
        revision = thread.revision + 1
      ; messages = thread.messages @ [ message ]
      }
  | Thread_pin_message { id; expected_revision; message; pinned } ->
    let thread = find t.threads id in
    expected_entity
      Thread
      (Communication_id.Thread.to_string id)
      thread.revision
      expected_revision;
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
    expected_entity
      Team
      (Communication_id.Team.to_string id)
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
      ; priority
      ; related
      ; supersedes
      } ->
    if Map.mem t.requests id
    then
      raise
        (Json.Decode_error
           (Problem.identity_collision
              Request
              ~id:(Communication_id.Request.to_string id)));
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
      ; message_revision =
          (match discussion with
           | Some discussion -> Discussion.revision discussion message
           | None ->
             Json.fail Invalid_argument "request creation requires discussion capture")
      ; correlation_id
      ; reply_to
      ; deadline_unix_ms
      ; priority
      ; related = unique related ~compare:Communication_id.Request.compare
      ; supersedes = unique supersedes ~compare:Communication_id.Request.compare
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
  | Request_metadata
      { id; expected_revision; priority; deadline_unix_ms; related; supersedes } ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    Update.Request_put
      { request =
          metadata old attribution ~priority ~deadline_unix_ms ~related ~supersedes
      ; kind = Request_updated
      }
  | Request_acknowledge { id; expected_revision; recipient } ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    Update.Request_put
      { request = acknowledge old attribution recipient; kind = Request_acknowledged }
  | Request_accept { id; expected_revision; recipient } ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    Update.Request_put
      { request = accept old attribution recipient; kind = Request_accepted }
  | Request_reassign { id; expected_revision; recipient } ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    Update.Request_put
      { request = reassign old attribution recipient; kind = Request_reassigned }
  | Request_ask _ | Request_resolve { body = Some _; _ } ->
    Json.fail Invalid_argument "discussion composition requires planning preparation"
  | Request_resolve { id; expected_revision; body = None } ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    Update.Request_put { request = resolve old attribution None; kind = Request_resolved }
  | Request_cancel { id; expected_revision } ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    Update.Request_put { request = cancel old attribution; kind = Request_cancelled }
  | Subscription_put { id; expected_revision; recipient; filter; active } ->
    expected_entity
      Subscription
      (Communication_id.Subscription.to_string id)
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

let prepare_update t ?discussion event_update ~attribution ~sequence =
  let make state event_update =
    let updated = update state attribution event_update in
    let change =
      { Change.version = 1
      ; revision = state.revision + 1
      ; sequence
      ; attribution
      ; update = event_update
      ; notifications =
          notification state ?discussion updated event_update ~sequence ~attribution
      }
    in
    apply_exn state ?discussion change, change
  in
  let candidate, change = make t event_update in
  let candidate, changes =
    let affected_thread =
      match event_update with
      | Update.Request_put { request; kind = Request_resolved | Request_cancelled } ->
        Some (find candidate.threads request.thread)
      | Thread_put thread -> Some thread
      | Board_put _
      | Team_put _
      | Request_put _
      | Subscription_put _
      | Inbox_ack _
      | Message_put _ -> None
    in
    match affected_thread with
    | None -> candidate, [ change ]
    | Some thread ->
      let requests =
        Map.data candidate.requests
        |> List.filter ~f:(fun request ->
          Communication_id.Thread.equal request.Request.thread thread.id)
      in
      let has_open =
        List.exists requests ~f:(fun request -> Request.Status.equal request.status Open)
      in
      if
        Thread.Closure_policy.equal thread.closure_policy When_all_requests_terminal
        && (not (List.is_empty requests))
        && (not has_open)
        && not (Thread.State.equal thread.state Resolved)
      then (
        let candidate, close =
          make
            candidate
            (Thread_put { thread with revision = thread.revision + 1; state = Resolved })
        in
        candidate, [ change; close ])
      else candidate, [ change ]
  in
  let result =
    match event_update with
    | Update.Request_put { request; kind = Request_resolved } ->
      let answer =
        match request.status with
        | Resolved { answer; _ } -> answer
        | Open | Cancelled _ -> assert false
      in
      Json.obj
        [ "request_id", Communication_id.Request.jsonaf_of_t request.id
        ; "request_revision", Json.int request.revision
        ; "thread_id", Communication_id.Thread.jsonaf_of_t request.thread
        ; "thread_revision", Json.int (find candidate.threads request.thread).revision
        ; "status", Json.field (Communication_wire.request_json request) "status"
        ; ( "answer"
          , Option.value_map answer ~default:`Null ~f:(fun pin ->
              unwrap (Api_codec.encode Communication_wire.comment_ref pin)) )
        ]
    | Thread_put thread ->
      Communication_wire.thread_json (find candidate.threads thread.id)
    | Board_put _
    | Team_put _
    | Request_put _
    | Subscription_put _
    | Inbox_ack _
    | Message_put _ -> update_json event_update
  in
  { candidate; changes; result }
;;

let prepare t ?discussion command ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let method_, _ = Communication_command.encode command |> unwrap in
    let attribution = { Attribution.actor; run; timestamp } in
    attribution_valid attribution;
    let event_update = command_update t ?discussion command attribution in
    let prepared = prepare_update t ?discussion event_update ~attribution ~sequence in
    if not (String.equal method_ "inbox.ack")
    then Communication_wire.validate_result ~method_ prepared.result;
    prepared)
;;

let prepare_resolution
      t
      ~discussion
      ~id
      ~expected_revision
      ~answer
      ~actor
      ~run
      ~timestamp
      ~sequence
  =
  Json.decode (fun () ->
    let old = find t.requests id in
    expected_entity
      Request
      (Communication_id.Request.to_string id)
      old.revision
      expected_revision;
    let attribution = { Attribution.actor; run; timestamp } in
    attribution_valid attribution;
    let prepared =
      prepare_update
        t
        ~discussion
        (Update.Request_put
           { request = resolve old attribution (Some answer); kind = Request_resolved })
        ~attribution
        ~sequence
    in
    Communication_wire.validate_result ~method_:"request.resolve" prepared.result;
    prepared)
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
    if Map.mem t.messages command.message_id
    then
      raise
        (Json.Decode_error
           (Problem.identity_collision
              Message
              ~id:(Communication_id.Message.to_string command.message_id)));
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
      ; notifications =
          notification t ~discussion updated event_update ~sequence ~attribution
      }
    in
    let candidate = apply_exn t ~discussion change in
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
    Map.iter t.requests ~f:(fun request ->
      let thread = find t.threads request.thread in
      let check_pin pin =
        ignore (pinned_version discussion pin : Jsonaf.t);
        require
          (Entity_ref.equal
             (Discussion.target discussion pin.Communication_event.Comment_ref.comment_id)
             (Scope.target (scope t thread)))
          Corrupt_store
          "request pin targets another scope";
        require
          (List.mem thread.messages pin.comment_id ~equal:Id.Comment.equal)
          Corrupt_store
          "request pin is not attached to thread"
      in
      check_pin { comment_id = request.message; revision = request.message_revision };
      match request.status with
      | Resolved { attribution; answer = Some pin } ->
        check_pin pin;
        let version = pinned_version discussion pin in
        require
          (Id.Actor.equal
             (Id.Actor.t_of_jsonaf (Json.field version "actor"))
             attribution.actor)
          Corrupt_store
          "answer pin author differs";
        require
          (match Json.field version "reply_to" with
           | `Null -> false
           | json -> Id.Comment.equal (Id.Comment.t_of_jsonaf json) request.message)
          Corrupt_store
          "answer pin does not reply to question"
      | Resolved { answer = None; _ } | Open | Cancelled _ -> ());
    let request_counts =
      Map.fold
        t.requests
        ~init:Communication_id.Thread.Map.empty
        ~f:(fun ~key:_ ~data:request counts ->
          Map.update counts request.Request.thread ~f:(fun previous ->
            let total, open_count = Option.value previous ~default:(0, 0) in
            ( total + 1
            , open_count + if Request.Status.equal request.status Open then 1 else 0 )))
    in
    Map.iter t.threads ~f:(fun thread ->
      let total, open_count =
        Option.value (Map.find request_counts thread.Thread.id) ~default:(0, 0)
      in
      if
        Thread.Closure_policy.equal thread.closure_policy When_all_requests_terminal
        && total > 0
        && open_count = 0
      then
        require
          (Thread.State.equal thread.state Resolved)
          Corrupt_store
          "automatic thread closure missing after terminal requests");
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
  let source, current_revision =
    match notification.source with
    | Message id -> "message", (find t.messages id).Message.revision
    | Request id -> "request", (find t.requests id).Request.revision
    | Thread id -> "thread", (find t.threads id).Thread.revision
  in
  let body =
    Option.map notification.causal_body ~f:(fun pin ->
      pinned_version discussion pin, "captured")
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
    | Request_updated -> "request_updated"
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
      ; ( "causal_body"
        , Option.value_map notification.causal_body ~default:`Null ~f:(fun pin ->
            unwrap (Api_codec.encode Communication_wire.comment_ref pin)) )
      ; ( "request_status"
        , match notification.source with
          | Request id ->
            Json.field
              (Json.field (Communication_wire.request_json (find t.requests id)) "status")
              "kind"
          | Message _ | Thread _ -> `Null )
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
      (match optional params "revision" Json.integer with
       | Some revision -> expected t.revision revision
       | None ->
         require
           (offset = 0)
           Invalid_argument
           "pagination requires communication revision");
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
        let record =
          match Communication_wire.request_json request with
          | `Object fields ->
            Json.obj
              (fields
               @ [ "thread_revision", Json.int (find t.threads request.thread).revision
                 ; ( "superseded_by_request_ids"
                   , `Array
                       (Map.data t.requests
                        |> List.filter ~f:(fun other ->
                          List.mem
                            other.Request.supersedes
                            request.id
                            ~equal:Communication_id.Request.equal)
                        |> List.map ~f:(fun other ->
                          Communication_id.Request.jsonaf_of_t other.Request.id)) )
                 ; ( "answer"
                   , match request.status with
                     | Resolved { answer = Some pin; _ } ->
                       pinned_version discussion pin |> Discussion_wire.comment_json
                     | Resolved { answer = None; _ } | Open | Cancelled _ -> `Null )
                 ])
          | _ -> assert false
        in
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
        let priority = optional params "priority" Json.integer in
        let related_to =
          optional params "related_to_request_id" Communication_id.Request.t_of_jsonaf
        in
        let supersedes =
          optional params "supersedes_request_id" Communication_id.Request.t_of_jsonaf
        in
        let superseded_by =
          optional params "superseded_by_request_id" Communication_id.Request.t_of_jsonaf
        in
        Option.iter related_to ~f:(fun id -> ignore (find t.requests id : Request.t));
        Option.iter supersedes ~f:(fun id -> ignore (find t.requests id : Request.t));
        Option.iter superseded_by ~f:(fun id -> ignore (find t.requests id : Request.t));
        let ticket = optional params "ticket_id" Id.Ticket.t_of_jsonaf in
        let resolver = optional params "resolver_id" Id.Actor.t_of_jsonaf in
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
          && Option.value_map priority ~default:true ~f:(Int.equal request.priority)
          && Option.value_map related_to ~default:true ~f:(fun id ->
            List.mem request.related id ~equal:Communication_id.Request.equal
            || List.mem
                 (find t.requests id).related
                 request.id
                 ~equal:Communication_id.Request.equal)
          && Option.value_map supersedes ~default:true ~f:(fun id ->
            List.mem request.supersedes id ~equal:Communication_id.Request.equal)
          && Option.value_map superseded_by ~default:true ~f:(fun id ->
            List.mem
              (find t.requests id).supersedes
              request.id
              ~equal:Communication_id.Request.equal)
          && Option.value_map ticket ~default:true ~f:(fun ticket ->
            List.mem
              (find t.threads request.thread).links
              (Entity_ref.Ticket ticket)
              ~equal:Entity_ref.equal)
          && Option.value_map resolver ~default:true ~f:(Id.Actor.equal request.resolver)
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
        |> List.map ~f:(fun request ->
          let thread = find t.threads request.Request.thread in
          Communication_wire.request_list_json request ~thread ~scope:(scope t thread)
          |> unwrap)
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
