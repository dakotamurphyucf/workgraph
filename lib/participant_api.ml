open Core
module F = Api_codec.Fields
module W = Coordination_wire

let ( ++ ) = F.both

module Source = struct
  type t =
    | Catalog
    | Activity
    | Fact
    | Comment
    | Request
    | Run
  [@@deriving compare, equal, sexp]

  let codec =
    Api_codec.enum
      [ "catalog", Catalog
      ; "activity", Activity
      ; "fact", Fact
      ; "comment", Comment
      ; "request", Request
      ; "run", Run
      ]
      ~equal
  ;;
end

module Observation = struct
  type t =
    { first_revision : int
    ; last_revision : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "first_revision" W.positive ++ F.required "last_revision" W.positive)
         ~decode:(fun (first_revision, last_revision) ->
           { first_revision; last_revision })
         ~encode:(fun t -> t.first_revision, t.last_revision))
    |> fun codec ->
    W.checked codec (fun t ->
      if t.first_revision > t.last_revision
      then Json.fail Invalid_argument "participant observation revisions are reversed")
  ;;
end

module Participant = struct
  type t =
    { actor_id : Id.Actor.t
    ; registration : Planning_wire.Actor.t option
    ; observed : Observation.t option
    ; sources : Source.t list
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "actor_id" W.actor
          ++ F.required "registration" (Api_codec.nullable Planning_wire.Actor.codec)
          ++ F.required "observed" (Api_codec.nullable Observation.codec)
          ++ F.required "sources" (Api_codec.list Source.codec ~max_items:6))
         ~decode:(fun (((actor_id, registration), observed), sources) ->
           { actor_id; registration; observed; sources })
         ~encode:(fun t -> ((t.actor_id, t.registration), t.observed), t.sources))
    |> fun codec ->
    W.checked codec (fun t ->
      if
        List.is_empty t.sources
        || not (List.is_sorted_strictly t.sources ~compare:Source.compare)
      then
        Json.fail
          Invalid_argument
          "participant sources must be nonempty, ordered and distinct";
      let has source = List.mem t.sources source ~equal:Source.equal in
      if
        Bool.(has Catalog <> Option.is_some t.registration)
        || Bool.(has Activity <> Option.is_some t.observed)
        || (List.exists t.sources ~f:(function
              | Source.Catalog | Activity -> false
              | Fact | Comment | Request | Run -> true)
            && not (has Activity))
      then
        Json.fail
          Invalid_argument
          "participant registration, observation and sources differ";
      Option.iter t.registration ~f:(fun registration ->
        if not (Id.Actor.equal t.actor_id registration.actor_id)
        then Json.fail Invalid_argument "participant catalog identity differs"))
  ;;
end

module Request = struct
  type t = Planning_query_options.t

  let codec = Api_codec.object_ Planning_query_options.page_fields
  let limit = Planning_query_options.limit
  let offset = Planning_query_options.offset
  let at_revision = Planning_query_options.at_revision
  let max_bytes = Planning_query_options.max_bytes
end

let response_codec =
  Planning_wire.Page.codec Participant.codec
  |> fun codec ->
  W.checked codec (fun page ->
    if
      not
        (List.is_sorted_strictly page.Planning_wire.Page.items ~compare:(fun a b ->
           Id.Actor.compare a.Participant.actor_id b.actor_id))
    then
      Json.fail
        Invalid_argument
        "participant page identities must be ordered and distinct")
;;

let descriptor =
  Api_method.Packed.Pack
    (Api_method.create
       ~name:"participant.list"
       ~summary:
         "Discover catalog actors and retained attributed participants without inferring \
          liveness."
       ~mode:Read
       ~request:Request.codec
       ~response:response_codec)
;;
