open Core

module Entry = struct
  type t =
    { root : string
    ; generation : int
    ; capture : Session_store.Capture.t
    ; weight : int
    }

  let matches t ~root ~generation ~workspace ~head =
    String.equal t.root root
    && t.generation = generation
    && Id.Workspace.equal (Session_store.Capture.workspace t.capture) workspace
    && Option.equal String.equal (Session_store.Capture.head t.capture) head
  ;;
end

type t = { mutable entries : Entry.t list }

let create () = { entries = [] }

let find t ~root ~generation ~workspace ~head =
  let matches = Entry.matches ~root ~generation ~workspace ~head in
  match List.find t.entries ~f:matches with
  | None -> None
  | Some entry ->
    t.entries <- entry :: List.filter t.entries ~f:(fun e -> not (matches e));
    Some entry.capture
;;

let weight capture =
  let sessions = Session_store.Capture.sessions capture in
  let events =
    List.sum
      (module Int)
      sessions
      ~f:(fun session ->
        Session_store.Capture.upper_bound capture ~session:(Session.id session))
  in
  (4 * Session_store.Capture.metadata_bytes capture)
  + (192 * List.length (Session_store.Capture.portable_files capture))
  + (256 * (List.length sessions + events))
;;

let add t ~root ~generation ~capture ~weight =
  let workspace = Session_store.Capture.workspace capture in
  let head = Session_store.Capture.head capture in
  let remaining =
    List.filter t.entries ~f:(fun entry ->
      not
        ((String.equal entry.root root && entry.generation <> generation)
         || Entry.matches entry ~root ~generation ~workspace ~head))
  in
  let maximum = 16 * 1024 * 1024 in
  if weight < 0 then invalid_arg "negative history cache weight";
  if weight > maximum
  then t.entries <- remaining
  else (
    let rec retain count used = function
      | [] -> []
      | entry :: rest ->
        if count >= 8 || used + entry.Entry.weight > maximum
        then []
        else entry :: retain (count + 1) (used + entry.weight) rest
    in
    t.entries <- retain 0 0 ({ Entry.root; generation; capture; weight } :: remaining))
;;
