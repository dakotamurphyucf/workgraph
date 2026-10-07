open Core

type direction =
  | Before
  | After
  | Around
[@@deriving sexp, equal]

let get capture ref_ =
  Result.map (Session_store.Capture.event capture ref_) ~f:Session_event.to_json
;;

let read capture ~session ~anchor ~direction ~limit ~max_bytes =
  Json.decode (fun () ->
    if limit < 1 || limit > 100 || max_bytes < 4096 || max_bytes > 1024 * 1024
    then
      Json.fail
        Invalid_argument
        "history read requires limit 1..100 and budget 4KiB..1MiB";
    if anchor < 0 then Json.fail Invalid_argument "negative history anchor";
    if
      not
        (List.exists (Session_store.Capture.sessions capture) ~f:(fun metadata ->
           Session_id.equal (Session.id metadata) session))
    then Json.fail Not_found "session not found";
    let upper_bound = Session_store.Capture.upper_bound capture ~session in
    if anchor > upper_bound
    then Json.fail Invalid_argument "history anchor outside capture";
    let events = Session_store.Capture.events capture ~session in
    let candidates =
      match direction with
      | After ->
        List.filter events ~f:(fun event -> (Session_event.ref_ event).sequence > anchor)
      | Before ->
        List.filter events ~f:(fun event -> (Session_event.ref_ event).sequence < anchor)
        |> List.rev
      | Around ->
        let start = Int.max 1 (anchor - (limit / 2)) in
        List.filter events ~f:(fun event -> (Session_event.ref_ event).sequence >= start)
    in
    let selected = List.take candidates limit in
    let render items has_more next_anchor omitted =
      Json.obj
        [ "capture", Session_store.Capture.to_json capture
        ; "session_id", Session_id.jsonaf_of_t session
        ; "through", Json.int upper_bound
        ; "items", `Array items
        ; ("has_more", if has_more then `True else `False)
        ; "next_anchor", Json.int next_anchor
        ; "omitted_for_budget", Json.int omitted
        ]
    in
    let rec fit acc last = function
      | [] -> render (List.rev acc) (List.length candidates > List.length selected) last 0
      | event :: rest ->
        let item = Session_event.to_json event in
        let next_anchor = (Session_event.ref_ event).sequence in
        let trial = render (List.rev (item :: acc)) true next_anchor 0 in
        if String.length (Json.canonical trial) > max_bytes
        then
          if List.is_empty acc
          then
            Json.fail Blocked "one event metadata exceeds read budget; increase max_bytes"
          else render (List.rev acc) true last (List.length (event :: rest))
        else fit (item :: acc) next_anchor rest
    in
    let result = fit [] anchor selected in
    if String.length (Json.canonical result) > max_bytes
    then Json.fail Blocked "history read metadata exceeds budget; increase max_bytes";
    result)
;;
