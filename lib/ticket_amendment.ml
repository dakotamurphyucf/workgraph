open Core
module Key = Amendment_id
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let encode codec value = Api_codec.encode codec value |> unwrap

let positive =
  W.checked W.counter (fun n ->
    if n = 0
    then Json.fail Invalid_argument "positive amendment revision or token required")
;;

let identifier = W.id Key.of_string Key.to_string

module Reference = struct
  type t =
    { id : Key.t
    ; revision : int
    }
  [@@deriving sexp, compare, equal]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "amendment_id" identifier ++ F.required "revision" positive)
         ~decode:(fun (id, revision) -> { id; revision })
         ~encode:(fun t -> t.id, t.revision))
  ;;
end

module Attribution = struct
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "actor_id" W.actor
          ++ F.required "run_id" (Api_codec.nullable W.run)
          ++ F.required "timestamp" (W.nonblank ~max_bytes:128))
         ~decode:(fun ((actor, run), timestamp) -> { actor; run; timestamp })
         ~encode:(fun t -> (t.actor, t.run), t.timestamp))
  ;;
end

module Source = struct
  type t =
    | Text of string
    | Resource of Evidence_event.Resource_pin.t
  [@@deriving sexp, equal]

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "text"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "text")
                  ++ F.required "body" (W.nonblank ~max_bytes:65536))
                 ~decode:(fun ((), body) -> Text body)
                 ~encode:(function
                   | Text body -> (), body
                   | Resource _ -> Json.fail Invalid_argument "inline amendment expected"))
          )
        ; ( "resource"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "resource")
                  ++ F.required "pin" Evidence_wire.resource_pin)
                 ~decode:(fun ((), pin) -> Resource pin)
                 ~encode:(function
                   | Resource pin -> (), pin
                   | Text _ -> Json.fail Invalid_argument "resource amendment expected"))
          )
        ]
      ~select:(function
        | Text _ -> "text"
        | Resource _ -> "resource")
  ;;
end

module Ownership = struct
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; token : int
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "actor_id" W.actor
          ++ F.required "run_id" (Api_codec.nullable W.run)
          ++ F.required "token" positive)
         ~decode:(fun ((actor, run), token) -> { actor; run; token })
         ~encode:(fun t -> (t.actor, t.run), t.token))
  ;;
end

