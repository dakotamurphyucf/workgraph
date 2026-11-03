open Core

module Key = struct
  module T = struct
    type t = string [@@deriving sexp_of, compare, equal]

    let of_string s = Result.map (Id.Run.of_string s) ~f:Id.Run.to_string

    let t_of_sexp sexp =
      match of_string (String.t_of_sexp sexp) with
      | Ok s -> s
      | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
    ;;
  end

  include T
  include Comparable.Make (T)

  let to_string t = t
  let jsonaf_of_t = Json.string

  let t_of_jsonaf j =
    match of_string (Json.text j) with
    | Ok t -> t
    | Error e -> raise (Json.Decode_error e)
  ;;
end

module Scope = struct
  type t =
    | Run of Id.Run.t
    | Attempt of Attempt.Id.t
  [@@deriving sexp, equal]
end

module Metric = struct
  type t =
    { name : string
    ; unit_ : string
    ; value : int64
    }
  [@@deriving sexp, equal]

  let identifier text ~max_bytes ~name =
    (not (String.is_empty text))
    && String.length text <= max_bytes
    && String.for_all text ~f:(fun c ->
      (Char.is_alphanum c && Char.to_int c < 128)
      || Char.equal c '_'
      || Char.equal c '.'
      || Char.equal c '-'
      || ((not name) && (Char.equal c '/' || Char.equal c '%')))
  ;;

  let validate t =
    Json.decode (fun () ->
      if
        (not (identifier t.name ~max_bytes:64 ~name:true))
        || (not (identifier t.unit_ ~max_bytes:32 ~name:false))
        || List.mem [ "tokens"; "elapsed_ms" ] t.name ~equal:String.equal
        || Int64.(t.value < zero)
      then
        Json.fail
          Invalid_argument
          "invalid named metric (bounded ASCII name/unit, nonnegative integer; \
           tokens/elapsed_ms reserved)")
  ;;

  let codec =
    let module F = Api_codec.Fields in
    Api_codec.object_
      (F.map
         (F.both
            (F.both
               (F.required "name" (Api_codec.text ~max_bytes:64))
               (F.required "unit" (Api_codec.text ~max_bytes:32)))
            (F.required "value" (Api_codec.decimal64 ~max:Int64.max_value)))
         ~decode:(fun ((name, unit_), value) -> { name; unit_; value })
         ~encode:(fun t -> (t.name, t.unit_), t.value))
    |> fun codec ->
    Api_codec.map
      codec
      ~decode:(fun metric -> Result.map (validate metric) ~f:(fun () -> metric))
      ~encode:Fn.id
      ~description:
        "Additive caller-reported integer sample; unique bounded ASCII name and explicit \
         unit, no conversion."
  ;;
end

module Metric_total = struct
  type t =
    { name : string
    ; unit_ : string
    ; samples : int
    ; value : int64
    ; overflow : bool
    }

  let codec =
    let module F = Api_codec.Fields in
    let ( ++ ) = F.both in
    Api_codec.object_
      (F.map
         (F.required "name" (Api_codec.text ~max_bytes:64)
          ++ F.required "unit" (Api_codec.text ~max_bytes:32)
          ++ F.required "samples" (Api_codec.decimal ~max:Int.max_value)
          ++ F.required "value" (Api_codec.decimal64 ~max:Int64.max_value)
          ++ F.required "overflow" Api_codec.boolean)
         ~decode:(fun ((((name, unit_), samples), value), overflow) ->
           { name; unit_; samples; value; overflow })
         ~encode:(fun t -> (((t.name, t.unit_), t.samples), t.value), t.overflow))
    |> fun codec ->
    Api_codec.map
      codec
      ~decode:(fun total ->
        Result.bind
          (Metric.validate
             { name = total.name; unit_ = total.unit_; value = total.value })
          ~f:(fun () ->
            Json.decode (fun () ->
              if
                total.samples <= 0
                || (total.overflow && not (Int64.equal total.value Int64.max_value))
              then
                Json.fail
                  Invalid_argument
                  "metric total needs samples and truthful saturation";
              total)))
      ~encode:Fn.id
      ~description:"Exact source-deduplicated name/unit sum; saturation is explicit."
  ;;
end

type t =
  { id : Key.t
  ; scope : Scope.t
  ; actor : Id.Actor.t
  ; tokens : int64
  ; elapsed_ms : int64
  ; metrics : Metric.t list
  ; provenance : string
  ; timestamp : string
  }
[@@deriving sexp, equal]

