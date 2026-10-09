open Core

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required
let obj fields = Api_codec.as_json (Api_codec.object_ fields)
let text maximum = Api_codec.text ~max_bytes:maximum

let id of_string to_string =
  Api_codec.reference
    (Api_codec.map
       (text 96)
       ~decode:of_string
       ~encode:to_string
       ~description:"Validated entity ID.")
;;

let project = id Id.Project.of_string Id.Project.to_string
let ticket = id Id.Ticket.of_string Id.Ticket.to_string
let actor = id Id.Actor.of_string Id.Actor.to_string
let resource = id Id.Resource.of_string Id.Resource.to_string
let contract = id Evidence_id.Contract.of_string Evidence_id.Contract.to_string
let decision = id Evidence_id.Decision.of_string Evidence_id.Decision.to_string

let positive =
  Api_codec.map
    (Api_codec.decimal ~max:Int.max_value)
    ~decode:(fun n ->
      if n > 0
      then Ok n
      else Error (Problem.create Invalid_argument "positive revision required"))
    ~encode:Fn.id
    ~description:"Positive exact revision."
;;

let name =
  Api_codec.map
    (text 96)
    ~decode:(fun n -> Result.map (Id.Resource.of_string n) ~f:Id.Resource.to_string)
    ~encode:Fn.id
    ~description:"Literal ASCII name; aliases are not interpreted."
;;

let nonblank maximum =
  Api_codec.map
    (text maximum)
    ~decode:(fun value ->
      if String.is_empty (String.strip value)
      then Error (Problem.create Invalid_argument "text must be nonblank")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonblank bounded UTF-8 text."
;;

let digest lengths =
  Api_codec.map
    (text (List.fold lengths ~init:0 ~f:Int.max))
    ~decode:(fun value ->
      if
        List.mem lengths (String.length value) ~equal:Int.equal
        && String.for_all value ~f:(fun c ->
          Char.is_digit c || Char.(c >= 'a' && c <= 'f'))
      then Ok value
      else Error (Problem.create Invalid_argument "invalid lowercase digest"))
    ~encode:Fn.id
    ~description:"Exact lowercase hexadecimal digest."
;;

let sha256 = digest [ 64 ]
let list codec = Api_codec.list codec ~max_items:100

let tagged cases =
  Api_codec.tagged ~discriminator:"kind" ~cases ~select:(fun json ->
    Json.field json "kind" |> Json.text)
;;

let tag name fields = obj (req "kind" (Api_codec.literal name) <*> fields)

let scope =
  tagged
    [ "project", tag "project" (req "project_id" project)
    ; "ticket", tag "ticket" (req "ticket_id" ticket)
    ]
;;

let requirement =
  tagged
    [ "actor", tag "actor" (req "actor_id" actor)
    ; "role", tag "role" (req "name" name <*> req "member_ids" (list actor))
    ]
;;

let criterion_ref =
  obj (req "scope" scope <*> req "policy_revision" positive <*> req "key" name)
;;

let source = obj (req "scope" scope <*> req "revision" positive)

let inherited_override =
  obj
    (req "against" source
     <*> req "membership_revision" positive
     <*> req "reviewers" (list requirement)
     <*> req "validators" (list name)
     <*> req "criteria" (list name)
     <*> req "waive_separate_actor" Api_codec.boolean
     <*> req "reason" (nonblank 4096))
;;

let manifest_ref =
  obj
    (req "manifest_id" (id Evidence_id.Manifest.of_string Evidence_id.Manifest.to_string)
     <*> req "revision" positive)
;;

let contract_ref = obj (req "contract_id" contract <*> req "revision" positive)

let resource_fields =
  req "resource_id" resource <*> req "revision" positive <*> req "digest" sha256
;;

let resource_pin = obj resource_fields

let pin =
  tagged
    [ "resource", tag "resource" resource_fields
    ; ( "event"
      , tag
          "event"
          (req "session_id" (id Session_id.of_string Session_id.to_string)
           <*> req "sequence" positive) )
    ; ( "commit"
      , tag
          "commit"
          (req "repository" (nonblank 1024) <*> req "object_id" (digest [ 40; 64 ])) )
    ; "checksum", tag "checksum" (req "source" (nonblank 1024) <*> req "digest" sha256)
    ; ( "comment"
      , tag
          "comment"
          (req "comment_id" (id Id.Comment.of_string Id.Comment.to_string)
           <*> req "revision" positive) )
    ; "contract", tag "contract" (req "contract_id" contract <*> req "revision" positive)
    ; "decision", tag "decision" (req "decision_id" decision <*> req "revision" positive)
    ]
;;

let artifact = obj (req "name" name <*> req "pin" pin)

let entity_ref =
  tagged
    [ "workspace", obj (req "kind" (Api_codec.literal "workspace"))
    ; "project", tag "project" (req "project_id" project)
    ; ( "milestone"
      , tag
          "milestone"
          (req "milestone_id" (id Id.Milestone.of_string Id.Milestone.to_string)) )
    ; "ticket", tag "ticket" (req "ticket_id" ticket)
    ; "resource", tag "resource" (req "resource_id" resource)
    ]
;;

let disposition =
  tagged
    [ "acknowledge", obj (req "kind" (Api_codec.literal "acknowledge"))
    ; "continue", tag "continue" (req "reason" (nonblank 65_536))
    ; "revised", tag "revised" (req "manifest" manifest_ref)
    ]
;;