module Revision = struct
  module Publication = struct
    type t =
      { title : string
      ; source : Source.t
      ; require_ack : bool
      ; supersedes : Reference.t list
      }
    [@@deriving sexp, equal]

    let codec =
      Api_codec.object_
        (F.map
           (F.required "title" (W.nonblank ~max_bytes:512)
            ++ F.required "source" Source.codec
            ++ F.required "require_ack" Api_codec.boolean
            ++ F.required "supersedes" (Api_codec.list Reference.codec ~max_items:32))
           ~decode:(fun (((title, source), require_ack), supersedes) ->
             { title; source; require_ack; supersedes })
           ~encode:(fun t -> ((t.title, t.source), t.require_ack), t.supersedes))
      |> fun codec ->
      W.checked codec (fun t ->
        if
          List.contains_dup t.supersedes ~compare:(fun a b ->
            Key.compare a.Reference.id b.id)
        then Json.fail Invalid_argument "duplicate superseded amendment")
    ;;
  end

  module Content = struct
    type t =
      | Published of Publication.t
      | Withdrawn of
          { previous : Reference.t
          ; reason : string
          }
      | Superseded of
          { previous : Reference.t
          ; replacement : Reference.t
          }
    [@@deriving sexp, equal]

    let codec =
      Api_codec.tagged
        ~discriminator:"kind"
        ~cases:
          [ ( "published"
            , Api_codec.object_
                (F.map
                   (F.required "kind" (Api_codec.literal "published")
                    ++ F.required "publication" Publication.codec)
                   ~decode:(fun ((), p) -> Published p)
                   ~encode:(function
                     | Published p -> (), p
                     | Withdrawn _ | Superseded _ ->
                       Json.fail Invalid_argument "publication expected")) )
          ; ( "withdrawn"
            , Api_codec.object_
                (F.map
                   (F.required "kind" (Api_codec.literal "withdrawn")
                    ++ F.required "previous" Reference.codec
                    ++ F.required "reason" (W.nonblank ~max_bytes:65536))
                   ~decode:(fun (((), previous), reason) ->
                     Withdrawn { previous; reason })
                   ~encode:(function
                     | Withdrawn { previous; reason } -> ((), previous), reason
                     | Published _ | Superseded _ ->
                       Json.fail Invalid_argument "withdrawal expected")) )
          ; ( "superseded"
            , Api_codec.object_
                (F.map
                   (F.required "kind" (Api_codec.literal "superseded")
                    ++ F.required "previous" Reference.codec
                    ++ F.required "replacement" Reference.codec)
                   ~decode:(fun (((), previous), replacement) ->
                     Superseded { previous; replacement })
                   ~encode:(function
                     | Superseded { previous; replacement } -> ((), previous), replacement
                     | Published _ | Withdrawn _ ->
                       Json.fail Invalid_argument "supersession expected")) )
          ]
        ~select:(function
          | Published _ -> "published"
          | Withdrawn _ -> "withdrawn"
          | Superseded _ -> "superseded")
    ;;
  end

  type t =
    { reference : Reference.t
    ; ticket : Id.Ticket.t
    ; content : Content.t
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "reference" Reference.codec
          ++ F.required "ticket_id" W.ticket
          ++ F.required "content" Content.codec
          ++ F.required "attribution" Attribution.codec)
         ~decode:(fun (((reference, ticket), content), attribution) ->
           { reference; ticket; content; attribution })
         ~encode:(fun t -> ((t.reference, t.ticket), t.content), t.attribution))
    |> fun codec ->
    W.checked codec (fun t ->
      match t.content with
      | Published p ->
        if List.exists p.supersedes ~f:(fun r -> Key.equal r.Reference.id t.reference.id)
        then Json.fail Dependency_cycle "amendment cannot supersede itself"
      | Withdrawn { previous; _ } | Superseded { previous; _ } ->
        if
          (not (Key.equal previous.id t.reference.id))
          || previous.revision >= Int.max_value
          || t.reference.revision <> previous.revision + 1
        then Json.fail Invalid_argument "terminal amendment previous revision differs";
        (match t.content with
         | Superseded { replacement; _ } when Key.equal replacement.id t.reference.id ->
           Json.fail Dependency_cycle "amendment cannot replace itself"
         | Published _ | Withdrawn _ | Superseded _ -> ()))
  ;;
end

module Acknowledgement = struct
  type t =
    { amendment : Reference.t
    ; ticket : Id.Ticket.t
    ; ownership : Ownership.t
    ; timestamp : string
    ; observed_unix_ms : int64 option
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "amendment" Reference.codec
          ++ F.required "ticket_id" W.ticket
          ++ F.required "ownership" Ownership.codec
          ++ F.required "timestamp" (W.nonblank ~max_bytes:128)
          ++ F.required
               "observed_unix_ms"
               (Api_codec.nullable (Api_codec.decimal64 ~max:Int64.max_value)))
         ~decode:(fun ((((amendment, ticket), ownership), timestamp), observed_unix_ms) ->
           { amendment; ticket; ownership; timestamp; observed_unix_ms })
         ~encode:(fun t ->
           (((t.amendment, t.ticket), t.ownership), t.timestamp), t.observed_unix_ms))
  ;;

  let jsonaf_of_t t = encode codec t
  let t_of_jsonaf json = Api_codec.decode codec json |> unwrap

  let validate_lease t ~lease =
    Json.decode (fun () ->
      ignore (encode codec t : Jsonaf.t);
      if t.ownership.token <> Allocation_lease.epoch lease
      then Json.fail Stale_claim "amendment acknowledgement lease epoch differs";
      match t.observed_unix_ms, Allocation_lease.deadline_unix_ms lease with
      | None, None -> ()
      | None, Some _ ->
        Json.fail
          Invalid_argument
          "timed amendment acknowledgement requires recorded server clock"
      | Some now_unix_ms, _ ->
        (match
           Allocation_lease.validate_owner lease ~epoch:t.ownership.token ~now_unix_ms
         with
         | Ok () -> ()
         | Error error -> raise (Json.Decode_error error)))
  ;;
end

