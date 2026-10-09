open Core

let id decode encode =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode
    ~encode
    ~description:"Validated coordination identity."
;;

let counter = Api_codec.decimal ~max:Int.max_value

let positive =
  Api_codec.map
    counter
    ~decode:(fun n ->
      if n > 0
      then Ok n
      else Error (Problem.create Invalid_argument "Counter must be positive"))
    ~encode:Fn.id
    ~description:"Positive decimal counter."
;;

let nonblank ~max_bytes =
  Api_codec.map
    (Api_codec.text ~max_bytes)
    ~decode:(fun s ->
      if String.is_empty (String.strip s)
      then Error (Problem.create Invalid_argument "Text must be nonblank")
      else Ok s)
    ~encode:Fn.id
    ~description:"Nonblank UTF8 text."
;;

let checked codec validate =
  Api_codec.map
    codec
    ~decode:(fun t ->
      Json.decode (fun () ->
        validate t;
        t))
    ~encode:Fn.id
    ~description:"Validated cooperative coordination record."
;;

let encode_exn codec t =
  match Api_codec.encode codec t with
  | Ok j -> j
  | Error e -> raise (Json.Decode_error e)
;;

let decode_exn codec j =
  match Api_codec.decode codec j with
  | Ok t -> t
  | Error e -> raise (Json.Decode_error e)
;;

let actor = id Id.Actor.of_string Id.Actor.to_string
let run = id Id.Run.of_string Id.Run.to_string
let ticket = id Id.Ticket.of_string Id.Ticket.to_string
let evidence = Api_codec.list Evidence_wire.pin ~max_items:100
