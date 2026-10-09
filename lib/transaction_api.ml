open Core

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let facts =
  List.map Facts.mutation_methods ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Update working facts: " ^ name)
         ~mode:Mutation
         ~request:(unwrap (Facts.Command.raw_codec name))
         ~response:(unwrap (Facts.response_codec name))))
;;

let methods =
  List.map Planning_api.methods ~f:(fun method_ ->
    match Planning_api.descriptor ~method_ with
    | Some descriptor -> descriptor
    | None -> invalid_arg ("missing planning method contract: " ^ method_))
  @ Communication_api.methods
  @ [ Api_method.Packed.Pack Communication.message_method
    ; Pack Communication_inbox.ack_method
    ]
  @ List.map Agent_run_api.mutation_methods ~f:(fun method_ ->
    match Agent_run_api.descriptor ~method_ with
    | Some descriptor -> descriptor
    | None -> invalid_arg ("missing run method contract: " ^ method_))
  @ Evidence.api_methods
  @ Agent_run_policy_api.methods
  @ facts
  |> List.filter ~f:(fun (Api_method.Packed.Pack method_) ->
    Api_method.Mode.equal (Api_method.mode method_) Mutation)
;;

let creation_methods =
  [ "project.create"
  ; "ticket.create"
  ; "milestone.create"
  ; "comment.add"
  ; "thread.reply"
  ; "board.put"
  ; "thread.put"
  ; "team.put"
  ; "subscription.put"
  ; "request.create"
  ; "run.register"
  ; "attempt.start"
  ; "contract.put"
  ; "manifest.publish"
  ; "decision.put"
  ; "review.record"
  ; "validation.add"
  ; "template.instantiate"
  ; "template.instance_register"
  ; "resource.put_text"
  ]
;;

let request =
  Planning_api.Operation.batch_codec
    ~requests:
      (List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
         Api_method.name method_, Api_codec.as_json (Api_method.request_codec method_)))
    ~creation_methods
;;

module Result_item = struct
  type t =
    { method_ : string
    ; data : Jsonaf.t
    }

  let codec =
    let cases =
      List.map methods ~f:(fun (Api_method.Packed.Pack method_) ->
        let name = Api_method.name method_ in
        let fields =
          Api_codec.Fields.both
            (Api_codec.Fields.required "method" (Api_codec.literal name))
            (Api_codec.Fields.required
               "data"
               (Api_codec.as_json (Api_method.response_codec method_)))
        in
        ( name
        , Api_codec.object_
            (Api_codec.Fields.map
               fields
               ~decode:(fun ((), data) -> { method_ = name; data })
               ~encode:(fun t -> (), t.data)) ))
    in
    Api_codec.tagged ~discriminator:"method" ~cases ~select:(fun t -> t.method_)
  ;;
end

let response =
  let items =
    Api_codec.map
      (Api_codec.list Result_item.codec ~max_items:32)
      ~decode:(fun items ->
        if List.is_empty items
        then Error (Problem.create Invalid_argument "transaction requires results")
        else Ok items)
      ~encode:Fn.id
      ~description:"One complete method-tagged receipt per submitted operation, in order."
  in
  Api_codec.object_ (Api_codec.Fields.required "results" items)
;;

let method_ =
  Api_method.create
    ~name:"transaction.apply"
    ~summary:
      "Commit 1..32 ordered planning operations atomically, with typed creation aliases."
    ~mode:Mutation
    ~request
    ~response
;;

let result items = Api_method.encode_response method_ items
