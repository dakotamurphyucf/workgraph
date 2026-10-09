open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

let jsonaf_of_int = Json.int
let int_of_jsonaf = Json.integer

module Pool = struct
  type t =
    { name : string
    ; limit : int
    ; active : int
    }
  [@@deriving sexp]
end

module Candidate = struct
  type t =
    { ticket : Id.Ticket.t
    ; priority : int
    ; creation_sequence : int
    ; ready : bool
    ; available : bool
    ; required_capabilities : string list
    ; pools : Pool.t list
    }
  [@@deriving sexp]
end

module Reason = struct
  type t =
    | Not_ready
    | Claimed
    | Missing_capability of string
    | Pool_full of string
  [@@deriving sexp, equal]
end

type t =
  | Selected of Candidate.t
  | Empty
[@@deriving sexp]

let eligibility c ~capabilities =
  (if c.Candidate.ready then [] else [ Reason.Not_ready ])
  @ (if c.available then [] else [ Reason.Claimed ])
  @ List.filter_map c.required_capabilities ~f:(fun required ->
    if List.mem capabilities required ~equal:String.equal
    then None
    else Some (Reason.Missing_capability required))
  @ List.filter_map c.pools ~f:(fun p ->
    if p.Pool.active >= p.limit then Some (Reason.Pool_full p.name) else None)
;;

let validate_candidates_exn candidates =
  if
    List.contains_dup
      (List.map candidates ~f:(fun c -> c.Candidate.ticket))
      ~compare:Id.Ticket.compare
  then Json.fail Invalid_argument "Duplicate allocation candidate";
  List.iter candidates ~f:(fun c ->
    if c.Candidate.priority < 0 || c.priority > 4 || c.creation_sequence < 0
    then Json.fail Invalid_argument "Invalid allocation ordering";
    List.iter c.pools ~f:(fun p ->
      if p.Pool.limit < 1 || p.active < 0 || String.is_empty p.name
      then Json.fail Invalid_argument "Invalid concurrency pool"))
;;

let choose candidates ~capabilities =
  Json.decode (fun () ->
    validate_candidates_exn candidates;
    let rank p = if p = 0 then 5 else p in
    let compare a b =
      let first = Int.compare (rank a.Candidate.priority) (rank b.Candidate.priority) in
      if first <> 0
      then first
      else (
        let second = Int.compare a.creation_sequence b.creation_sequence in
        if second <> 0 then second else Id.Ticket.compare a.ticket b.ticket)
    in
    match
      List.find (List.sort candidates ~compare) ~f:(fun c ->
        List.is_empty (eligibility c ~capabilities))
    with
    | None -> Empty
    | Some c -> Selected c)
;;

module Budget_limit = struct
  type kind =
    | Attempts
    | Active_attempts
  [@@deriving sexp, equal]

  type t =
    { kind : kind
    ; used : int
    ; limit : int
    }
  [@@deriving sexp]

  let codec =
    let module F = Api_codec.Fields in
    let counter = Api_codec.decimal ~max:Int.max_value in
    Api_codec.map
      (Api_codec.object_
         (F.both
            (F.required
               "kind"
               (Api_codec.enum
                  [ "attempts", Attempts; "active_attempts", Active_attempts ]
                  ~equal:equal_kind))
            (F.both (F.required "used" counter) (F.required "limit" counter))))
      ~decode:(fun (kind, (used, limit)) ->
        if limit < 1 || used < limit
        then Error (Problem.create Invalid_argument "allocation limit is not exhausted")
        else Ok { kind; used; limit })
      ~encode:(fun t -> t.kind, (t.used, t.limit))
      ~description:
        "Exhausted run attempt or concurrency limit; reported spending is advisory."
  ;;
end

