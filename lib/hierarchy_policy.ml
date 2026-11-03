open Core

module Descendant_prerequisites = struct
  type t =
    | Independent
    | Inherit
  [@@deriving sexp, equal]

  let codec = Api_codec.enum [ "independent", Independent; "inherit", Inherit ] ~equal
end

module Child_completion = struct
  type t =
    | All_done
    | Done_or_canceled
  [@@deriving sexp, equal]

  let codec =
    Api_codec.enum [ "all_done", All_done; "done_or_canceled", Done_or_canceled ] ~equal
  ;;

  let satisfied t ~status =
    match status with
    | Workflow.Category.Done -> true
    | Canceled -> equal t Done_or_canceled
    | Backlog | Todo | In_progress -> false
  ;;
end

type t =
  { descendant_prerequisites : Descendant_prerequisites.t
  ; child_completion : Child_completion.t
  }
[@@deriving sexp, equal]

let default = { descendant_prerequisites = Independent; child_completion = All_done }
let ( ++ ) = Api_codec.Fields.both

let policy_fields =
  Api_codec.Fields.(
    map
      (required "descendant_prerequisites" Descendant_prerequisites.codec
       ++ required "child_completion" Child_completion.codec)
      ~decode:(fun (descendant_prerequisites, child_completion) ->
        { descendant_prerequisites; child_completion })
      ~encode:(fun t -> t.descendant_prerequisites, t.child_completion))
;;

let codec = Api_codec.object_ policy_fields

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

module Definition = struct
  type policy = t [@@deriving sexp, equal]

  type t =
    { ticket : Id.Ticket.t
    ; revision : int
    ; policy : policy
    ; reason : string
    }
  [@@deriving sexp, equal]

  let create ~ticket ~revision ~policy ~reason =
    if revision <= 0
    then
      Error (Problem.create Invalid_argument "Hierarchy policy revision must be positive")
    else
      Result.map
        (Api_codec.decode (Coordination_wire.nonblank ~max_bytes:65_536) (`String reason))
        ~f:(fun reason -> { ticket; revision; policy; reason })
  ;;

  let ticket t = t.ticket
  let revision t = t.revision
  let policy t = t.policy
  let reason t = t.reason

  let codec =
    Api_codec.map
      (Api_codec.object_
         Api_codec.Fields.(
           required "ticket_id" Coordination_wire.ticket
           ++ required "revision" Coordination_wire.positive
           ++ policy_fields
           ++ required "reason" (Coordination_wire.nonblank ~max_bytes:65_536)))
      ~decode:(fun (((ticket, revision), policy), reason) ->
        create ~ticket ~revision ~policy ~reason)
      ~encode:(fun t -> ((t.ticket, t.revision), t.policy), t.reason)
      ~description:"Explicit revisioned hierarchy policy with its exact audit reason."
  ;;

  let t_of_sexp_unchecked = t_of_sexp

  let t_of_sexp sexp =
    let t = t_of_sexp_unchecked sexp in
    match
      create ~ticket:t.ticket ~revision:t.revision ~policy:t.policy ~reason:t.reason
    with
    | Ok t -> t
    | Error problem -> Sexplib.Conv.of_sexp_error problem.message sexp
  ;;

  let jsonaf_of_t t =
    Json.obj
      [ "ticket", Id.Ticket.jsonaf_of_t t.ticket
      ; "revision", Json.int t.revision
      ; ( "descendant_prerequisites"
        , unwrap
            (Api_codec.encode
               Descendant_prerequisites.codec
               t.policy.descendant_prerequisites) )
      ; ( "child_completion"
        , unwrap (Api_codec.encode Child_completion.codec t.policy.child_completion) )
      ; "reason", `String t.reason
      ]
  ;;

  let t_of_jsonaf json =
    Json.fields
      json
      ~allowed:
        [ "ticket"; "revision"; "descendant_prerequisites"; "child_completion"; "reason" ];
    let get = Json.field json in
    let policy =
      { descendant_prerequisites =
          unwrap
            (Api_codec.decode
               Descendant_prerequisites.codec
               (get "descendant_prerequisites"))
      ; child_completion =
          unwrap (Api_codec.decode Child_completion.codec (get "child_completion"))
      }
    in
    unwrap
      (create
         ~ticket:(Id.Ticket.t_of_jsonaf (get "ticket"))
         ~revision:(Json.integer (get "revision"))
         ~policy
         ~reason:(Json.text (get "reason")))
  ;;
end