let validate t =
  Json.decode (fun () ->
    if Int64.(t.tokens < zero || t.elapsed_ms < zero)
    then Json.fail Invalid_argument "Reported usage is negative";
    if List.length t.metrics > 16
    then Json.fail Invalid_argument "at most 16 named metrics per usage record";
    List.iter t.metrics ~f:(fun metric ->
      match Metric.validate metric with
      | Ok () -> ()
      | Error e -> raise (Json.Decode_error e));
    if
      not
        (List.is_sorted_strictly t.metrics ~compare:(fun a b ->
           String.compare a.Metric.name b.name))
    then Json.fail Invalid_argument "named metrics must be distinct and sorted by name";
    if
      String.is_empty (String.strip t.provenance)
      || String.length t.provenance > 4096
      || String.is_empty t.timestamp
      || String.length t.timestamp > 128
    then Json.fail Invalid_argument "Invalid usage provenance or timestamp")
;;

let to_json t =
  Json.obj
    [ "id", Key.jsonaf_of_t t.id
    ; ( "scope"
      , match t.scope with
        | Scope.Run id -> Json.obj [ "run", Id.Run.jsonaf_of_t id ]
        | Attempt id -> Json.obj [ "attempt", Attempt.Id.jsonaf_of_t id ] )
    ; "actor", Id.Actor.jsonaf_of_t t.actor
    ; "tokens", Json.int64 t.tokens
    ; "elapsed_ms", Json.int64 t.elapsed_ms
    ; ( "metrics"
      , `Array
          (List.map t.metrics ~f:(fun metric ->
             match Api_codec.encode Metric.codec metric with
             | Ok json -> json
             | Error e -> raise (Json.Decode_error e))) )
    ; "provenance", Json.string t.provenance
    ; "timestamp", Json.string t.timestamp
    ]
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields
      json
      ~allowed:
        [ "id"
        ; "scope"
        ; "actor"
        ; "tokens"
        ; "elapsed_ms"
        ; "metrics"
        ; "provenance"
        ; "timestamp"
        ];
    let get = Json.field json in
    let scope =
      let j = get "scope" in
      match Json.optional j "run", Json.optional j "attempt" with
      | Some id, None ->
        Json.fields j ~allowed:[ "run" ];
        Scope.Run (Id.Run.t_of_jsonaf id)
      | None, Some id ->
        Json.fields j ~allowed:[ "attempt" ];
        Attempt (Attempt.Id.t_of_jsonaf id)
      | Some _, Some _ | None, None -> Json.fail Invalid_argument "Usage needs one scope"
    in
    let t =
      { id = Key.t_of_jsonaf (get "id")
      ; scope
      ; actor = Id.Actor.t_of_jsonaf (get "actor")
      ; tokens = Json.integer64 (get "tokens")
      ; elapsed_ms = Json.integer64 (get "elapsed_ms")
      ; metrics =
          Json.list (get "metrics")
          |> List.map ~f:(fun json ->
            match Api_codec.decode Metric.codec json with
            | Ok metric -> metric
            | Error e -> raise (Json.Decode_error e))
      ; provenance = Json.text (get "provenance")
      ; timestamp = Json.text (get "timestamp")
      }
    in
    (match validate t with
     | Ok () -> ()
     | Error e -> raise (Json.Decode_error e));
    t)
;;

let deduplicate records =
  Json.decode (fun () ->
    List.fold records ~init:Key.Map.empty ~f:(fun map record ->
      (match validate record with
       | Ok () -> ()
       | Error e -> raise (Json.Decode_error e));
      match Map.find map record.id with
      | None -> Map.set map ~key:record.id ~data:record
      | Some old ->
        if not (equal old record)
        then Json.fail Idempotency_conflict "conflicting immutable usage source";
        map)
    |> Map.data)
;;

let metric_totals records =
  Result.bind (deduplicate records) ~f:(fun records ->
    Json.decode (fun () ->
      let sums =
        List.fold records ~init:String.Map.empty ~f:(fun sums record ->
          List.fold record.metrics ~init:sums ~f:(fun sums metric ->
            Map.update sums metric.Metric.name ~f:(fun units ->
              Map.update
                (Option.value units ~default:String.Map.empty)
                metric.unit_
                ~f:(fun previous ->
                  let old =
                    Option.value
                      previous
                      ~default:
                        { Metric_total.name = metric.name
                        ; unit_ = metric.unit_
                        ; samples = 0
                        ; value = 0L
                        ; overflow = false
                        }
                  in
                  let overflow = Int64.(metric.value > max_value - old.value) in
                  { old with
                    samples = old.samples + 1
                  ; value =
                      (if overflow
                       then Int64.max_value
                       else Int64.(old.value + metric.value))
                  ; overflow = old.overflow || overflow
                  }))))
      in
      Map.data sums |> List.concat_map ~f:Map.data))
;;

module Id = Key