module Explanation = struct
  module Kind = struct
    type t =
      | Not_ready
      | Claimed
      | Missing_capability
      | Pool_full
      | Parent_filtered
    [@@deriving equal]

    let all = [ Not_ready; Claimed; Missing_capability; Pool_full; Parent_filtered ]

    let codec =
      Api_codec.enum
        [ "not_ready", Not_ready
        ; "claimed", Claimed
        ; "missing_capability", Missing_capability
        ; "pool_full", Pool_full
        ; "parent_filtered", Parent_filtered
        ]
        ~equal
    ;;
  end

  module Reason_count = struct
    type t =
      { kind : Kind.t
      ; count : int
      ; example_ticket_ids : Id.Ticket.t list
      ; omitted_examples : int
      }

    let codec =
      let module F = Api_codec.Fields in
      let ( ++ ) = F.both in
      let counter = Api_codec.decimal ~max:Int.max_value in
      let id =
        Api_codec.map
          (Api_codec.text ~max_bytes:96)
          ~decode:Id.Ticket.of_string
          ~encode:Id.Ticket.to_string
          ~description:"Ticket identity."
      in
      Api_codec.map
        (Api_codec.object_
           (F.required "kind" Kind.codec
            ++ F.required "count" counter
            ++ F.required "example_ticket_ids" (Api_codec.list id ~max_items:5)
            ++ F.required "omitted_examples" counter))
        ~decode:(fun (((kind, count), example_ticket_ids), omitted_examples) ->
          if
            count < 1
            || List.length example_ticket_ids > count
            || omitted_examples <> count - List.length example_ticket_ids
            || List.contains_dup example_ticket_ids ~compare:Id.Ticket.compare
          then
            Error
              (Problem.create Invalid_argument "inconsistent allocation reason counts")
          else Ok { kind; count; example_ticket_ids; omitted_examples })
        ~encode:(fun t -> ((t.kind, t.count), t.example_ticket_ids), t.omitted_examples)
        ~description:"Overlapping candidate count and at most five exact example IDs."
    ;;
  end

  type t =
    { captured_workspace_revision : int
    ; candidate_count : int
    ; reasons : Reason_count.t list
    ; run_limits : Budget_limit.t list
    }

  let codec =
    let module F = Api_codec.Fields in
    let ( ++ ) = F.both in
    let counter = Api_codec.decimal ~max:Int.max_value in
    Api_codec.map
      (Api_codec.object_
         (F.required "captured_workspace_revision" counter
          ++ F.required "candidate_count" counter
          ++ F.required "reasons" (Api_codec.list Reason_count.codec ~max_items:5)
          ++ F.required "run_limits" (Api_codec.list Budget_limit.codec ~max_items:2)))
      ~decode:
        (fun
          (((captured_workspace_revision, candidate_count), reasons), run_limits) ->
        if
          List.exists reasons ~f:(fun r -> r.Reason_count.count > candidate_count)
          || (candidate_count > 0 && List.is_empty reasons && List.is_empty run_limits)
          || List.exists Kind.all ~f:(fun k ->
            List.count reasons ~f:(fun r -> Kind.equal k r.Reason_count.kind) > 1)
          || List.exists [ Budget_limit.Attempts; Active_attempts ] ~f:(fun k ->
            List.count run_limits ~f:(fun r ->
              Budget_limit.equal_kind k r.Budget_limit.kind)
            > 1)
        then Error (Problem.create Invalid_argument "inconsistent allocation explanation")
        else Ok { captured_workspace_revision; candidate_count; reasons; run_limits })
      ~encode:(fun t ->
        ((t.captured_workspace_revision, t.candidate_count), t.reasons), t.run_limits)
      ~description:
        "Captured empty-allocation diagnosis; counts can overlap and scope is the \
         requested project."
  ;;

  let create
        ~captured_workspace_revision
        ~candidates
        ~capabilities
        ~parent_filtered
        ~limits
    =
    Result.bind
      (Json.decode (fun () -> validate_candidates_exn candidates))
      ~f:(fun () ->
        let assessed =
          List.map candidates ~f:(fun candidate ->
            let reasons =
              List.map (eligibility candidate ~capabilities) ~f:(function
                | Reason.Not_ready -> Kind.Not_ready
                | Claimed -> Claimed
                | Missing_capability _ -> Missing_capability
                | Pool_full _ -> Pool_full)
            in
            ( candidate.Candidate.ticket
            , if parent_filtered candidate.ticket
              then Kind.Parent_filtered :: reasons
              else reasons ))
        in
        if
          List.is_empty limits
          && List.exists assessed ~f:(fun (_, reasons) -> List.is_empty reasons)
        then
          Error
            (Problem.create
               Invalid_argument
               "allocation explanation contains eligible work")
        else (
          let reasons =
            List.filter_map Kind.all ~f:(fun kind ->
              let ids =
                List.filter_map assessed ~f:(fun (id, kinds) ->
                  if List.mem kinds kind ~equal:Kind.equal then Some id else None)
                |> List.sort ~compare:Id.Ticket.compare
              in
              match ids with
              | [] -> None
              | _ ->
                Some
                  { Reason_count.kind
                  ; count = List.length ids
                  ; example_ticket_ids = List.take ids 5
                  ; omitted_examples = Int.max 0 (List.length ids - 5)
                  })
          in
          let t =
            { captured_workspace_revision
            ; candidate_count = List.length candidates
            ; reasons
            ; run_limits = limits
            }
          in
          Result.map (Api_codec.encode codec t) ~f:(fun _ -> t)))
  ;;

  let to_json t =
    match Api_codec.encode codec t with
    | Ok json -> json
    | Error problem -> raise (Json.Decode_error problem)
  ;;
end

module Definition = struct
  type t =
    { name : string
    ; revision : int
    ; limit : int
    }
  [@@deriving sexp, equal, jsonaf]
end

module Ticket_policy = struct
  type t =
    { ticket : Id.Ticket.t
    ; revision : int
    ; required_capabilities : string list
    ; pools : string list
    }
  [@@deriving sexp, equal, jsonaf]
end
