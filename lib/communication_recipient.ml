open Core
module Recipient = Communication_event.Recipient
module Fields = Api_codec.Fields

let identifier decode encode =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode
    ~encode
    ~description:"Opaque validated recipient identity."
;;

let actor =
  Api_codec.map
    (Api_codec.object_
       (Fields.both
          (Fields.required "kind" (Api_codec.enum [ "actor", () ] ~equal:Unit.equal))
          (Fields.required "id" (identifier Id.Actor.of_string Id.Actor.to_string))))
    ~decode:(fun ((), id) -> Ok (Recipient.Actor id))
    ~encode:(function
      | Recipient.Actor id -> (), id
      | Run _ -> Json.fail Invalid_argument "expected actor recipient")
    ~description:"Actor recipient."
;;

let run =
  Api_codec.map
    (Api_codec.object_
       (Fields.both
          (Fields.required "kind" (Api_codec.enum [ "run", () ] ~equal:Unit.equal))
          (Fields.required "id" (identifier Id.Run.of_string Id.Run.to_string))))
    ~decode:(fun ((), id) -> Ok (Recipient.Run id))
    ~encode:(function
      | Recipient.Run id -> (), id
      | Actor _ -> Json.fail Invalid_argument "expected run recipient")
    ~description:"Run recipient."
;;

let codec =
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:[ "actor", actor; "run", run ]
    ~select:(function
      | Recipient.Actor _ -> "actor"
      | Run _ -> "run")
;;
