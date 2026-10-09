open Core
module Fields = Api_codec.Fields

module Declaration = struct
  type t =
    { target : Path_scope.t
    ; mode : Reservation.Mode.t
    }
  [@@deriving sexp, equal]

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.both
            (Fields.required "target" Path_scope.codec)
            (Fields.required
               "mode"
               (Api_codec.enum
                  [ "exclusive", Reservation.Mode.Exclusive; "shared", Shared ]
                  ~equal:Reservation.Mode.equal)))
         ~decode:(fun (target, mode) -> { target; mode })
         ~encode:(fun t -> t.target, t.mode))
  ;;
end

type t =
  { ticket_id : Id.Ticket.t
  ; revision : int
  ; declarations : Declaration.t list
  ; require_reservations : bool
  }
[@@deriving sexp, equal]

let canonicalize declarations =
  Json.decode (fun () ->
    if List.length declarations > 100
    then Json.fail Invalid_argument "Ticket path declaration limit is 100";
    if
      List.contains_dup
        (List.map declarations ~f:(fun d -> d.Declaration.target))
        ~compare:Path_scope.compare
    then Json.fail Invalid_argument "Each ticket path target must be declared once";
    List.sort declarations ~compare:(fun a b ->
      Path_scope.compare a.Declaration.target b.target))
;;

let validate t =
  if t.revision < 1
  then Json.fail Invalid_argument "Ticket paths revision must be positive";
  match canonicalize t.declarations with
  | Error e -> raise (Json.Decode_error e)
  | Ok declarations ->
    if not (List.equal Declaration.equal declarations t.declarations)
    then Json.fail Invalid_argument "Ticket path declarations must be canonical"
;;

let ticket =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:Id.Ticket.of_string
    ~encode:Id.Ticket.to_string
    ~description:"Ticket ID."
;;

let codec =
  Api_codec.map
    (Api_codec.object_
       (Fields.map
          (Fields.both
             (Fields.required "ticket_id" ticket)
             (Fields.both
                (Fields.required "revision" (Api_codec.decimal ~max:Int.max_value))
                (Fields.both
                   (Fields.required
                      "declarations"
                      (Api_codec.list Declaration.codec ~max_items:100))
                   (Fields.required "require_reservations" Api_codec.boolean))))
          ~decode:(fun (ticket_id, (revision, (declarations, require_reservations))) ->
            { ticket_id; revision; declarations; require_reservations })
          ~encode:(fun t ->
            t.ticket_id, (t.revision, (t.declarations, t.require_reservations)))))
    ~decode:(fun t ->
      Json.decode (fun () ->
        validate t;
        t))
    ~encode:Fn.id
    ~description:"Canonical distinct target declarations; positive policy revision."
;;

let jsonaf_of_t t =
  match Api_codec.encode codec t with
  | Ok json -> json
  | Error e -> raise (Json.Decode_error e)
;;

let t_of_jsonaf json =
  let t =
    match Api_codec.decode codec json with
    | Ok t -> t
    | Error e -> raise (Json.Decode_error e)
  in
  List.iter
    (Json.list (Json.field json "declarations"))
    ~f:(fun d -> ignore (Path_scope.t_of_jsonaf (Json.field d "target") : Path_scope.t));
  t
;;

let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match
    Json.decode (fun () ->
      validate t;
      t)
  with
  | Ok t -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.Problem.message sexp
;;
