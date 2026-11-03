open Core
module A = Ticket_amendment
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let opt = F.optional
let raw fields = Api_codec.as_json (Api_codec.object_ fields)

let unwrap = function
  | Ok x -> x
  | Error e -> raise (Json.Decode_error e)
;;

let json codec value = Api_codec.encode codec value |> unwrap
let identifier = W.id Amendment_id.of_string Amendment_id.to_string

let positive =
  W.checked W.counter (fun n ->
    if n = 0 then Json.fail Invalid_argument "amendment revision/token must be positive")
;;

let mutation_methods =
  [ "ticket.amendment.publish"
  ; "ticket.amendment.withdraw"
  ; "ticket.amendment.acknowledge"
  ]
;;

let query_methods =
  [ "ticket.amendment.get"
  ; "ticket.amendment.list"
  ; "ticket.amendment.history"
  ; "ticket.amendment.acknowledgements"
  ]
;;

let publication =
  Api_codec.object_
    (F.map
       (req "amendment_id" identifier
        ++ req "ticket_id" W.ticket
        ++ req "expected_revision" W.counter
        ++ req "title" (W.nonblank ~max_bytes:512)
        ++ req "source" A.Source.codec
        ++ opt "require_ack" Api_codec.boolean
        ++ opt "supersedes" (Api_codec.list A.Reference.codec ~max_items:32))
       ~decode:
         (fun
           ( (((((id, ticket), expected_revision), title), source), require_ack)
           , supersedes ) ->
         A.Command.Publish
           { id
           ; ticket
           ; expected_revision
           ; title
           ; source
           ; require_ack = Option.value require_ack ~default:false
           ; supersedes = Option.value supersedes ~default:[]
           })
       ~encode:(function
         | Publish
             { id; ticket; expected_revision; title; source; require_ack; supersedes } ->
           ( (((((id, ticket), expected_revision), title), source), Some require_ack)
           , Some supersedes )
         | Withdraw _ | Acknowledge _ ->
           Json.fail Invalid_argument "publication command expected"))
  |> fun codec ->
  W.checked codec (function
    | A.Command.Publish { id; supersedes; _ } ->
      if
        List.contains_dup supersedes ~compare:(fun a b ->
          Amendment_id.compare a.A.Reference.id b.id)
      then Json.fail Invalid_argument "duplicate superseded amendment";
      if List.exists supersedes ~f:(fun r -> Amendment_id.equal id r.A.Reference.id)
      then Json.fail Dependency_cycle "amendment cannot supersede itself"
    | Withdraw _ | Acknowledge _ ->
      Json.fail Invalid_argument "publication command expected")
;;

let withdrawal =
  Api_codec.object_
    (F.map
       (req "amendment_id" identifier
        ++ req "expected_revision" positive
        ++ req "reason" (W.nonblank ~max_bytes:65536))
       ~decode:(fun ((id, revision), reason) ->
         A.Command.Withdraw { amendment = { id; revision }; reason })
       ~encode:(function
         | Withdraw { amendment; reason } -> (amendment.id, amendment.revision), reason
         | Publish _ | Acknowledge _ ->
           Json.fail Invalid_argument "withdrawal command expected"))
;;

let acknowledgement =
  Api_codec.object_
    (F.map
       (req "amendment_id" identifier
        ++ req "expected_revision" positive
        ++ req "ticket_id" W.ticket
        ++ req "token" positive)
       ~decode:(fun (((id, revision), ticket), token) ->
         A.Command.Acknowledge { amendment = { id; revision }; ticket; token })
       ~encode:(function
         | Acknowledge { amendment; ticket; token } ->
           ((amendment.id, amendment.revision), ticket), token
         | Publish _ | Withdraw _ -> Json.fail Invalid_argument "ack command expected"))
;;

let mutation_codec = function
  | "ticket.amendment.publish" -> Some publication
  | "ticket.amendment.withdraw" -> Some withdrawal
  | "ticket.amendment.acknowledge" -> Some acknowledgement
  | _ -> None
;;

let decode ~method_ ~params =
  match mutation_codec method_ with
  | Some codec -> Api_codec.decode codec params
  | None -> Error (Problem.create Invalid_argument "unknown amendment mutation")
;;

let encode command =
  let method_ =
    match command with
    | A.Command.Publish _ -> "ticket.amendment.publish"
    | Withdraw _ -> "ticket.amendment.withdraw"
    | Acknowledge _ -> "ticket.amendment.acknowledge"
  in
  Result.map
    (Api_codec.encode (Option.value_exn (mutation_codec method_)) command)
    ~f:(fun json -> method_, json)
