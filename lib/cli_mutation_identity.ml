open Core

let required request =
  match Api_catalog.find (Protocol.Request.method_ request) with
  | Some (Api_method.Packed.Pack method_) ->
    Api_method.Mode.equal (Api_method.mode method_) Mutation
  | None -> String.equal (Protocol.Request.method_ request) "resource.upload"
;;

let ensure request ~random ~allow_generate =
  Json.decode (fun () ->
    if
      required request
      && Option.is_none (Json.optional (Protocol.Request.params request) "mutation_id")
    then (
      if not allow_generate
      then
        Json.fail
          Invalid_argument
          "mutations require --mutation-id, --save-request or --request-directory";
      let bytes = Cstruct.create 32 in
      Eio.Flow.read_exact random bytes;
      let fields =
        match Protocol.Request.params request with
        | `Object fields -> fields
        | _ -> assert false
      in
      Protocol.Request.with_params
        request
        (Json.obj
           (("mutation_id", Json.string (Json.hash (Cstruct.to_string bytes))) :: fields))
      |> Disk.unwrap)
    else request)
;;
