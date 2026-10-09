open Core

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let text n = Api_codec.text ~max_bytes:n

let id of_string to_string =
  Api_codec.map
    (text 96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated entity ID."
;;

let name =
  Api_codec.map
    (text 96)
    ~decode:(fun n -> Result.map (Id.Resource.of_string n) ~f:Id.Resource.to_string)
    ~encode:Fn.id
    ~description:"Literal ASCII graph or parameter name."
;;

let nonblank n =
  Api_codec.map
    (text n)
    ~decode:(fun s ->
      if String.is_empty (String.strip s)
      then Error (Problem.create Invalid_argument "text must be nonblank")
      else Ok s)
    ~encode:Fn.id
    ~description:"Nonblank bounded UTF-8 text."
;;

let positive =
  Api_codec.map
    (Api_codec.decimal ~max:Int.max_value)
    ~decode:(fun n ->
      if n > 0
      then Ok n
      else Error (Problem.create Invalid_argument "version must be positive"))
    ~encode:Fn.id
    ~description:"Positive version."
;;

let actor = id Id.Actor.of_string Id.Actor.to_string
let ticket = id Id.Ticket.of_string Id.Ticket.to_string
let resource = id Id.Resource.of_string Id.Resource.to_string

let instance_id =
  id Workflow_template.Instance_id.of_string Workflow_template.Instance_id.to_string
;;

let list codec n = Api_codec.list codec ~max_items:n
let nullable = Api_codec.nullable

let unwrap = function
  | Ok v -> v
  | Error p -> raise (Json.Decode_error p)
;;

let validate condition message = if not condition then Json.fail Invalid_argument message

let parameters =
  Api_codec.map
    (Api_codec.dictionary (text 16_384) ~max_items:32 ~max_key_bytes:96)
    ~decode:(fun values ->
      Json.decode (fun () ->
        List.iter values ~f:(fun (key, _) ->
          ignore (unwrap (Id.Resource.of_string key) : Id.Resource.t));
        List.sort values ~compare:(fun (a, _) (b, _) -> String.compare a b)))
    ~encode:Fn.id
    ~description:
      "At most 32 named literal substitutions; values never undergo alias interpretation."
;;

let node_fields reviewers =
  req "alias" name
  <*> req "title" (nonblank 512)
  <*> req "description" (text 65_536)
  <*> req "depends_on" (list name 31)
  <*> req "parent" (nullable name)
  <*> req "capabilities" (list (nonblank 96) 100)
  <*> req "reviewer_ids" (list reviewers 100)
  <*> req "separate_actor" Api_codec.boolean
;;

let node =
  obj
    (node_fields actor)
    ~decode:
      (fun
        ( ( (((((alias, title), description), depends_on), parent), capabilities)
          , reviewers )
        , separate_actor ) ->
      { Workflow_template.Node.alias
      ; title
      ; description
      ; depends_on
      ; parent
      ; capabilities
      ; reviewers
      ; separate_actor
      })
    ~encode:(fun n ->
      ( ( ( ( (((n.Workflow_template.Node.alias, n.title), n.description), n.depends_on)
            , n.parent )
          , n.capabilities )
        , n.reviewers )
      , n.separate_actor ))
;;

let spec_fields nodes = req "parameters" (list name 32) <*> req "nodes" (list nodes 31)

let spec =
  Api_codec.map
    (obj
       (spec_fields node)
       ~decode:(fun (parameters, nodes) -> { Workflow_template.Spec.parameters; nodes })
       ~encode:(fun s -> s.Workflow_template.Spec.parameters, s.nodes))
    ~decode:(fun s -> Result.map (Workflow_template.Spec.validate s) ~f:(fun () -> s))
    ~encode:Fn.id
    ~description:
      "Validated acyclic graph with 1..31 nodes and at most 32 atomic operations."
;;

let digest =
  Api_codec.map
    (text 64)
    ~decode:(fun s ->
      Json.decode (fun () ->
        validate
          (String.length s = 64
           && String.for_all s ~f:(fun c ->
             Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
          "invalid SHA256 digest";
        s))
    ~encode:Fn.id
    ~description:"Exact lowercase SHA256 canonical Spec asset digest."
;;

let template =
  Api_codec.map
    (obj
       (req "template_id" resource
        <*> req "template_revision" positive
        <*> req "digest" digest
        <*> req "spec" spec)
       ~decode:(fun (((resource, resource_revision), digest), spec) ->
         { Workflow_template.resource; resource_revision; digest; spec })
       ~encode:(fun t ->
         ((t.Workflow_template.resource, t.resource_revision), t.digest), t.spec))
    ~decode:(fun t ->
      Result.bind
        (Workflow_template.create
           ~resource:t.resource
           ~resource_revision:t.resource_revision
           ~spec:t.spec)
        ~f:(fun expected ->
          if Workflow_template.equal expected t
          then Ok t
          else
            Error
              (Problem.create
                 Invalid_argument
                 "template digest differs from canonical Spec asset")))
    ~encode:Fn.id
    ~description:"Exact canonical template asset binding."
;;

let planned_fields tickets actors =
  req "alias" name
  <*> req "ticket_id" tickets
  <*> req "title" (nonblank 512)
  <*> req "description" (text 65_536)
  <*> req "prerequisite_ticket_ids" (list tickets 31)
  <*> req "parent_ticket_id" (nullable tickets)
  <*> req "capabilities" (list (nonblank 96) 100)
  <*> req "reviewer_ids" (list actors 100)
  <*> req "separate_actor" Api_codec.boolean
;;

let planned_ticket =
  obj
    (planned_fields ticket actor)
    ~decode:
      (fun
        ( ( ( (((((alias, ticket), title), description), dependencies), parent)
            , capabilities )
          , reviewers )
        , separate_actor ) ->
      { Workflow_template.Planned_ticket.alias
      ; ticket
      ; title
      ; description
      ; dependencies
      ; parent
      ; capabilities
      ; reviewers
      ; separate_actor
      })
    ~encode:(fun n ->
      ( ( ( ( ( ( ((n.Workflow_template.Planned_ticket.alias, n.ticket), n.title)
                , n.description )
              , n.dependencies )
            , n.parent )
          , n.capabilities )
        , n.reviewers )
      , n.separate_actor ))
;;

let instance_fields instances templates tickets =
  req "instance_id" instances
  <*> req "template_id" templates
  <*> req "template_revision" positive
  <*> req "parameters" parameters
  <*> req "tickets" (list tickets 31)
;;

let instance =
  Api_codec.map
    (obj
       (instance_fields instance_id resource planned_ticket)
       ~decode:(fun ((((id, template), template_revision), parameters), tickets) ->
         { Workflow_template.Instance.id
         ; template
         ; template_revision
         ; parameters
         ; tickets
         })
       ~encode:(fun i ->
         ( ( ((i.Workflow_template.Instance.id, i.template), i.template_revision)
           , i.parameters )
         , i.tickets )))
    ~decode:(fun i ->
      Json.decode (fun () ->
        validate
          (not (List.is_empty i.Workflow_template.Instance.tickets))
          "instance requires tickets";
        validate
          (not
             (List.contains_dup
                (List.map i.tickets ~f:(fun n -> n.Workflow_template.Planned_ticket.alias))
                ~compare:String.compare))
          "duplicate instance alias";
        validate
          (not
             (List.contains_dup
                (List.map i.tickets ~f:(fun n ->
                   n.Workflow_template.Planned_ticket.ticket))
                ~compare:Id.Ticket.compare))
          "duplicate instance ticket";
        i))
    ~encode:Fn.id
    ~description:
      "Complete deterministic expansion, validated against its template when registered."
;;

module Raw = struct
  let raw fields = Api_codec.as_json (Api_codec.object_ fields)
  let node = raw (node_fields (Api_codec.reference actor))
  let spec = raw (spec_fields node)

  let planned =
    raw (planned_fields (Api_codec.reference ticket) (Api_codec.reference actor))
  ;;

  let instance =
    raw
      (instance_fields
         (Api_codec.reference instance_id)
         (Api_codec.reference resource)
         planned)
  ;;
end
