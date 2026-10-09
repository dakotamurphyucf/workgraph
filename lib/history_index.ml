open Core

type t =
  { fs : Eio.Fs.dir_ty Eio.Path.t
  ; root : string
  ; mutable indexed : String.Set.t
  }

let create ~fs ~root = { fs; root; indexed = String.Set.empty }
let path t relative = Eio.Path.(t.fs / t.root / relative)
let name event = Session_event.identity_hash event ^ ".text"
let index_path t event = path t (".local/history-index/" ^ name event)

let all_events capture =
  List.concat_map (Session_store.Capture.sessions capture) ~f:(fun metadata ->
    Session_store.Capture.events capture ~session:(Session.id metadata))
;;

let rebuild t capture =
  Disk.protect (fun () ->
    Disk.ensure_directory (path t ".local");
    Disk.ensure_directory (path t ".local/history-index");
    List.iter (all_events capture) ~f:(fun event ->
      if Set.mem t.indexed (Session_event.identity_hash event)
      then ()
      else (
        match Session_event.searchable_text event with
        | None -> t.indexed <- Set.add t.indexed (Session_event.identity_hash event)
        | Some ref_ ->
          let source = path t ("blobs/" ^ ref_.digest) in
          let digest, size = Blob.inspect source |> Disk.unwrap in
          if (not (String.equal digest ref_.digest)) || size <> ref_.size_bytes
          then Json.fail Corrupt_store "history index source corrupt";
          History_text.validate source |> Disk.unwrap;
          let destination = index_path t event in
          (match Eio.Path.kind ~follow:false destination with
           | `Regular_file ->
             let digest, size =
               File_content.inspect destination ~max_bytes:(64 * 1024 * 1024)
               |> Disk.unwrap
             in
             if (not (String.equal digest ref_.digest)) || size <> ref_.size_bytes
             then (
               Eio.Path.unlink destination;
               ignore
                 (File_content.copy source ~dst:destination ~max_bytes:(64 * 1024 * 1024)
                  |> Disk.unwrap
                  : string * int))
           | `Not_found ->
             ignore
               (File_content.copy source ~dst:destination ~max_bytes:(64 * 1024 * 1024)
                |> Disk.unwrap
                : string * int)
           | _ -> Json.fail Corrupt_store "history index path unsafe");
          t.indexed <- Set.add t.indexed (Session_event.identity_hash event))))
;;

let snippet bytes offset =
  let start = Int.max 0 (offset - 80) in
  let rec boundary pos =
    if pos < String.length bytes && Char.to_int bytes.[pos] land 0xc0 = 0x80
    then boundary (pos + 1)
    else pos
  in
  let start = boundary start in
  let selected = Query_budget.prefix (String.drop_prefix bytes start) ~max_bytes:512 in
  (* Stream chunks may end inside a scalar. A short snippet does not pass through
     the byte-cap boundary logic, so explicitly omit its incomplete final scalar. *)
  let complete_bytes =
    Uutf.String.fold_utf_8
      (fun complete_bytes offset -> function
         | `Uchar _ -> complete_bytes
         | `Malformed _ -> Int.min complete_bytes offset)
      (String.length selected)
      selected
  in
  String.prefix selected complete_bytes
;;

let find t event ~text =
  let needle = String.lowercase text in
  let overlap = String.length text + 512 in
  let found = ref None in
  Eio.Path.with_open_in (index_path t event) (fun file ->
    let buffer = Cstruct.create (256 * 1024) in
    let rec scan tail offset =
      let count =
        try Eio.Flow.single_read file buffer with
        | End_of_file -> 0
      in
      if count > 0
      then (
        let bytes = tail ^ Cstruct.to_string (Cstruct.sub buffer 0 count) in
        match String.substr_index (String.lowercase bytes) ~pattern:needle with
        | Some local ->
          found := Some (offset - String.length tail + local, snippet bytes local)
        | None ->
          scan
            (String.suffix bytes (Int.min overlap (String.length bytes)))
            (offset + count))
    in
    scan "" 0);
  !found
;;

