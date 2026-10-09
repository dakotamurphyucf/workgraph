open Core

module Limit = struct
  type t =
    | Planning_commits
    | Planning_transaction_bytes
    | Planning_payload_bytes
    | History_commits
    | History_batch_bytes
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Referenced_resource_bytes
    | Fact_keys
    | Fact_version_bytes
    | Active_uploads
    | Reserved_upload_bytes
  [@@deriving sexp, compare, equal]

  let maximum = function
    | Planning_commits -> 100_000
    | Planning_transaction_bytes -> 128 * 1024 * 1024
    | Planning_payload_bytes | History_batch_bytes -> 64 * 1024 * 1024
    | History_commits -> 1_000_000
    | Tickets | Resources | Fact_keys -> 10_000
    | Projects | Milestones -> 1_000
    | Referenced_resource_bytes -> 512 * 1024 * 1024
    | Fact_version_bytes -> 16 * 1024 * 1024
    | Active_uploads -> 8
    | Reserved_upload_bytes -> 256 * 1024 * 1024
  ;;

  let entries =
    [ "planning_commits", Planning_commits
    ; "planning_transaction_bytes", Planning_transaction_bytes
    ; "planning_payload_bytes", Planning_payload_bytes
    ; "history_commits", History_commits
    ; "history_batch_bytes", History_batch_bytes
    ; "tickets", Tickets
    ; "projects", Projects
    ; "milestones", Milestones
    ; "resources", Resources
    ; "referenced_resource_bytes", Referenced_resource_bytes
    ; "fact_keys", Fact_keys
    ; "fact_version_bytes", Fact_version_bytes
    ; "active_uploads", Active_uploads
    ; "reserved_upload_bytes", Reserved_upload_bytes
    ]
  ;;

  let name t = List.find_exn entries ~f:(fun (_, limit) -> equal t limit) |> fst
  let codec = Api_codec.enum entries ~equal

  let unit_ = function
    | Planning_transaction_bytes
    | Planning_payload_bytes
    | History_batch_bytes
    | Referenced_resource_bytes
    | Fact_version_bytes
    | Reserved_upload_bytes -> "bytes"
    | Planning_commits
    | History_commits
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Fact_keys
    | Active_uploads -> "count"
  ;;
end

type t =
  { limit : Limit.t
  ; used : int
  }
[@@deriving sexp, equal]

let create limit ~used =
  if used < 0 || used > Limit.maximum limit
  then
    Error
      (Problem.create Invalid_argument "Admission usage is outside its enforced limit")
  else Ok { limit; used }
;;

let limit t = t.limit
let used t = t.used
let remaining t = Limit.maximum t.limit - t.used

let codec =
  let module F = Api_codec.Fields in
  let ( ++ ) = F.both in
  Api_codec.map
    (Api_codec.object_
       (F.required "name" Limit.codec
        ++ F.required "unit" (Api_codec.text ~max_bytes:5)
        ++ F.required "used" (Api_codec.decimal ~max:Int.max_value)
        ++ F.required "limit" (Api_codec.decimal ~max:Int.max_value)
        ++ F.required "remaining" (Api_codec.decimal ~max:Int.max_value)))
    ~decode:(fun ((((limit, unit_), used), maximum), remaining) ->
      Result.bind (create limit ~used) ~f:(fun t ->
        if
          String.equal unit_ (Limit.unit_ limit)
          && maximum = Limit.maximum limit
          && remaining = maximum - used
        then Ok t
        else Error (Problem.create Invalid_argument "Admission units or headroom differ")))
    ~encode:(fun t ->
      (((t.limit, Limit.unit_ t.limit), t.used), Limit.maximum t.limit), remaining t)
    ~description:"Exact admission accounting using the same limits as the owning guards."
;;

let unchecked_t_of_sexp = t_of_sexp

let t_of_sexp sexp =
  let t = unchecked_t_of_sexp sexp in
  match create t.limit ~used:t.used with
  | Ok t -> t
  | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
;;
