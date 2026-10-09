open Core

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let invalid message = Error (Problem.create Invalid_argument message)
let count = Api_codec.decimal ~max:Int.max_value

let digest =
  Api_codec.map
    (Api_codec.text ~max_bytes:64)
    ~decode:(fun text ->
      if
        String.length text = 64
        && String.for_all text ~f:(fun c ->
          Char.is_digit c || Char.between c ~low:'a' ~high:'f')
      then Ok text
      else invalid "digest must be 64 lowercase SHA-256 hexadecimal characters")
    ~encode:Fn.id
    ~description:"64 lowercase hexadecimal SHA-256 characters."
;;

module Query_scope = struct
  type t =
    | Communication
    | Runs
    | Evidence
    | Policy
  [@@deriving sexp, equal]

  let name = function
    | Communication -> "communication"
    | Runs -> "runs"
    | Evidence -> "evidence"
    | Policy -> "policy"
  ;;

  let codec =
    Api_codec.enum
      (List.map [ Communication; Runs; Evidence; Policy ] ~f:(fun t -> name t, t))
      ~equal
  ;;
end

module Budget = struct
  module Detail = struct
    let valid_pointer path =
      let rec escapes index =
        if index >= String.length path
        then true
        else if Char.equal path.[index] '~'
        then
          index + 1 < String.length path
          && (Char.equal path.[index + 1] '0' || Char.equal path.[index + 1] '1')
          && escapes (index + 2)
        else escapes (index + 1)
      in
      String.is_prefix path ~prefix:"/" && escapes 0
    ;;

    module Kind = struct
      type t =
        | Text_bytes
        | Items
      [@@deriving equal]

      let codec = Api_codec.enum [ "text_bytes", Text_bytes; "items", Items ] ~equal
    end

    type t =
      { path : string
      ; kind : Kind.t
      ; omitted : int
      }

    let codec =
      let open Api_codec in
      let open Fields in
      both
        (both
           (required "path" (text ~max_bytes:Framing.max_bytes))
           (required "kind" Kind.codec))
        (required "omitted" count)
      |> map
           ~decode:(fun ((path, kind), omitted) -> { path; kind; omitted })
           ~encode:(fun { path; kind; omitted } -> (path, kind), omitted)
      |> object_
      |> Api_codec.map
           ~decode:(fun t ->
             if valid_pointer t.path && t.omitted > 0
             then Ok t
             else
               invalid "budget details require a JSON pointer and positive omission count")
           ~encode:Fn.id
           ~description:
             "Path is a JSON pointer into the public result; omitted is positive."
    ;;
  end

  type t =
    { max_bytes : int
    ; returned_bytes : int
    ; truncated : bool
    ; omitted_fields : int
    ; omitted_items : int
    ; details : Detail.t list
    ; details_complete : bool
    }

  let details_consistent t =
    let rec consume details ~fields ~items =
      match details with
      | [] -> (not t.details_complete) || (fields = 0 && items = 0)
      | { Detail.kind = Text_bytes; _ } :: rest ->
        fields > 0 && consume rest ~fields:(fields - 1) ~items
      | { Detail.kind = Items; omitted; _ } :: rest ->
        omitted <= items && consume rest ~fields ~items:(items - omitted)
    in
    (not
       (List.contains_dup
          (List.map t.details ~f:(fun detail -> detail.Detail.path))
          ~compare:String.compare))
    && consume t.details ~fields:t.omitted_fields ~items:t.omitted_items
  ;;

  let codec =
    let open Api_codec in
    let open Fields in
    both
      (both
         (both (required "max_bytes" count) (required "returned_bytes" count))
         (both (required "truncated" boolean) (required "omitted_fields" count)))
      (both
         (required "omitted_items" count)
         (both
            (required "details" (list Detail.codec ~max_items:4))
            (required "details_complete" boolean)))
    |> map
         ~decode:
           (fun
             ( ((max_bytes, returned_bytes), (truncated, omitted_fields))
             , (omitted_items, (details, details_complete)) ) ->
           { max_bytes
           ; returned_bytes
           ; truncated
           ; omitted_fields
           ; omitted_items
           ; details
           ; details_complete
           })
         ~encode:
           (fun
             { max_bytes
             ; returned_bytes
             ; truncated
             ; omitted_fields
             ; omitted_items
             ; details
             ; details_complete
             } ->
           ( ((max_bytes, returned_bytes), (truncated, omitted_fields))
           , (omitted_items, (details, details_complete)) ))
    |> object_
    |> Api_codec.map
         ~decode:(fun t ->
           if
             t.max_bytes < 4096
             || t.max_bytes > 1024 * 1024
             || t.returned_bytes > t.max_bytes
           then invalid "query budget byte counts are outside bounds"
           else if
             not (Bool.equal t.truncated (t.omitted_fields > 0 || t.omitted_items > 0))
           then invalid "query budget truncation flag disagrees with omission counts"
           else if
             (not t.truncated)
             && ((not (List.is_empty t.details)) || not t.details_complete)
           then invalid "an untruncated query cannot have omissions"
           else if not (details_consistent t)
           then invalid "query budget details disagree with omission totals"
           else Ok t)
         ~encode:Fn.id
         ~description:
           "4096 <= returned-byte budget <= 1048576; returned_bytes <= max_bytes. \
            Truncated iff fields or items were omitted. Detail paths are unique; item \
            counts and text-field counts cannot exceed totals, and equal them when \
            details_complete is true."
  ;;
