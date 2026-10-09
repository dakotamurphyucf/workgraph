open Core

let require condition message = if not condition then Json.fail Invalid_argument message

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let encode codec value = unwrap (Api_codec.encode codec value)
let decode codec json = unwrap (Api_codec.decode codec json)

let validated_sexp codec parse sexp =
  let value = parse sexp in
  let validated =
    let open Result.Let_syntax in
    let%bind json = Api_codec.encode codec value in
    Api_codec.decode codec json
  in
  match validated with
  | Ok value -> value
  | Error problem -> Sexplib.Conv.of_sexp_error problem.message sexp
;;

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required
let opt = Api_codec.Fields.optional

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let decimal = Api_codec.decimal ~max:Int.max_value

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated ASCII identifier."
;;

let actor_codec = id Id.Actor.of_string Id.Actor.to_string
let project_codec = id Id.Project.of_string Id.Project.to_string
let ticket_codec = id Id.Ticket.of_string Id.Ticket.to_string

let nonblank text maximum =
  ignore (decode (Api_codec.text ~max_bytes:maximum) (Json.string text) : string);
  require (not (String.is_empty (String.strip text))) "text must be nonblank"
;;

let names values =
  require (List.length values <= 100) "too many requirement names";
  List.iter values ~f:(fun name ->
    ignore (unwrap (Id.Resource.of_string name) : Id.Resource.t));
  require
    (List.length (List.dedup_and_sort values ~compare:String.compare) = List.length values)
    "duplicate requirement name"
;;

let canonical values compare = List.dedup_and_sort values ~compare

module Scope = struct
  module T = struct
    type t =
      | Project of Id.Project.t
      | Ticket of Id.Ticket.t
    [@@deriving sexp, compare, equal]
  end

  include T
  include Comparable.Make (T)

  let codec =
    let project =
      obj
        (req "kind" (Api_codec.literal "project") <*> req "project_id" project_codec)
        ~decode:(fun ((), id) -> Project id)
        ~encode:(function
          | Project id -> (), id
          | Ticket _ -> Json.fail Invalid_argument "project scope expected")
    in
    let ticket =
      obj
        (req "kind" (Api_codec.literal "ticket") <*> req "ticket_id" ticket_codec)
        ~decode:(fun ((), id) -> Ticket id)
        ~encode:(function
          | Ticket id -> (), id
          | Project _ -> Json.fail Invalid_argument "ticket scope expected")
    in
    Api_codec.tagged
      ~discriminator:"kind"
      ~cases:[ "project", project; "ticket", ticket ]
      ~select:(function
        | Project _ -> "project"
        | Ticket _ -> "ticket")
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp
end

module Requirement = struct
  type t =
    | Named_actor of Id.Actor.t
    | Role of
        { name : string
        ; members : Id.Actor.t list
        }
  [@@deriving sexp, compare, equal]

  let validate = function
    | Named_actor _ -> ()
    | Role { name; members } ->
      ignore (unwrap (Id.Resource.of_string name) : Id.Resource.t);
      require
        ((not (List.is_empty members)) && List.length members <= 100)
        "reviewer role requires 1..100 members";
      require
        (List.length (canonical members Id.Actor.compare) = List.length members)
        "duplicate reviewer role member"
  ;;

  let normalize = function
    | Named_actor actor -> Named_actor actor
    | Role { name; members } ->
      Role { name; members = canonical members Id.Actor.compare }
  ;;

  let codec =
    let named =
      obj
        (req "kind" (Api_codec.literal "actor") <*> req "actor_id" actor_codec)
        ~decode:(fun ((), actor) -> Named_actor actor)
        ~encode:(function
          | Named_actor actor -> (), actor
          | Role _ -> Json.fail Invalid_argument "named actor expected")
    in
    let role =
      obj
        (req "kind" (Api_codec.literal "role")
         <*> req "name" (Api_codec.text ~max_bytes:96)
         <*> req "member_ids" (Api_codec.list actor_codec ~max_items:100))
        ~decode:(fun (((), name), members) -> Role { name; members })
        ~encode:(function
          | Role { name; members } -> ((), name), members
          | Named_actor _ -> Json.fail Invalid_argument "role expected")
    in
    Api_codec.map
      (Api_codec.tagged
         ~discriminator:"kind"
         ~cases:[ "actor", named; "role", role ]
         ~select:(function
           | Named_actor _ -> "actor"
           | Role _ -> "role"))
      ~decode:(fun t ->
        Json.decode (fun () ->
          validate t;
          normalize t))
      ~encode:Fn.id
      ~description:"Named reviewer or nonempty explicit reviewer role."
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp
end