module Update = struct
  type t =
    | Revisions of Revision.t list
    | Acknowledged of Acknowledgement.t
  [@@deriving sexp, equal]

  let codec =
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "revisions"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "revisions")
                  ++ F.required
                       "records"
                       (W.checked
                          (Api_codec.list Revision.codec ~max_items:33)
                          (fun records ->
                             if List.is_empty records
                             then
                               Json.fail
                                 Invalid_argument
                                 "empty amendment revision change")))
                 ~decode:(fun ((), r) -> Revisions r)
                 ~encode:(function
                   | Revisions r -> (), r
                   | Acknowledged _ ->
                     Json.fail Invalid_argument "amendment revisions expected")) )
        ; ( "acknowledged"
          , Api_codec.object_
              (F.map
                 (F.required "kind" (Api_codec.literal "acknowledged")
                  ++ F.required "acknowledgement" Acknowledgement.codec)
                 ~decode:(fun ((), a) -> Acknowledged a)
                 ~encode:(function
                   | Acknowledged a -> (), a
                   | Revisions _ -> Json.fail Invalid_argument "amendment ack expected"))
          )
        ]
      ~select:(function
        | Revisions _ -> "revisions"
        | Acknowledged _ -> "acknowledged")
  ;;
end

module Change = struct
  type t =
    { revision : int
    ; update : Update.t
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (F.map
         (F.required "revision" positive ++ F.required "update" Update.codec)
         ~decode:(fun (revision, update) -> { revision; update })
         ~encode:(fun t -> t.revision, t.update))
  ;;

  let targets t =
    match t.update with
    | Update.Revisions records ->
      List.map records ~f:(fun r -> r.Revision.ticket)
      |> List.dedup_and_sort ~compare:Id.Ticket.compare
    | Acknowledged ack -> [ ack.ticket ]
  ;;

  let to_json t = encode codec t
  let of_json = Api_codec.decode codec
  let jsonaf_of_t = to_json
  let t_of_jsonaf json = of_json json |> unwrap
end

module Command = struct
  type t =
    | Publish of
        { id : Key.t
        ; ticket : Id.Ticket.t
        ; expected_revision : int
        ; title : string
        ; source : Source.t
        ; require_ack : bool
        ; supersedes : Reference.t list
        }
    | Withdraw of
        { amendment : Reference.t
        ; reason : string
        }
    | Acknowledge of
        { amendment : Reference.t
        ; ticket : Id.Ticket.t
        ; token : int
        }
  [@@deriving sexp]
end

type t =
  { revision : int
  ; records : Revision.t list Key.Map.t
  ; acks : Acknowledgement.t list
  }

type prepared =
  { candidate : t
  ; changes : Change.t list
  ; result : Jsonaf.t
  }

let empty = { revision = 0; records = Key.Map.empty; acks = [] }
let revision t = t.revision
let candidate t = t.candidate
let changes t = t.changes
let result t = t.result
let head t id = Map.find t.records id |> Option.bind ~f:List.hd
let history t id = Map.find t.records id |> Option.value ~default:[] |> List.rev

let get t reference =
  List.find (history t reference.Reference.id) ~f:(fun r ->
    Reference.equal r.Revision.reference reference)
;;

let heads t ~ticket =
  Map.data t.records
  |> List.filter_map ~f:List.hd
  |> List.filter ~f:(fun r ->
    Option.for_all ticket ~f:(Id.Ticket.equal r.Revision.ticket))
;;

let acknowledgements t reference =
  List.filter t.acks ~f:(fun a -> Reference.equal a.Acknowledgement.amendment reference)
;;

let require condition kind message = if not condition then Json.fail kind message

let next_counter value =
  require (value < Int.max_value) Conflict "amendment revision exhausted";
  value + 1
;;

let find_head t reference =
  let current =
    match head t reference.Reference.id with
    | Some r -> r
    | None -> Json.fail Not_found "amendment not found"
  in
  if not (Reference.equal current.reference reference)
  then
    raise
      (Json.Decode_error
         (Problem.create Conflict "amendment revision changed"
          |> fun error ->
          Problem.with_details
            error
            (Problem.Details.Revision
               { expected = reference.revision; actual = current.reference.revision })));
  current
;;

let active t reference =
  let current = find_head t reference in
  match current.content with
  | Published p -> current, p
  | Withdrawn _ | Superseded _ ->
    Json.fail Conflict "amendment is terminal; publish a new identity"
;;

let binding_equal (a : Acknowledgement.t) (b : Acknowledgement.t) =
  Reference.equal a.amendment b.amendment
  && Id.Ticket.equal a.ticket b.ticket
  && Ownership.equal a.ownership b.ownership
;;

let apply_exn t change ~ownership =
  ignore (encode Change.codec change : Jsonaf.t);
  require
    (change.Change.revision = next_counter t.revision)
    Corrupt_store
    "amendment activity revision is not consecutive";
  let append state record =
    let old =
      Map.find state.records record.Revision.reference.id |> Option.value ~default:[]
    in
    { state with
      records = Map.set state.records ~key:record.reference.id ~data:(record :: old)
    }
  in
  let next =
    match change.update with
    | Acknowledged a ->
      let record, _ = active t a.amendment in
      require
        (Id.Ticket.equal record.ticket a.ticket)
        Conflict
        "ack ticket differs from amendment";
      require
        (Option.equal Ownership.equal (ownership a.ticket) (Some a.ownership))
        Stale_claim
        "amendment acknowledgement requires current actor/run/claim token";
      require
        (not (List.exists t.acks ~f:(binding_equal a)))
        Corrupt_store
        "duplicate amendment acknowledgement event";
      { t with acks = t.acks @ [ a ] }
    | Revisions [] -> Json.fail Invalid_argument "empty amendment revision change"
    | Revisions (first :: rest) ->
      let previous = head t first.reference.id in
      let next_revision =
        Option.value_map previous ~default:1 ~f:(fun r ->
          next_counter r.Revision.reference.revision)
      in
      require
        (first.reference.revision = next_revision)
        Conflict
        "amendment revision is not consecutive";
      Option.iter previous ~f:(fun r ->
        require
          (Id.Ticket.equal r.Revision.ticket first.ticket)
          Conflict
          "amendment ticket cannot change";
        ignore (active t r.reference : Revision.t * Revision.Publication.t));
      (match first.content with
       | Published p ->
         let expected =
           List.map p.supersedes ~f:(fun reference ->
             require
               (not (Key.equal reference.Reference.id first.reference.id))
               Dependency_cycle
               "amendment cannot supersede itself";
             let old, _ = active t reference in
             require
               (Id.Ticket.equal old.ticket first.ticket)
               Conflict
               "superseded amendment belongs to another ticket";
             { Revision.reference =
                 { reference with revision = next_counter reference.revision }
             ; ticket = old.ticket
             ; content =
                 Superseded { previous = reference; replacement = first.reference }
             ; attribution = first.attribution
             })
         in
         require
           (List.equal Revision.equal expected rest)
           Corrupt_store
           "publication supersession audit differs";
         List.fold (first :: rest) ~init:t ~f:append
       | Withdrawn { previous = reference; reason = _ } ->
         require
           (List.is_empty rest)
           Invalid_argument
           "withdrawal must be a single record";
         let old, _ = active t reference in
         require
           (Key.equal reference.id first.reference.id
            && Id.Ticket.equal old.ticket first.ticket
            && first.reference.revision = next_counter reference.revision)
           Conflict
           "withdrawal prior revision differs";
         append t first
       | Superseded _ ->
         Json.fail Corrupt_store "standalone supersession is not an atomic publication")
  in
  { next with revision = change.revision }
;;

let apply t change ~ownership = Json.decode (fun () -> apply_exn t change ~ownership)

let prepare t command ~actor ~run ~timestamp ~now_unix_ms ~ownership =
  Json.decode (fun () ->
    let attribution = { Attribution.actor; run; timestamp } in
    let update =
      match command with
      | Command.Publish
          { id; ticket; expected_revision; title; source; require_ack; supersedes } ->
        let actual =
          Option.value_map (head t id) ~default:0 ~f:(fun r ->
            r.Revision.reference.revision)
        in
        require
          (expected_revision = actual)
          Conflict
          "amendment publication expected revision differs";
        let first =
          { Revision.reference = { id; revision = next_counter actual }
          ; ticket
          ; content = Published { title; source; require_ack; supersedes }
          ; attribution
          }
        in
        let terminal =
          List.map supersedes ~f:(fun reference ->
            let old, _ = active t reference in
            { Revision.reference =
                { reference with revision = next_counter reference.revision }
            ; ticket = old.ticket
            ; content = Superseded { previous = reference; replacement = first.reference }
            ; attribution
            })
        in
        Update.Revisions (first :: terminal)
      | Withdraw { amendment; reason } ->
        let old, _ = active t amendment in
        Revisions
          [ { Revision.reference =
                { amendment with revision = next_counter amendment.revision }
            ; ticket = old.ticket
            ; content = Withdrawn { previous = amendment; reason }
            ; attribution
            }
          ]
      | Acknowledge { amendment; ticket; token } ->
        Acknowledged
          { amendment
          ; ticket
          ; ownership = { actor; run; token }
          ; timestamp
          ; observed_unix_ms = now_unix_ms
          }
    in
    match update with
    | Acknowledged a when List.exists t.acks ~f:(binding_equal a) ->
      ignore (encode Acknowledgement.codec a : Jsonaf.t);
      ignore (active t a.amendment : Revision.t * Revision.Publication.t);
      require
        (Option.equal Ownership.equal (ownership a.ticket) (Some a.ownership))
        Stale_claim
        "amendment acknowledgement ownership changed";
      { candidate = t
      ; changes = []
      ; result =
          Json.obj [ "amendment", encode Reference.codec a.amendment; "duplicate", `True ]
      }
    | Revisions _ | Acknowledged _ ->
      let change = { Change.revision = next_counter t.revision; update } in
      let candidate = apply_exn t change ~ownership in
      { candidate
      ; changes = [ change ]
      ; result =
          (match update with
           | Revisions records ->
             Json.obj
               [ "reference", encode Reference.codec (List.hd_exn records).reference
               ; ( "changed"
                 , `Array
                     (List.map records ~f:(fun r ->
                        encode Reference.codec r.Revision.reference)) )
               ]
           | Acknowledged a ->
             Json.obj
               [ "amendment", encode Reference.codec a.amendment; "duplicate", `False ])
      })
;;

let pending t ~ticket ~ownership =
  heads t ~ticket:(Some ticket)
  |> List.filter_map ~f:(fun r ->
    match r.Revision.content with
    | Published p when p.require_ack ->
      if
        List.exists t.acks ~f:(fun a ->
          Reference.equal a.amendment r.reference
          && Option.equal Ownership.equal ownership (Some a.ownership))
      then None
      else Some r.reference
    | Published _ | Withdrawn _ | Superseded _ -> None)
;;

let ensure_can_complete t ~ticket ~ownership =
  Json.decode (fun () ->
    let missing = pending t ~ticket ~ownership in
    if not (List.is_empty missing)
    then
      Json.fail
        Blocked
        (sprintf
           "required amendment acknowledgement missing (%d): %s; acknowledge each exact \
            revision for the current claim"
           (List.length missing)
           (List.take missing 8
            |> List.map ~f:(fun r ->
              sprintf "%s@%d" (Key.to_string r.Reference.id) r.revision)
            |> String.concat ~sep:", ")))
;;

let validate_references t ~ticket_exists ~resource_digest =
  Json.decode (fun () ->
    Map.iter t.records ~f:(fun versions ->
      List.iter versions ~f:(fun r ->
        require (ticket_exists r.Revision.ticket) Not_found "amendment ticket missing";
        match r.content with
        | Published { source = Resource pin; _ } ->
          require
            (Option.equal
               String.equal
               (resource_digest pin.id ~revision:pin.revision)
               (Some pin.digest))
            Not_found
            "amendment immutable resource pin missing or digest differs"
        | Published { source = Text _; _ } | Withdrawn _ | Superseded _ -> ()));
    List.iter t.acks ~f:(fun a ->
      match get t a.Acknowledgement.amendment with
      | Some { content = Published _; ticket; _ } ->
        require (Id.Ticket.equal ticket a.ticket) Corrupt_store "ack ticket differs"
      | Some _ | None -> Json.fail Corrupt_store "ack publication missing"))
;;

let to_json t =
  Json.obj
    [ "revision", Json.int t.revision
    ; ( "records"
      , `Array
          (Map.data t.records
           |> List.concat_map ~f:List.rev
           |> List.map ~f:(encode Revision.codec)) )
    ; "acknowledgements", `Array (List.map t.acks ~f:(encode Acknowledgement.codec))
    ]
;;

module Id = Amendment_id