;;

let bounds =
  opt "at_revision" W.counter
  ++ opt
       "max_bytes"
       (W.checked (Api_codec.decimal ~max:1048576) (fun n ->
          if n < 4096
          then Json.fail Invalid_argument "query max_bytes must be 4096..1048576"))
;;

let page =
  opt
    "limit"
    (W.checked (Api_codec.decimal ~max:100) (fun n ->
       if n = 0 then Json.fail Invalid_argument "limit must be 1..100"))
  ++ opt "offset" W.counter
  ++ bounds
;;

let query_codec = function
  | "ticket.amendment.get" ->
    Some (raw (req "amendment_id" identifier ++ opt "revision" positive ++ bounds))
  | "ticket.amendment.list" ->
    Some (raw (opt "ticket_id" W.ticket ++ opt "active_only" Api_codec.boolean ++ page))
  | "ticket.amendment.history" -> Some (raw (req "amendment_id" identifier ++ page))
  | "ticket.amendment.acknowledgements" ->
    Some (raw (req "amendment_id" identifier ++ req "revision" positive ++ page))
  | _ -> None
;;

let publication_result =
  raw
    (req "reference" A.Reference.codec
     ++ req "changed" (Api_codec.list A.Reference.codec ~max_items:33))
  |> fun codec ->
  W.checked codec (fun value ->
    let reference =
      Json.field value "reference" |> Api_codec.decode A.Reference.codec |> unwrap
    in
    let changed =
      Json.field value "changed"
      |> Json.list
      |> List.map ~f:(fun v -> Api_codec.decode A.Reference.codec v |> unwrap)
    in
    if
      (not
         (Option.value_map
            (List.hd changed)
            ~default:false
            ~f:(A.Reference.equal reference)))
      || List.contains_dup changed ~compare:(fun a b ->
        Amendment_id.compare a.A.Reference.id b.id)
    then Json.fail Invalid_argument "amendment publication result references differ")
;;

let ack_result =
  raw (req "amendment" A.Reference.codec ++ req "duplicate" Api_codec.boolean)
;;

let bool value key =
  match Json.field value key with
  | `True -> true
  | `False -> false
  | _ -> Json.fail Invalid_argument "boolean required"
;;