let search t capture ~text ?session ?kinds ?after ~limit ~max_bytes () =
  Disk.protect (fun () ->
    ignore (Json.canonical (Json.string text) : string);
    if
      String.is_empty text
      || String.length text > 256
      || limit < 1
      || limit > 100
      || max_bytes < 4096
      || max_bytes > 1024 * 1024
    then Json.fail Invalid_argument "invalid history search text/limit/budget";
    Option.iter session ~f:(fun id ->
      if
        not
          (List.exists (Session_store.Capture.sessions capture) ~f:(fun metadata ->
             Session_id.equal (Session.id metadata) id))
      then Json.fail Not_found "session not found");
    Option.iter after ~f:(fun ref_ ->
      ignore (Session_store.Capture.event capture ref_ |> Disk.unwrap : Session_event.t));
    let events = all_events capture in
    let filtered =
      List.filter events ~f:(fun event ->
        Option.value_map session ~default:true ~f:(fun id ->
          Session_id.equal id (Session_event.ref_ event).session)
        && Option.value_map kinds ~default:true ~f:(fun kinds ->
          List.mem kinds (Session_event.kind event) ~equal:String.equal))
    in
    let unsearchable =
      List.count filtered ~f:(fun event ->
        Option.is_none (Session_event.searchable_text event))
    in
    let missing =
      List.count filtered ~f:(fun event ->
        not (Set.mem t.indexed (Session_event.identity_hash event)))
    in
    let coverage =
      List.map (Session_store.Capture.sessions capture) ~f:(fun metadata ->
        let id = Session.id metadata in
        let rec contiguous through = function
          | event :: rest when Set.mem t.indexed (Session_event.identity_hash event) ->
            contiguous (Session_event.ref_ event).sequence rest
          | [] | _ :: _ -> through
        in
        Json.obj
          [ "session_id", Session_id.jsonaf_of_t id
          ; ( "committed_through"
            , Json.int (Session_store.Capture.upper_bound capture ~session:id) )
          ; ( "indexed_through"
            , Json.int (contiguous 0 (Session_store.Capture.events capture ~session:id)) )
          ])
    in
    let candidates =
      List.filter filtered ~f:(fun event ->
        Option.value_map after ~default:true ~f:(fun ref_ ->
          Session.Event_ref.compare (Session_event.ref_ event) ref_ > 0))
    in
    let render items next has_more omitted =
      Json.obj
        [ "capture", Session_store.Capture.to_json capture
        ; "items", `Array items
        ; ( "next"
          , if missing > 0
            then `Null
            else Option.value_map next ~default:`Null ~f:Session.Event_ref.to_json )
        ; ("restart_after_indexing", if missing > 0 then `True else `False)
        ; ("has_more", if has_more then `True else `False)
        ; "coverage", `Array coverage
        ; ("complete", if missing = 0 then `True else `False)
        ; "unindexed_events", Json.int missing
        ; "unsearchable_events", Json.int unsearchable
        ; "omitted_for_budget", Json.int omitted
        ]
    in
    let rec scan acc count last = function
      | [] -> render (List.rev acc) last false 0
      | event :: rest ->
        if count >= limit
        then render (List.rev acc) last true 0
        else (
          let ref_ = Session_event.ref_ event in
          if not (Set.mem t.indexed (Session_event.identity_hash event))
          then scan acc count (Some ref_) rest
          else (
            match Session_event.searchable_text event with
            | None -> scan acc count (Some ref_) rest
            | Some _ ->
              (match find t event ~text with
               | None -> scan acc count (Some ref_) rest
               | Some (byte_offset, snippet) ->
                 let item =
                   Json.obj
                     [ ( "event_ref"
                       , Api_codec.encode History_wire.event_ref ref_ |> Disk.unwrap )
                     ; "kind", Json.string (Session_event.kind event)
                     ; "role", Json.string (Session_event.role event)
                     ; "byte_offset", Json.int byte_offset
                     ; "snippet", Json.string snippet
                     ]
                 in
                 if
                   Api_response.encoded_size
                     History
                     (render (List.rev (item :: acc)) (Some ref_) true 0)
                   > max_bytes
                 then
                   if count = 0
                   then Json.fail Blocked "history search metadata exceeds budget"
                   else render (List.rev acc) last true 1
                 else scan (item :: acc) (count + 1) (Some ref_) rest)))
    in
    let result = scan [] 0 after candidates in
    if Api_response.encoded_size History result > max_bytes
    then Json.fail Blocked "history coverage exceeds search budget";
    result)
;;