let reviewers_valid reviewers =
  require (List.length reviewers <= 100) "too many reviewer requirements";
  List.iter reviewers ~f:Requirement.validate;
  let roles =
    List.filter_map reviewers ~f:(function
      | Requirement.Named_actor _ -> None
      | Role { name; _ } -> Some name)
  in
  require
    (List.length (canonical roles String.compare) = List.length roles)
    "duplicate reviewer role name";
  require
    (List.length
       (canonical (List.map reviewers ~f:Requirement.normalize) Requirement.compare)
     = List.length reviewers)
    "duplicate reviewer requirement"
;;

module Criterion = struct
  module Key : Id.S = struct
    let of_string value =
      Result.map (Id.Resource.of_string value) ~f:Id.Resource.to_string
    ;;

    module T = struct
      type t = string [@@deriving sexp_of, compare, equal]

      let t_of_sexp sexp =
        match of_string (String.t_of_sexp sexp) with
        | Ok value -> value
        | Error problem -> Sexplib.Conv.of_sexp_error problem.message sexp
      ;;
    end

    include T
    include Comparable.Make (T)

    let to_string t = t
    let jsonaf_of_t t = Json.string t
    let t_of_jsonaf json = unwrap (of_string (Json.text json))
  end

  type t =
    { key : Key.t
    ; description : string
    ; required : bool
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.map
      (obj
         (req "key" (id Key.of_string Key.to_string)
          <*> req "description" (Api_codec.text ~max_bytes:4096)
          <*> req "required" Api_codec.boolean)
         ~decode:(fun ((key, description), required) -> { key; description; required })
         ~encode:(fun { key; description; required } -> (key, description), required))
      ~decode:(fun t ->
        Json.decode (fun () ->
          nonblank t.description 4096;
          t))
      ~encode:Fn.id
      ~description:"Identified nonblank criterion statement."
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp

  module Ref = struct
    type t =
      { scope : Scope.t
      ; policy_revision : int
      ; key : Key.t
      }
    [@@deriving sexp, compare, equal]

    let codec =
      Api_codec.map
        (obj
           (req "scope" Scope.codec
            <*> req "policy_revision" decimal
            <*> req "key" (id Key.of_string Key.to_string))
           ~decode:(fun ((scope, policy_revision), key) ->
             { scope; policy_revision; key })
           ~encode:(fun { scope; policy_revision; key } -> (scope, policy_revision), key))
        ~decode:(fun t ->
          Json.decode (fun () ->
            require (t.policy_revision > 0) "criterion revision must be positive";
            t))
        ~encode:Fn.id
        ~description:"Criterion identity includes the scope and exact policy version."
    ;;

    let jsonaf_of_t = encode codec
    let t_of_jsonaf = decode codec
    let t_of_sexp = validated_sexp codec t_of_sexp
  end
end

module Source = struct
  type t =
    { scope : Scope.t
    ; revision : int
    }
  [@@deriving sexp, compare, equal]

  let codec =
    Api_codec.map
      (obj
         (req "scope" Scope.codec <*> req "revision" decimal)
         ~decode:(fun (scope, revision) -> { scope; revision })
         ~encode:(fun { scope; revision } -> scope, revision))
      ~decode:(fun t ->
        Json.decode (fun () ->
          require (t.revision > 0) "policy revision must be positive";
          t))
      ~encode:Fn.id
      ~description:"Exact positive policy source version."
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp
end

module Inherited_override = struct
  type t =
    { against : Source.t
    ; membership_revision : int
    ; reviewers : Requirement.t list
    ; validators : string list
    ; criteria : Criterion.Key.t list
    ; waive_separate_actor : bool
    ; reason : string
    }
  [@@deriving sexp, equal]

  let create
        ~against
        ~membership_revision
        ~reviewers
        ~validators
        ~criteria
        ~waive_separate_actor
        ~reason
    =
    Json.decode (fun () ->
      (match against.Source.scope with
       | Scope.Project _ -> ()
       | Ticket _ -> Json.fail Invalid_argument "override must identify project policy");
      require (against.revision > 0) "override source revision must be positive";
      require (membership_revision > 0) "override membership revision must be positive";
      reviewers_valid reviewers;
      names validators;
      require
        (List.length criteria <= 100
         && List.length (canonical criteria Criterion.Key.compare) = List.length criteria
        )
        "duplicate or excessive waived criteria";
      nonblank reason 4096;
      require
        (waive_separate_actor
         || not
              (List.is_empty reviewers
               && List.is_empty validators
               && List.is_empty criteria))
        "override waives no requirements";
      { against
      ; membership_revision
      ; reviewers =
          canonical (List.map reviewers ~f:Requirement.normalize) Requirement.compare
      ; validators = canonical validators String.compare
      ; criteria = canonical criteria Criterion.Key.compare
      ; waive_separate_actor
      ; reason
      })
  ;;

  let against t = t.against
  let membership_revision t = t.membership_revision
  let reason t = t.reason

  let codec =
    Api_codec.map
      (obj
         (req "against" Source.codec
          <*> req "membership_revision" decimal
          <*> req "reviewers" (Api_codec.list Requirement.codec ~max_items:100)
          <*> req
                "validators"
                (Api_codec.list (Api_codec.text ~max_bytes:96) ~max_items:100)
          <*> req
                "criteria"
                (Api_codec.list
                   (id Criterion.Key.of_string Criterion.Key.to_string)
                   ~max_items:100)
          <*> req "waive_separate_actor" Api_codec.boolean
          <*> req "reason" (Api_codec.text ~max_bytes:4096))
         ~decode:
           (fun
             ( ( ((((against, membership_revision), reviewers), validators), criteria)
               , waive_separate_actor )
             , reason ) ->
           ( against
           , membership_revision
           , reviewers
           , validators
           , criteria
           , waive_separate_actor
           , reason ))
         ~encode:
           (fun
             ( against
             , membership_revision
             , reviewers
             , validators
             , criteria
             , waive_separate_actor
             , reason ) ->
           ( ( ((((against, membership_revision), reviewers), validators), criteria)
             , waive_separate_actor )
           , reason )))
      ~decode:
        (fun
          ( against
          , membership_revision
          , reviewers
          , validators
          , criteria
          , waive_separate_actor
          , reason ) ->
        create
          ~against
          ~membership_revision
          ~reviewers
          ~validators
          ~criteria
          ~waive_separate_actor
          ~reason)
      ~encode:(fun t ->
        ( t.against
        , t.membership_revision
        , t.reviewers
        , t.validators
        , t.criteria
        , t.waive_separate_actor
        , t.reason ))
      ~description:
        "Explicit project waivers bind an exact source and ticket membership revision."
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp
end

module Definition = struct
  type t =
    { scope : Scope.t
    ; revision : int
    ; enabled : bool
    ; reviewers : Requirement.t list
    ; separate_actor : bool
    ; validators : string list
    ; criteria : Criterion.t list
    ; inherited_override : Inherited_override.t option
    }
  [@@deriving sexp, equal]

  let create
        ~scope
        ~revision
        ~enabled
        ~reviewers
        ~separate_actor
        ~validators
        ~criteria
        ~inherited_override
    =
    Json.decode (fun () ->
      require (revision > 0) "policy revision must be positive";
      reviewers_valid reviewers;
      names validators;
      require (List.length criteria <= 100) "too many acceptance criteria";
      List.iter criteria ~f:(fun c -> ignore (encode Criterion.codec c : Jsonaf.t));
      require
        (List.length
           (canonical
              (List.map criteria ~f:(fun c -> c.Criterion.key))
              Criterion.Key.compare)
         = List.length criteria)
        "duplicate criterion key";
      (match scope, inherited_override with
       | Scope.Project _, Some _ ->
         Json.fail Invalid_argument "project policy cannot override inheritance"
       | Project _, None | Ticket _, _ -> ());
      Option.iter inherited_override ~f:(fun override ->
        ignore (encode Inherited_override.codec override : Jsonaf.t));
      { scope
      ; revision
      ; enabled
      ; reviewers =
          canonical (List.map reviewers ~f:Requirement.normalize) Requirement.compare
      ; separate_actor
      ; validators = canonical validators String.compare
      ; criteria =
          List.sort criteria ~compare:(fun a b -> Criterion.Key.compare a.key b.key)
      ; inherited_override
      })
  ;;

  let scope t = t.scope
  let revision t = t.revision
  let enabled t = t.enabled
  let reviewers t = t.reviewers
  let separate_actor t = t.separate_actor
  let validators t = t.validators
  let criteria t = t.criteria
  let inherited_override t = t.inherited_override

  let codec =
    Api_codec.map
      (obj
         (req "scope" Scope.codec
          <*> req "revision" decimal
          <*> req "enabled" Api_codec.boolean
          <*> req "reviewers" (Api_codec.list Requirement.codec ~max_items:100)
          <*> req "separate_actor" Api_codec.boolean
          <*> req
                "validators"
                (Api_codec.list (Api_codec.text ~max_bytes:96) ~max_items:100)
          <*> req "criteria" (Api_codec.list Criterion.codec ~max_items:100)
          <*> req "inherited_override" (Api_codec.nullable Inherited_override.codec))
         ~decode:
           (fun
             ( ( (((((scope, revision), enabled), reviewers), separate_actor), validators)
               , criteria )
             , inherited_override ) ->
           ( scope
           , revision
           , enabled
           , reviewers
           , separate_actor
           , validators
           , criteria
           , inherited_override ))
         ~encode:
           (fun
             ( scope
             , revision
             , enabled
             , reviewers
             , separate_actor
             , validators
             , criteria
             , inherited_override ) ->
           ( ( (((((scope, revision), enabled), reviewers), separate_actor), validators)
             , criteria )
           , inherited_override )))
      ~decode:
        (fun
          ( scope
          , revision
          , enabled
          , reviewers
          , separate_actor
          , validators
          , criteria
          , inherited_override ) ->
        create
          ~scope
          ~revision
          ~enabled
          ~reviewers
          ~separate_actor
          ~validators
          ~criteria
          ~inherited_override)
      ~encode:(fun t ->
        ( t.scope
        , t.revision
        , t.enabled
        , t.reviewers
        , t.separate_actor
        , t.validators
        , t.criteria
        , t.inherited_override ))
      ~description:"One canonical scoped acceptance policy definition."
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp

  let members = function
    | Requirement.Named_actor actor -> [ actor ]
    | Role { members; _ } -> members
  ;;

  let requirement_implies newer older =
    List.for_all (members newer) ~f:(fun actor ->
      List.mem (members older) actor ~equal:Id.Actor.equal)
  ;;

  let check_update previous ~next ~weakening_reason =
    Json.decode (fun () ->
      Option.iter weakening_reason ~f:(fun reason -> nonblank reason 4096);
      let weakened =
        match previous with
        | None -> Option.is_some next.inherited_override
        | Some old ->
          require
            (Scope.equal old.scope next.scope && next.revision = old.revision + 1)
            "policy update scope or revision differs";
          let removes_required =
            old.enabled
            && ((not next.enabled)
                || (old.separate_actor && not next.separate_actor)
                || List.exists old.validators ~f:(fun name ->
                  not (List.mem next.validators name ~equal:String.equal))
                || List.exists old.reviewers ~f:(fun requirement ->
                  not
                    (List.exists next.reviewers ~f:(fun newer ->
                       requirement_implies newer requirement)))
                || List.exists old.criteria ~f:(fun criterion ->
                  criterion.required
                  && not
                       (List.exists next.criteria ~f:(fun newer ->
                          Criterion.Key.equal criterion.key newer.key
                          && newer.required
                          && String.equal criterion.description newer.description))))
          in
          removes_required
          || (Option.is_some next.inherited_override
              && not
                   (Option.equal
                      Inherited_override.equal
                      old.inherited_override
                      next.inherited_override))
      in
      require
        ((not weakened) || Option.is_some weakening_reason)
        "weakening acceptance requirements requires an attributed reason")
  ;;
end

module Effective = struct
  type t =
    { ticket_id : Id.Ticket.t
    ; project_id : Id.Project.t option
    ; membership_revision : int
    ; sources : Source.t list
    ; minimum_reopening_token : int option
    ; ownership_token : int option
    ; reviewers : Requirement.t list
    ; validators : string list
    ; criteria : (Criterion.Ref.t * Criterion.t) list
    ; separate_actor : bool
    ; applied_override : Inherited_override.t option
    ; stale_override : Inherited_override.t option
    ; digest : string
    }
  [@@deriving sexp, equal]

  let criteria_codec =
    obj
      (req "reference" Criterion.Ref.codec <*> req "criterion" Criterion.codec)
      ~decode:Fn.id
      ~encode:Fn.id
  ;;

  let payload_codec =
    obj
      (req "ticket_id" ticket_codec
       <*> req "project_id" (Api_codec.nullable project_codec)
       <*> req "membership_revision" decimal
       <*> req "sources" (Api_codec.list Source.codec ~max_items:2)
       <*> req "minimum_reopening_token" (Api_codec.nullable decimal)
       <*> req "ownership_token" (Api_codec.nullable decimal)
       <*> req "reviewers" (Api_codec.list Requirement.codec ~max_items:200)
       <*> req "validators" (Api_codec.list (Api_codec.text ~max_bytes:96) ~max_items:200)
       <*> req "criteria" (Api_codec.list criteria_codec ~max_items:200)
       <*> req "separate_actor" Api_codec.boolean
       <*> req "applied_override" (Api_codec.nullable Inherited_override.codec)
       <*> req "stale_override" (Api_codec.nullable Inherited_override.codec))
      ~decode:
        (fun
          ( ( ( ( ( ( ( ( (((ticket_id, project_id), membership_revision), sources)
                        , minimum_reopening_token )
                      , ownership_token )
                    , reviewers )
                  , validators )
                , criteria )
              , separate_actor )
            , applied_override )
          , stale_override ) ->
        { ticket_id
        ; project_id
        ; membership_revision
        ; sources
        ; minimum_reopening_token
        ; ownership_token
        ; reviewers
        ; validators
        ; criteria
        ; separate_actor
        ; applied_override
        ; stale_override
        ; digest = ""
        })
      ~encode:(fun t ->
        ( ( ( ( ( ( ( ( (((t.ticket_id, t.project_id), t.membership_revision), t.sources)
                      , t.minimum_reopening_token )
                    , t.ownership_token )
                  , t.reviewers )
                , t.validators )
              , t.criteria )
            , t.separate_actor )
          , t.applied_override )
        , t.stale_override ))
  ;;

  let recompute t = Json.hash (Json.canonical (encode payload_codec t))

  let validate t =
    let canonical_check values compare equal =
      require
        (List.equal equal values (canonical values compare))
        "effective requirements must be canonical"
    in
    require (t.membership_revision > 0) "membership revision must be positive";
    canonical_check t.sources Source.compare Source.equal;
    canonical_check t.reviewers Requirement.compare Requirement.equal;
    canonical_check t.validators String.compare String.equal;
    canonical_check (List.map t.criteria ~f:fst) Criterion.Ref.compare Criterion.Ref.equal;
    Option.iter t.ownership_token ~f:(fun token ->
      require (token > 0) "ownership token must be positive");
    Option.iter t.minimum_reopening_token ~f:(fun token ->
      require (token > 0) "reopening token must be positive");
    List.iter t.sources ~f:(fun source ->
      match source.Source.scope with
      | Scope.Ticket ticket ->
        require (Id.Ticket.equal ticket t.ticket_id) "binding ticket source differs"
      | Project project ->
        require
          (Option.value_map t.project_id ~default:false ~f:(Id.Project.equal project))
          "binding project source differs");
    require
      (List.length
         (canonical (List.map t.sources ~f:(fun s -> s.Source.scope)) Scope.compare)
       = List.length t.sources)
      "duplicate binding source scope";
    List.iter t.criteria ~f:(fun (reference, criterion) ->
      require
        (Criterion.Key.equal reference.Criterion.Ref.key criterion.Criterion.key)
        "criterion key and reference differ";
      require
        (List.exists t.sources ~f:(fun source ->
           Scope.equal source.Source.scope reference.scope
           && source.revision = reference.policy_revision))
        "criterion source missing from binding");
    require
      (not (Option.is_some t.applied_override && Option.is_some t.stale_override))
      "override cannot be applied and stale";
    Option.iter t.applied_override ~f:(fun override ->
      require
        (List.mem t.sources override.Inherited_override.against ~equal:Source.equal
         && override.membership_revision = t.membership_revision)
        "applied override source is stale");
    Option.iter t.stale_override ~f:(fun override ->
      require
        (not
           (List.mem t.sources override.Inherited_override.against ~equal:Source.equal
            && override.membership_revision = t.membership_revision))
        "stale override matches current source")
  ;;

  let codec =
    Api_codec.map
      (Api_codec.merge_objects
         payload_codec
         (obj (req "digest" (Api_codec.text ~max_bytes:64)) ~decode:Fn.id ~encode:Fn.id))
      ~decode:(fun (t, digest) ->
        Json.decode (fun () ->
          validate t;
          let t = { t with digest } in
          require (String.equal digest (recompute t)) "effective policy digest mismatch";
          t))
      ~encode:(fun t -> t, t.digest)
      ~description:"Full policy binding; digest is recomputed from canonical fields."
  ;;

  let jsonaf_of_t = encode codec
  let t_of_jsonaf = decode codec
  let t_of_sexp = validated_sexp codec t_of_sexp

  let resolve
        ~ticket_id
        ~project_id
        ~membership_revision
        ~project
        ~ticket
        ~minimum_reopening_token
        ~ownership_token
    =
    Json.decode (fun () ->
      Option.iter project ~f:(fun definition ->
        require
          (Option.value_map project_id ~default:false ~f:(fun id ->
             Scope.equal definition.Definition.scope (Scope.Project id)))
          "project policy scope differs from membership");
      Option.iter ticket ~f:(fun definition ->
        require
          (Scope.equal definition.Definition.scope (Scope.Ticket ticket_id))
          "ticket policy scope differs");
      let sources =
        canonical
          (List.filter_map
             [ project; ticket ]
             ~f:
               (Option.map ~f:(fun d ->
                  { Source.scope = d.Definition.scope; revision = d.revision })))
          Source.compare
      in
      let override = Option.bind ticket ~f:Definition.inherited_override in
      let applied_override, stale_override =
        match override with
        | None -> None, None
        | Some override ->
          if
            List.mem sources override.Inherited_override.against ~equal:Source.equal
            && override.membership_revision = membership_revision
          then Some override, None
          else None, Some override
      in
      Option.iter applied_override ~f:(fun override ->
        let inherited = Option.value_exn project in
        require inherited.Definition.enabled "cannot waive disabled inherited policy";
        List.iter override.reviewers ~f:(fun reviewer ->
          require
            (List.mem inherited.reviewers reviewer ~equal:Requirement.equal)
            "waived reviewer missing from inherited policy");
        List.iter override.validators ~f:(fun name ->
          require
            (List.mem inherited.validators name ~equal:String.equal)
            "waived validator missing from inherited policy");
        List.iter override.criteria ~f:(fun key ->
          require
            (List.exists inherited.criteria ~f:(fun c ->
               Criterion.Key.equal c.Criterion.key key && c.required))
            "waived required criterion missing from inherited policy");
        require
          ((not override.waive_separate_actor) || inherited.separate_actor)
          "waived actor separation is absent");
      let collect definition =
        match definition with
        | None -> [], [], [], false
        | Some d when not d.Definition.enabled -> [], [], [], false
        | Some d ->
          let override =
            match d.scope with
            | Scope.Project _ -> applied_override
            | Ticket _ -> None
          in
          let reviewers =
            List.filter d.reviewers ~f:(fun r ->
              not
                (Option.value_map override ~default:false ~f:(fun o ->
                   List.mem o.Inherited_override.reviewers r ~equal:Requirement.equal)))
          in
          let validators =
            List.filter d.validators ~f:(fun v ->
              not
                (Option.value_map override ~default:false ~f:(fun o ->
                   List.mem o.Inherited_override.validators v ~equal:String.equal)))
          in
          let criteria =
            List.map d.criteria ~f:(fun c ->
              let waived =
                Option.value_map override ~default:false ~f:(fun o ->
                  List.mem
                    o.Inherited_override.criteria
                    c.Criterion.key
                    ~equal:Criterion.Key.equal)
              in
              ( { Criterion.Ref.scope = d.scope
                ; policy_revision = d.revision
                ; key = c.key
                }
              , { c with required = c.required && not waived } ))
          in
          let separate_actor =
            d.separate_actor
            && not
                 (Option.value_map override ~default:false ~f:(fun o ->
                    o.Inherited_override.waive_separate_actor))
          in
          reviewers, validators, criteria, separate_actor
      in
      let pr, pv, pc, ps = collect project in
      let tr, tv, tc, ts = collect ticket in
      let t =
        { ticket_id
        ; project_id
        ; membership_revision
        ; sources
        ; minimum_reopening_token
        ; ownership_token
        ; reviewers = canonical (pr @ tr) Requirement.compare
        ; validators = canonical (pv @ tv) String.compare
        ; criteria =
            List.sort (pc @ tc) ~compare:(fun (a, _) (b, _) -> Criterion.Ref.compare a b)
        ; separate_actor = ps || ts
        ; applied_override
        ; stale_override
        ; digest = ""
        }
      in
      validate t;
      { t with digest = recompute t })
  ;;

  let is_configured t =
    t.separate_actor
    || (not (List.is_empty t.reviewers && List.is_empty t.validators))
    || List.exists t.criteria ~f:(fun (_, c) -> c.Criterion.required)
  ;;

  let sources t = t.sources
  let digest t = t.digest
  let reviewers t = t.reviewers
  let validators t = t.validators
  let criteria t = t.criteria
  let separate_actor t = t.separate_actor
  let stale_override t = t.stale_override

  module Binding = struct
    type nonrec t = t [@@deriving sexp, equal]

    let digest = digest
    let ticket_id t = t.ticket_id
    let ownership_token t = t.ownership_token
    let codec = codec
    let jsonaf_of_t = jsonaf_of_t
    let t_of_jsonaf = t_of_jsonaf
  end

  let binding t = t
end
