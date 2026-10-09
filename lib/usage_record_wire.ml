open Core

let ( <*> ) = Api_codec.Fields.both
let req = Api_codec.Fields.required

let obj fields ~decode ~encode =
  Api_codec.object_ (Api_codec.Fields.map fields ~decode ~encode)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated entity ID."
;;

let nonblank n =
  Api_codec.map
    (Api_codec.text ~max_bytes:n)
    ~decode:(fun s ->
      if String.is_empty (String.strip s)
      then Error (Problem.create Invalid_argument "text must be nonblank")
      else Ok s)
    ~encode:Fn.id
    ~description:"Nonblank attributed text."
;;

type ('run, 'attempt) reference_scope =
  | Run of 'run
  | Attempt of 'attempt

let scope_branches run attempt =
  [ ( "run"
    , obj
        (req "kind" (Api_codec.literal "run") <*> req "run_id" run)
        ~decode:(fun ((), id) -> Run id)
        ~encode:(function
          | Run id -> (), id
          | Attempt _ -> Json.fail Invalid_argument "run scope expected") )
  ; ( "attempt"
    , obj
        (req "kind" (Api_codec.literal "attempt") <*> req "attempt_id" attempt)
        ~decode:(fun ((), id) -> Attempt id)
        ~encode:(function
          | Attempt id -> (), id
          | Run _ -> Json.fail Invalid_argument "attempt scope expected") )
  ]
;;

let scope_value run attempt =
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:(scope_branches run attempt)
    ~select:(function
    | Run _ -> "run"
    | Attempt _ -> "attempt")
;;

let run = id Id.Run.of_string Id.Run.to_string
let attempt = id Attempt.Id.of_string Attempt.Id.to_string

let scope =
  Api_codec.map
    (scope_value run attempt)
    ~decode:(function
      | Run id -> Ok (Usage_record.Scope.Run id)
      | Attempt id -> Ok (Usage_record.Scope.Attempt id))
    ~encode:(function
      | Usage_record.Scope.Run id -> Run id
      | Attempt id -> Attempt id)
    ~description:"One immutable run or attempt scope."
;;

let raw_scope =
  Api_codec.as_json (scope_value (Api_codec.reference run) (Api_codec.reference attempt))
;;

let record =
  Api_codec.map
    (obj
       (req "usage_id" (id Usage_record.Id.of_string Usage_record.Id.to_string)
        <*> req "scope" scope
        <*> req "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
        <*> req "tokens" (Api_codec.decimal64 ~max:Int64.max_value)
        <*> req "elapsed_ms" (Api_codec.decimal64 ~max:Int64.max_value)
        <*> req "provenance" (nonblank 4096)
        <*> req "timestamp" (nonblank 128))
       ~decode:
         (fun
           ((((((id, scope), actor), tokens), elapsed_ms), provenance), timestamp) ->
         { Usage_record.id; scope; actor; tokens; elapsed_ms; provenance; timestamp })
       ~encode:(fun r ->
         ( ( ((((r.Usage_record.id, r.scope), r.actor), r.tokens), r.elapsed_ms)
           , r.provenance )
         , r.timestamp )))
    ~decode:(fun r -> Result.map (Usage_record.validate r) ~f:(fun () -> r))
    ~encode:Fn.id
    ~description:
      "Immutable externally reported record; exact IDs deduplicate and content changes \
       conflict."
;;
