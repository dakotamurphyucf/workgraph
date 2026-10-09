open Core

type t =
  { through : int
  ; digest : string
  }
[@@deriving equal]

let through t = t.through
let digest t = t.digest

let with_checkpoint activity ~through ~checkpoint =
  Json.decode (fun () ->
    if through < 0 then Json.fail Invalid_argument "negative capture revision";
    Option.iter checkpoint ~f:(fun n ->
      if n < 0 || n > through then Json.fail Invalid_argument "checkpoint outside capture");
    let initial = Json.hash "workgraph-feed-lineage-v1" in
    let rec fold entries ~next ~digest ~observed =
      if next > through
      then { through; digest }, observed
      else (
        match entries with
        | [] -> Json.fail Corrupt_store "audit prefix unavailable"
        | event :: rest ->
          if Json.integer (Json.field event "revision") <> next
          then Json.fail Corrupt_store "audit prefix revisions are not contiguous";
          let digest = Json.hash (digest ^ Json.canonical event) in
          let observed =
            if Option.exists checkpoint ~f:(Int.equal next) then Some digest else observed
          in
          fold rest ~next:(next + 1) ~digest ~observed)
    in
    fold
      (List.rev activity)
      ~next:1
      ~digest:initial
      ~observed:(if Option.exists checkpoint ~f:(Int.equal 0) then Some initial else None))
;;

let of_activity activity ~through =
  Result.map (with_checkpoint activity ~through ~checkpoint:None) ~f:fst
;;