end

module History_capture = struct
  module Session_bound = struct
    type t =
      { session : Session_id.t
      ; through : Api_position.Session_sequence.t
      }

    let codec =
      let open Api_codec in
      let id =
        map
          (text ~max_bytes:96)
          ~decode:Session_id.of_string
          ~encode:Session_id.to_string
          ~description:"Session identifier."
      in
      Fields.both
        (Fields.required "session_id" id)
        (Fields.required "through" Api_position.Session_sequence.codec)
      |> Fields.map
           ~decode:(fun (session, through) -> { session; through })
           ~encode:(fun { session; through } -> session, through)
      |> object_
    ;;
  end

  type t =
    { workspace : Id.Workspace.t
    ; head : string option
    ; sequence : Api_position.History_sequence.t
    ; sessions : Session_bound.t list
    }

  let codec =
    let open Api_codec in
    let workspace =
      map
        (text ~max_bytes:96)
        ~decode:Id.Workspace.of_string
        ~encode:Id.Workspace.to_string
        ~description:"Workspace identifier."
    in
    Fields.both
      (Fields.both
         (Fields.required "workspace_id" workspace)
         (Fields.required "head" (nullable digest)))
      (Fields.both
         (Fields.required "sequence" Api_position.History_sequence.codec)
         (Fields.required "sessions" (list Session_bound.codec ~max_items:1_000_000)))
    |> Fields.map
         ~decode:(fun ((workspace, head), (sequence, sessions)) ->
           { workspace; head; sequence; sessions })
         ~encode:(fun { workspace; head; sequence; sessions } ->
           (workspace, head), (sequence, sessions))
    |> object_
    |> map
         ~decode:(fun t ->
           let empty = Api_position.History_sequence.to_int t.sequence = 0 in
           if not (Bool.equal empty (Option.is_none t.head))
           then invalid "history capture head and sequence disagree"
           else if empty && not (List.is_empty t.sessions)
           then invalid "empty history capture cannot contain sessions"
           else if
             List.contains_dup
               (List.map t.sessions ~f:(fun session -> session.Session_bound.session))
               ~compare:Session_id.compare
           then invalid "history capture contains duplicate sessions"
           else Ok t)
         ~encode:Fn.id
         ~description:
           "Immutable history journal capture. Zero sequence iff head is null; an empty \
            capture has no sessions. Session IDs are unique; through counts session \
            events, not journal commits."
  ;;
end

type t =
  { workspace_revision : Api_position.Workspace_revision.t option
  ; query_revision : Api_position.Query_revision.t option
  ; query_scope : Query_scope.t option
  ; history_sequence : Api_position.History_sequence.t option
  ; durable : bool option
  ; budget : Budget.t option
  ; history_capture : History_capture.t option
  ; snapshot : string option
  }

let codec =
  let open Api_codec in
  let open Fields in
  both
    (both
       (both
          (optional "workspace_revision" Api_position.Workspace_revision.codec)
          (optional "query_revision" Api_position.Query_revision.codec))
       (both
          (optional "query_scope" Query_scope.codec)
          (optional "history_sequence" Api_position.History_sequence.codec)))
    (both
       (both (optional "durable" boolean) (optional "budget" Budget.codec))
       (both
          (optional "history_capture" History_capture.codec)
          (optional "snapshot" digest)))
  |> map
       ~decode:
         (fun
           ( ((workspace_revision, query_revision), (query_scope, history_sequence))
           , ((durable, budget), (history_capture, snapshot)) ) ->
         { workspace_revision
         ; query_revision
         ; query_scope
         ; history_sequence
         ; durable
         ; budget
         ; history_capture
         ; snapshot
         })
       ~encode:
         (fun
           { workspace_revision
           ; query_revision
           ; query_scope
           ; history_sequence
           ; durable
           ; budget
           ; history_capture
           ; snapshot
           } ->
         ( ((workspace_revision, query_revision), (query_scope, history_sequence))
         , ((durable, budget), (history_capture, snapshot)) ))
  |> object_
  |> Api_codec.map
       ~decode:(fun t ->
         if Option.is_some t.query_revision && Option.is_none t.query_scope
         then invalid "a query revision requires its scope"
         else if Option.is_some t.workspace_revision && Option.is_some t.history_sequence
         then invalid "a feed position cannot be both planning and history"
         else Ok t)
       ~encode:Fn.id
       ~description:
         "Only applicable metadata is present; null does not mean absent. Query \
          revisions require query_scope. Planning and history feed positions are \
          distinct."
;;

let of_json = Api_codec.decode codec
let to_json t = Api_codec.encode codec t |> unwrap