let nullable value key =
  match Json.field value key with
  | `Null -> None
  | value -> Some value
;;

let page_result codec =
  raw
    (req "items" (Api_codec.list codec ~max_items:100)
     ++ req "offset" W.counter
     ++ req "remaining" W.counter
     ++ req "next_offset" (Api_codec.nullable W.counter)
     ++ req "needs_larger_budget" Api_codec.boolean
     ++ req "required_bytes" (Api_codec.nullable W.counter))
  |> fun codec ->
  W.checked codec (fun value ->
    let count = Json.field value "items" |> Json.list |> List.length in
    let offset = Json.field value "offset" |> Json.integer
    and remaining = Json.field value "remaining" |> Json.integer in
    let next = nullable value "next_offset" |> Option.map ~f:Json.integer in
    let needs = bool value "needs_larger_budget" in
    let required = nullable value "required_bytes" |> Option.map ~f:Json.integer in
    if
      count > Int.max_value - offset
      || (not
            (Option.equal
               Int.equal
               next
               (if remaining = 0 then None else Some (offset + count))))
      || (not (Bool.equal needs (count = 0 && remaining > 0)))
      || (not (Bool.equal needs (Option.is_some required)))
      || Option.exists required ~f:(fun n -> n = 0)
    then
      Json.fail Invalid_argument "amendment page continuation or budget metadata differs")
;;

let get_result =
  raw
    (req "item" (Api_codec.nullable A.Revision.codec)
     ++ req "reference" A.Reference.codec
     ++ req "head_revision" positive
     ++ req "active" Api_codec.boolean
     ++ req "pending_acknowledgement" Api_codec.boolean
     ++ req "acknowledgements" W.counter
     ++ req "needs_larger_budget" Api_codec.boolean
     ++ req "required_bytes" (Api_codec.nullable W.counter))
  |> fun codec ->
  W.checked codec (fun value ->
    let reference =
      Json.field value "reference" |> Api_codec.decode A.Reference.codec |> unwrap
    in
    let head = Json.field value "head_revision" |> Json.integer in
    let item =
      nullable value "item"
      |> Option.map ~f:(fun item -> Api_codec.decode A.Revision.codec item |> unwrap)
    in
    let active = bool value "active"
    and pending = bool value "pending_acknowledgement"
    and needs = bool value "needs_larger_budget" in
    let required = nullable value "required_bytes" |> Option.map ~f:Json.integer in
    if
      reference.revision > head
      || (active && reference.revision <> head)
      || (pending && not active)
      || (not (Bool.equal needs (Option.is_none item)))
      || (not (Bool.equal needs (Option.is_some required)))
      || Option.exists required ~f:(fun n -> n = 0)
      || Option.exists item ~f:(fun r ->
        (not (A.Reference.equal reference r.A.Revision.reference))
        || not
             (Bool.equal
                active
                (reference.revision = head
                 &&
                 match r.content with
                 | Published _ -> true
                 | Withdrawn _ | Superseded _ -> false)))
    then Json.fail Invalid_argument "amendment read reference or budget metadata differs")
;;

let response_codec ~method_ =
  if List.mem mutation_methods method_ ~equal:String.equal
  then
    Some
      (if String.equal method_ "ticket.amendment.acknowledge"
       then ack_result
       else publication_result)
  else if List.mem query_methods method_ ~equal:String.equal
  then
    Some
      (if String.equal method_ "ticket.amendment.get"
       then get_result
       else if String.equal method_ "ticket.amendment.acknowledgements"
       then page_result A.Acknowledgement.codec
       else page_result A.Revision.codec)
  else None
;;

let validate_result ~method_ result =
  match response_codec ~method_ with
  | None -> invalid_arg "unknown amendment result method"
  | Some codec ->
    (match Api_codec.encode codec result with
     | Ok _ -> ()
     | Error error -> raise (Api_method.Invalid_response (method_, error)))
;;

let methods =
  List.map mutation_methods ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:
           "Publish an immutable instruction revision, withdraw explicitly, or \
            acknowledge an exact revision and claim."
         ~mode:Mutation
         ~request:(Option.value_exn (mutation_codec name))
         ~response:
           (if String.equal name "ticket.amendment.acknowledge"
            then ack_result
            else publication_result)))
  @ List.map query_methods ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:
           "Read captured immutable amendment revisions and exact ownership \
            acknowledgements with whole-record pagination."
         ~mode:Read
         ~request:(Option.value_exn (query_codec name))
         ~response:
           (if String.equal name "ticket.amendment.get"
            then get_result
            else if String.equal name "ticket.amendment.acknowledgements"
            then page_result A.Acknowledgement.codec
            else page_result A.Revision.codec)))
;;

let query t ~workspace_revision ~ownership ~ticket_completed ~method_ ~params =
  Json.decode (fun () ->
    ignore
      (Api_codec.decode
         (match query_codec method_ with
          | Some c -> c
          | None -> Json.fail Invalid_argument "unknown amendment query")
         params
       |> unwrap
       : Jsonaf.t);
    let optional key decode = Option.map (Json.optional params key) ~f:decode in
    let guard = optional "at_revision" Json.integer in
    Option.iter guard ~f:(fun revision ->
      if revision <> workspace_revision
      then Json.fail Conflict "amendment query workspace capture changed");
    let max_bytes = Query_budget.of_params params in
    let envelope data ~omitted_items =
      Json.obj [ "workspace_revision", Json.int workspace_revision; "data", data ]
      |> Query_budget.annotate_whole_items_exn
           ~measure:(Api_response.encoded_size Planning_read)
           ~max_bytes
           ~omitted_items
    in
    (* The annotation includes max_bytes itself. Solve the minimum budget against
    its own decimal width, so retrying exactly required_bytes really fits. *)
    let required_budget value =
      let fields =
        match value with
        | `Object fields -> List.Assoc.remove fields "budget" ~equal:String.equal
        | _ -> assert false
      in
      let omitted_items =
        Json.field (Json.field value "budget") "omitted_items" |> Json.integer
      in
      let rec minimum budget =
        let sized =
          Json.obj fields
          |> Query_budget.annotate_whole_items_exn
               ~measure:(Api_response.encoded_size Planning_read)
               ~max_bytes:budget
               ~omitted_items
          |> Api_response.encoded_size Planning_read
        in
        let next = Int.max 4096 sized in
        if next = budget then budget else minimum next
      in
      minimum 4096
    in
    let id () = Json.field params "amendment_id" |> Amendment_id.t_of_jsonaf in
    let find_head id =
      match A.head t id with
      | Some r -> r
      | None -> Json.fail Not_found "amendment not found"
    in
    let get_reference () =
      { A.Reference.id = id (); revision = Json.field params "revision" |> Json.integer }
    in
    if String.equal method_ "ticket.amendment.get"
    then (
      let head = find_head (id ()) in
      let reference =
        Option.value_map
          (optional "revision" Json.integer)
          ~default:head.reference
          ~f:(fun revision -> { A.Reference.id = id (); revision })
      in
      let record =
        match A.get t reference with
        | Some r -> r
        | None -> Json.fail Not_found "amendment revision not found"
      in
      let active =
        A.Reference.equal reference head.reference
        &&
        match head.content with
        | Published _ -> true
        | Withdrawn _ | Superseded _ -> false
      in
      let pending =
        (not (ticket_completed record.ticket))
        && List.exists
             (A.pending t ~ticket:record.ticket ~ownership:(ownership record.ticket))
             ~f:(A.Reference.equal reference)
      in
      let data item ~required_bytes =
        Json.obj
          [ ( "item"
            , Option.value_map item ~default:`Null ~f:(fun r -> json A.Revision.codec r) )
          ; "reference", json A.Reference.codec reference
          ; "head_revision", Json.int head.reference.revision
          ; ("active", if active then `True else `False)
          ; ("pending_acknowledgement", if pending then `True else `False)
          ; "acknowledgements", Json.int (List.length (A.acknowledgements t reference))
          ; ("needs_larger_budget", if Option.is_none item then `True else `False)
          ; "required_bytes", Option.value_map required_bytes ~default:`Null ~f:Json.int
          ]
      in
      let full = envelope (data (Some record) ~required_bytes:None) ~omitted_items:0 in
      if Api_response.encoded_size Planning_read full <= max_bytes
      then full
      else (
        let result =
          envelope
            (data None ~required_bytes:(Some (required_budget full)))
            ~omitted_items:1
        in
        if Api_response.encoded_size Planning_read result > max_bytes
        then Json.fail Invalid_argument "amendment metadata exceeds query budget";
        result))
    else (
      let items =
        match method_ with
        | "ticket.amendment.list" ->
          A.heads t ~ticket:(optional "ticket_id" Id.Ticket.t_of_jsonaf)
          |> List.filter ~f:(fun r ->
            (not
               (Option.value_map
                  (Json.optional params "active_only")
                  ~default:true
                  ~f:(function
                  | `True -> true
                  | _ -> false)))
            ||
            match r.A.Revision.content with
            | Published _ -> true
            | Withdrawn _ | Superseded _ -> false)
          |> List.map ~f:(fun r -> json A.Revision.codec r)
        | "ticket.amendment.history" ->
          ignore (find_head (id ()) : A.Revision.t);
          A.history t (id ()) |> List.map ~f:(fun r -> json A.Revision.codec r)
        | "ticket.amendment.acknowledgements" ->
          let reference = get_reference () in
          if Option.is_none (A.get t reference)
          then Json.fail Not_found "amendment revision not found";
          A.acknowledgements t reference
          |> List.map ~f:(fun a -> json A.Acknowledgement.codec a)
        | _ -> Json.fail Invalid_argument "unsupported amendment page"
      in
      let offset = Option.value (optional "offset" Json.integer) ~default:0
      and limit = Option.value (optional "limit" Json.integer) ~default:50 in
      if offset > 0 && Option.is_none guard
      then Json.fail Invalid_argument "amendment pagination requires at_revision";
      let remaining = List.drop items offset in
      let page selected ~required_bytes =
        let count = List.length selected in
        let left = List.length remaining - count in
        Json.obj
          [ "items", `Array selected
          ; "offset", Json.int offset
          ; "remaining", Json.int left
          ; ("next_offset", if left = 0 then `Null else Json.int (offset + count))
          ; ("needs_larger_budget", if count = 0 && left > 0 then `True else `False)
          ; "required_bytes", Option.value_map required_bytes ~default:`Null ~f:Json.int
          ]
        |> fun data ->
        envelope data ~omitted_items:(Int.min limit (List.length remaining) - count)
      in
      let required =
        Option.map (List.hd remaining) ~f:(fun item ->
          page [ item ] ~required_bytes:None |> required_budget)
      in
      let rec fit count =
        let result =
          page
            (List.take remaining count)
            ~required_bytes:(if count = 0 then required else None)
        in
        if Api_response.encoded_size Planning_read result <= max_bytes
        then result
        else if count > 0
        then fit (count - 1)
        else Json.fail Invalid_argument "amendment page metadata exceeds query budget"
      in
      fit (Int.min limit (List.length remaining))))
;;
