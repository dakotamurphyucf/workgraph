open Core

let require condition kind message = if not condition then Json.fail kind message

let optional json f =
  match json with
  | `Null -> None
  | json -> Some (f json)
;;

type t =
  { run : Id.Run.t
  ; revision : int
  ; max_attempts : int option
  ; max_active_attempts : int option
  ; reported_token_limit : int64 option
  ; reported_elapsed_ms_limit : int64 option
  }
[@@deriving sexp, equal]

let t_of_sexp_unchecked = t_of_sexp

let validate_exn t =
  require (t.revision > 0) Invalid_argument "Budget revision must be positive";
  List.iter [ t.max_attempts; t.max_active_attempts ] ~f:(fun n ->
    Option.iter n ~f:(fun n ->
      require (n > 0) Invalid_argument "Attempt limit must be positive"));
  List.iter [ t.reported_token_limit; t.reported_elapsed_ms_limit ] ~f:(fun n ->
    Option.iter n ~f:(fun n ->
      require Int64.(n >= zero) Invalid_argument "Reported usage limit cannot be negative"))
;;

let t_of_sexp sexp =
  let value = t_of_sexp_unchecked sexp in
  try
    validate_exn value;
    value
  with
  | Json.Decode_error p -> Sexplib.Conv.of_sexp_error p.Problem.message sexp
;;

let to_json t =
  Json.obj
    [ "run", Id.Run.jsonaf_of_t t.run
    ; "revision", Json.int t.revision
    ; "max_attempts", Option.value_map t.max_attempts ~default:`Null ~f:Json.int
    ; ( "max_active_attempts"
      , Option.value_map t.max_active_attempts ~default:`Null ~f:Json.int )
    ; ( "reported_token_limit"
      , Option.value_map t.reported_token_limit ~default:`Null ~f:Json.int64 )
    ; ( "reported_elapsed_ms_limit"
      , Option.value_map t.reported_elapsed_ms_limit ~default:`Null ~f:Json.int64 )
    ]
;;

let of_json_exn json =
  Json.fields
    json
    ~allowed:
      [ "run"
      ; "revision"
      ; "max_attempts"
      ; "max_active_attempts"
      ; "reported_token_limit"
      ; "reported_elapsed_ms_limit"
      ];
  let get = Json.field json in
  let t =
    { run = Id.Run.t_of_jsonaf (get "run")
    ; revision = Json.integer (get "revision")
    ; max_attempts = optional (get "max_attempts") Json.integer
    ; max_active_attempts = optional (get "max_active_attempts") Json.integer
    ; reported_token_limit = optional (get "reported_token_limit") Json.integer64
    ; reported_elapsed_ms_limit =
        optional (get "reported_elapsed_ms_limit") Json.integer64
    }
  in
  validate_exn t;
  t
;;

module Attention = struct
  module Kind = struct
    type t =
      | Reported_tokens
      | Reported_elapsed_ms
    [@@deriving sexp_of, equal]

    let to_string = function
      | Reported_tokens -> "reported_tokens"
      | Reported_elapsed_ms -> "reported_elapsed_ms"
    ;;

    let codec =
      Api_codec.enum
        [ "reported_tokens", Reported_tokens; "reported_elapsed_ms", Reported_elapsed_ms ]
        ~equal
    ;;
  end

  type t =
    { run_id : Id.Run.t
    ; kind : Kind.t
    ; reported : int64
    ; reported_total_is_lower_bound : bool
    ; limit : int64
    }

  let create ~run ~kind ~reported ~limit =
    Json.decode (fun () ->
      require
        Int64.(reported >= zero && limit >= zero && reported >= limit)
        Invalid_argument
        "Attention requires nonnegative reported spending at or above its configured \
         limit";
      { run_id = run
      ; kind
      ; reported
      ; reported_total_is_lower_bound = Int64.equal reported Int64.max_value
      ; limit
      })
  ;;

  let codec =
    let open Api_codec.Fields in
    Api_codec.map
      (Api_codec.object_
         (both
            (both
               (both
                  (both
                     (both
                        (required "run_id" Coordination_wire.run)
                        (required "kind" Kind.codec))
                     (required "reported" (Api_codec.decimal64 ~max:Int64.max_value)))
                  (required "reported_total_is_lower_bound" Api_codec.boolean))
               (required "limit" (Api_codec.decimal64 ~max:Int64.max_value)))
            (required "provenance" (Api_codec.literal "externally_reported"))))
      ~decode:(fun (((((run, kind), reported), lower_bound), limit), ()) ->
        Result.bind (create ~run ~kind ~reported ~limit) ~f:(fun value ->
          if Bool.equal lower_bound value.reported_total_is_lower_bound
          then Ok value
          else
            Error
              (Problem.create
                 Invalid_argument
                 "Attention lower-bound flag differs from saturated total")))
      ~encode:(fun t ->
        ((((t.run_id, t.kind), t.reported), t.reported_total_is_lower_bound), t.limit), ())
      ~description:
        "Actual externally reported limit attention; totals saturated at int64 maximum \
         are lower bounds."
  ;;
end
